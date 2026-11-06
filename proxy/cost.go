package main

import (
	"encoding/json"
	"math"
	"strings"
)

// Turns an upstream LLM response into normalised usage: the four token
// buckets the api prices at ingest (ADR 0003) plus the cost the provider
// itself reported. Runs after the response has been forwarded.
//
//	input_tokens        fresh (uncached) prompt tokens, billed at the input rate
//	output_tokens       completion tokens, billed at the output rate
//	cache_read_tokens   prompt tokens served from the provider's cache
//	cache_write_tokens  prompt tokens written into the provider's cache
//
// Cache buckets have their own rates (Anthropic: reads 0.1x input, 5-minute
// writes 1.25x). Folding them into input at the full rate over-counted real
// builds ~4x, because cache reads dominate agentic traffic.

// Usage is one request's metered usage. ProviderCost is what the provider
// reported (only cortecs sends one today, `usage.cost`, unit undocumented),
// stored raw and never billed.
type Usage struct {
	InputTokens      float64
	OutputTokens     float64
	CacheReadTokens  float64
	CacheWriteTokens float64
	ProviderCost     *float64
}

// num is the value when it is a JSON number, else 0.
func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func isNum(v any) bool {
	_, ok := v.(float64)
	return ok
}

func field(v any, key string) any {
	m, _ := v.(map[string]any)
	return m[key]
}

// usageBlock is `usage`, else `message.usage` (Anthropic's message_start),
// when it is an object.
func usageBlock(obj any) map[string]any {
	u := field(obj, "usage")
	if u == nil {
		u = field(field(obj, "message"), "usage")
	}
	m, _ := u.(map[string]any)
	return m
}

func providerCost(u map[string]any) *float64 {
	if c, ok := u["cost"].(float64); ok {
		return &c
	}
	return nil
}

// cachedPromptTokens is the cached share of an OpenAI-compatible prompt:
// prompt_tokens_details.cached_tokens, or DeepSeek's prompt_cache_hit_tokens.
func cachedPromptTokens(u map[string]any) float64 {
	if c := num(field(u["prompt_tokens_details"], "cached_tokens")); c != 0 {
		return c
	}
	return num(u["prompt_cache_hit_tokens"])
}

// Gemini's OpenAI layer leaves thinking tokens out of completion_tokens and
// shows them only in total_tokens, while billing them as output. The gap is
// zero on every other provider, where total is the plain sum.
func completionWithHiddenThinking(u map[string]any) float64 {
	completion := num(u["completion_tokens"])
	unreported := math.Max(0, num(u["total_tokens"])-num(u["prompt_tokens"])-completion)
	return completion + unreported
}

// usageFromObject reads one parsed JSON body. Two shapes:
//   - Anthropic Messages (and OpenAI's gpt-4o-*-transcribe): input_tokens is
//     the uncached remainder, cache buckets come as separate fields.
//   - OpenAI-compatible: prompt_tokens INCLUDES cached tokens; the cached
//     share is subtracted into its own bucket. These providers report no
//     cache writes (a write is a normal miss, already counted as input).
func usageFromObject(obj any) *Usage {
	u := usageBlock(obj)
	if u == nil {
		return nil
	}
	if in, ok := u["input_tokens"].(float64); ok {
		return &Usage{
			InputTokens:      in,
			OutputTokens:     num(u["output_tokens"]),
			CacheReadTokens:  num(u["cache_read_input_tokens"]),
			CacheWriteTokens: num(u["cache_creation_input_tokens"]),
			ProviderCost:     providerCost(u),
		}
	}
	if prompt, ok := u["prompt_tokens"].(float64); ok {
		cached := cachedPromptTokens(u)
		return &Usage{
			InputTokens:     math.Max(0, prompt-cached),
			OutputTokens:    completionWithHiddenThinking(u),
			CacheReadTokens: cached,
			ProviderCost:    providerCost(u),
		}
	}
	return nil
}

// extractUsageFromJSON reads a non-streaming body; nil when it is not JSON or
// carries no usage.
func extractUsageFromJSON(body []byte) *Usage {
	var obj any
	if json.Unmarshal(body, &obj) != nil {
		return nil
	}
	return usageFromObject(obj)
}

// extractUsageFromSSE reads a buffered event stream. Usage arrives spread
// across events:
//   - Anthropic: message_start carries input (+ cache) tokens; each
//     message_delta carries the cumulative output_tokens.
//   - OpenAI: one trailing chunk carries the whole block, only when the
//     caller sent stream_options.include_usage. Without it there is nothing
//     to read and the request goes unmetered.
//
// Input/cache come from whichever event supplies them; output keeps the
// largest value seen.
func extractUsageFromSSE(text string) *Usage {
	var r Usage
	seen := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[5:])
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var obj any
		if json.Unmarshal([]byte(payload), &obj) != nil {
			continue
		}
		u := usageBlock(obj)
		if u == nil {
			continue
		}
		if in, ok := u["input_tokens"].(float64); ok {
			r.InputTokens = in
			r.CacheReadTokens = num(u["cache_read_input_tokens"])
			r.CacheWriteTokens = num(u["cache_creation_input_tokens"])
			seen = true
		}
		if prompt, ok := u["prompt_tokens"].(float64); ok {
			cached := cachedPromptTokens(u)
			r.InputTokens = math.Max(0, prompt-cached)
			r.CacheReadTokens = cached
			seen = true
		}
		if out, ok := u["output_tokens"].(float64); ok && out > r.OutputTokens {
			r.OutputTokens = out
			seen = true
		}
		if c, ok := u["completion_tokens"].(float64); ok {
			completion := c
			if isNum(u["prompt_tokens"]) {
				completion = completionWithHiddenThinking(u)
			}
			if completion > r.OutputTokens {
				r.OutputTokens = completion
			}
			seen = true
		}
		// cortecs puts it on the final usage chunk, next to the token counts.
		if c := providerCost(u); c != nil {
			r.ProviderCost = c
		}
	}
	if !seen {
		return nil
	}
	return &r
}

// computeCostUsd is the catalog estimate of one request: per-request charge
// plus token cost. Missing cache rates fall back to read = 0.1x input, write
// = 1.25x input (the Anthropic multipliers, the safe direction for a cap). A
// long_context tier bills the whole request at its rates once the prompt (all
// three input buckets) crosses its threshold. Mirrors shared/pricing.ts
// computeCostUsd, which the api prices with at ingest; nothing bills from
// this one (it is the cost_usd key holders read on the proxy's GET /usage).
func computeCostUsd(m *Model, u Usage) float64 {
	prompt := u.InputTokens + u.CacheReadTokens + u.CacheWriteTokens
	in, out, read, write := m.Input, m.Output, m.CacheRead, m.CacheWrite
	if lc := m.LongContext; lc != nil && prompt > lc.AbovePromptTokens {
		in, out, read, write = lc.Input, lc.Output, &lc.CacheRead, &lc.CacheWrite
	}
	readRate := in * 0.1
	if read != nil {
		readRate = *read
	}
	writeRate := in * 1.25
	if write != nil {
		writeRate = *write
	}
	perRequest := 0.0
	if m.PerRequest != nil {
		perRequest = *m.PerRequest
	}
	return perRequest + (u.InputTokens*in+
		u.OutputTokens*out+
		u.CacheReadTokens*readRate+
		u.CacheWriteTokens*writeRate)/1_000_000
}
