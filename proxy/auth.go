package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Credential verification for the two DB-backed shapes (ADR 0001 §3 / §10.6).
//
// The proxy holds TWO verification capabilities and ZERO minting ones (ADR
// 0001 §10.4a): the Ed25519 PUBLIC key (verifies sub-key JWTs, can never
// mint) and the key-meta cache (looks up top-level opaque keys, can never
// forge).
//
// The token comes in `x-api-key` (Anthropic SDK) or `Authorization: Bearer`
// (OpenAI SDK); either works.

// Credential is a verified key the request carries forward.
type Credential struct {
	// The gateway row PK; usage rows are keyed by it (jti is an alias).
	KeyID string
	// Label set at mint time; shows in logs and usage rows.
	Name string
	// Allowed catalog model slugs; "*" grants any, empty grants none. The
	// row is the authority, also for sub-keys.
	Models []string
	// The key, or the root it derives from, is 'over_budget' (ADR 0003 §4):
	// LLM calls get 402, reading its own usage is still allowed.
	OverBudget bool
	KeyType    string // "top" | "derived"
	// Lineage (ADR 0001 §7.6): a top-level key has parent nil, root = self.
	ParentKeyID *string
	RootKeyID   *string
}

func (c *Credential) modelAllowed(slug string) bool {
	return slices.Contains(c.Models, "*") || slices.Contains(c.Models, slug)
}

var bearerPrefix = regexp.MustCompile(`(?i)^Bearer\s+`)

func extractCredential(h http.Header) string {
	if k := h.Get("x-api-key"); k != "" {
		return k
	}
	return bearerPrefix.ReplaceAllString(h.Get("authorization"), "")
}

// sha256 hex of the secret: the keys.key_hash the api stores.
func hashKey(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

const topPrefix = "sk_live_"

var jwtSegment = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// looksLikeJWT: exactly three non-empty base64url segments. The authority is
// the signature check that follows.
func looksLikeJWT(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if !jwtSegment.MatchString(p) {
			return false
		}
	}
	return true
}

type Auth struct {
	pub  ed25519.PublicKey
	keys *KeyCache
}

// usable: a cached row that is not deny and not expired. The cache denies
// revoked, expired and missing rows when it stores them; expiry is checked
// again because a cached row can expire within the TTL.
func usable(k *KeyMeta) bool {
	return k != nil && (k.ExpiresAt == nil || k.ExpiresAt.After(time.Now()))
}

// toCredential: a usable row ('active' or 'over_budget'). A derived key also
// needs its root: an over-budget root stops the whole subtree (402), a root
// that is revoked or gone denies (401). Ingest flips only the key it charged
// and that key's root, never the root's other children, so this check is what
// makes a root's budget cover them. The root row comes from the same cache.
func (a *Auth) toCredential(ctx context.Context, k *KeyMeta) (*Credential, error) {
	if !usable(k) {
		return nil, nil
	}
	over := k.Status == "over_budget"
	if k.RootKeyID != nil && *k.RootKeyID != k.KeyID {
		root, err := a.keys.byKeyID(ctx, *k.RootKeyID)
		if err != nil {
			return nil, err
		}
		if !usable(root) {
			return nil, nil
		}
		over = over || root.Status == "over_budget"
	}
	return &Credential{
		KeyID:       k.KeyID,
		Name:        k.Label,
		Models:      k.Models,
		OverBudget:  over,
		KeyType:     k.KeyType,
		ParentKeyID: k.ParentKeyID,
		RootKeyID:   k.RootKeyID,
	}, nil
}

// verify is the hot-path entry (ADR 0001 §10.6): detect the format, verify
// (hash lookup / Ed25519 signature), then the row from the cache (DB on a
// miss). nil credential = 401; an error is a DB failure.
func (a *Auth) verify(ctx context.Context, presented string) (*Credential, error) {
	if presented == "" {
		return nil, nil
	}
	if strings.HasPrefix(presented, topPrefix) {
		k, err := a.keys.byKeyHash(ctx, hashKey(presented))
		if err != nil {
			return nil, err
		}
		return a.toCredential(ctx, k)
	}
	if looksLikeJWT(presented) {
		jti := a.verifyJWT(presented, time.Now())
		if jti == "" {
			return nil, nil
		}
		// The row is the authority on lifecycle, lineage and budget.
		k, err := a.keys.byKeyID(ctx, jti)
		if err != nil {
			return nil, err
		}
		return a.toCredential(ctx, k)
	}
	return nil, nil
}

// verifyJWT checks a compact EdDSA JWT against the public key and returns its
// jti, or "" when it does not verify. The same checks jose's jwtVerify did:
// alg EdDSA, the signature, exp (must be in the future) and nbf when present.
// The kid header is not checked (single key until a rotation needs it).
func (a *Auth) verifyJWT(token string, now time.Time) string {
	parts := strings.Split(token, ".")
	var header struct {
		Alg string `json:"alg"`
	}
	if !decodeSegment(parts[0], &header) || header.Alg != "EdDSA" {
		return ""
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(a.pub, []byte(parts[0]+"."+parts[1]), sig) {
		return ""
	}
	var claims map[string]any
	if !decodeSegment(parts[1], &claims) || claims == nil {
		return ""
	}
	secs := float64(now.Unix())
	if v, ok := claims["exp"]; ok {
		exp, isNum := v.(float64)
		if !isNum || exp <= secs {
			return ""
		}
	}
	if v, ok := claims["nbf"]; ok {
		nbf, isNum := v.(float64)
		if !isNum || nbf > secs {
			return ""
		}
	}
	if v, ok := claims["iat"]; ok {
		if _, isNum := v.(float64); !isNum {
			return ""
		}
	}
	jti, _ := claims["jti"].(string)
	return jti
}

func decodeSegment(seg string, v any) bool {
	b, err := base64.RawURLEncoding.DecodeString(seg)
	return err == nil && json.Unmarshal(b, v) == nil
}
