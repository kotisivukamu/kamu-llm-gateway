package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the process environment, read once at boot. Fail fast: a missing
// or malformed value stops the process instead of accepting unverified keys.
// Upstream provider keys are NOT here: they are read per request
// (os.Getenv(provider.APIKeyEnvVar)), so a dev box without them still boots,
// and a provider whose key is unset answers 502 provider_key_missing.
type Config struct {
	Port    string
	Version string
	// SQLite usage ledger (the per-machine buffer the api's poller drains).
	DBPath string
	// Gateway Postgres, read only: key metadata and model_prices. As
	// admin_role (BYPASSRLS): the lookup has no user context.
	GatewayDatabaseURL string
	// Ed25519 PUBLIC key (base64 of the raw 32 bytes) that verifies derived
	// sub-key JWTs; the same key the api signs with. Verify only, never mint.
	PublicKey ed25519.PublicKey
	// The kid the api puts in sub-key JWTs. Not checked yet (single key);
	// kept so a rotation can accept a previous kid during a grace window.
	KeyID string
	// How long a key-metadata row is cached: the window in which a
	// revocation or over_budget flip reaches the proxy.
	KeyMetaTTL time.Duration
	// Service secret of the control-plane poller on /usage and siblings on
	// /usage/local.
	PollToken string
	// Fly machine and app (6PN sibling discovery); "local" / "" outside Fly.
	MachineID string
	AppName   string
}

func loadConfig() (Config, error) {
	c := Config{
		Port:               envOr("PORT", "8301"),
		Version:            envOr("VERSION", "dev"),
		DBPath:             envOr("DB_PATH", "llm-proxy.db"),
		GatewayDatabaseURL: os.Getenv("GATEWAY_DATABASE_URL"),
		KeyID:              envOr("ED25519_KEY_ID", "dev-ed25519-1"),
		PollToken:          os.Getenv("CONTROL_PLANE_POLL_TOKEN"),
		MachineID:          envOr("FLY_MACHINE_ID", "local"),
		AppName:            os.Getenv("FLY_APP_NAME"),
	}
	if _, err := strconv.Atoi(c.Port); err != nil {
		return c, fmt.Errorf("PORT must be a number, got %q", c.Port)
	}
	if c.GatewayDatabaseURL == "" {
		return c, fmt.Errorf("GATEWAY_DATABASE_URL is required")
	}
	if c.PollToken == "" {
		return c, fmt.Errorf("CONTROL_PLANE_POLL_TOKEN is required")
	}
	pub, err := base64.StdEncoding.DecodeString(os.Getenv("ED25519_PUBLIC_KEY"))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return c, fmt.Errorf("ED25519_PUBLIC_KEY must be base64 of the raw 32-byte public key")
	}
	c.PublicKey = pub
	ttl, err := strconv.Atoi(envOr("KEY_META_CACHE_TTL_SEC", "10"))
	if err != nil || ttl <= 0 {
		return c, fmt.Errorf("KEY_META_CACHE_TTL_SEC must be a positive integer")
	}
	c.KeyMetaTTL = time.Duration(ttl) * time.Second
	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
