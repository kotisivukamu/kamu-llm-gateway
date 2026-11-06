package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// mergeRequestBody (ADR 0002): the proxy rewrites `model` upstream-only when a
// provider namespaces/renames a model; the client slug stays the authority
// for authz/cost/metering. The upstream `model` must win over both the
// client's `model` and any stray `model` in request_overrides.

func members(t *testing.T, s string) []member {
	t.Helper()
	m, err := objectMembers([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// withModel swaps a catalog entry for one test.
func withModel(t *testing.T, slug string, edit func(m *Model)) {
	t.Helper()
	saved := catalog.modelBySlug[slug]
	m := *saved
	edit(&m)
	catalog.modelBySlug[slug] = &m
	t.Cleanup(func() { catalog.modelBySlug[slug] = saved })
}

func TestMergeNoRewriteWithoutUpstreamSlugOrOverrides(t *testing.T) {
	// claude-opus-4-8 has neither upstream_model_slug nor request_overrides.
	if _, changed := catalog.mergeRequestBody("claude-opus-4-8", members(t, `{"model":"claude-opus-4-8","messages":[],"max_tokens":10}`)); changed {
		t.Fatal("rewrote a body that needs no rewrite")
	}
}

func TestMergeUpstreamSlugRewritesModel(t *testing.T) {
	// glm-5.3 routes through cortecs with the bare slug; simulate a
	// tensorx-native entry the way a catalog edit would.
	withModel(t, "glm-5.3", func(m *Model) { m.UpstreamModelSlug = "z-ai/glm-5.3" })
	out, changed := catalog.mergeRequestBody("glm-5.3", members(t, `{"model":"glm-5.3","messages":[ {"a":1} ]}`))
	mustEqual(t, changed, true, "changed")
	mustEqual(t, string(out), `{"model":"z-ai/glm-5.3","messages":[{"a":1}]}`, "body")
}

func TestMergeModelWinsOverClientAndOverrides(t *testing.T) {
	withModel(t, "glm-5.3", func(m *Model) {
		m.UpstreamModelSlug = "z-ai/glm-5.3"
		m.overrides = members(t, `{"model":"WRONG-from-override","temperature":0.2}`)
	})
	out, _ := catalog.mergeRequestBody("glm-5.3", members(t, `{"model":"WRONG-from-client","messages":[]}`))
	mustEqual(t, string(out), `{"model":"z-ai/glm-5.3","messages":[],"temperature":0.2}`, "body")
}

func TestMergeUnknownModelPassesThrough(t *testing.T) {
	// A model the catalog doesn't know 403s at authz before this runs, but
	// the merge must not fail on it.
	if _, changed := catalog.mergeRequestBody("z-ai/unknown-model", members(t, `{"model":"z-ai/unknown-model"}`)); changed {
		t.Fatal("rewrote an unknown model")
	}
}

func TestObjectMembersKeepsOrderLikeJSONParse(t *testing.T) {
	ms := members(t, ` {"b":1,"a":{"x":[1,2]},"b":3} `)
	mustEqual(t, string(encodeMembers(ms)), `{"b":3,"a":{"x":[1,2]}}`, "order and last value")
	for _, bad := range []string{`[1]`, `"s"`, `null`, `{"a":1} x`, `{"a":`} {
		if _, err := objectMembers([]byte(bad)); err == nil {
			t.Fatalf("%s parsed as an object", bad)
		}
	}
}

func TestEveryVariantSetsUpstreamSlug(t *testing.T) {
	// Without it the proxy forwards `slug@provider` verbatim and the provider
	// 404s (seen on prod for the @cortecs variants, 2026-09-23).
	for _, m := range catalog.Models {
		base, provider, ok := strings.Cut(m.Slug, "@")
		if !ok {
			continue
		}
		if m.UpstreamModelSlug == "" || strings.Contains(m.UpstreamModelSlug, "@") {
			t.Fatalf("%s forwards %q upstream", m.Slug, m.UpstreamModelSlug)
		}
		mustEqual(t, provider, m.ProviderSlug, m.Slug+" pinned provider")
		_ = base
	}
}

// The one catalog file is what the Deno side reads too: the shape both
// expect.
func TestCatalogFileShape(t *testing.T) {
	mustEqual(t, len(catalog.Providers), 9, "providers")
	mustEqual(t, len(catalog.Models), 57, "models")
	mustEqual(t, catalog.Providers[0].Slug, "anthropic", "file order kept")
	mustEqual(t, catalog.Models[0].Slug, "claude-opus-5-5", "file order kept")
	g := catalog.provider("google")
	mustEqual(t, g.StripPathPrefix, "/v1", "google prefix")
	mustEqual(t, g.pathAllowed("/v1/chat/completions"), true, "google path")
	mustEqual(t, g.pathAllowed("/v1/chat/completions/x"), false, "anchored")
	mustEqual(t, catalog.provider("jev-images").UpstreamHeaders["TypeSafe-Danger-Zone-Images"], "true", "jev-images header")
	h := catalog.model("claude-haiku-5-5").LongContext
	mustEqual(t, h.AbovePromptTokens, 100_000, "haiku tier")
	if _, err := loadCatalog([]byte(`{"providers":{},"models":{"x":{"provider_slug":"nope"}}}`)); err == nil {
		t.Fatal("a model on an unknown provider loaded")
	}
}

// GET /catalog serves the price ingest bills with: a model with a
// model_prices row takes the DB rates, one without keeps the catalog price.
func TestCatalogViewDBPriceOverridesCatalog(t *testing.T) {
	view := buildCatalogView(catalog, map[string]dbRates{
		"glm-5.3": {Input: 0.530329, Output: 2.121314, CacheRead: 0.159445, CacheWrite: 0.530329},
	})
	var glm, haiku catalogModelView
	for _, m := range view.Models {
		switch m.Slug {
		case "glm-5.3":
			glm = m
		case "claude-haiku-5-5":
			haiku = m
		}
	}
	mustEqual(t, glm.Input, 0.530329, "input")
	mustEqual(t, glm.Output, 2.121314, "output")
	mustEqual(t, *glm.CacheRead, 0.159445, "cache read")
	mustEqual(t, *glm.CacheWrite, 0.530329, "cache write")
	mustEqual(t, *glm.PerRequest, 0.0, "per request")
	mustEqual(t, glm.ProviderSlug, "cortecs", "provider")
	mustEqual(t, haiku.Input, catalog.model("claude-haiku-5-5").Input, "catalog price kept")
	mustEqual(t, haiku.LongContext != nil, true, "long_context kept")
	mustEqual(t, len(view.Models), len(catalog.Models), "every model")
	for i := 1; i < len(view.Models); i++ {
		if view.Models[i-1].Slug >= view.Models[i].Slug {
			t.Fatal("models not sorted")
		}
	}
}

func TestCatalogRoute(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"glm-5.3"}, topOpts{})
	base := serve(t, a)
	res, out := doJSON(t, "GET", base+"/catalog", nil, nil)
	mustEqual(t, res.StatusCode, 401, "no credential")
	mustEqual(t, out["error"], any("Unauthorized"), "error")

	// A model_prices row in effect is served instead of the file price.
	var id string
	err := ownerPool.QueryRow(context.Background(), `
		INSERT INTO llm.model_prices
		  (model, input_cost_per_mtok_usd, output_cost_per_mtok_usd,
		   cache_read_cost_per_mtok_usd, cache_write_cost_per_mtok_usd,
		   per_request_cost_usd, valid_from, source, created_by)
		VALUES ('gpt-5.6-luna', 0.123456, 1, 0.01, 0.2, 0, now() - interval '1 second', 'go-test', 'go-test')
		RETURNING id::text`).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = ownerPool.Exec(context.Background(), `DELETE FROM llm.model_prices WHERE id = $1`, id)
	})

	req, _ := http.NewRequest("GET", base+"/catalog", nil)
	req.Header.Set("x-api-key", key.secret)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	mustEqual(t, res.StatusCode, 200, "status")
	var body struct {
		Providers []map[string]any `json:"providers"`
		Models    []map[string]any `json:"models"`
	}
	raw, _ := io.ReadAll(res.Body)
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	mustEqual(t, len(body.Providers), 9, "providers")
	mustEqual(t, len(body.Providers[0]), 1, "providers are slugs only")
	for _, m := range body.Models {
		if m["slug"] == "gpt-5.6-luna" {
			mustEqual(t, m["input_cost_per_mtok_usd"], any(0.123456), "DB price")
		}
	}
	if strings.Contains(string(raw), "API_KEY") || strings.Contains(string(raw), "allowed_paths") {
		t.Fatal("catalog leaks env var names or paths")
	}
}

func TestPiCatalog(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"glm-5.3"}, topOpts{})
	base := serve(t, a)
	res, _ := doJSON(t, "GET", base+"/llm/catalog", nil, nil)
	mustEqual(t, res.StatusCode, 401, "no credential")

	res, out := doJSON(t, "GET", base+"/llm/catalog?api_key_env=bad-name", bearerHeader(key.secret), nil)
	mustEqual(t, res.StatusCode, 400, "bad env name")
	mustEqual(t, out["error"], any("api_key_env must be a shell env var name"), "error")
	res, _ = doJSON(t, "GET", base+"/llm/catalog?api_key_env=", bearerHeader(key.secret), nil)
	mustEqual(t, res.StatusCode, 400, "empty env name")

	req, _ := http.NewRequest("GET", base+"/llm/catalog?api_key_env=KAMU_TOKEN", nil)
	req.Header.Set("Authorization", "Bearer "+key.secret)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	// Provider order is the file's.
	if i, j := strings.Index(string(raw), `"anthropic"`), strings.Index(string(raw), `"openai"`); i < 0 || j < i {
		t.Fatalf("provider order: %s", raw[:200])
	}
	var body struct {
		Providers map[string]struct {
			BaseURL string `json:"baseUrl"`
			API     string `json:"api"`
			APIKey  string `json:"apiKey"`
			Models  []struct {
				ID   string             `json:"id"`
				Cost map[string]float64 `json:"cost"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	host := strings.TrimPrefix(base, "http://")
	ant := body.Providers["anthropic"]
	mustEqual(t, ant.BaseURL, "https://"+host+"/llm/anthropic", "anthropic baseUrl")
	mustEqual(t, ant.API, "anthropic-messages", "anthropic api")
	mustEqual(t, ant.APIKey, "$KAMU_TOKEN", "apiKey")
	cx := body.Providers["cortecs"]
	mustEqual(t, cx.BaseURL, "https://"+host+"/llm/cortecs/v1", "cortecs baseUrl")
	mustEqual(t, cx.API, "openai-completions", "cortecs api")
	mustEqual(t, cx.Models[0].ID, "kimi-k3", "cortecs first model in file order")
	mustEqual(t, cx.Models[0].Cost["cacheRead"], 0.3, "cacheRead")
	_, jev := body.Providers["jev"]
	_, jevImages := body.Providers["jev-images"]
	mustEqual(t, jev || jevImages, false, "jev not in the pi catalog")
	mustEqual(t, len(body.Providers), 7, "chat providers")
}
