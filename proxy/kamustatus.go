// KamuStatus server-side error reporter.
//
// A copy of kamuhub's bff/kamustatus.go (the Go twin of the Deno services'
// kamustatus-reporter.ts). Separate repos and modules, so no shared import;
// keep the copies in step when the wire contract changes.
//
// It speaks the same v1 wire contract as the browser SDK (see kamustatus
// packages/telemetry/PROTOCOL.md): POST {url}/i/{key}, Content-Type text/plain,
// JSON body. Server-side reporters send no Origin header, which ingest accepts
// by design.
//
// Deliberately dependency-free and deliberately silent: telemetry must never
// panic into a request path, never block a response, and never turn an ingest
// outage into a customer-visible failure.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	ksSDK             = "kamustatus-server-go/0.1.0"
	ksFlushInterval   = 5 * time.Second
	ksFlushAtEvents   = 20
	ksMaxEventsPerMin = 100
	ksMaxMsg          = 2048
	ksMaxStack        = 8192
	ksDeliveryTimeout = 10 * time.Second
)

type ksEvent struct {
	T     string  `json:"t"`
	Ts    int64   `json:"ts"`
	URL   string  `json:"url"`
	Name  string  `json:"name"`
	Msg   string  `json:"msg"`
	Stack *string `json:"stack"`
	Src   *string `json:"src"` // always null from a server reporter
}

type ksEnvelope struct {
	V       int       `json:"v"`
	SDK     string    `json:"sdk"`
	Release *string   `json:"release"`
	Sid     string    `json:"sid"`
	Dropped int       `json:"dropped"`
	Events  []ksEvent `json:"events"`
}

type ksReporter struct {
	enabled bool
	url     string // "{INGEST_URL}/i/{INGEST_KEY}"
	base    string // absolute origin events are attributed to
	release *string
	sid     string
	client  *http.Client

	mu          sync.Mutex
	buffer      []ksEvent
	dropped     int
	timer       *time.Timer
	windowStart time.Time
	windowCount int
	warned      bool
}

var kamustatus = newKSReporter()

func newKSReporter() *ksReporter {
	ingest := strings.TrimRight(os.Getenv("KAMUSTATUS_INGEST_URL"), "/")
	key := os.Getenv("KAMUSTATUS_INGEST_KEY")

	// Events need an absolute url. On Fly the app name is the honest identity of
	// the process; locally we fall back to localhost so dev noise is obvious.
	base := "http://localhost"
	if app := os.Getenv("FLY_APP_NAME"); app != "" {
		base = "https://" + app + ".fly.dev"
	}

	var release *string
	if v := os.Getenv("VERSION"); v != "" {
		release = &v
	}

	// One sid per process, mirroring the browser SDK's one-per-page-load.
	sid := make([]byte, 8)
	_, _ = rand.Read(sid)

	return &ksReporter{
		enabled: ingest != "" && key != "",
		url:     ingest + "/i/" + key,
		base:    base,
		release: release,
		sid:     hex.EncodeToString(sid),
		client:  &http.Client{Timeout: ksDeliveryTimeout},
	}
}

func (k *ksReporter) warnOnce(msg string) {
	if k.warned {
		return
	}
	k.warned = true
	log.Printf("[kamustatus] %s", msg)
}

// normalizeURL strips the query string: it can carry tokens and personal data,
// and the wire contract strips it for the browser too.
func (k *ksReporter) normalizeURL(where string) string {
	raw := where
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		if !strings.HasPrefix(raw, "/") {
			raw = "/" + raw
		}
		raw = k.base + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return k.base
	}
	return u.Scheme + "://" + u.Host + u.Path
}

func ksTruncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

// reportError buffers one error for delivery to KamuStatus. Fire-and-forget: it
// returns immediately and never panics. `where` is a request URL or a path; the
// query string is stripped. `stack` may be empty.
func reportError(err error, where string) {
	kamustatus.report("Error", err.Error(), "", where)
}

// reportErrorf is reportError for the call sites that have no error value (a
// recovered panic, a 5xx the handler wrote directly).
func reportErrorf(name, msg, stack, where string) {
	kamustatus.report(name, msg, stack, where)
}

func (k *ksReporter) report(name, msg, stack, where string) {
	if !k.enabled {
		k.mu.Lock()
		k.warnOnce("KAMUSTATUS_INGEST_URL/KEY unset, error reporting disabled")
		k.mu.Unlock()
		return
	}

	now := time.Now()

	k.mu.Lock()
	if now.Sub(k.windowStart) >= time.Minute {
		k.windowStart = now
		k.windowCount = 0
	}
	if k.windowCount >= ksMaxEventsPerMin {
		k.dropped++
		k.mu.Unlock()
		return
	}
	k.windowCount++

	var stackPtr *string
	if stack != "" {
		s := ksTruncate(stack, ksMaxStack)
		stackPtr = &s
	}
	k.buffer = append(k.buffer, ksEvent{
		T:     "error",
		Ts:    now.UnixMilli(),
		URL:   k.normalizeURL(where),
		Name:  name,
		Msg:   ksTruncate(msg, ksMaxMsg),
		Stack: stackPtr,
	})

	if len(k.buffer) >= ksFlushAtEvents {
		k.mu.Unlock()
		k.flush()
		return
	}
	if k.timer == nil {
		// AfterFunc, not a goroutine loop: it holds nothing open and a shutting-down
		// process just loses the pending batch, which is the right trade for telemetry.
		k.timer = time.AfterFunc(ksFlushInterval, k.flush)
	}
	k.mu.Unlock()
}

func (k *ksReporter) flush() {
	k.mu.Lock()
	if k.timer != nil {
		k.timer.Stop()
		k.timer = nil
	}
	if len(k.buffer) == 0 && k.dropped == 0 {
		k.mu.Unlock()
		return
	}
	env := ksEnvelope{
		V: 1, SDK: ksSDK, Release: k.release, Sid: k.sid,
		Dropped: k.dropped, Events: k.buffer,
	}
	k.buffer = nil
	k.dropped = 0
	k.mu.Unlock()

	body, err := json.Marshal(env)
	if err != nil {
		return
	}
	go func() {
		req, err := http.NewRequest(http.MethodPost, k.url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "text/plain")
		res, err := k.client.Do(req)
		if err != nil {
			k.mu.Lock()
			k.warnOnce("ingest unreachable, dropping error events")
			k.mu.Unlock()
			return
		}
		_ = res.Body.Close()
	}()
}

// ksPanicMsg renders a recovered panic value the way `err.Error()` would.
func ksPanicMsg(v any) string {
	if err, ok := v.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(v)
}
