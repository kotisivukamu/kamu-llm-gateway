package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
)

// GET /catalog: read-only view of the catalog with the prices ingest bills
// with.
//
// Exists so kotisivukamu does not keep a hand-maintained second copy of our
// upstream prices (its llm_models table prices every studio session; the two
// copies once drifted silently, 28% too high on kimi-k2.7-code).
//
// Deliberately READ ONLY: the catalog stays a reviewed file that ships with a
// release. Never exposes credentials, nor the names of the env vars holding
// them (a hint about how to attack the machine), nor allowed_paths. Providers
// are reduced to their slugs.
//
// Auth: a gateway credential like the proxy path. The catalog is not secret
// exactly, but our per-model cost basis is commercially sensitive.
//
// PRICES are the newest llm.model_prices row in effect (the daily provider
// price sync appends there), else the catalog price. Serving the file prices
// alone left kotisivukamu syncing a week-old glm-5.3 rate after cortecs cut
// prices on 2026-10-20. long_context stays the catalog's; model_prices
// carries base rates only.

// dbRates is one model_prices row.
type dbRates struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
	PerRequest float64
}

type catalogModelView struct {
	Slug         string       `json:"slug"`
	ProviderSlug string       `json:"provider_slug"`
	Input        float64      `json:"input_cost_per_mtok_usd"`
	Output       float64      `json:"output_cost_per_mtok_usd"`
	CacheRead    *float64     `json:"cache_read_cost_per_mtok_usd"`
	CacheWrite   *float64     `json:"cache_write_cost_per_mtok_usd"`
	PerRequest   *float64     `json:"per_request_cost_usd"`
	LongContext  *LongContext `json:"long_context"`
}

type providerSlugView struct {
	Slug string `json:"slug"`
}

type catalogViewBody struct {
	Providers []providerSlugView `json:"providers"`
	Models    []catalogModelView `json:"models"`
}

// buildCatalogView lays each model's DB price, when it has one, over the
// catalog price. Both lists sorted by slug (byte order; it equals the JS
// localeCompare order the Deno version used for every slug in the file).
func buildCatalogView(c *Catalog, prices map[string]dbRates) catalogViewBody {
	body := catalogViewBody{Providers: []providerSlugView{}, Models: []catalogModelView{}}
	for _, p := range c.Providers {
		body.Providers = append(body.Providers, providerSlugView{p.Slug})
	}
	sort.Slice(body.Providers, func(i, j int) bool { return body.Providers[i].Slug < body.Providers[j].Slug })
	for _, m := range c.Models {
		v := catalogModelView{
			Slug:         m.Slug,
			ProviderSlug: m.ProviderSlug,
			Input:        m.Input,
			Output:       m.Output,
			CacheRead:    m.CacheRead,
			CacheWrite:   m.CacheWrite,
			PerRequest:   m.PerRequest,
			LongContext:  m.LongContext,
		}
		if db, ok := prices[m.Slug]; ok {
			v.Input, v.Output = db.Input, db.Output
			v.CacheRead, v.CacheWrite, v.PerRequest = &db.CacheRead, &db.CacheWrite, &db.PerRequest
		}
		body.Models = append(body.Models, v)
	}
	sort.Slice(body.Models, func(i, j int) bool { return body.Models[i].Slug < body.Models[j].Slug })
	return body
}

// currentDBPrices is the model_prices row in effect now, per model. A DB
// error fails the request rather than falling back to the catalog: a caller
// syncing prices from here would otherwise write stale prices unknowingly.
func (a *app) currentDBPrices(ctx context.Context) (map[string]dbRates, error) {
	rows, err := a.pool.Query(ctx, `
	  SELECT DISTINCT ON (model) model,
	         input_cost_per_mtok_usd::float8,
	         output_cost_per_mtok_usd::float8,
	         cache_read_cost_per_mtok_usd::float8,
	         cache_write_cost_per_mtok_usd::float8,
	         per_request_cost_usd::float8
	    FROM model_prices
	   WHERE valid_from <= now()
	   ORDER BY model, valid_from DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]dbRates{}
	for rows.Next() {
		var model string
		var r dbRates
		if err := rows.Scan(&model, &r.Input, &r.Output, &r.CacheRead, &r.CacheWrite, &r.PerRequest); err != nil {
			return nil, err
		}
		out[model] = r
	}
	return out, rows.Err()
}

func (a *app) catalogView(w http.ResponseWriter, r *http.Request) error {
	cred, err := a.auth.verify(r.Context(), extractCredential(r.Header))
	if err != nil {
		return err
	}
	if cred == nil {
		writeJSON(w, 401, obj("error", "Unauthorized"))
		return nil
	}
	prices, err := a.currentDBPrices(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, 200, buildCatalogView(catalog, prices))
	return nil
}

var shellEnvName = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

// GET /llm/catalog: the catalog in pi's models.json shape, so a pi extension
// discovers providers at load and always matches what prod can route.
//
// baseUrl comes from the request: the scheme from x-forwarded-proto (Fly
// terminates TLS, so the request we see is plain http, and an http:// baseUrl
// gets a force_https 301 whose retry drops x-api-key: a 401 that looks like a
// bad token). Only the scheme is taken from the edge. The host stays as the
// caller asked for it: baseUrl is where pi sends $LLM_PROXY_TOKEN, so
// honouring x-forwarded-host would let anyone reaching this service directly
// (Flycast/6PN) point the catalog at a host of their choosing and collect the
// token. The /v1 suffix rule is pi's: anthropic-messages appends /v1/messages
// itself, openai-completions appends /chat/completions and needs it.
//
// apiKey is a shell-style env var reference, never a token: pi interpolates it
// from the child process env. The var name is a query param because it is
// the caller's convention.
func (a *app) piCatalog(w http.ResponseWriter, r *http.Request) error {
	cred, err := a.auth.verify(r.Context(), extractCredential(r.Header))
	if err != nil {
		return err
	}
	if cred == nil {
		writeJSON(w, 401, obj("error", "Unauthorized"))
		return nil
	}
	apiKeyEnv := "LLM_PROXY_TOKEN"
	if v, ok := r.URL.Query()["api_key_env"]; ok {
		apiKeyEnv = v[0]
	}
	if !shellEnvName.MatchString(apiKeyEnv) {
		writeJSON(w, 400, obj("error", "api_key_env must be a shell env var name"))
		return nil
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
		if r.TLS != nil {
			proto = "https"
		}
	}
	writeJSON(w, 200, obj("providers", piProviders(catalog, proto+"://"+r.Host, apiKeyEnv)))
	return nil
}

type piCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type piModel struct {
	ID   string `json:"id"`
	Cost piCost `json:"cost"`
}

type piProvider struct {
	BaseURL string    `json:"baseUrl"`
	API     string    `json:"api"`
	APIKey  string    `json:"apiKey"`
	Models  []piModel `json:"models"`
}

// piProviders lists the chat providers (Jev's classifier endpoint speaks
// neither protocol) with their models, in catalog order.
func piProviders(c *Catalog, origin, apiKeyEnv string) orderedJSON {
	var out orderedJSON
	for _, p := range c.Providers {
		if !p.pathAllowed("/v1/messages") && !p.pathAllowed("/v1/chat/completions") {
			continue
		}
		// Native Anthropic is the only non-OpenAI wire protocol we speak.
		api, baseURL := "openai-completions", origin+"/llm/"+p.Slug+"/v1"
		if p.AuthStyle == "x-api-key" {
			api, baseURL = "anthropic-messages", origin+"/llm/"+p.Slug
		}
		var models []piModel
		for _, m := range c.Models {
			if m.ProviderSlug != p.Slug {
				continue
			}
			cost := piCost{Input: m.Input, Output: m.Output}
			if m.CacheRead != nil {
				cost.CacheRead = *m.CacheRead
			}
			if m.CacheWrite != nil {
				cost.CacheWrite = *m.CacheWrite
			}
			models = append(models, piModel{ID: m.Slug, Cost: cost})
		}
		if len(models) == 0 {
			continue
		}
		out = append(out, orderedField{p.Slug, piProvider{
			BaseURL: baseURL, API: api, APIKey: "$" + apiKeyEnv, Models: models,
		}})
	}
	return out
}

// obj builds an orderedJSON from key, value pairs: the error bodies keep the
// key order Hono wrote them in.
func obj(kv ...any) orderedJSON {
	var o orderedJSON
	for i := 0; i < len(kv); i += 2 {
		o = append(o, orderedField{kv[i].(string), kv[i+1]})
	}
	return o
}

// orderedJSON is a JSON object that keeps its key order.
type orderedJSON []orderedField

type orderedField struct {
	Key   string
	Value any
}

func (o orderedJSON) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, f := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(f.Key)
		b.Write(k)
		b.WriteByte(':')
		v, err := json.Marshal(f.Value)
		if err != nil {
			return nil, err
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
