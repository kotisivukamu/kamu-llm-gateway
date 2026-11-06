package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Key metadata from the gateway Postgres, behind an in-process cache (ADR
// 0001 §10.4 / §10.6 step 3).
//
// The proxy only READS Postgres: llm.keys rows to resolve the two credential
// shapes (top-level opaque keys by key_hash = sha256 hex of the secret,
// derived sub-keys by id = the JWT jti), and llm.model_prices for GET
// /catalog. Spend is charged by the api at ingest, which also flips a key to
// 'over_budget' (ADR 0003 §4); the proxy sees that only through this cache.
//
// The hot path reads from the cache; only a miss reaches the DB. The cache is
// the ONLY place revocation takes up to KEY_META_CACHE_TTL_SEC to propagate:
// a revoked, expired or missing row is cached as deny for the TTL (so a
// brute-force sweep of made-up hashes doesn't hit the DB on every try).

// KeyMeta is the subset of an llm.keys row needed to authorize and meter.
type KeyMeta struct {
	KeyID       string
	Label       string
	Models      []string
	Status      string
	KeyType     string // "top" | "derived"
	ParentKeyID *string
	RootKeyID   *string
	ExpiresAt   *time.Time
}

// newGatewayPool connects lazily (like postgres.js): a dev box without the DB
// still boots and serves /health. search_path makes unqualified names resolve
// to llm.* (then public), the gateway-wide convention.
func newGatewayPool(url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 3
	cfg.MaxConnIdleTime = 30 * time.Second
	cfg.ConnConfig.ConnectTimeout = 10 * time.Second
	cfg.ConnConfig.RuntimeParams["search_path"] = "llm,public"
	return pgxpool.NewWithConfig(context.Background(), cfg)
}

const keyMetaColumns = `SELECT id::text, label, models, status, key_type,
       parent_key_id::text, root_key_id::text, expires_at
  FROM llm.keys `

func scanKeyMeta(row pgx.Row) (*KeyMeta, error) {
	var k KeyMeta
	err := row.Scan(&k.KeyID, &k.Label, &k.Models, &k.Status, &k.KeyType,
		&k.ParentKeyID, &k.RootKeyID, &k.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &k, nil
}

type cacheEntry struct {
	meta *KeyMeta // nil = deny
	exp  time.Time
}

type KeyCache struct {
	pool *pgxpool.Pool
	ttl  time.Duration

	mu     sync.Mutex
	byHash map[string]cacheEntry // top-level keys, by sha256(secret) hex
	byID   map[string]cacheEntry // derived keys (jti) and roots, by row PK
}

func newKeyCache(pool *pgxpool.Pool, ttl time.Duration) *KeyCache {
	return &KeyCache{
		pool:   pool,
		ttl:    ttl,
		byHash: map[string]cacheEntry{},
		byID:   map[string]cacheEntry{},
	}
}

// toCached resolves a row into what the cache holds: nil (deny) unless the
// row exists, is 'active' or 'over_budget', and has not expired. An
// over_budget row is kept: it gets 402 rather than 401, and may still read
// its own usage.
func toCached(row *KeyMeta) *KeyMeta {
	if row == nil || (row.Status != "active" && row.Status != "over_budget") {
		return nil
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now()) {
		return nil
	}
	return row
}

func (c *KeyCache) lookup(ctx context.Context, m map[string]cacheEntry, key, where string) (*KeyMeta, error) {
	c.mu.Lock()
	e, ok := m[key]
	c.mu.Unlock()
	if ok && time.Now().Before(e.exp) {
		return e.meta, nil
	}
	row, err := scanKeyMeta(c.pool.QueryRow(ctx, keyMetaColumns+where+" LIMIT 1", key))
	if err != nil {
		return nil, err
	}
	meta := toCached(row)
	c.mu.Lock()
	// Expired entries are only replaced, never swept; a crude cap keeps a
	// long uptime (or a sweep of made-up keys) from growing it without bound.
	if len(m) > 10000 {
		clear(m)
	}
	m[key] = cacheEntry{meta: meta, exp: time.Now().Add(c.ttl)}
	c.mu.Unlock()
	return meta, nil
}

// byKeyHash looks up a top-level opaque key by sha256(secret) hex.
func (c *KeyCache) byKeyHash(ctx context.Context, hash string) (*KeyMeta, error) {
	return c.lookup(ctx, c.byHash, hash, "WHERE key_hash = $1")
}

// byKeyID looks up a key by row PK: a derived key's jti, or a root.
func (c *KeyCache) byKeyID(ctx context.Context, id string) (*KeyMeta, error) {
	return c.lookup(ctx, c.byID, id, "WHERE id = $1")
}
