import "./support/env.ts";
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import postgres from "postgres";
import { gateway, getSpentUsd } from "../gateway-db.ts";
import { stmt } from "../db.ts";
import { MAX_MULTIPART_BYTES, proxy } from "../routes/proxy.ts";

// POST /llm/openai/v1/audio/transcriptions through the real proxy route, with
// api.openai.com replaced by a fetch stub. Keys are real llm.keys rows (the
// same verification path as production); usage lands in the in-memory SQLite
// ledger and, for budgeted keys, the Postgres spend ledger.

const opts = { sanitizeOps: false, sanitizeResources: false };

const admin = postgres(
  Deno.env.get("GATEWAY_DATABASE_URL")!.replace(
    /\/\/[^@]+@/,
    "//postgres:postgres@",
  ),
  { connection: { search_path: "llm,public" }, onnotice: () => {} },
);

const app = new Hono();
app.route("/llm", proxy);

Deno.env.set("OPENAI_API_KEY", "sk-test-upstream");

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seedKey(
  models: string[],
): Promise<{ id: string; secret: string }> {
  const org = `org_stt_${crypto.randomUUID()}`;
  const [team] = await admin<{ id: string }[]>`
    INSERT INTO llm.teams (kamuid_org_id, name, slug)
    VALUES (${org}, 'Transcription Test', ${org})
    RETURNING id
  `;
  const secret = `sk_live_${crypto.randomUUID().replaceAll("-", "")}`;
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, budget_usd, status)
    VALUES (${team.id}, 'stt', ${await sha256Hex(secret)}, 'sk_live_test',
            'top', ${models}, 10, 'active')
    RETURNING id
  `;
  await admin`UPDATE llm.keys SET root_key_id = id WHERE id = ${key.id}`;
  return { id: key.id, secret };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
}

// Replaces global fetch for the duration of `fn`, answering every upstream
// call with `reply` and recording what the proxy sent.
async function withUpstream(
  reply: unknown,
  fn: (calls: Captured[]) => Promise<void>,
) {
  const calls: Captured[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      headers: req.headers,
      body: new Uint8Array(await req.arrayBuffer()),
    });
    return new Response(JSON.stringify(reply), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

function form(model: string | null, audioBytes = 1024): FormData {
  const f = new FormData();
  f.append("file", new File([new Uint8Array(audioBytes)], "note.webm"));
  if (model) f.append("model", model);
  f.append("language", "fi");
  return f;
}

async function post(
  secret: string,
  body: FormData | Uint8Array<ArrayBuffer>,
  type?: string,
) {
  const req = body instanceof FormData
    ? new Request("http://proxy/x", { method: "POST", body })
    : new Request("http://proxy/x", {
      method: "POST",
      body,
      headers: { "content-type": type! },
    });
  const bytes = new Uint8Array(await req.arrayBuffer());
  return await app.request("/llm/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": req.headers.get("content-type")!,
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
  });
}

// The metering tee runs after the response is returned; poll the ledger.
async function usageRows(keyId: string, want: number) {
  for (let i = 0; i < 100; i++) {
    const rows = stmt(
      `SELECT model, input_tokens, output_tokens, cost_usd
         FROM usage_log WHERE key_id = ?`,
    ).all(keyId) as Array<
      {
        model: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number | null;
      }
    >;
    if (rows.length >= want) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

Deno.test({
  name: "transcription: model from the form is authorized and usage is priced",
  fn: async () => {
    const key = await seedKey(["gpt-4o-mini-transcribe"]);
    const sent = form("gpt-4o-mini-transcribe");
    const reply = {
      text: "hei",
      usage: {
        type: "tokens",
        input_tokens: 1000,
        input_token_details: { text_tokens: 40, audio_tokens: 960 },
        output_tokens: 200,
        total_tokens: 1200,
      },
    };
    await withUpstream(reply, async (calls) => {
      const res = await post(key.secret, sent);
      assertEquals(res.status, 200);
      assertEquals((await res.json()).text, "hei");

      // Forwarded byte-for-byte with the caller's boundary, upstream key
      // swapped in.
      assertEquals(calls.length, 1);
      assertEquals(
        calls[0].url,
        "https://api.openai.com/v1/audio/transcriptions",
      );
      assertEquals(
        calls[0].headers.get("authorization"),
        "Bearer sk-test-upstream",
      );
      const expected = new Uint8Array(
        await new Request("http://x", { method: "POST", body: sent })
          .arrayBuffer(),
      );
      assertEquals(calls[0].body.byteLength, expected.byteLength);
      const upstreamForm = await new Request("http://x", {
        method: "POST",
        headers: { "content-type": calls[0].headers.get("content-type")! },
        body: calls[0].body,
      }).formData();
      assertEquals(upstreamForm.get("model"), "gpt-4o-mini-transcribe");
      assertEquals((upstreamForm.get("file") as File).size, 1024);
    });

    const [row] = await usageRows(key.id, 1);
    assertEquals(row.model, "gpt-4o-mini-transcribe");
    assertEquals(row.input_tokens, 1000);
    assertEquals(row.output_tokens, 200);
    // 1000 x $1.25/M + 200 x $5/M
    const want = (1000 * 1.25 + 200 * 5) / 1_000_000;
    assertAlmostEquals(row.cost_usd!, want, 1e-12);
    assertAlmostEquals(await getSpentUsd(key.id), want, 1e-9);
  },
  ...opts,
});

Deno.test({
  name:
    "transcription: a model the key does not grant is refused before upstream",
  fn: async () => {
    const key = await seedKey(["gpt-4o-mini-transcribe"]);
    await withUpstream({}, async (calls) => {
      const res = await post(key.secret, form("gpt-4o-transcribe"));
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error, "model_not_allowed");
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "transcription: whisper-1 passes through and records no usage",
  fn: async () => {
    const key = await seedKey(["whisper-1"]);
    const reply = { text: "hei", usage: { type: "duration", seconds: 4 } };
    await withUpstream(reply, async (calls) => {
      const res = await post(key.secret, form("whisper-1"));
      assertEquals(res.status, 200);
      assertEquals((await res.json()).text, "hei");
      assertEquals(calls.length, 1);
    });
    // Give the tee time to run; nothing priceable, so nothing recorded.
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(await usageRows(key.id, 1), []);
  },
  ...opts,
});

Deno.test({
  name: "transcription: oversized and malformed bodies are refused",
  fn: async () => {
    const key = await seedKey(["*"]);
    await withUpstream({}, async (calls) => {
      const big = await post(
        key.secret,
        form("gpt-4o-mini-transcribe", MAX_MULTIPART_BYTES + 1),
      );
      assertEquals(big.status, 413);

      const bad = await post(
        key.secret,
        new TextEncoder().encode("not a form"),
        "multipart/form-data; boundary=nope",
      );
      assertEquals(bad.status, 400);
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "transcription: close pools",
  fn: async () => {
    await admin.end();
    await gateway.end();
  },
  ...opts,
});
