package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// GET /usage: the poll secret sees every row of this machine; a gateway
// credential sees only its own tree (top-level key: root_key_id = self) or
// itself (derived key: key_id = self), merged across machines. Filters narrow,
// never widen. Rows go in through recordUsage, the same path as metering.

func use(t *testing.T, a *app, keyID, rootKeyID string, parent *string, name string, in float64, cost *float64) {
	t.Helper()
	err := a.ledger.recordUsage(UsageRecord{
		KeyID: keyID, Name: name, ParentKeyID: parent, RootKeyID: &rootKeyID,
		Model: "glm-5.3", ProviderSlug: "cortecs",
		InputTokens: in, OutputTokens: 10, CacheReadTokens: 5, CacheWriteTokens: 1,
		CostUsd: cost,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func f64(v float64) *float64 { return &v }

type pageResp struct {
	Status  int
	Partial string
	Body    usagePage
}

func getUsage(t *testing.T, base, path string, header map[string]string) pageResp {
	t.Helper()
	req, _ := http.NewRequest("GET", base+path, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var p usagePage
	raw, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(raw, &p)
	return pageResp{Status: res.StatusCode, Partial: res.Header.Get("X-Usage-Partial"), Body: p}
}

func keyIDs(rows []usageRow) string {
	var out []string
	for _, r := range rows {
		out = append(out, r.KeyID)
	}
	return strings.Join(out, ",")
}

// scopeFixture: tree A (top + two children) and an unrelated tree B in
// another team.
type scopeFixture struct {
	a                *app
	base             string
	topA, topB       topKey
	childA1, childA2 childKey
	childB           childKey
}

func newScopeFixture(t *testing.T) scopeFixture {
	f := scopeFixture{a: newTestApp(t)}
	f.topA = seedTop(t, "", []string{"*"}, topOpts{})
	f.childA1 = seedChild(t, f.topA, "")
	f.childA2 = seedChild(t, f.topA, "")
	f.topB = seedTop(t, "", []string{"*"}, topOpts{})
	f.childB = seedChild(t, f.topB, "")
	use(t, f.a, f.topA.id, f.topA.id, nil, "top-a", 100, f64(0.5))
	use(t, f.a, f.childA1.id, f.topA.id, &f.topA.id, "build-1", 100, f64(0.25))
	use(t, f.a, f.childA1.id, f.topA.id, &f.topA.id, "build-1", 100, nil)
	use(t, f.a, f.childA2.id, f.topA.id, &f.topA.id, "build-2", 100, f64(1))
	use(t, f.a, f.topB.id, f.topB.id, nil, "top-b", 100, f64(2))
	use(t, f.a, f.childB.id, f.topB.id, &f.topB.id, "build-1", 100, f64(4))
	f.base = serve(t, f.a)
	return f
}

func TestUsagePollSecretSeesEveryRow(t *testing.T) {
	f := newScopeFixture(t)
	r := getUsage(t, f.base, "/usage", bearerHeader(testPollToken))
	mustEqual(t, r.Status, 200, "status")
	mustEqual(t, len(r.Body.Rows), 6, "rows")
	mustEqual(t, *r.Body.MaxID, r.Body.Rows[5].ID, "max_id")
	mustEqual(t, r.Body.Totals.Requests, 6, "requests")
	mustEqual(t, r.Body.Totals.CostUsd, 7.75, "cost")
	mustEqual(t, r.Body.Rows[0].JTI, r.Body.Rows[0].KeyID, "jti alias")
	if !strings.HasSuffix(r.Body.Rows[0].CreatedAt, "Z") || !strings.Contains(r.Body.Rows[0].CreatedAt, "T") {
		t.Fatalf("created_at %q", r.Body.Rows[0].CreatedAt)
	}
}

func TestUsageTopKeySeesItsTree(t *testing.T) {
	f := newScopeFixture(t)
	r := getUsage(t, f.base, "/usage", bearerHeader(f.topA.secret))
	mustEqual(t, r.Status, 200, "status")
	mustEqual(t, keyIDs(r.Body.Rows), strings.Join([]string{f.topA.id, f.childA1.id, f.childA1.id, f.childA2.id}, ","), "rows")
	mustEqual(t, r.Body.Totals, usageTotals{
		Requests: 4, InputTokens: 400, OutputTokens: 40, CacheReadTokens: 20, CacheWriteTokens: 4,
		CostUsd: 1.75, // the null-cost row is counted, not priced
	}, "totals")

	// x-api-key works too.
	r = getUsage(t, f.base, "/usage", map[string]string{"x-api-key": f.topB.secret})
	mustEqual(t, keyIDs(r.Body.Rows), f.topB.id+","+f.childB.id, "x-api-key rows")
}

func TestUsageDerivedKeySeesItself(t *testing.T) {
	f := newScopeFixture(t)
	r := getUsage(t, f.base, "/usage", bearerHeader(f.childA1.jwt))
	mustEqual(t, r.Status, 200, "status")
	mustEqual(t, keyIDs(r.Body.Rows), f.childA1.id+","+f.childA1.id, "rows")
	mustEqual(t, r.Body.Totals.CostUsd, 0.25, "cost")
}

func TestUsageFiltersNarrowWithinScope(t *testing.T) {
	f := newScopeFixture(t)
	r := getUsage(t, f.base, "/usage?jti="+f.childA2.id, bearerHeader(f.topA.secret))
	mustEqual(t, keyIDs(r.Body.Rows), f.childA2.id, "by jti")
	mustEqual(t, r.Body.Totals.CostUsd, 1.0, "by jti cost")
	r = getUsage(t, f.base, "/usage?key_id="+f.childA1.id, bearerHeader(f.topA.secret))
	mustEqual(t, len(r.Body.Rows), 2, "by key_id")

	// name=build-1 exists in both trees; a key holder sees only its own.
	byName := getUsage(t, f.base, "/usage?name=build-1", bearerHeader(f.topA.secret))
	mustEqual(t, keyIDs(byName.Body.Rows), f.childA1.id+","+f.childA1.id, "by name")
	r = getUsage(t, f.base, "/usage?name=build-1", bearerHeader(testPollToken))
	mustEqual(t, len(r.Body.Rows), 3, "poll by name")

	// since + limit still page.
	first := byName.Body.Rows[0].ID
	r = getUsage(t, f.base, fmt.Sprintf("/usage?name=build-1&since=%d", first), bearerHeader(f.topA.secret))
	mustEqual(t, len(r.Body.Rows), 1, "since")
	r = getUsage(t, f.base, "/usage?limit=2", bearerHeader(testPollToken))
	mustEqual(t, len(r.Body.Rows), 2, "limit")
	mustEqual(t, r.Body.Totals.Requests, 2, "limit totals")
}

func TestUsageFiltersNeverWiden(t *testing.T) {
	f := newScopeFixture(t)
	r := getUsage(t, f.base, "/usage?key_id="+f.childB.id, bearerHeader(f.topA.secret))
	mustEqual(t, r.Status, 200, "status")
	mustEqual(t, len(r.Body.Rows), 0, "other tree")
	if r.Body.MaxID != nil {
		t.Fatal("max_id should be null")
	}
	mustEqual(t, r.Body.Totals, usageTotals{}, "empty totals")
	mustEqual(t, len(getUsage(t, f.base, "/usage?jti="+f.childA2.id, bearerHeader(f.childA1.jwt)).Body.Rows), 0, "sibling")
	mustEqual(t, len(getUsage(t, f.base, "/usage?key_id="+f.topA.id, bearerHeader(f.childA1.jwt)).Body.Rows), 0, "parent")

	// The JSON shape of an empty page: rows [], max_id null.
	req, _ := http.NewRequest("GET", f.base+"/usage?key_id=nope", nil)
	req.Header.Set("Authorization", "Bearer "+testPollToken)
	res, _ := http.DefaultClient.Do(req)
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	mustEqual(t, string(raw), `{"rows":[],"max_id":null,"totals":{"requests":0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"cost_usd":0}}`, "empty page")
}

func TestUsageBadExpiredRevokedCredential401(t *testing.T) {
	f := newScopeFixture(t)
	mustEqual(t, getUsage(t, f.base, "/usage", nil).Status, 401, "none")
	mustEqual(t, getUsage(t, f.base, "/usage", bearerHeader("not-a-key")).Status, 401, "garbage")
	mustEqual(t, getUsage(t, f.base, "/usage", bearerHeader("sk_live_doesnotexist")).Status, 401, "unknown")
	expiredJWT := signSubKey(f.childA1.id, time.Now().Add(-time.Minute))
	mustEqual(t, getUsage(t, f.base, "/usage", bearerHeader(expiredJWT)).Status, 401, "expired jwt")
	past := time.Now().Add(-time.Minute)
	expiredTop := seedTop(t, f.topA.teamID, []string{"*"}, topOpts{expiresAt: &past})
	mustEqual(t, getUsage(t, f.base, "/usage", bearerHeader(expiredTop.secret)).Status, 401, "expired top")

	// Revoked derived row: a fresh id so the key-meta cache has no entry.
	revoked := seedChild(t, f.topA, "")
	_, _ = ownerPool.Exec(context.Background(), `UPDATE llm.keys SET status = 'revoked' WHERE id = $1`, revoked.id)
	mustEqual(t, getUsage(t, f.base, "/usage", bearerHeader(revoked.jwt)).Status, 401, "revoked")

	// A JWT signed by some other key.
	forged := f.childA1.jwt[:len(f.childA1.jwt)-4] + "AAAA"
	mustEqual(t, getUsage(t, f.base, "/usage", bearerHeader(forged)).Status, 401, "forged")
}

// A revocation reaches the proxy within the cache TTL, not before.
func TestKeyMetaCacheTTL(t *testing.T) {
	cfg := testConfig()
	cfg.KeyMetaTTL = 300 * time.Millisecond
	a := newApp(cfg, gatewayPool)
	key := seedTop(t, "", []string{"*"}, topOpts{})
	base := serve(t, a)
	mustEqual(t, getUsage(t, base, "/usage", bearerHeader(key.secret)).Status, 200, "active")
	_, _ = ownerPool.Exec(context.Background(), `UPDATE llm.keys SET status = 'revoked' WHERE id = $1`, key.id)
	mustEqual(t, getUsage(t, base, "/usage", bearerHeader(key.secret)).Status, 200, "cached")
	time.Sleep(350 * time.Millisecond)
	mustEqual(t, getUsage(t, base, "/usage", bearerHeader(key.secret)).Status, 401, "after TTL")
}

// --- Cross-machine merge ----------------------------------------------------

// idAt is a UUIDv7 for a given ms + counter with a random tail.
func idAt(ms int64, counter int) string {
	h := fmt.Sprintf("%012x", ms)
	tail := randomHex(8)
	return fmt.Sprintf("%s-%s-7%03x-8%s-%s", h[:8], h[8:], counter, tail[:3], tail[4:])
}

func siblingRow(keyID, rootID, usageID string, in float64) usageRow {
	m, p := "sibling", "cortecs"
	return usageRow{
		ID: cursorOf(usageID), UsageID: &usageID, MachineID: &m,
		KeyID: keyID, JTI: keyID, Name: "build", ParentKeyID: &rootID, RootKeyID: &rootID,
		Model: "glm-5.3", ProviderSlug: &p, InputTokens: in, OutputTokens: 1,
		CostUsd: f64(0.5), CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

const farFloor = 9007199254740991 // Number.MAX_SAFE_INTEGER, as a TS sibling would send

type seenReq struct {
	url  *url.URL
	auth string
}

type fakeSibling struct {
	origin string
	mu     sync.Mutex
	seen   []seenReq
}

func (s *fakeSibling) Seen() []seenReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]seenReq(nil), s.seen...)
}

// newFakeSibling answers GET /usage/local with respond(url).
func newFakeSibling(t *testing.T, respond func(u *url.URL, w http.ResponseWriter)) *fakeSibling {
	s := &fakeSibling{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.seen = append(s.seen, seenReq{r.URL, r.Header.Get("Authorization")})
		s.mu.Unlock()
		respond(r.URL, w)
	}))
	t.Cleanup(srv.Close)
	s.origin = srv.URL
	return s
}

func answer(rows []usageRow, floor int64) func(*url.URL, http.ResponseWriter) {
	return func(_ *url.URL, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(localPage{Rows: rows, Floor: floor})
	}
}

func setSiblings(a *app, origins ...string) {
	a.siblings = func(context.Context) ([]string, error) { return origins, nil }
}

func TestMergeLocalAndTwoSiblingsDedupedOrdered(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	use(t, a, child.id, top.id, &top.id, "build", 1, f64(0.25))
	use(t, a, child.id, top.id, &top.id, "build", 2, f64(0.25))
	base := serve(t, a)
	local := getUsage(t, base, "/usage?jti="+child.id, bearerHeader(testPollToken))
	mustEqual(t, len(local.Body.Rows), 2, "local rows")
	l1, l2 := local.Body.Rows[0], local.Body.Rows[1]

	now := time.Now().UnixMilli()
	early := idAt(now-60_000, 0) // before both local rows
	// l2 again: a row both machines report must count once.
	dup := siblingRow(child.id, top.id, *l2.UsageID, 2)
	sa := newFakeSibling(t, answer([]usageRow{siblingRow(child.id, top.id, early, 10), dup}, farFloor))
	late := idAt(now-1000, 7)
	sb := newFakeSibling(t, answer([]usageRow{siblingRow(child.id, top.id, late, 20)}, farFloor))
	setSiblings(a, sa.origin, sb.origin)

	r := getUsage(t, base, "/usage?since=0&jti="+child.id+"&limit=5000", bearerHeader(child.jwt))
	mustEqual(t, r.Status, 200, "status")
	mustEqual(t, r.Partial, "", "partial")
	var ins []float64
	for _, row := range r.Body.Rows {
		ins = append(ins, row.InputTokens)
		mustEqual(t, row.ID, cursorOf(*row.UsageID), "id is the cursor")
	}
	sort.Float64s(ins)
	mustEqual(t, fmt.Sprint(ins), "[1 2 10 20]", "rows")
	mustEqual(t, *r.Body.Rows[0].UsageID, early, "first row")
	if !sort.SliceIsSorted(r.Body.Rows, func(i, j int) bool { return r.Body.Rows[i].ID < r.Body.Rows[j].ID }) {
		t.Fatal("rows not ordered by id")
	}
	mustEqual(t, *r.Body.MaxID, r.Body.Rows[3].ID, "max_id")
	mustEqual(t, r.Body.Totals.Requests, 4, "requests")
	mustEqual(t, r.Body.Totals.InputTokens, 33, "input")
	mustEqual(t, r.Body.Totals.CostUsd, 1.5, "cost")
	found := false
	for _, row := range r.Body.Rows {
		found = found || *row.UsageID == *l1.UsageID
	}
	mustEqual(t, found, true, "local row present")

	// Siblings were asked with the poll token, the caller's scope and the
	// caller's own params, on the internal endpoint.
	for _, s := range []*fakeSibling{sa, sb} {
		seen := s.Seen()
		mustEqual(t, len(seen), 1, "sibling requests")
		mustEqual(t, seen[0].url.Path, "/usage/local", "path")
		mustEqual(t, seen[0].auth, "Bearer "+testPollToken, "auth")
		q := seen[0].url.Query()
		mustEqual(t, q.Get("scope_key"), child.id, "scope_key")
		mustEqual(t, q.Has("scope_root"), false, "scope_root")
		mustEqual(t, q.Get("jti"), child.id, "jti")
		mustEqual(t, q.Get("since"), "0", "since")
	}

	// A top-level key is scoped by root on the siblings.
	getUsage(t, base, "/usage", bearerHeader(top.secret))
	q := sa.Seen()[1].url.Query()
	mustEqual(t, q.Get("scope_root"), top.id, "scope_root")
	mustEqual(t, q.Has("scope_key"), false, "scope_key")
}

func TestMergeSinceMaxIDLoopCountsEveryRowOnce(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	var mu sync.Mutex
	var sibRows []usageRow
	s := newFakeSibling(t, func(u *url.URL, w http.ResponseWriter) {
		var since int64
		fmt.Sscan(u.Query().Get("since"), &since)
		mu.Lock()
		var out []usageRow
		for _, r := range sibRows {
			if r.ID > since {
				out = append(out, r)
			}
		}
		mu.Unlock()
		answer(out, farFloor)(u, w)
	})
	setSiblings(a, s.origin)
	base := serve(t, a)

	use(t, a, child.id, top.id, &top.id, "build", 1, f64(0.1))
	mu.Lock()
	sibRows = []usageRow{siblingRow(child.id, top.id, idAt(time.Now().UnixMilli()-5, 0), 2)}
	mu.Unlock()
	first := getUsage(t, base, "/usage?since=0&jti="+child.id, bearerHeader(child.jwt))
	mustEqual(t, first.Body.Totals.InputTokens, 3, "first page")

	// New rows on both machines after the cursor; nothing is re-counted.
	use(t, a, child.id, top.id, &top.id, "build", 4, f64(0.1))
	mu.Lock()
	sibRows = append(sibRows, siblingRow(child.id, top.id, idAt(time.Now().UnixMilli()+1, 0), 8))
	mu.Unlock()
	time.Sleep(5 * time.Millisecond) // the local floor is "now": let it pass the sibling row
	second := getUsage(t, base, fmt.Sprintf("/usage?since=%d&jti=%s", *first.Body.MaxID, child.id), bearerHeader(child.jwt))
	mustEqual(t, second.Body.Totals.InputTokens, 12, "second page")
	third := getUsage(t, base, fmt.Sprintf("/usage?since=%d&jti=%s", *second.Body.MaxID, child.id), bearerHeader(child.jwt))
	mustEqual(t, len(third.Body.Rows), 0, "third page")
	if third.Body.MaxID != nil {
		t.Fatal("third max_id should be null")
	}
}

func TestMergeRowsAboveSiblingFloorWait(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	baseMs := time.Now().UnixMilli() - 10_000
	sib := siblingRow(child.id, top.id, idAt(baseMs, 0), 2)
	var mu sync.Mutex
	floor := cursorOf(idAt(baseMs-1, 0)) // sibling written up to before sib
	s := newFakeSibling(t, func(u *url.URL, w http.ResponseWriter) {
		mu.Lock()
		f := floor
		mu.Unlock()
		answer([]usageRow{sib}, f)(u, w)
	})
	setSiblings(a, s.origin)
	base := serve(t, a)

	use(t, a, child.id, top.id, &top.id, "build", 1, f64(0.1)) // newer than the sibling's floor
	held := getUsage(t, base, "/usage?jti="+child.id, bearerHeader(child.jwt))
	mustEqual(t, len(held.Body.Rows), 0, "held")
	if held.Body.MaxID != nil {
		t.Fatal("held max_id should be null")
	}
	mu.Lock()
	floor = farFloor
	mu.Unlock()
	later := getUsage(t, base, "/usage?since=0&jti="+child.id, bearerHeader(child.jwt))
	mustEqual(t, len(later.Body.Rows), 2, "later rows")
	mustEqual(t, later.Body.Rows[0].InputTokens, 2, "sibling first")
	mustEqual(t, later.Body.Rows[1].InputTokens, 1, "local second")
}

func TestMergeLimitKeepsRowsSharingLastID(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	ms := time.Now().UnixMilli() - 20_000
	sa := newFakeSibling(t, answer([]usageRow{
		siblingRow(child.id, top.id, idAt(ms, 0), 1),
		siblingRow(child.id, top.id, idAt(ms, 1), 2),
	}, farFloor))
	sb := newFakeSibling(t, answer([]usageRow{
		siblingRow(child.id, top.id, idAt(ms, 1), 3), // same ms + counter
	}, farFloor))
	setSiblings(a, sa.origin, sb.origin)
	base := serve(t, a)
	p := getUsage(t, base, "/usage?limit=2&jti="+child.id, bearerHeader(child.jwt))
	mustEqual(t, len(p.Body.Rows), 3, "rows")
	mustEqual(t, p.Body.Rows[1].ID, p.Body.Rows[2].ID, "shared id")
	one := getUsage(t, base, "/usage?limit=1&jti="+child.id, bearerHeader(child.jwt))
	mustEqual(t, len(one.Body.Rows), 1, "limit 1")
	mustEqual(t, one.Body.Rows[0].InputTokens, 1, "limit 1 row")
}

func TestMergeUnreachableFailingSlowSiblingsPartial(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	use(t, a, child.id, top.id, &top.id, "build", 5, f64(0.1))
	// A port nothing listens on: bind one, then close it.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closedOrigin := "http://" + l.Addr().String()
	l.Close()
	failing := newFakeSibling(t, func(_ *url.URL, w http.ResponseWriter) {
		w.WriteHeader(500)
		_, _ = io.WriteString(w, "boom")
	})
	slow := newFakeSibling(t, func(u *url.URL, w http.ResponseWriter) {
		time.Sleep(3 * time.Second)
		answer(nil, 0)(u, w)
	})
	setSiblings(a, closedOrigin, failing.origin, slow.origin)
	base := serve(t, a)

	t0 := time.Now()
	r := getUsage(t, base, "/usage?jti="+child.id, bearerHeader(child.jwt))
	if d := time.Since(t0); d > 2900*time.Millisecond {
		t.Fatalf("sibling timeout must be ~2 s, took %v", d)
	}
	mustEqual(t, r.Status, 200, "status")
	mustEqual(t, len(r.Body.Rows), 1, "rows")
	mustEqual(t, r.Body.Rows[0].InputTokens, 5, "local row")
	mustEqual(t, r.Partial, "127,127,127", "partial")

	a.siblings = func(context.Context) ([]string, error) { return nil, fmt.Errorf("no dns") }
	r = getUsage(t, base, "/usage?jti="+child.id, bearerHeader(child.jwt))
	mustEqual(t, r.Partial, "discovery", "discovery partial")
	mustEqual(t, len(r.Body.Rows), 1, "rows without discovery")
}

func TestPollTokenLocalOnlyNeverAsksSiblings(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	use(t, a, child.id, top.id, &top.id, "build", 7, f64(0.1))
	asked := false
	a.siblings = func(context.Context) ([]string, error) { asked = true; return nil, nil }
	r := getUsage(t, serve(t, a), "/usage?jti="+child.id, bearerHeader(testPollToken))
	mustEqual(t, asked, false, "asked siblings")
	mustEqual(t, r.Partial, "", "partial")
	mustEqual(t, len(r.Body.Rows), 1, "rows")
	mustEqual(t, r.Body.Rows[0].InputTokens, 7, "row")
	// Poll-path ids stay this machine's row ids.
	if r.Body.Rows[0].ID >= 1_000_000 {
		t.Fatalf("poll id %d is not a row id", r.Body.Rows[0].ID)
	}
}

func TestUsageLocalPollTokenOnlyScopedThisMachine(t *testing.T) {
	a := newTestApp(t)
	top := seedTop(t, "", []string{"*"}, topOpts{})
	child := seedChild(t, top, "")
	other := seedChild(t, top, "")
	use(t, a, child.id, top.id, &top.id, "build", 3, f64(0.1))
	use(t, a, other.id, top.id, &top.id, "build", 4, f64(0.1))
	asked := false
	a.siblings = func(context.Context) ([]string, error) { asked = true; return nil, nil }
	base := serve(t, a)
	local := func(bearer, query string) (int, localPage) {
		req, _ := http.NewRequest("GET", base+"/usage/local"+query, nil)
		req.Header.Set("Authorization", "Bearer "+bearer)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var p localPage
		_ = json.NewDecoder(res.Body).Decode(&p)
		return res.StatusCode, p
	}
	s, _ := local(child.jwt, "?scope_key="+child.id)
	mustEqual(t, s, 401, "derived key")
	s, _ = local(top.secret, "?scope_root="+top.id)
	mustEqual(t, s, 401, "top key")
	s, _ = local(testPollToken, "")
	mustEqual(t, s, 400, "no scope")
	s, _ = local(testPollToken, "?scope_key=a&scope_root=b")
	mustEqual(t, s, 400, "two scopes")

	s, p := local(testPollToken, "?scope_key="+child.id)
	mustEqual(t, s, 200, "status")
	mustEqual(t, len(p.Rows), 1, "rows")
	mustEqual(t, p.Rows[0].InputTokens, 3, "row")
	mustEqual(t, p.Rows[0].ID, cursorOf(*p.Rows[0].UsageID), "cursor id")
	if p.Floor <= p.Rows[0].ID {
		t.Fatalf("floor %d not above row %d", p.Floor, p.Rows[0].ID)
	}
	mustEqual(t, asked, false, "asked siblings")

	// A scope filter never widens: the other key's rows via jti stay out.
	_, p = local(testPollToken, "?scope_key="+child.id+"&jti="+other.id)
	mustEqual(t, len(p.Rows), 0, "narrowed")
}

func TestDiscoverSiblingsOutsideFly(t *testing.T) {
	a := newTestApp(t)
	origins, err := a.discoverSiblings(context.Background())
	mustEqual(t, err, nil, "error")
	mustEqual(t, len(origins), 0, "origins")
}
