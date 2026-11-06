package main

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// usage_id is the poller's dedupe key and cursor across proxy machines, so it
// must be a valid UUID (it lands in a Postgres uuid column) and sort by time
// as a plain string.

var uuidV7 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestUUIDv7Format(t *testing.T) {
	l := newLedger(":memory:", "local")
	if id := l.uuidv7(time.Now().UnixMilli()); !uuidV7.MatchString(id) {
		t.Fatalf("not a UUIDv7: %s", id)
	}
}

func TestUUIDv7StrictlyIncreasingWithinOneMs(t *testing.T) {
	l := newLedger(":memory:", "local")
	ms := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	prev := l.uuidv7(ms)
	for i := 0; i < 10_000; i++ { // same ms every time, past the 4096 counter
		next := l.uuidv7(ms)
		if next <= prev {
			t.Fatalf("%s after %s", next, prev)
		}
		prev = next
	}
}

func TestUUIDv7LaterMsSortsAfter(t *testing.T) {
	l := newLedger(":memory:", "local")
	ms := time.Date(2031, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	for i := int64(0); i < 1000; i++ {
		if a, b := l.uuidv7(ms+2*i), l.uuidv7(ms+2*i+1); a >= b {
			t.Fatalf("%s >= %s", a, b)
		}
	}
	// The id starts with its millisecond timestamp in hex, and cursorOf reads
	// it back.
	at := time.Date(2032, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	id := l.uuidv7(at)
	h := fmt.Sprintf("%012x", at)
	mustEqual(t, id[:13], h[:8]+"-"+h[8:], "timestamp prefix")
	mustEqual(t, cursorOf(id), (at-cursorEpochMs)*cursorPerMs, "cursor")
	mustEqual(t, usageIDAtLeast(cursorOf(id)), id[:18], "usageIDAtLeast")
}

func TestUsageFloorIsAboveEveryWrittenID(t *testing.T) {
	l := newLedger(":memory:", "local")
	now := time.Now().UnixMilli()
	id := l.uuidv7(now)
	ms, seq := l.usageFloor(now)
	if floor := (ms-cursorEpochMs)*cursorPerMs + int64(seq); floor <= cursorOf(id) {
		t.Fatalf("floor %d not above %d", floor, cursorOf(id))
	}
	// The next id is at or above the floor.
	next := l.uuidv7(now)
	mustEqual(t, cursorOf(next) >= (ms-cursorEpochMs)*cursorPerMs+int64(seq), true, "next id above floor")
}

func TestPollAfterPagesByUsageIDWithMachineID(t *testing.T) {
	a := newTestApp(t)
	key := "after-" + randomHex(4)
	for i := 0; i < 3; i++ {
		_ = a.ledger.recordUsage(UsageRecord{KeyID: key, Name: "after-test", RootKeyID: &key,
			Model: "m", ProviderSlug: "cortecs", InputTokens: float64(i)})
	}
	base := serve(t, a)
	all := getUsage(t, base, "/usage?after=0&key_id="+key, bearerHeader(testPollToken)).Body.Rows
	mustEqual(t, len(all), 3, "rows")
	for i, r := range all {
		mustEqual(t, r.InputTokens, float64(i), "order")
	}
	mustEqual(t, *all[0].MachineID, "local", "machine_id")
	rest := getUsage(t, base, "/usage?after="+*all[0].UsageID+"&key_id="+key, bearerHeader(testPollToken)).Body.Rows
	mustEqual(t, len(rest), 2, "rest")
	mustEqual(t, rest[0].InputTokens, 1, "rest first")
}

// ADR 0003 §1: the poller prices from the feed, so each row carries the raw
// buckets, which provider served it, and the provider-reported cost.
func TestPollFeedCarriesProviderBucketsAndCost(t *testing.T) {
	a := newTestApp(t)
	key := "feed-" + randomHex(4)
	_ = a.ledger.recordUsage(UsageRecord{KeyID: key, Name: "feed-test", RootKeyID: &key,
		Model: "glm-5.3", ProviderSlug: "cortecs", InputTokens: 200, OutputTokens: 40,
		CacheReadTokens: 1000, CacheWriteTokens: 7, ProviderCost: f64(1234)})
	rows := getUsage(t, serve(t, a), "/usage?after=0&key_id="+key, bearerHeader(testPollToken)).Body.Rows
	r := rows[0]
	mustEqual(t, r.Model, "glm-5.3", "model")
	mustEqual(t, *r.ProviderSlug, "cortecs", "provider_slug")
	mustEqual(t, r.InputTokens, 200, "input")
	mustEqual(t, r.OutputTokens, 40, "output")
	mustEqual(t, r.CacheReadTokens, 1000, "cache read")
	mustEqual(t, r.CacheWriteTokens, 7, "cache write")
	mustEqual(t, *r.ProviderCost, 1234, "provider_cost")
	if r.CostUsd != nil {
		t.Fatal("cost_usd should be null")
	}
}

// A ledger file the Deno proxy wrote (all six migrations applied, rows
// present) is picked up as is: no migration reruns, rows still readable.
func TestLedgerFileFromDenoProxyIsReused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "llm-proxy.db")
	l := newLedger(path, "m1")
	if err := l.recordUsage(UsageRecord{KeyID: "k", Name: "n", Model: "m", ProviderSlug: "p", InputTokens: 3}); err != nil {
		t.Fatal(err)
	}
	l.db.Close()

	db, _ := sql.Open("sqlite", path)
	var applied int
	_ = db.QueryRow(`SELECT count(*) FROM _migrations`).Scan(&applied)
	db.Close()
	mustEqual(t, applied, 6, "applied migrations")

	again := newLedger(path, "m1")
	rows, err := again.selectRows([]string{"key_id = ?"}, []any{"k"}, "id", 10)
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, len(rows), 1, "rows after reopen")
	mustEqual(t, rows[0].InputTokens, 3, "row")
	again.db.Close()
}

func TestHealthEndpoints(t *testing.T) {
	a := newTestApp(t)
	base := serve(t, a)
	res, body := doJSON(t, "GET", base+"/health", nil, nil)
	mustEqual(t, res.StatusCode, 200, "health")
	mustEqual(t, body["ok"], any(true), "ok")
	mustEqual(t, body["version"], any("test"), "version")
	res, body = doJSON(t, "GET", base+"/health/deep", nil, nil)
	mustEqual(t, res.StatusCode, 200, "deep")
	mustEqual(t, body["db"], any("ok"), "deep db")

	broken := newApp(func() Config { c := testConfig(); c.DBPath = t.TempDir(); return c }(), gatewayPool)
	res, body = doJSON(t, "GET", serve(t, broken)+"/health/deep", nil, nil)
	mustEqual(t, res.StatusCode, 503, "deep broken")
	mustEqual(t, body["status"], any("degraded"), "deep broken status")
}
