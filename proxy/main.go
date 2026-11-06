// The kamu-llm-gateway LLM proxy: the consumption path for a gateway key (ADR
// 0001). Callers hit /llm/<provider>/<upstream path> with their key; the
// proxy verifies it, swaps in the provider key, forwards, streams the answer
// back as it arrives and meters the usage into a per-machine SQLite ledger
// that the api's poller drains (/usage).
//
// Go + stdlib net/http: the Deno version returned a tee() branch of the
// upstream body, and Deno.serve delivered every SSE stream in one burst when
// upstream finished. Here each upstream chunk is written and flushed as it
// arrives.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"runtime/debug"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type app struct {
	cfg      Config
	auth     *Auth
	ledger   *Ledger
	pool     *pgxpool.Pool
	upstream *http.Client
	siblings func(ctx context.Context) ([]string, error)
}

func main() {
	log.SetFlags(0)
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("Invalid environment: %v", err)
	}
	pool, err := newGatewayPool(cfg.GatewayDatabaseURL)
	if err != nil {
		log.Fatalf("GATEWAY_DATABASE_URL: %v", err)
	}
	a := newApp(cfg, pool)
	srv := &http.Server{
		Addr:    ":" + cfg.Port, // all interfaces, IPv6 too: Fly 6PN callers
		Handler: a.routes(),
		// Slowloris defense. No read/write timeouts: streams run for minutes.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("proxy listening on :%s", cfg.Port)
	log.Fatal(srv.ListenAndServe())
}

func newApp(cfg Config, pool *pgxpool.Pool) *app {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// No Accept-Encoding upstream: bodies come back as identity, so the bytes
	// we meter and forward are what the client reads, and no gzip stage sits
	// between an upstream chunk and the client.
	transport.DisableCompression = true
	a := &app{
		cfg:      cfg,
		ledger:   newLedger(cfg.DBPath, cfg.MachineID),
		pool:     pool,
		upstream: &http.Client{Transport: transport},
	}
	a.auth = &Auth{pub: cfg.PublicKey, keys: newKeyCache(pool, cfg.KeyMetaTTL)}
	a.siblings = a.discoverSiblings
	return a
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, obj("ok", true, "version", a.cfg.Version))
	})
	// Deep check: touches the SQLite ledger. Deliberately NOT what Fly checks
	// (fly.toml points at /health): a broken ledger file must not make Fly
	// restart the machine in a loop. This one is for KamuStatus.
	mux.HandleFunc("GET /health/deep", func(w http.ResponseWriter, _ *http.Request) {
		if err := a.ledger.probe(); err != nil {
			log.Printf("[health] sqlite probe failed: %v", err)
			writeJSON(w, 503, obj("status", "degraded", "db", "error"))
			return
		}
		writeJSON(w, 200, obj("status", "ok", "db", "ok"))
	})
	// More specific than /llm/, so "catalog" is never taken for a provider.
	mux.HandleFunc("GET /llm/catalog", a.handle(a.piCatalog))
	// Control-plane feed and key holders' own usage. See usage.go.
	mux.HandleFunc("/usage", a.handle(a.usage))
	mux.HandleFunc("GET /usage/local", a.handle(a.usageLocal))
	mux.HandleFunc("/llm/", a.handle(a.proxy))
	// Read-only catalog view with effective prices. See catalog_routes.go.
	mux.HandleFunc("GET /catalog", a.handle(a.catalogView))
	return reportPanics(mux)
}

// handle turns a returned error into the JSON error answer (the Hono
// onError of the Deno version): an upstream that can't be reached is a 503
// one-liner, anything else is reported to KamuStatus and answered 500.
func (a *app) handle(h func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := h(w, r)
		if err == nil {
			return
		}
		msg := err.Error()
		if transientError.MatchString(msg) {
			log.Printf("[proxy] %s %s upstream not ready: %s", r.Method, r.URL.Path, msg)
			writeJSON(w, 503, obj("error", "upstream_not_ready", "message", msg))
			return
		}
		// A client that hung up before upstream answered is not our error.
		if r.Context().Err() == nil {
			reportError(err, r.URL.Path)
		}
		log.Printf("[proxy] error: %s %s: %v", r.Method, r.URL.Path, err)
		writeJSON(w, 500, obj("error", msg))
	}
}

// Upstream connect/DNS failures: full errors for "provider not reachable"
// aren't actionable.
var transientError = regexp.MustCompile(`(?i)dns error|no such host|Connect|Connection refused|tcp connect|connection closed`)

// reportPanics reports a panic to KamuStatus and re-panics, so net/http keeps
// its behaviour (log + close the connection). http.ErrAbortHandler is the
// proxy cutting a broken stream on purpose, not a bug.
func reportPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v != http.ErrAbortHandler {
					reportErrorf("panic", ksPanicMsg(v), string(debug.Stack()), r.URL.Path)
				}
				panic(v)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// writeJSON writes v the way Hono's c.json did: compact, no HTML escaping,
// no trailing newline.
func writeJSON(w http.ResponseWriter, status int, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}
