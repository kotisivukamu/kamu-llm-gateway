package main

import "testing"

// Pricing rules that depend on catalog shape rather than plain per-token
// multiplication, and the usage shapes providers send.

func usage(in, out, cacheRead, cacheWrite float64) Usage {
	return Usage{InputTokens: in, OutputTokens: out, CacheReadTokens: cacheRead, CacheWriteTokens: cacheWrite}
}

func sameUsage(t *testing.T, got *Usage, want Usage) {
	t.Helper()
	if got == nil {
		t.Fatalf("no usage, want %+v", want)
	}
	if got.InputTokens != want.InputTokens || got.OutputTokens != want.OutputTokens ||
		got.CacheReadTokens != want.CacheReadTokens || got.CacheWriteTokens != want.CacheWriteTokens {
		t.Fatalf("usage %+v, want %+v", *got, want)
	}
	if (got.ProviderCost == nil) != (want.ProviderCost == nil) ||
		(got.ProviderCost != nil && *got.ProviderCost != *want.ProviderCost) {
		t.Fatalf("provider cost %v, want %v", got.ProviderCost, want.ProviderCost)
	}
}

func costNear(t *testing.T, got, want float64) {
	t.Helper()
	if !near(got, want) {
		t.Fatalf("cost %v, want %v", got, want)
	}
}

func TestHaikuBaseRatesUpTo100kPrompt(t *testing.T) {
	cost := computeCostUsd(catalog.model("claude-haiku-5-5"), usage(50_000, 1_000, 40_000, 10_000)) // prompt = 100,000
	costNear(t, cost, (50_000*0.1+1_000*0.5+40_000*0.01+10_000*0.125)/1e6)
}

func TestHaikuLongContextPast100kCacheHitsIncluded(t *testing.T) {
	// Fresh input alone is small; the cache read pushes the prompt over.
	cost := computeCostUsd(catalog.model("claude-haiku-5-5"), usage(1_000, 2_000, 99_001, 0))
	costNear(t, cost, (1_000*0.5+2_000*2.5+99_001*0.05)/1e6)
}

func TestNoLongContextTierIgnoresPromptLength(t *testing.T) {
	cost := computeCostUsd(catalog.model("claude-sonnet-5-5"), usage(500_000, 1_000, 200_000, 0))
	costNear(t, cost, (500_000*2+1_000*10+200_000*0.1)/1e6)
}

func TestMissingCacheRatesFallBack(t *testing.T) {
	m := &Model{Input: 2, Output: 4}
	costNear(t, computeCostUsd(m, usage(0, 0, 1_000_000, 1_000_000)), 2*0.1+2*1.25)
}

func TestTranscribeUsageAudioAndTextAtInputRate(t *testing.T) {
	u := extractUsageFromJSON([]byte(`{"text":"x","usage":{"type":"tokens","input_tokens":300,"input_token_details":{"text_tokens":20,"audio_tokens":280},"output_tokens":50,"total_tokens":350}}`))
	sameUsage(t, u, usage(300, 50, 0, 0))
	costNear(t, computeCostUsd(catalog.model("gpt-4o-transcribe"), *u), (300*2.5+50*10)/1e6)
}

func TestWhisperDurationUsageYieldsNothing(t *testing.T) {
	if u := extractUsageFromJSON([]byte(`{"text":"x","usage":{"type":"duration","seconds":12}}`)); u != nil {
		t.Fatalf("got %+v", *u)
	}
}

func TestGeminiHiddenThinkingCountsAsOutput(t *testing.T) {
	u := extractUsageFromJSON([]byte(`{"usage":{"prompt_tokens":50,"completion_tokens":33,"total_tokens":380}}`))
	sameUsage(t, u, usage(50, 330, 0, 0))
	costNear(t, computeCostUsd(catalog.model("gemini-3.8-flash"), *u), (50*0.75+330*3.75)/1e6)
}

func TestGeminiHiddenThinkingStreamed(t *testing.T) {
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"Hei\"}}]}\n\n" +
		"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":33,\"total_tokens\":380}}\n\n" +
		"data: [DONE]"
	sameUsage(t, extractUsageFromSSE(sse), usage(50, 330, 0, 0))
}

func TestTotalEqualToSumAddsNothing(t *testing.T) {
	sameUsage(t, extractUsageFromJSON([]byte(`{"usage":{"prompt_tokens":50,"completion_tokens":33,"total_tokens":83}}`)), usage(50, 33, 0, 0))
}

func TestPerRequestChargedOnceOnTopOfTokens(t *testing.T) {
	per := 0.003
	m := &Model{ProviderSlug: "jev", Input: 1, Output: 2, PerRequest: &per}
	costNear(t, computeCostUsd(m, usage(0, 0, 0, 0)), 0.003)
	costNear(t, computeCostUsd(m, usage(1_000, 500, 0, 0)), 0.003+(1_000*1+500*2)/1e6)
	// Jev: $0.042 per million input tokens, output free, no per-request charge.
	jev := catalog.model("jev-latest")
	mustEqual(t, computeCostUsd(jev, usage(0, 0, 0, 0)), 0, "jev empty")
	costNear(t, computeCostUsd(jev, usage(418, 33, 0, 0)), 418*0.042/1e6)
	mustEqual(t, computeCostUsd(catalog.model("jev-1.14.0"), usage(418, 33, 0, 0)),
		computeCostUsd(jev, usage(418, 33, 0, 0)), "versioned jev priced like the alias")
}

// ADR 0003 §1: the provider-reported cost is kept raw next to the buckets.
// cortecs (OpenAI-compatible) sends it as usage.cost.
func TestCortecsCostNonStreaming(t *testing.T) {
	u := extractUsageFromJSON([]byte(`{"choices":[{"message":{"role":"assistant","content":"Hei"}}],"usage":{"prompt_tokens":1200,"completion_tokens":40,"total_tokens":1240,"prompt_tokens_details":{"cached_tokens":1000},"cost":1234,"cost_details":{"prompt_cost":1200,"cache_read_cost":34}}}`))
	want := usage(200, 40, 1000, 0)
	want.ProviderCost = f64(1234)
	sameUsage(t, u, want)
}

func TestCortecsCostOnFinalStreamChunk(t *testing.T) {
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"Hei\"}}]}\n\n" +
		"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1200,\"completion_tokens\":40,\"total_tokens\":1240,\"prompt_tokens_details\":{\"cached_tokens\":1000},\"cost\":0.000321}}\n\n" +
		"data: [DONE]"
	want := usage(200, 40, 1000, 0)
	want.ProviderCost = f64(0.000321)
	sameUsage(t, extractUsageFromSSE(sse), want)
}

func TestNoCostLeavesProviderCostNull(t *testing.T) {
	sameUsage(t, extractUsageFromJSON([]byte(`{"usage":{"input_tokens":10,"output_tokens":2}}`)), usage(10, 2, 0, 0))
}

// Anthropic streams input (+ cache) on message_start and the cumulative
// output on each message_delta; CRLF line ends are fine.
func TestAnthropicStreamUsage(t *testing.T) {
	sse := "event: message_start\r\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":3000,\"cache_creation_input_tokens\":40,\"output_tokens\":1}}}\r\n\r\n" +
		"event: message_delta\r\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\r\n\r\n" +
		"event: message_delta\r\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":19}}\r\n\r\n" +
		"data: not json\n\n"
	sameUsage(t, extractUsageFromSSE(sse), usage(12, 19, 3000, 40))
}

// DeepSeek's native API reports cache hits as prompt_cache_hit_tokens.
func TestDeepSeekCacheHits(t *testing.T) {
	sameUsage(t, extractUsageFromJSON([]byte(`{"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_cache_hit_tokens":80}}`)), usage(20, 5, 80, 0))
}

func TestNoUsageInStreamIsNil(t *testing.T) {
	if u := extractUsageFromSSE("data: {\"choices\":[]}\n\ndata: [DONE]\n\n"); u != nil {
		t.Fatalf("got %+v", *u)
	}
}
