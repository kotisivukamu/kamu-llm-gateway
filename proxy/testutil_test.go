package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The suite runs against a real Postgres with the gateway migrations applied
// (README "Running tests"), as the Deno suite did: keys are real llm.keys
// rows verified through the production path. GATEWAY_DATABASE_URL is the
// proxy's own connection (admin_role, BYPASSRLS); fixtures are written as the
// postgres owner on the same database. The usage ledger is an in-memory
// SQLite per test app.

var (
	testDatabaseURL = envOr("GATEWAY_DATABASE_URL",
		"postgres://admin_role:admin_role@localhost:5432/kamu_llm_gateway_test")
	testPollToken = envOr("CONTROL_PLANE_POLL_TOKEN", "test-poll-token")
	// Throwaway Ed25519 test pair, the same as api/src/tests and CI: the api
	// signs sub-keys with the private half, the proxy holds the public one.
	testPublicKey  = envOr("ED25519_PUBLIC_KEY", "VxiWrfnCtLTKomsUlDYHqGcLrUsyUh0g+n310PIbS64=")
	testPrivateKey = "9eoI/HkwmmgkmKzs9yu8drtLyeglFbz5FIulBSRHXrk="

	gatewayPool *pgxpool.Pool // what the app under test reads with
	ownerPool   *pgxpool.Pool // fixtures
)

func TestMain(m *testing.M) {
	var err error
	if gatewayPool, err = newGatewayPool(testDatabaseURL); err != nil {
		panic(err)
	}
	owner := regexp.MustCompile(`//[^@]+@`).ReplaceAllString(testDatabaseURL, "//postgres:postgres@")
	if ownerPool, err = pgxpool.New(context.Background(), owner); err != nil {
		panic(err)
	}
	code := m.Run()
	gatewayPool.Close()
	ownerPool.Close()
	os.Exit(code)
}

func testConfig() Config {
	pub, _ := base64.StdEncoding.DecodeString(testPublicKey)
	return Config{
		Port:               "8301",
		Version:            "test",
		DBPath:             ":memory:",
		GatewayDatabaseURL: testDatabaseURL,
		PublicKey:          pub,
		KeyID:              "test-ed25519-1",
		KeyMetaTTL:         10 * time.Second,
		PollToken:          testPollToken,
		MachineID:          "local",
	}
}

// newTestApp is a proxy with a fresh ledger and key cache, no siblings.
func newTestApp(t *testing.T) *app {
	t.Helper()
	a := newApp(testConfig(), gatewayPool)
	a.siblings = func(context.Context) ([]string, error) { return nil, nil }
	t.Cleanup(func() {
		if a.ledger.db != nil {
			a.ledger.db.Close()
		}
	})
	return a
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func seedTeam(t *testing.T) string {
	t.Helper()
	org := "org_go_" + randomHex(8)
	var id string
	err := ownerPool.QueryRow(context.Background(), `
		INSERT INTO llm.teams (kamuid_org_id, name, slug)
		VALUES ($1, 'Go Proxy Test', $1) RETURNING id::text`, org).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

type topKey struct {
	id, secret, teamID string
}

type topOpts struct {
	status    string
	expiresAt *time.Time
	label     string
}

// seedTop is an active top-level key (root_key_id = itself) in a new team
// unless teamID is given.
func seedTop(t *testing.T, teamID string, models []string, o topOpts) topKey {
	t.Helper()
	if teamID == "" {
		teamID = seedTeam(t)
	}
	if o.status == "" {
		o.status = "active"
	}
	if o.label == "" {
		o.label = "top"
	}
	secret := "sk_live_" + randomHex(16)
	var id string
	err := ownerPool.QueryRow(context.Background(), `
		INSERT INTO llm.keys
		  (team_id, label, key_hash, prefix, key_type, models, budget_usd, status, expires_at)
		VALUES ($1, $2, $3, 'sk_live_test', 'top', $4, 10, $5, $6)
		RETURNING id::text`, teamID, o.label, hashKey(secret), models, o.status, o.expiresAt).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ownerPool.Exec(context.Background(),
		`UPDATE llm.keys SET root_key_id = id WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	return topKey{id: id, secret: secret, teamID: teamID}
}

type childKey struct {
	id, jwt string
}

// seedChild is a derived key row under root, and its signed JWT.
func seedChild(t *testing.T, root topKey, status string) childKey {
	t.Helper()
	if status == "" {
		status = "active"
	}
	var id string
	err := ownerPool.QueryRow(context.Background(), `
		INSERT INTO llm.keys
		  (team_id, label, key_type, models, status, parent_key_id, root_key_id, expires_at)
		VALUES ($1, 'child', 'derived', '{"*"}', $2, $3, $3, now() + interval '1 hour')
		RETURNING id::text`, root.teamID, status, root.id).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return childKey{id: id, jwt: signSubKey(id, time.Now().Add(time.Hour))}
}

// signSubKey mints a sub-key JWT the way the api does (EdDSA, kid header).
func signSubKey(jti string, exp time.Time) string {
	seed, _ := base64.StdEncoding.DecodeString(testPrivateKey)
	priv := ed25519.NewKeyFromSeed(seed)
	enc := base64.RawURLEncoding
	header, _ := json.Marshal(map[string]any{"alg": "EdDSA", "kid": "test-ed25519-1"})
	claims, _ := json.Marshal(map[string]any{
		"jti": jti, "sub": "root", "iat": time.Now().Unix(), "exp": exp.Unix(),
	})
	signing := enc.EncodeToString(header) + "." + enc.EncodeToString(claims)
	return signing + "." + enc.EncodeToString(ed25519.Sign(priv, []byte(signing)))
}

// upstreamCall is what the proxy sent upstream.
type upstreamCall struct {
	URL    string // as the proxy addressed it, before the test redirect
	Header http.Header
	Body   []byte
}

// fakeUpstream is a real HTTP server standing in for every provider: the
// app's client is pointed at it whatever host the catalog names, and each
// call is recorded. handler answers; nil answers 200 JSON with reply.
type fakeUpstream struct {
	mu    sync.Mutex
	calls []upstreamCall
	srv   *httptest.Server
}

func (f *fakeUpstream) Calls() []upstreamCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]upstreamCall(nil), f.calls...)
}

func withUpstream(t *testing.T, a *app, handler http.HandlerFunc) *fakeUpstream {
	t.Helper()
	f := &fakeUpstream{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.calls = append(f.calls, upstreamCall{
			URL: r.Header.Get("X-Test-Original-Url"), Header: r.Header.Clone(), Body: body,
		})
		f.mu.Unlock()
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		handler(w, r)
	}))
	t.Cleanup(f.srv.Close)
	target, _ := url.Parse(f.srv.URL)
	base := a.upstream.Transport
	a.upstream = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		r = r.Clone(r.Context())
		r.Header.Set("X-Test-Original-Url", r.URL.String())
		r.URL.Scheme, r.URL.Host = target.Scheme, target.Host
		r.Host = target.Host
		return base.RoundTrip(r)
	})}
	return f
}

func replyJSON(reply any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// serve runs the app on a real HTTP server.
func serve(t *testing.T, a *app) string {
	t.Helper()
	srv := httptest.NewServer(a.routes())
	t.Cleanup(srv.Close)
	return srv.URL
}

type ledgerRow struct {
	Model        string
	ProviderSlug *string
	InputTokens  float64
	OutputTokens float64
	CostUsd      *float64
}

// usageRows polls the ledger: metering runs after the response is sent.
func usageRows(t *testing.T, a *app, keyID string, want int) []ledgerRow {
	t.Helper()
	for i := 0; i < 100; i++ {
		db, err := a.ledger.conn()
		if err != nil {
			t.Fatal(err)
		}
		rows, err := db.Query(`SELECT model, provider_slug, input_tokens, output_tokens, cost_usd
		  FROM usage_log WHERE key_id = ? ORDER BY id`, keyID)
		if err != nil {
			t.Fatal(err)
		}
		var out []ledgerRow
		for rows.Next() {
			var r ledgerRow
			if err := rows.Scan(&r.Model, &r.ProviderSlug, &r.InputTokens, &r.OutputTokens, &r.CostUsd); err != nil {
				t.Fatal(err)
			}
			out = append(out, r)
		}
		rows.Close()
		if len(out) >= want {
			return out
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil
}

func doJSON(t *testing.T, method, u string, header map[string]string, body any) (*http.Response, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, u, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return res, out
}

func bearerHeader(secret string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + secret}
}

func near(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-12
}

func mustEqual[T comparable](t *testing.T, got, want T, what string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}
