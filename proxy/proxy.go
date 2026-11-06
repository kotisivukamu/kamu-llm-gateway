package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"strings"
	"time"
)

// Upper bound for a buffered multipart body: Jev's 32 MiB request limit
// (images as file parts), which also covers OpenAI's 25 MB transcription
// uploads plus their envelope. JSON bodies are not capped here.
const maxMultipartBytes = 32 * 1024 * 1024

// Headers forwarded upstream. Drops hop-by-hop, cookies and anything
// caller-identifying; the allowlist is what the Anthropic and OpenAI SDKs
// send. accept-encoding is deliberately absent (see newApp).
var forwardHeaders = []string{
	"content-type",
	"accept",
	"anthropic-version",
	"anthropic-beta",
	"openai-beta",
	"openai-organization",
	"openai-project",
	"x-stainless-arch",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
	"user-agent",
}

// Response headers not copied back: hop-by-hop ones are the server's own
// business, and content-length/-encoding describe a body the client does not
// get byte for byte.
var dropResponseHeaders = map[string]bool{
	"Content-Encoding":  true,
	"Content-Length":    true,
	"Connection":        true,
	"Keep-Alive":        true,
	"Transfer-Encoding": true,
	"Upgrade":           true,
	"Trailer":           true,
	"Te":                true,
}

// proxy serves /llm/<provider>/<upstream path>.
func (a *app) proxy(w http.ResponseWriter, r *http.Request) error {
	startedAt := time.Now()
	rest := strings.TrimPrefix(r.URL.EscapedPath(), "/llm/")
	providerSlug, _, _ := strings.Cut(rest, "/")
	provider := catalog.provider(providerSlug)
	if provider == nil {
		writeJSON(w, 404, obj("error", "provider_unknown", "provider", providerSlug))
		return nil
	}

	cred, err := a.auth.verify(r.Context(), extractCredential(r.Header))
	if err != nil {
		return err
	}
	if cred == nil {
		writeJSON(w, 401, obj("error", "unauthorized"))
		return nil
	}

	// Budgets are enforced by status (ADR 0003 §4): the api charges spend when
	// it ingests usage and flips a key that reached its budget, or whose root
	// did, to 'over_budget'. No per-request spend read, so a key can overrun by
	// what lands within the poll interval + cache TTL: runaway protection.
	if cred.OverBudget {
		writeJSON(w, 402, obj("error", "budget_exceeded"))
		return nil
	}

	upstreamPath := strings.TrimPrefix(rest, providerSlug)
	if upstreamPath == "" {
		upstreamPath = "/"
	}
	if !provider.pathAllowed(upstreamPath) {
		log.Printf("[proxy] path rejected provider=%s path=%s", providerSlug, upstreamPath)
		writeJSON(w, 403, obj(
			"error", "path_not_allowed", "provider", providerSlug, "path", upstreamPath,
		))
		return nil
	}

	// Read the body before touching the upstream key, so model authorization
	// (a property of the key) answers 403 even on a deploy that lacks the
	// provider key (a property of the deployment, 502).
	b, done, err := a.readBody(w, r, cred)
	if err != nil || done {
		return err
	}

	// A provider with fixed upstream headers (jev-images) only serves its own
	// model slugs: a base slug sent here would get the variant behaviour while
	// its usage row reads as the base model.
	if provider.UpstreamHeaders != nil {
		if m := catalog.model(b.model); m == nil || m.ProviderSlug != providerSlug {
			got := b.model
			if got == "" {
				got = "none"
			}
			writeJSON(w, 400, obj(
				"error", "model_not_on_provider",
				"detail", fmt.Sprintf("provider %s only serves its own models, got %s", providerSlug, got),
			))
			return nil
		}
	}

	// The catalog names the env var holding the upstream secret (Doppler ->
	// Fly secrets -> process env); the key itself never sits in the DB.
	upstreamKey := strings.TrimSpace(os.Getenv(provider.APIKeyEnvVar))
	if upstreamKey == "" {
		log.Printf("[proxy] env var %s is empty for provider=%s", provider.APIKeyEnvVar, providerSlug)
		writeJSON(w, 502, obj("error", "provider_key_missing"))
		return nil
	}

	forwardedPath := upstreamPath
	if p := provider.StripPathPrefix; p != "" && strings.HasPrefix(upstreamPath, p+"/") {
		forwardedPath = upstreamPath[len(p):]
	}
	upstreamURL := strings.TrimSuffix(provider.BaseURL, "/") + forwardedPath
	if r.URL.RawQuery != "" {
		upstreamURL += "?" + r.URL.RawQuery
	}

	// The request context: a client that disconnects aborts the upstream call
	// and with it the spend.
	req, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, b.body)
	if err != nil {
		return err
	}
	req.ContentLength = b.length
	for _, h := range forwardHeaders {
		if v, ok := r.Header[http.CanonicalHeaderKey(h)]; ok {
			req.Header[http.CanonicalHeaderKey(h)] = v
		}
	}
	if b.contentType != "" {
		req.Header.Set("Content-Type", b.contentType)
	}
	if provider.AuthStyle == "x-api-key" || provider.AuthStyle == "both" {
		req.Header.Set("x-api-key", upstreamKey)
	}
	if provider.AuthStyle == "bearer" || provider.AuthStyle == "both" {
		req.Header.Set("Authorization", "Bearer "+upstreamKey)
	}
	for k, v := range provider.UpstreamHeaders {
		req.Header.Set(k, v)
	}

	resp, err := a.upstream.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		if dropResponseHeaders[k] || strings.HasPrefix(strings.ToLower(k), "access-control-") {
			continue
		}
		w.Header()[k] = vs
	}
	model := b.model
	if model == "" {
		model = "-"
	}
	log.Printf("[proxy] %s %s%s key=%q model=%s status=%d latency=%dms",
		r.Method, providerSlug, upstreamPath, cred.Name, model, resp.StatusCode,
		time.Since(startedAt).Milliseconds())

	w.WriteHeader(resp.StatusCode)
	rc := http.NewResponseController(w)
	_ = rc.Flush() // headers go out now, before the first body chunk

	// Error and bodyless responses (HEAD, 204, 205, 304) carry no billable
	// usage: pass straight through. Everything else is metered from a copy
	// kept while streaming.
	bodyless := r.Method == http.MethodHead || resp.StatusCode == 204 ||
		resp.StatusCode == 205 || resp.StatusCode == 304
	metered := resp.StatusCode < 400 && !bodyless
	var kept bytes.Buffer
	readErr := streamBody(w, rc, resp.Body, metered, &kept)

	if metered {
		isSSE := strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "event-stream")
		go a.meter(cred, providerSlug, b.model, isSSE, kept.Bytes())
	}

	// Upstream broke off mid-body while the client is still there: cut the
	// client connection too, rather than end the response cleanly and let a
	// truncated body pass for a complete one.
	if readErr != nil && r.Context().Err() == nil {
		log.Printf("[proxy] upstream body failed provider=%s key=%q: %v", providerSlug, cred.Name, readErr)
		panic(http.ErrAbortHandler)
	}
	return nil
}

// streamBody copies upstream to the client one chunk at a time, flushing each
// as it arrives (SSE must not wait for the end of the generation), and keeps
// a copy for metering when asked. A client that goes away stops the writes;
// its disconnect cancels the request context, which ends the upstream read.
// Returns the upstream read error, nil at a clean end.
func streamBody(w io.Writer, rc *http.ResponseController, body io.Reader, keep bool, kept *bytes.Buffer) error {
	buf := make([]byte, 32*1024)
	clientOK := true
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if keep {
				kept.Write(buf[:n])
			}
			if clientOK {
				if _, werr := w.Write(buf[:n]); werr != nil {
					clientOK = false
				} else if ferr := rc.Flush(); ferr != nil {
					clientOK = false
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// meter writes the usage row for one forwarded response. It runs after the
// stream ended, also a cut one (what arrived is metered: an Anthropic stream
// cut after message_start still records its input). Models billed per
// request (Jev) get a row for every call even without reported tokens;
// token-billed ones need usage to price.
func (a *app) meter(cred *Credential, providerSlug, clientModel string, isSSE bool, body []byte) {
	var reported *Usage
	if isSSE {
		reported = extractUsageFromSSE(string(body))
	} else {
		reported = extractUsageFromJSON(body)
	}
	entry := catalog.model(clientModel)
	perRequest := entry != nil && entry.PerRequest != nil
	if reported == nil && !perRequest {
		return
	}
	usage := Usage{}
	if reported != nil {
		usage = *reported
	}
	model := clientModel
	if model == "" {
		model = "-"
	}
	// cost_usd is the catalog estimate key holders read on GET /usage; the
	// api prices the buckets itself at ingest (ADR 0003 §5).
	var cost *float64
	if entry != nil {
		c := computeCostUsd(entry, usage)
		cost = &c
	}
	err := a.ledger.recordUsage(UsageRecord{
		KeyID:            cred.KeyID,
		Name:             cred.Name,
		ParentKeyID:      cred.ParentKeyID,
		RootKeyID:        cred.RootKeyID,
		Model:            model,
		ProviderSlug:     providerSlug,
		InputTokens:      usage.InputTokens,
		OutputTokens:     usage.OutputTokens,
		CacheReadTokens:  usage.CacheReadTokens,
		CacheWriteTokens: usage.CacheWriteTokens,
		ProviderCost:     usage.ProviderCost,
		CostUsd:          cost,
	})
	if err != nil {
		log.Printf("[proxy] metering failed key=%q: %v", cred.Name, err)
		return
	}
	providerCost := "-"
	if usage.ProviderCost != nil {
		providerCost = fmt.Sprint(*usage.ProviderCost)
	}
	log.Printf("[proxy] metered key=%q model=%s in=%v out=%v cacheRead=%v cacheWrite=%v providerCost=%s",
		cred.Name, model, usage.InputTokens, usage.OutputTokens,
		usage.CacheReadTokens, usage.CacheWriteTokens, providerCost)
}

// upstreamBody is the request body to forward and the model it asks for.
type upstreamBody struct {
	body        io.Reader // nil: no body
	length      int64     // -1: unknown (streamed through)
	contentType string    // set only when the body was re-encoded
	model       string    // client-facing slug, "" when the body names none
}

// readBody reads what the proxy must see of the request body: `model`, for
// authorization and metering, and the upstream rewrite (ADR 0002). JSON and
// multipart are buffered; any other type streams through untouched. Writes
// the error answer itself and returns done=true when the request is refused.
func (a *app) readBody(w http.ResponseWriter, r *http.Request, cred *Credential) (b upstreamBody, done bool, err error) {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return upstreamBody{}, false, nil
	}
	ct := strings.ToLower(r.Header.Get("Content-Type"))

	// A body without `model` (count_tokens, a models list) is still
	// forwarded; the credential was verified.
	refused := func(model string) bool {
		if model == "" || cred.modelAllowed(model) {
			return false
		}
		writeJSON(w, 403, obj(
			"error", "model_not_allowed",
			"detail", fmt.Sprintf("key %q does not grant model=%s", cred.Name, model),
		))
		return true
	}

	switch {
	// Multipart carries `model` as a form field (audio transcription) or
	// inside a JSON part named `request` (Jev with image parts). The form is
	// buffered and forwarded byte for byte (same boundary, same file parts)
	// unless the model needs an upstream rename; only then is it re-encoded
	// with a rewritten `request` part. Unlike JSON, an unparseable form is
	// refused: passing it through would skip the model check.
	case strings.Contains(ct, "multipart/form-data"):
		// Content-Length is not trusted alone: a chunked upload carries none.
		var raw []byte
		if r.ContentLength != 0 && r.ContentLength <= maxMultipartBytes {
			if raw, err = io.ReadAll(io.LimitReader(r.Body, maxMultipartBytes+1)); err != nil {
				return b, false, err
			}
		}
		if len(raw) == 0 || len(raw) > maxMultipartBytes {
			writeJSON(w, 413, obj(
				"error", "payload_too_large",
				"detail", fmt.Sprintf("multipart bodies are limited to %d bytes", maxMultipartBytes),
			))
			return b, true, nil
		}
		parts, perr := parseMultipart(r.Header.Get("Content-Type"), raw)
		if perr != nil {
			writeJSON(w, 400, obj("error", "invalid_multipart_body"))
			return b, true, nil
		}
		// The first `model` entry when it is a plain field, else the model in
		// the `request` JSON part.
		model, fromField := "", false
		if i := firstPart(parts, "model"); i >= 0 && parts[i].filename == "" {
			model, fromField = string(parts[i].data), true
		}
		var request []member
		if i := firstPart(parts, "request"); i >= 0 {
			if !json.Valid(parts[i].data) {
				writeJSON(w, 400, obj("error", "invalid_multipart_body"))
				return b, true, nil
			}
			request, _ = objectMembers(parts[i].data) // nil unless an object
			if !fromField {
				model = jsonString(request, "model")
			}
		}
		if refused(model) {
			return b, true, nil
		}
		if request != nil && model != "" {
			if merged, changed := catalog.mergeRequestBody(model, request); changed {
				body, ctype := encodeMultipart(parts, merged)
				return upstreamBody{body: bytes.NewReader(body), length: int64(len(body)), contentType: ctype, model: model}, false, nil
			}
		}
		return upstreamBody{body: bytes.NewReader(raw), length: int64(len(raw)), model: model}, false, nil

	case strings.Contains(ct, "application/json"):
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			return b, false, err
		}
		obj, perr := objectMembers(raw)
		if perr != nil {
			// Not a JSON object: passed through as is, with no model to check.
			log.Printf("[proxy] body parse failed (passing through): %v", perr)
			return upstreamBody{body: bytes.NewReader(raw), length: int64(len(raw))}, false, nil
		}
		model := jsonString(obj, "model")
		if refused(model) {
			return b, true, nil
		}
		if model != "" {
			if merged, changed := catalog.mergeRequestBody(model, obj); changed {
				return upstreamBody{body: bytes.NewReader(merged), length: int64(len(merged)), model: model}, false, nil
			}
		}
		return upstreamBody{body: bytes.NewReader(raw), length: int64(len(raw)), model: model}, false, nil

	default:
		// Any other content type streams raw; it carries no model field.
		if r.ContentLength == 0 {
			return b, false, nil
		}
		return upstreamBody{body: r.Body, length: r.ContentLength}, false, nil
	}
}

// jsonString is the member's value when it is a JSON string, else "".
func jsonString(ms []member, key string) string {
	for _, m := range ms {
		if m.Key == key {
			var s string
			if json.Unmarshal(m.Value, &s) == nil {
				return s
			}
			return ""
		}
	}
	return ""
}

type formPart struct {
	name        string
	filename    string
	contentType string
	data        []byte
}

func firstPart(parts []formPart, name string) int {
	for i, p := range parts {
		if p.name == name {
			return i
		}
	}
	return -1
}

// parseMultipart reads a whole multipart/form-data body. A part with a
// filename is a file, one without is a plain field (the FormData rule).
func parseMultipart(contentType string, raw []byte) ([]formPart, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, err
	}
	if params["boundary"] == "" {
		return nil, errors.New("no boundary")
	}
	mr := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
	var parts []formPart
	for {
		p, err := mr.NextRawPart()
		if err == io.EOF {
			return parts, nil
		}
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(p)
		if err != nil {
			return nil, err
		}
		parts = append(parts, formPart{
			name:        p.FormName(),
			filename:    p.FileName(),
			contentType: p.Header.Get("Content-Type"),
			data:        data,
		})
	}
}

// encodeMultipart re-encodes the form with a new boundary and the `request`
// part replaced by the rewritten JSON, sent as a JSON blob the way FormData
// encodes one.
func encodeMultipart(parts []formPart, request []byte) ([]byte, string) {
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	for _, p := range parts {
		h := textproto.MIMEHeader{}
		data := p.data
		switch {
		case p.name == "request":
			h.Set("Content-Disposition", `form-data; name="request"; filename="blob"`)
			h.Set("Content-Type", "application/json")
			data = request
		case p.filename != "":
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, p.name, p.filename))
			ct := p.contentType
			if ct == "" {
				ct = "application/octet-stream"
			}
			h.Set("Content-Type", ct)
		default:
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q`, p.name))
		}
		pw, _ := mw.CreatePart(h)
		_, _ = pw.Write(data)
	}
	_ = mw.Close()
	return b.Bytes(), mw.FormDataContentType()
}
