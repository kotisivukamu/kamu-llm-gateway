// Turns an upstream LLM response into an estimated USD cost, using the static
// per-model prices in catalog.ts (the math is in shared/pricing.ts). Runs off
// the hot path: proxy.ts tees the response and this code prices the buffered
// copy in the background.
//
// Normalisation rule: usage collapses into four buckets —
//   input_tokens        fresh (uncached) prompt tokens, billed at the input rate
//   output_tokens       completion tokens, billed at the output rate
//   cache_read_tokens   prompt tokens served from the provider's cache
//   cache_write_tokens  prompt tokens written into the provider's cache
// Cache buckets are priced with the catalog's cache rates (Anthropic: reads at
// 0.1x input, 5-minute writes at 1.25x input). Folding them into input at the
// full rate — the pre-2026-08 behaviour — over-counted real builds ~4x,
// because cache reads dominate agentic traffic.

import type { NormUsage } from "@shared/pricing.ts";

export type { NormUsage };

// deno-lint-ignore no-explicit-any
type Json = any;

export const NO_USAGE: NormUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

// Gemini's OpenAI layer leaves thinking tokens out of completion_tokens
// and shows them only in total_tokens, while billing them as output. The
// gap is zero on every other provider, where total is the plain sum.
function completionWithHiddenThinking(u: Json): number {
  const completion = num(u.completion_tokens);
  const unreported = Math.max(
    0,
    num(u.total_tokens) - u.prompt_tokens - completion,
  );
  return completion + unreported;
}

// Pulls normalised usage out of a single parsed JSON object, covering both the
// Anthropic Messages shape (usage.input_tokens excludes the cache_* buckets,
// which arrive as separate fields; OpenAI's gpt-4o-*-transcribe responses
// share it: input_tokens = audio + text, no cache fields) and the
// OpenAI-compatible shape
// (usage.prompt_tokens INCLUDES cached tokens; the cached share is reported in
// prompt_tokens_details.cached_tokens, or prompt_cache_hit_tokens on DeepSeek's
// native API).
function usageFromObject(obj: Json): NormUsage | null {
  const u = obj?.usage ?? obj?.message?.usage;
  if (!u || typeof u !== "object") return null;

  if (typeof u.input_tokens === "number") {
    // Anthropic. input_tokens is the uncached remainder only.
    return {
      input_tokens: u.input_tokens,
      output_tokens: num(u.output_tokens),
      cache_read_tokens: num(u.cache_read_input_tokens),
      cache_write_tokens: num(u.cache_creation_input_tokens),
    };
  }

  if (typeof u.prompt_tokens === "number") {
    // OpenAI-compatible. prompt_tokens includes cached tokens, so subtract the
    // cached share out into its own bucket. OpenAI-compat providers don't
    // report cache writes separately — a write is a normal miss, already
    // counted (and priced) as fresh input.
    const cached = num(u.prompt_tokens_details?.cached_tokens) ||
      num(u.prompt_cache_hit_tokens);
    return {
      input_tokens: Math.max(0, u.prompt_tokens - cached),
      output_tokens: completionWithHiddenThinking(u),
      cache_read_tokens: cached,
      cache_write_tokens: 0,
    };
  }

  return null;
}

// Non-streaming JSON response body (already parsed).
export function extractUsageFromJson(body: unknown): NormUsage | null {
  return usageFromObject(body);
}

// Streaming (SSE) response body, buffered to a string. Usage arrives spread
// across events:
//   - Anthropic: `message_start` carries input (+ cache) tokens; the final
//     `message_delta` carries the cumulative `output_tokens`.
//   - OpenAI: a single trailing chunk carries the full usage block, but only
//     when the caller sent `stream_options: { include_usage: true }`. If they
//     didn't, there is no usage to read and we return null (that request is
//     un-metered — see the enforcement note in proxy.ts).
// We take input/cache from whichever event supplies them and keep the largest
// output value seen (Anthropic's output_tokens is cumulative across
// message_delta).
export function extractUsageFromSse(text: string): NormUsage | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let seen = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let obj: Json;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }

    // Read whichever usage bucket this event happens to carry. Unlike a
    // complete JSON body, individual SSE events are partial: Anthropic's
    // `message_start` has input (+ cache) and an initial output_tokens, its
    // `message_delta` events carry only the growing output_tokens, and an
    // OpenAI include_usage chunk carries the whole block at once.
    const u = obj?.usage ?? obj?.message?.usage;
    if (!u || typeof u !== "object") continue;

    if (typeof u.input_tokens === "number") {
      input = u.input_tokens;
      cacheRead = num(u.cache_read_input_tokens);
      cacheWrite = num(u.cache_creation_input_tokens);
      seen = true;
    }
    if (typeof u.prompt_tokens === "number") {
      const cached = num(u.prompt_tokens_details?.cached_tokens) ||
        num(u.prompt_cache_hit_tokens);
      input = Math.max(0, u.prompt_tokens - cached);
      cacheRead = cached;
      seen = true;
    }
    if (typeof u.output_tokens === "number" && u.output_tokens > output) {
      output = u.output_tokens;
      seen = true;
    }
    if (typeof u.completion_tokens === "number") {
      const completion = typeof u.prompt_tokens === "number"
        ? completionWithHiddenThinking(u)
        : u.completion_tokens;
      if (completion > output) output = completion;
      seen = true;
    }
  }

  return seen
    ? {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    }
    : null;
}

// The cost math itself lives in shared/ so the api poller can price at
// ingest with the same rules (ADR 0003).
export { computeCostUsd } from "@shared/pricing.ts";
