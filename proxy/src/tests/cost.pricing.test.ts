import { assertAlmostEquals, assertEquals } from "@std/assert";
import { MODELS } from "../catalog.ts";
import { computeCostUsd, extractUsageFromJson } from "../cost.ts";

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
