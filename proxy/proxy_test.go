package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"testing"
	"time"
)

// The /llm proxy route over real HTTP on both sides: the app on an httptest
// server, every provider replaced by a fake upstream server. Keys are real
// llm.keys rows; usage lands in the app's in-memory ledger. The proxy writes
// no spend: the api charges it at ingest and sets keys 'over_budget', which
// the proxy answers with 402 (ADR 0003 §4).

var geminiReply = map[string]any{
	"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "Hei"}}},
	"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 40},
}

func chat(t *testing.T, base, credential string) (*http.Response, map[string]any) {
	t.Setenv("GEMINI_API_KEY", "gemini-test-upstream")
	return doJSON(t, "POST", base+"/llm/google/v1/chat/completions", bearerHeader(credential),
		map[string]any{
			"model":    "gemini-3.1-flash-lite",
			"messages": []any{map[string]any{"role": "user", "content": "Moi"}},
		})
}

// transcriptionForm is a multipart audio upload like the OpenAI SDK sends.
func transcriptionForm(model string, audioBytes int) ([]byte, string) {
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, _ := mw.CreateFormFile("file", "note.webm")
	_, _ = fw.Write(make([]byte, audioBytes))
	if model != "" {
		_ = mw.WriteField("model", model)
	}
	_ = mw.WriteField("language", "fi")
	_ = mw.Close()
	return b.Bytes(), mw.FormDataContentType()
}

func postRaw(t *testing.T, u, secret string, body []byte, contentType string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("POST", u, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", contentType)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res, out
}

func formValues(t *testing.T, contentType string, body []byte) map[string][]byte {
	t.Helper()
	parts, err := parseMultipart(contentType, body)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]byte{}
	for _, p := range parts {
		out[p.name] = p.data
	}
	return out
}

func TestTranscriptionAuthorizedAndMeteredNoSpend(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "sk-test-upstream")
	key := seedTop(t, "", []string{"gpt-4o-mini-transcribe"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{
		"text": "hei",
		"usage": map[string]any{
			"type": "tokens", "input_tokens": 1000,
			"input_token_details": map[string]any{"text_tokens": 40, "audio_tokens": 960},
			"output_tokens":       200, "total_tokens": 1200,
		},
	}))
	base := serve(t, a)
	body, ctype := transcriptionForm("gpt-4o-mini-transcribe", 1024)
	res, out := postRaw(t, base+"/llm/openai/v1/audio/transcriptions", key.secret, body, ctype)
	mustEqual(t, res.StatusCode, 200, "status")
	if !strings.Contains(string(out), `"text":"hei"`) {
		t.Fatalf("body %s", out)
	}

	// Forwarded byte for byte with the caller's boundary, upstream key swapped in.
	calls := up.Calls()
	mustEqual(t, len(calls), 1, "upstream calls")
	mustEqual(t, calls[0].URL, "https://api.openai.com/v1/audio/transcriptions", "upstream url")
	mustEqual(t, calls[0].Header.Get("Authorization"), "Bearer sk-test-upstream", "upstream auth")
	mustEqual(t, calls[0].Header.Get("Content-Type"), ctype, "content-type")
	if !bytes.Equal(calls[0].Body, body) {
		t.Fatal("multipart body not forwarded byte for byte")
	}

	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, len(rows), 1, "rows")
	mustEqual(t, rows[0].Model, "gpt-4o-mini-transcribe", "model")
	mustEqual(t, rows[0].InputTokens, 1000, "input")
	mustEqual(t, rows[0].OutputTokens, 200, "output")
	if !near(*rows[0].CostUsd, (1000*1.25+200*5)/1e6) {
		t.Fatalf("cost %v", *rows[0].CostUsd)
	}
	// The budgeted key's spend is the api's to charge at ingest.
	var n int
	_ = ownerPool.QueryRow(context.Background(),
		`SELECT count(*) FROM llm.key_spend WHERE key_id = $1`, key.id).Scan(&n)
	mustEqual(t, n, 0, "key_spend rows")
}

func TestTranscriptionModelNotGranted(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "sk-test-upstream")
	key := seedTop(t, "", []string{"gpt-4o-mini-transcribe"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{}))
	body, ctype := transcriptionForm("gpt-4o-transcribe", 1024)
	res, out := postRaw(t, serve(t, a)+"/llm/openai/v1/audio/transcriptions", key.secret, body, ctype)
	mustEqual(t, res.StatusCode, 403, "status")
	mustEqual(t, string(out), `{"error":"model_not_allowed","detail":"key \"top\" does not grant model=gpt-4o-transcribe"}`, "body")
	mustEqual(t, len(up.Calls()), 0, "upstream calls")
}

func TestTranscriptionWhisperPassesUnmetered(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "sk-test-upstream")
	key := seedTop(t, "", []string{"whisper-1"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{
		"text": "hei", "usage": map[string]any{"type": "duration", "seconds": 4},
	}))
	body, ctype := transcriptionForm("whisper-1", 1024)
	res, _ := postRaw(t, serve(t, a)+"/llm/openai/v1/audio/transcriptions", key.secret, body, ctype)
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, len(up.Calls()), 1, "upstream calls")
	time.Sleep(200 * time.Millisecond) // nothing priceable, so nothing recorded
	mustEqual(t, len(usageRows(t, a, key.id, 0)), 0, "rows")
}

func TestTranscriptionOversizedAndMalformed(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "sk-test-upstream")
	key := seedTop(t, "", []string{"*"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{}))
	base := serve(t, a)

	big, ctype := transcriptionForm("gpt-4o-mini-transcribe", maxMultipartBytes+1)
	res, out := postRaw(t, base+"/llm/openai/v1/audio/transcriptions", key.secret, big, ctype)
	mustEqual(t, res.StatusCode, 413, "oversized status")
	mustEqual(t, string(out), `{"error":"payload_too_large","detail":"multipart bodies are limited to 33554432 bytes"}`, "oversized body")

	// Chunked (no content-length): the cap still holds.
	req, _ := http.NewRequest("POST", base+"/llm/openai/v1/audio/transcriptions", io.MultiReader(bytes.NewReader(big)))
	req.Header.Set("Authorization", "Bearer "+key.secret)
	req.Header.Set("Content-Type", ctype)
	req.ContentLength = -1
	chunked, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	chunked.Body.Close()
	mustEqual(t, chunked.StatusCode, 413, "chunked oversized status")

	res, out = postRaw(t, base+"/llm/openai/v1/audio/transcriptions", key.secret,
		[]byte("not a form"), "multipart/form-data; boundary=nope")
	mustEqual(t, res.StatusCode, 400, "malformed status")
	mustEqual(t, string(out), `{"error":"invalid_multipart_body"}`, "malformed body")
	mustEqual(t, len(up.Calls()), 0, "upstream calls")
}

func TestGoogleStripsV1(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"gemini-3.1-flash-lite"}, topOpts{})
	up := withUpstream(t, a, replyJSON(geminiReply))
	res, _ := chat(t, serve(t, a), key.secret)
	mustEqual(t, res.StatusCode, 200, "status")
	calls := up.Calls()
	mustEqual(t, calls[0].URL, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "upstream url")
	mustEqual(t, calls[0].Header.Get("Authorization"), "Bearer gemini-test-upstream", "upstream auth")
	// The caller's credential never goes upstream.
	mustEqual(t, calls[0].Header.Get("X-Api-Key"), "", "x-api-key upstream")

	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, rows[0].OutputTokens, 30, "output incl. hidden thinking")
	mustEqual(t, *rows[0].ProviderSlug, "google", "provider_slug")
	if !near(*rows[0].CostUsd, (10*0.25+30*1.5)/1e6) {
		t.Fatalf("cost %v", *rows[0].CostUsd)
	}
}

func TestJevForwardedAndLoggedPerRequest(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("JEV_API_KEY", "jev-test-upstream")
	key := seedTop(t, "", []string{"jev-latest"}, topOpts{})
	sent := `{"model":"jev-latest","state":"Previous: invoice question. New: thanks, paid now.","questions":{"related":{"type":"choice","instructions":"Is the new message part of the same conversation?","criteria":{"yes":"Same topic","no":"A new topic"}}}}`
	// No usage block: the row is logged anyway (per_request_cost_usd is set).
	reply := `{"model":"jev-2026-10","answers":{"related":{"choice":"yes","confidence":0.91,"probabilities":{"yes":0.91,"no":0.09}}}}`
	up := withUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, reply)
	})
	res, out := postRaw(t, serve(t, a)+"/llm/jev/v1/systemone", key.secret, []byte(sent), "application/json")
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, string(out), reply, "reply unchanged")
	calls := up.Calls()
	mustEqual(t, len(calls), 1, "upstream calls")
	mustEqual(t, calls[0].URL, "https://api.typesafe.ai/v1/systemone", "upstream url")
	mustEqual(t, calls[0].Header.Get("Authorization"), "Bearer jev-test-upstream", "upstream auth")
	mustEqual(t, calls[0].Header.Get("Typesafe-Danger-Zone-Images"), "", "images header")
	mustEqual(t, string(calls[0].Body), sent, "body unchanged")

	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, len(rows), 1, "rows")
	mustEqual(t, rows[0].Model, "jev-latest", "model")
	mustEqual(t, rows[0].InputTokens, 0, "input")
	mustEqual(t, *rows[0].CostUsd, 0, "cost")
}

func TestJevOnlySystemOne(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("JEV_API_KEY", "jev-test-upstream")
	key := seedTop(t, "", []string{"*"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{}))
	res, out := doJSON(t, "POST", serve(t, a)+"/llm/jev/v1/chat/completions", bearerHeader(key.secret),
		map[string]any{"model": "jev-latest"})
	mustEqual(t, res.StatusCode, 403, "status")
	mustEqual(t, out["error"], any("path_not_allowed"), "error")
	mustEqual(t, out["path"], any("/v1/chat/completions"), "path")
	mustEqual(t, len(up.Calls()), 0, "upstream calls")
}

func TestJevCallerCannotSwitchImagesOn(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("JEV_API_KEY", "jev-test-upstream")
	key := seedTop(t, "", []string{"jev-latest"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{}))
	res, _ := doJSON(t, "POST", serve(t, a)+"/llm/jev/v1/systemone",
		map[string]string{"Authorization": "Bearer " + key.secret, "TypeSafe-Danger-Zone-Images": "true"},
		map[string]any{"model": "jev-latest"})
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, up.Calls()[0].Header.Get("Typesafe-Danger-Zone-Images"), "", "images header")
}

var imageQuestion = `"state":{"img":"ref-1"},"questions":{"q":{"type":"noul","instructions":"Is ` + "`img`" + ` mostly one colour?"}}`

func TestJevImagesHeaderBaseSlugAndLoggedSlug(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("JEV_API_KEY", "jev-test-upstream")
	key := seedTop(t, "", []string{"jev-latest-images"}, topOpts{})
	reply := `{"answers":{"q":{"answer":"yes"}},"usage":{"input_tokens":300,"output_tokens":2}}`
	up := withUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, reply)
	})
	assets := `"assets":{"ref-1":{"type":"image","format":"png","data_base64":"iVBORw0KGgo="}}`
	sent := `{"model":"jev-latest-images",` + imageQuestion + `,` + assets + `}`
	res, out := postRaw(t, serve(t, a)+"/llm/jev-images/v1/systemone", key.secret, []byte(sent), "application/json")
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, string(out), reply, "reply")
	calls := up.Calls()
	mustEqual(t, calls[0].URL, "https://api.typesafe.ai/v1/systemone", "upstream url")
	mustEqual(t, calls[0].Header.Get("Authorization"), "Bearer jev-test-upstream", "upstream auth")
	mustEqual(t, calls[0].Header.Get("Typesafe-Danger-Zone-Images"), "true", "images header")
	// Same body, same key order, model rewritten in place.
	mustEqual(t, string(calls[0].Body), `{"model":"jev-latest",`+imageQuestion+`,`+assets+`}`, "upstream body")
	mustEqual(t, calls[0].Header.Get("Content-Length"), fmt.Sprint(len(calls[0].Body)), "content-length")

	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, rows[0].Model, "jev-latest-images", "model")
	mustEqual(t, *rows[0].ProviderSlug, "jev-images", "provider_slug")
	if !near(*rows[0].CostUsd, 300*0.042/1e6) {
		t.Fatalf("cost %v", *rows[0].CostUsd)
	}
}

func TestJevImagesRefusesBaseSlugsAndMissingModel(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("JEV_API_KEY", "jev-test-upstream")
	key := seedTop(t, "", []string{"*"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{}))
	base := serve(t, a)
	for _, body := range []string{`{"model":"jev-latest",` + imageQuestion + `}`, `{` + imageQuestion + `}`} {
		res, out := postRaw(t, base+"/llm/jev-images/v1/systemone", key.secret, []byte(body), "application/json")
		mustEqual(t, res.StatusCode, 400, "status")
		if !strings.Contains(string(out), `"error":"model_not_on_provider"`) {
			t.Fatalf("body %s", out)
		}
	}
	mustEqual(t, len(up.Calls()), 0, "upstream calls")
}

func TestJevImagesMultipartRewritesRequestPartKeepsImage(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("JEV_API_KEY", "jev-test-upstream")
	key := seedTop(t, "", []string{"jev-1.14.0-images"}, topOpts{})
	png := []byte{0x89, 0x50, 0x4e, 0x47, 1, 2, 3}
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="request"; filename="blob"`)
	h.Set("Content-Type", "application/json")
	pw, _ := mw.CreatePart(h)
	_, _ = io.WriteString(pw, `{"model":"jev-1.14.0-images",`+imageQuestion+`,"assets":{"ref-1":{"type":"image","part":"shot"}}}`)
	h = textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="shot"; filename="shot.png"`)
	h.Set("Content-Type", "image/png")
	pw, _ = mw.CreatePart(h)
	_, _ = pw.Write(png)
	_ = mw.Close()

	up := withUpstream(t, a, replyJSON(map[string]any{"answers": map[string]any{}}))
	res, _ := postRaw(t, serve(t, a)+"/llm/jev-images/v1/systemone", key.secret, b.Bytes(), mw.FormDataContentType())
	mustEqual(t, res.StatusCode, 200, "status")
	call := up.Calls()[0]
	mustEqual(t, call.Header.Get("Typesafe-Danger-Zone-Images"), "true", "images header")
	parts, err := parseMultipart(call.Header.Get("Content-Type"), call.Body)
	if err != nil {
		t.Fatal(err)
	}
	mustEqual(t, len(parts), 2, "parts")
	var req struct {
		Model  string         `json:"model"`
		Assets map[string]any `json:"assets"`
	}
	if err := json.Unmarshal(parts[0].data, &req); err != nil {
		t.Fatal(err)
	}
	mustEqual(t, req.Model, "jev-1.14.0", "upstream model")
	mustEqual(t, fmt.Sprint(req.Assets), "map[ref-1:map[part:shot type:image]]", "assets")
	mustEqual(t, parts[1].name, "shot", "image part")
	mustEqual(t, parts[1].contentType, "image/png", "image type")
	if !bytes.Equal(parts[1].data, png) {
		t.Fatal("image bytes changed")
	}
	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, rows[0].Model, "jev-1.14.0-images", "model")
}

// ADR 0002: the upstream slug goes on the wire, overrides merge in, and the
// client slug stays the authority for authz and the usage row.
func TestUpstreamSlugAndOverridesOnTheWire(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("TENSORX_API_KEY", "tx-test")
	t.Setenv("CORTECS_API_KEY", "cx-test")
	key := seedTop(t, "", []string{"glm-5.3@tensorx", "deepseek-v4.1-flash", "glm-5.3"}, topOpts{})
	up := withUpstream(t, a, replyJSON(map[string]any{"usage": map[string]any{"prompt_tokens": 5, "completion_tokens": 1}}))
	base := serve(t, a)

	body := `{"model":"glm-5.3@tensorx", "messages":[{"role":"user","content":"Moi"}],"stream":false}`
	res, _ := postRaw(t, base+"/llm/tensorx/v1/chat/completions", key.secret, []byte(body), "application/json")
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, string(up.Calls()[0].Body), `{"model":"z-ai/glm-5.3","messages":[{"role":"user","content":"Moi"}],"stream":false}`, "rewritten body")

	body = `{"messages":[],"model":"deepseek-v4.1-flash"}`
	res, _ = postRaw(t, base+"/llm/cortecs/v1/chat/completions", key.secret, []byte(body), "application/json")
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, string(up.Calls()[1].Body), `{"messages":[],"model":"deepseek-v4.1-flash","allowed_providers":["tensorix"]}`, "override body")

	// No rewrite: the caller's bytes go upstream untouched.
	body = `{"model": "glm-5.3", "messages": []}`
	res, _ = postRaw(t, base+"/llm/cortecs/v1/chat/completions", key.secret, []byte(body), "application/json")
	mustEqual(t, res.StatusCode, 200, "status")
	mustEqual(t, string(up.Calls()[2].Body), body, "untouched body")

	rows := usageRows(t, a, key.id, 3)
	mustEqual(t, rows[0].Model, "glm-5.3@tensorx", "usage row keeps the client slug")

	// A namespaced upstream slug is not a client slug: 403 before upstream.
	res, _ = postRaw(t, base+"/llm/tensorx/v1/chat/completions", key.secret, []byte(`{"model":"z-ai/glm-5.3"}`), "application/json")
	mustEqual(t, res.StatusCode, 403, "upstream slug from a client")
	mustEqual(t, len(up.Calls()), 3, "upstream calls")
}

func TestRefusalsBeforeUpstream(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"gemini-3.1-flash-lite"}, topOpts{})
	child := seedChild(t, key, "")
	up := withUpstream(t, a, replyJSON(geminiReply))
	base := serve(t, a)

	res, out := doJSON(t, "POST", base+"/llm/nope/v1/chat/completions", bearerHeader(key.secret), map[string]any{})
	mustEqual(t, res.StatusCode, 404, "unknown provider")
	mustEqual(t, out["error"], any("provider_unknown"), "unknown provider error")
	mustEqual(t, out["provider"], any("nope"), "unknown provider slug")

	res, out = doJSON(t, "POST", base+"/llm/google/v1/chat/completions", nil, map[string]any{})
	mustEqual(t, res.StatusCode, 401, "no credential")
	mustEqual(t, out["error"], any("unauthorized"), "no credential error")

	t.Setenv("GEMINI_API_KEY", "")
	res, out = doJSON(t, "POST", base+"/llm/google/v1/chat/completions",
		map[string]string{"x-api-key": key.secret}, map[string]any{"model": "gemini-3.1-flash-lite"})
	mustEqual(t, res.StatusCode, 502, "provider key missing")
	mustEqual(t, out["error"], any("provider_key_missing"), "provider key missing error")

	// Model authorization answers before the missing provider key.
	res, out = doJSON(t, "POST", base+"/llm/google/v1/chat/completions", bearerHeader(key.secret),
		map[string]any{"model": "gemini-3.8-flash"})
	mustEqual(t, res.StatusCode, 403, "model not allowed")
	mustEqual(t, out["error"], any("model_not_allowed"), "model not allowed error")

	res, out = doJSON(t, "POST", base+"/llm/google/v1/files", bearerHeader(key.secret), map[string]any{})
	mustEqual(t, res.StatusCode, 403, "path")
	mustEqual(t, out["error"], any("path_not_allowed"), "path error")

	// A derived key works like its root (models "*" on the child row).
	res, _ = chat(t, base, child.jwt)
	mustEqual(t, res.StatusCode, 200, "derived key")
	mustEqual(t, len(up.Calls()), 1, "upstream calls")
}

func TestUpstreamErrorPassesThroughUnmetered(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"*"}, topOpts{})
	withUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(429)
		_, _ = io.WriteString(w, `{"error":{"message":"slow down"},"usage":{"prompt_tokens":5}}`)
	})
	res, out := chat(t, serve(t, a), key.secret)
	mustEqual(t, res.StatusCode, 429, "status")
	mustEqual(t, res.Header.Get("Access-Control-Allow-Origin"), "", "CORS header dropped")
	mustEqual(t, fmt.Sprint(out["error"]), "map[message:slow down]", "body")
	time.Sleep(100 * time.Millisecond)
	mustEqual(t, len(usageRows(t, a, key.id, 0)), 0, "rows")
}

func TestUpstreamUnreachableIs503(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"*"}, topOpts{})
	// Port 1 on localhost: nothing listens, the dial is refused.
	inner := a.upstream.Transport
	a.upstream = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		r = r.Clone(r.Context())
		r.URL.Scheme, r.URL.Host = "http", "127.0.0.1:1"
		return inner.RoundTrip(r)
	})}
	res, out := chat(t, serve(t, a), key.secret)
	mustEqual(t, res.StatusCode, 503, "status")
	mustEqual(t, out["error"], any("upstream_not_ready"), "error")
}

// --- Budgets (ADR 0003 §4) ---------------------------------------------------

func TestBudgetStatuses(t *testing.T) {
	cases := []struct {
		name       string
		rootStatus string
		child      bool
		childState string
		want       int
	}{
		{"over_budget key gets 402", "over_budget", false, "", 402},
		{"revoked key gets 401", "revoked", false, "", 401},
		{"derived key under an active root goes through", "active", true, "active", 200},
		{"active derived key under an over_budget root gets 402", "over_budget", true, "active", 402},
		{"active derived key under a revoked root gets 401", "revoked", true, "active", 401},
		{"over_budget derived key under an active root gets 402", "active", true, "over_budget", 402},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := newTestApp(t)
			root := seedTop(t, "", []string{"*"}, topOpts{status: c.rootStatus})
			cred := root.secret
			if c.child {
				cred = seedChild(t, root, c.childState).jwt
			}
			up := withUpstream(t, a, replyJSON(geminiReply))
			res, out := chat(t, serve(t, a), cred)
			mustEqual(t, res.StatusCode, c.want, "status")
			if c.want == 402 {
				mustEqual(t, fmt.Sprint(out), "map[error:budget_exceeded]", "body")
			}
			wantCalls := 0
			if c.want == 200 {
				wantCalls = 1
			}
			mustEqual(t, len(up.Calls()), wantCalls, "upstream calls")
		})
	}
}

// --- Streaming -----------------------------------------------------------------

// slowSSE is an upstream event stream: one chunk per 150 ms, usage in the
// last one (the OpenAI shape with stream_options.include_usage).
func slowSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	events := []string{
		`{"choices":[{"delta":{"content":"Hei"}}]}`,
		`{"choices":[{"delta":{"content":" maailma"}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`,
	}
	rc := http.NewResponseController(w)
	for _, e := range events {
		time.Sleep(150 * time.Millisecond)
		_, _ = io.WriteString(w, "data: "+e+"\n\n")
		_ = rc.Flush()
	}
	time.Sleep(150 * time.Millisecond)
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
}

// The Deno proxy delivered every SSE stream in one burst when upstream
// finished (tee() of a socket-backed body). Over real HTTP on both sides,
// each event must reach the client as upstream sends it.
func TestStreamSSEChunksArriveAsUpstreamSendsThem(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"gemini-3.1-flash-lite"}, topOpts{})
	t.Setenv("GEMINI_API_KEY", "gemini-test-upstream")
	withUpstream(t, a, slowSSE)
	base := serve(t, a)

	t0 := time.Now()
	req, _ := http.NewRequest("POST", base+"/llm/google/v1/chat/completions", strings.NewReader(
		`{"model":"gemini-3.1-flash-lite","stream":true,"messages":[{"role":"user","content":"Moi"}]}`))
	req.Header.Set("Authorization", "Bearer "+key.secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	mustEqual(t, res.Header.Get("Content-Type"), "text/event-stream", "content-type")

	// The arrival time of each complete event.
	var arrivals []time.Duration
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "data: ") {
			arrivals = append(arrivals, time.Since(t0))
		}
	}
	mustEqual(t, len(arrivals), 4, "events")
	// Four events ~150 ms apart, not one burst at the end.
	if arrivals[0] >= 400*time.Millisecond {
		t.Fatalf("first event at %v", arrivals[0])
	}
	if spread := arrivals[3] - arrivals[0]; spread < 300*time.Millisecond {
		t.Fatalf("events spread over %v only: %v", spread, arrivals)
	}
	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, len(rows), 1, "rows")
	mustEqual(t, rows[0].OutputTokens, 2, "metered output tokens")
	mustEqual(t, rows[0].InputTokens, 10, "metered input tokens")
}

// A client that disconnects mid-stream aborts the upstream call (stops the
// spend). What arrived before the cut is metered.
func TestStreamClientDisconnectAbortsUpstream(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("ANTHROPIC_API_KEY", "ant-test")
	key := seedTop(t, "", []string{"claude-haiku-5-5"}, topOpts{})
	aborted := make(chan struct{})
	withUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		rc := http.NewResponseController(w)
		_, _ = io.WriteString(w, `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":1200,"cache_read_input_tokens":300,"output_tokens":1}}}

`)
		_ = rc.Flush()
		for {
			select {
			case <-r.Context().Done():
				close(aborted)
				return
			case <-time.After(50 * time.Millisecond):
				_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n")
				_ = rc.Flush()
			}
		}
	})
	base := serve(t, a)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/llm/anthropic/v1/messages", strings.NewReader(
		`{"model":"claude-haiku-5-5","stream":true,"max_tokens":10,"messages":[]}`))
	req.Header.Set("x-api-key", key.secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4096)
	if _, err := res.Body.Read(buf); err != nil {
		t.Fatal(err)
	}
	cancel()
	res.Body.Close()

	select {
	case <-aborted:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not aborted after the client left")
	}
	rows := usageRows(t, a, key.id, 1)
	mustEqual(t, len(rows), 1, "rows")
	mustEqual(t, rows[0].InputTokens, 1200, "input metered from message_start")
}

// Upstream breaking off mid-stream must not look like a complete response.
func TestStreamUpstreamCutReachesClientAsError(t *testing.T) {
	a := newTestApp(t)
	key := seedTop(t, "", []string{"*"}, topOpts{})
	withUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[]}\n\n")
		_ = http.NewResponseController(w).Flush()
		panic(http.ErrAbortHandler) // drop the connection mid-body
	})
	base := serve(t, a)
	t.Setenv("GEMINI_API_KEY", "g")
	req, _ := http.NewRequest("POST", base+"/llm/google/v1/chat/completions",
		strings.NewReader(`{"model":"gemini-3.1-flash-lite","stream":true}`))
	req.Header.Set("Authorization", "Bearer "+key.secret)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if _, err := io.ReadAll(res.Body); err == nil {
		t.Fatal("client read a clean end of a cut stream")
	}
}
