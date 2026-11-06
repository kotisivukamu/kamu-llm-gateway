package main

import (
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// The usage ledger: a SQLite file per proxy machine, on that machine's volume.
//
//   - usage_log: one row per completed request for EVERY key, with the raw
//     token buckets, the provider that served it and the provider-reported
//     cost (ADR 0003 §1). The api prices each row at ingest; cost_usd here is
//     only the catalog estimate key holders read on GET /usage. Carries the
//     lineage columns (parent_key_id, root_key_id) so spend rolls up to a
//     service's whole subtree (ADR 0001 §7.6). Each row has a usage_id
//     (UUIDv7, unique across machines and time-ordered) and the machine_id
//     that served it; the api's poller copies rows into Postgres keyed by
//     usage_id.
//   - token_spend: the pre-2026-10 per-key spend ledger, no longer read or
//     written (budgets moved to Postgres llm.key_spend). Left in place.
//
// `jti` is kept as an alias = key_id for the poll contract.
//
// The file and its _migrations bookkeeping are the ones the Deno proxy wrote,
// so an existing volume is picked up as is.

//go:embed migrations/*.sql
var migrationFiles embed.FS

type Ledger struct {
	path      string
	machineID string

	openMu sync.Mutex
	db     *sql.DB

	// idMu covers making a usage_id and inserting its row, and usageFloor:
	// every row with a usage_id below a floor is already in the table.
	idMu   sync.Mutex
	lastMs int64
	seq    int
}

func newLedger(path, machineID string) *Ledger {
	return &Ledger{path: path, machineID: machineID}
}

// conn opens (and migrates) the file on first use, so a broken ledger file
// fails the requests that need it (and /health/deep) instead of the boot.
func (l *Ledger) conn() (*sql.DB, error) {
	l.openMu.Lock()
	defer l.openMu.Unlock()
	if l.db != nil {
		return l.db, nil
	}
	dsn := l.path + "?_pragma=journal_mode(wal)&_pragma=busy_timeout(5000)"
	if l.path == ":memory:" {
		dsn = ":memory:"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection, like the Deno proxy's single DatabaseSync: SQLite has one
	// writer anyway, and ":memory:" (tests) is per connection.
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("ledger migrate: %w", err)
	}
	l.db = db
	return db, nil
}

// migrate applies every not-yet-applied migrations/*.sql in filename order,
// recording each in _migrations.
func migrate(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS _migrations (
	   name       TEXT PRIMARY KEY,
	   applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	 );`); err != nil {
		return err
	}
	applied := map[string]bool{}
	rows, err := db.Query(`SELECT name FROM _migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		applied[name] = true
	}
	rows.Close()

	names, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, path := range names {
		name := path[len("migrations/"):]
		if applied[name] {
			continue
		}
		sqlText, err := migrationFiles.ReadFile(path)
		if err != nil {
			return err
		}
		if _, err := db.Exec(string(sqlText)); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := db.Exec(`INSERT INTO _migrations (name) VALUES (?)`, name); err != nil {
			return err
		}
		log.Printf("[proxy] applied migration %s", name)
	}
	return nil
}

// probe proves the file is present and readable: /health/deep.
func (l *Ledger) probe() error {
	db, err := l.conn()
	if err != nil {
		return err
	}
	var ok int
	return db.QueryRow(`SELECT 1 AS ok`).Scan(&ok)
}

// uuidv7: 48-bit Unix ms timestamp, a 12-bit counter, then random bits. Sorts
// by time as a string, which is how the poller pages a machine (usage_id > ?).
// The counter keeps ids from this process strictly increasing even within one
// millisecond (RFC 9562 §6.2 method 1). Caller holds idMu.
func (l *Ledger) uuidv7(now int64) string {
	ms := now
	if ms <= l.lastMs {
		ms = l.lastMs
		l.seq++
		if l.seq > 0xfff {
			ms++
			l.seq = 0
		}
	} else {
		l.seq = 0
	}
	l.lastMs = ms

	var b [16]byte
	_, _ = rand.Read(b[:])
	ts := ms
	for i := 5; i >= 0; i-- {
		b[i] = byte(ts)
		ts >>= 8
	}
	b[6] = 0x70 | byte(l.seq>>8) // version 7 + counter high bits
	b[7] = byte(l.seq)
	b[8] = b[8]&0x3f | 0x80 // RFC 9562 variant
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// usageFloor is the lowest (ms, counter) any later usage_id from this process
// can have. Every row with a smaller usage_id is already in usage_log, since
// recordUsage makes the id and inserts the row under the same lock. /usage
// merges machines only up to the lowest floor, so a row that lands on one
// machine after another machine's newer rows were read is not skipped.
// Advances lastMs to now so a clock stepping back cannot go under the floor.
func (l *Ledger) usageFloor(now int64) (ms int64, seq int) {
	l.idMu.Lock()
	defer l.idMu.Unlock()
	if now > l.lastMs {
		l.lastMs = now
		l.seq = -1 // the next uuidv7 in this ms gets counter 0
		return now, 0
	}
	if l.seq < 0xfff {
		return l.lastMs, l.seq + 1
	}
	return l.lastMs + 1, 0
}

// UsageRecord is one completed upstream request. CostUsd is the catalog
// estimate (nil when the model has no catalog entry), not billed: the api
// prices the buckets at ingest (ADR 0003).
type UsageRecord struct {
	KeyID            string
	Name             string
	ParentKeyID      *string
	RootKeyID        *string
	Model            string
	ProviderSlug     string
	InputTokens      float64
	OutputTokens     float64
	CacheReadTokens  float64
	CacheWriteTokens float64
	ProviderCost     *float64
	CostUsd          *float64
}

func (l *Ledger) recordUsage(r UsageRecord) error {
	db, err := l.conn()
	if err != nil {
		return err
	}
	l.idMu.Lock()
	defer l.idMu.Unlock()
	_, err = db.Exec(`INSERT INTO usage_log
	     (usage_id, machine_id, key_id, jti, name, parent_key_id, root_key_id,
	      model, provider_slug, input_tokens, output_tokens,
	      cache_read_tokens, cache_write_tokens, provider_cost, cost_usd)
	   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		l.uuidv7(time.Now().UnixMilli()), l.machineID, r.KeyID, r.KeyID, r.Name,
		r.ParentKeyID, r.RootKeyID, r.Model, r.ProviderSlug,
		r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheWriteTokens,
		r.ProviderCost, r.CostUsd)
	return err
}
