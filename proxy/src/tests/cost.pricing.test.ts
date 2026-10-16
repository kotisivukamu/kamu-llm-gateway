import { assertAlmostEquals, assertEquals } from "@std/assert";
import { MODELS } from "../catalog.ts";
import {
  computeCostUsd,
  extractUsageFromJson,
  extractUsageFromSse,
} from "../cost.ts";

// Pricing rules in cost.ts that depend on catalog shape rather than plain
// per-token multiplication.

const usage = (
  input_tokens: number,
  output_tokens: number,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
) => ({ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens });

Deno.test("claude-haiku-5-5: base rates up to 100,000 prompt tokens", () => {
  const cost = computeCostUsd(
    MODELS["claude-haiku-5-5"],
    usage(50_000, 1_000, 40_000, 10_000), // prompt = exactly 100,000
  );
  const want = (50_000 * 0.1 + 1_000 * 0.5 + 40_000 * 0.01 + 10_000 * 0.125) /
    1e6;
  assertAlmostEquals(cost, want, 1e-12);
});

Deno.test("claude-haiku-5-5: the whole request moves to long-context rates past 100,000 prompt tokens, cache hits included", () => {
  // Fresh input alone is small; the cache read pushes the prompt over.
  const cost = computeCostUsd(
    MODELS["claude-haiku-5-5"],
    usage(1_000, 2_000, 99_001, 0),
  );
  const want = (1_000 * 0.5 + 2_000 * 2.5 + 99_001 * 0.05) / 1e6;
  assertAlmostEquals(cost, want, 1e-12);
});

Deno.test("models without a long_context tier ignore prompt length", () => {
  const cost = computeCostUsd(
    MODELS["claude-sonnet-5-5"],
    usage(500_000, 1_000, 200_000, 0),
  );
  assertAlmostEquals(
    cost,
    (500_000 * 2 + 1_000 * 10 + 200_000 * 0.1) / 1e6,
    1e-12,
  );
});

Deno.test("gpt-4o-transcribe usage block: audio + text input billed at the input rate", () => {
  const u = extractUsageFromJson({
    text: "x",
    usage: {
      type: "tokens",
      input_tokens: 300,
      input_token_details: { text_tokens: 20, audio_tokens: 280 },
      output_tokens: 50,
      total_tokens: 350,
    },
  });
  assertEquals(u, usage(300, 50));
  assertAlmostEquals(
    computeCostUsd(MODELS["gpt-4o-transcribe"], u!),
    (300 * 2.5 + 50 * 10) / 1e6,
    1e-12,
  );
});

Deno.test("whisper-1 duration usage yields nothing to price", () => {
  assertEquals(
    extractUsageFromJson({
      text: "x",
      usage: { type: "duration", seconds: 12 },
    }),
    null,
  );
});

Deno.test("Gemini thinking tokens hidden in total_tokens count as output", () => {
  const u = extractUsageFromJson({
    usage: { prompt_tokens: 50, completion_tokens: 33, total_tokens: 380 },
  });
  assertEquals(u, usage(50, 330));
  assertAlmostEquals(
    computeCostUsd(MODELS["gemini-3.8-flash"], u!),
    (50 * 0.75 + 330 * 3.75) / 1e6,
    1e-12,
  );
});

Deno.test("Gemini hidden thinking tokens are counted on a streamed response too", () => {
  const sse = [
    `data: {"choices":[{"delta":{"content":"Hei"}}]}`,
    `data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":33,"total_tokens":380}}`,
    "data: [DONE]",
  ].join("\n\n");
  assertEquals(extractUsageFromSse(sse), usage(50, 330));
});

Deno.test("total_tokens equal to the plain sum adds nothing", () => {
  assertEquals(
    extractUsageFromJson({
      usage: { prompt_tokens: 50, completion_tokens: 33, total_tokens: 83 },
    }),
    usage(50, 33),
  );
});

Deno.test("per_request_cost_usd is charged once per request on top of token cost", () => {
  const entry = {
    provider_slug: "jev",
    input_cost_per_mtok_usd: 1,
    output_cost_per_mtok_usd: 2,
    per_request_cost_usd: 0.003,
  };
  assertAlmostEquals(computeCostUsd(entry, usage(0, 0)), 0.003, 1e-12);
  assertAlmostEquals(
    computeCostUsd(entry, usage(1_000, 500)),
    0.003 + (1_000 * 1 + 500 * 2) / 1e6,
    1e-12,
  );
  // jev-latest: price unknown, logged at 0 until the catalog TODO is filled.
  assertEquals(computeCostUsd(MODELS["jev-latest"], usage(0, 0)), 0);
});
