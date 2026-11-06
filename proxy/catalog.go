package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
)

// The catalog of routable providers and models. The data is catalog.json,
// embedded at build time and also read by the Deno api/admin through
// shared/catalog.ts, so there is one copy. Its "note" fields carry the
// reasoning behind each provider and price.

//go:embed catalog.json
var catalogJSON []byte

// Provider is one upstream. AuthStyle says how the upstream key is sent:
// "x-api-key" (Anthropic native), "bearer" (OpenAI-compatible) or "both".
type Provider struct {
	Slug         string   `json:"-"`
	BaseURL      string   `json:"base_url"`
	AuthStyle    string   `json:"auth_style"`
	APIKeyEnvVar string   `json:"api_key_env_var"`
	AllowedPaths []string `json:"allowed_paths"`
	// Prefix removed from the caller's path before it is appended to BaseURL.
	StripPathPrefix string `json:"strip_path_prefix"`
	// Headers always set upstream (jev-images). A provider with these only
	// serves its own model slugs.
	UpstreamHeaders map[string]string `json:"upstream_headers"`

	allowed []*regexp.Regexp
}

func (p *Provider) pathAllowed(path string) bool {
	for _, re := range p.allowed {
		if re.MatchString(path) {
			return true
		}
	}
	return false
}

type LongContext struct {
	AbovePromptTokens float64 `json:"above_prompt_tokens"`
	Input             float64 `json:"input_cost_per_mtok_usd"`
	Output            float64 `json:"output_cost_per_mtok_usd"`
	CacheRead         float64 `json:"cache_read_cost_per_mtok_usd"`
	CacheWrite        float64 `json:"cache_write_cost_per_mtok_usd"`
}

// Model is keyed by the client-facing slug (the `model` clients send), which
// authz, metering and usage rows use. UpstreamModelSlug is only what goes on
// the wire (ADR 0002).
type Model struct {
	Slug              string   `json:"-"`
	ProviderSlug      string   `json:"provider_slug"`
	UpstreamModelSlug string   `json:"upstream_model_slug"`
	Input             float64  `json:"input_cost_per_mtok_usd"`
	Output            float64  `json:"output_cost_per_mtok_usd"`
	CacheRead         *float64 `json:"cache_read_cost_per_mtok_usd"`
	CacheWrite        *float64 `json:"cache_write_cost_per_mtok_usd"`
	PerRequest        *float64 `json:"per_request_cost_usd"`
	// Shallow merge into JSON request bodies, in file order.
	RequestOverrides json.RawMessage `json:"request_overrides"`
	LongContext      *LongContext    `json:"long_context"`

	overrides []member
}

// Catalog keeps the file order: the pi catalog lists providers and models in
// it.
type Catalog struct {
	Providers []*Provider
	Models    []*Model

	providerBySlug map[string]*Provider
	modelBySlug    map[string]*Model
}

var catalog = mustLoadCatalog(catalogJSON)

func mustLoadCatalog(data []byte) *Catalog {
	c, err := loadCatalog(data)
	if err != nil {
		panic(fmt.Sprintf("catalog.json: %v", err))
	}
	return c
}

func loadCatalog(data []byte) (*Catalog, error) {
	var top struct {
		Providers json.RawMessage `json:"providers"`
		Models    json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, err
	}
	c := &Catalog{providerBySlug: map[string]*Provider{}, modelBySlug: map[string]*Model{}}

	providers, err := objectMembers(top.Providers)
	if err != nil {
		return nil, fmt.Errorf("providers: %w", err)
	}
	for _, m := range providers {
		p := &Provider{}
		if err := json.Unmarshal(m.Value, p); err != nil {
			return nil, fmt.Errorf("provider %s: %w", m.Key, err)
		}
		p.Slug = m.Key
		for _, s := range p.AllowedPaths {
			re, err := regexp.Compile(s)
			if err != nil {
				return nil, fmt.Errorf("provider %s: %w", m.Key, err)
			}
			p.allowed = append(p.allowed, re)
		}
		c.Providers = append(c.Providers, p)
		c.providerBySlug[p.Slug] = p
	}

	models, err := objectMembers(top.Models)
	if err != nil {
		return nil, fmt.Errorf("models: %w", err)
	}
	for _, m := range models {
		e := &Model{}
		if err := json.Unmarshal(m.Value, e); err != nil {
			return nil, fmt.Errorf("model %s: %w", m.Key, err)
		}
		e.Slug = m.Key
		if c.providerBySlug[e.ProviderSlug] == nil {
			return nil, fmt.Errorf("model %s: unknown provider %q", m.Key, e.ProviderSlug)
		}
		if len(e.RequestOverrides) > 0 {
			if e.overrides, err = objectMembers(e.RequestOverrides); err != nil {
				return nil, fmt.Errorf("model %s request_overrides: %w", m.Key, err)
			}
		}
		c.Models = append(c.Models, e)
		c.modelBySlug[e.Slug] = e
	}
	return c, nil
}

func (c *Catalog) provider(slug string) *Provider { return c.providerBySlug[slug] }
func (c *Catalog) model(slug string) *Model       { return c.modelBySlug[slug] }

// mergeRequestBody rewrites a JSON object body for upstream: the model's
// request_overrides, then `model` set to the upstream slug LAST, so it wins
// over both the client's `model` and any stray `model` in the overrides (ADR
// 0002). clientModel stays the authority for authz, cost and metering; only
// the bytes on the wire change. Returns changed=false when nothing needs
// rewriting, and the caller forwards the original bytes. Key order is kept:
// an existing key keeps its place, a new one goes last, as a JS spread does.
func (c *Catalog) mergeRequestBody(clientModel string, original []member) ([]byte, bool) {
	entry := c.model(clientModel)
	upstreamModel := clientModel
	var overrides []member
	if entry != nil {
		overrides = entry.overrides
		if entry.UpstreamModelSlug != "" {
			upstreamModel = entry.UpstreamModelSlug
		}
	}
	if upstreamModel == clientModel && len(overrides) == 0 {
		return nil, false
	}
	merged := append([]member(nil), original...)
	for _, o := range overrides {
		merged = setMember(merged, o.Key, o.Value)
	}
	slug, _ := json.Marshal(upstreamModel)
	merged = setMember(merged, "model", slug)
	return encodeMembers(merged), true
}

// member is one key of a JSON object, value kept as raw JSON.
type member struct {
	Key   string
	Value json.RawMessage
}

// objectMembers parses a JSON object into its members in order. A repeated
// key keeps its first position and its last value, as JSON.parse does.
func objectMembers(data []byte) ([]member, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("not a JSON object")
	}
	var out []member
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key := tok.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out = setMember(out, key, v)
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing data after JSON object")
	}
	return out, nil
}

func setMember(ms []member, key string, v json.RawMessage) []member {
	for i := range ms {
		if ms[i].Key == key {
			ms[i].Value = v
			return ms
		}
	}
	return append(ms, member{key, v})
}

func encodeMembers(ms []member) []byte {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range ms {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(m.Key)
		b.Write(k)
		b.WriteByte(':')
		_ = json.Compact(&b, m.Value)
	}
	b.WriteByte('}')
	return b.Bytes()
}
