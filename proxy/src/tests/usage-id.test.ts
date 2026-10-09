import "./support/env.ts";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { recordUsage, uuidv7 } from "../db.ts";

// usage_id is the poller's dedupe key and cursor across proxy machines, so it
// must be a valid UUID (it lands in a Postgres uuid column) and sort by time
// as a plain string.

Deno.test("uuidv7: valid UUID with version 7 and the RFC variant", () => {
  assertMatch(
    uuidv7(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

Deno.test("uuidv7: strictly increasing, also within one millisecond", () => {
  const t = Date.parse("2030-01-01T00:00:00Z");
  let prev = uuidv7(t);
  for (let i = 0; i < 10_000; i++) {
    const next = uuidv7(t); // same ms every time, past the 4096 counter
    assert(next > prev);
    prev = next;
  }
});

Deno.test("uuidv7: a later millisecond always sorts after an earlier one", () => {
  const t = Date.parse("2031-01-01T00:00:00Z");
  for (let i = 0; i < 1000; i++) {
    assert(uuidv7(t + 2 * i) < uuidv7(t + 2 * i + 1));
  }
  // The id starts with its millisecond timestamp in hex. (A time later than
  // anything above: the generator never goes backwards.)
  const u = Date.parse("2032-01-01T00:00:00Z").toString(16).padStart(12, "0");
  assertEquals(
    uuidv7(Date.parse("2032-01-01T00:00:00Z")).slice(0, 13),
    `${u.slice(0, 8)}-${u.slice(8)}`,
  );
});

Deno.test("GET /usage?after= pages by usage_id and returns machine_id", async () => {
  const { usage } = await import("../routes/usage.ts");
  const key = crypto.randomUUID();
  for (let i = 0; i < 3; i++) {
    recordUsage({
      key_id: key,
      name: "after-test",
      parent_key_id: null,
      root_key_id: key,
      model: "m",
      input_tokens: i,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: null,
    });
  }
  const get = async (after: string) => {
    const res = await usage.request(`/?after=${after}&key_id=${key}`, {
      headers: { authorization: "Bearer test-poll-token" },
    });
    return (await res.json()).rows as Array<
      { usage_id: string; machine_id: string; input_tokens: number }
    >;
  };
  const all = await get("0");
  assertEquals(all.map((r) => r.input_tokens), [0, 1, 2]);
  assertEquals(all[0].machine_id, "local");
  const rest = await get(all[0].usage_id);
  assertEquals(rest.map((r) => r.input_tokens), [1, 2]);
});
