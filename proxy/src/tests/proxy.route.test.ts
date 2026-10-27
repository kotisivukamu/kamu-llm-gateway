import "./support/env.ts";
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import postgres from "postgres";
import { importJWK, SignJWT } from "jose";
import { gateway } from "../gateway-db.ts";
import { stmt } from "../db.ts";
import { MAX_MULTIPART_BYTES, proxy } from "../routes/proxy.ts";

// The real /llm proxy route (multipart transcription, provider path
// handling) with the upstream replaced by a fetch stub. Keys are real llm.keys rows (the
// same verification path as production); usage lands in the in-memory SQLite
// ledger only. The proxy writes no spend: the api charges it at ingest and
// sets keys 'over_budget', which the proxy answers with 402 (ADR 0003 §4).

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
  status = "active",
): Promise<{ id: string; secret: string; teamId: string }> {
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
            'top', ${models}, 10, ${status})
    RETURNING id
  `;
  await admin`UPDATE llm.keys SET root_key_id = id WHERE id = ${key.id}`;
  return { id: key.id, secret, teamId: team.id };
}

// Throwaway Ed25519 test key pair: the private half matches the test
// ED25519_PUBLIC_KEY in support/env.ts (same pair as usage.scope.test.ts).
const TEST_PRIVATE_KEY = "9eoI/HkwmmgkmKzs9yu8drtLyeglFbz5FIulBSRHXrk=";
const b64url = (b64: string) =>
  b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// A derived key row under `root`, and its signed JWT.
async function seedChild(
  root: { id: string; teamId: string },
  status = "active",
): Promise<{ id: string; jwt: string }> {
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_type, models, status, parent_key_id, root_key_id,
       expires_at)
    VALUES (${root.teamId}, 'child', 'derived', '{"*"}', ${status}, ${root.id},
            ${root.id}, now() + interval '1 hour')
    RETURNING id
  `;
  const signer = await importJWK({
    kty: "OKP",
    crv: "Ed25519",
    d: b64url(TEST_PRIVATE_KEY),
    x: b64url(Deno.env.get("ED25519_PUBLIC_KEY")!),
  }, "EdDSA");
  const jwt = await new SignJWT({ jti: key.id, sub: "root" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-ed25519-1" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(signer);
  return { id: key.id, jwt };
}

const GEMINI_REPLY = {
  choices: [{ message: { role: "assistant", content: "Hei" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 40 },
};

async function chat(credential: string) {
  Deno.env.set("GEMINI_API_KEY", "gemini-test-upstream");
  return await app.request("/llm/google/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gemini-3.1-flash-lite",
      messages: [{ role: "user", content: "Moi" }],
    }),
  });
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
  name:
    "transcription: model from the form is authorized and usage is metered, no spend written",
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
    // The budgeted key's spend is the api's to charge at ingest.
    const spend = await admin`
      SELECT 1 FROM llm.key_spend WHERE key_id = ${key.id}`;
    assertEquals(spend.length, 0);
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
  name: "google: /v1 is stripped before the Gemini OpenAI-compatible base",
  fn: async () => {
    const key = await seedKey(["gemini-3.1-flash-lite"]);
    Deno.env.set("GEMINI_API_KEY", "gemini-test-upstream");
    const reply = {
      choices: [{ message: { role: "assistant", content: "Hei" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 40 },
    };
    await withUpstream(reply, async (calls) => {
      const res = await app.request("/llm/google/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-3.1-flash-lite",
          messages: [{ role: "user", content: "Moi" }],
        }),
      });
      assertEquals(res.status, 200);
      assertEquals(
        calls[0].url,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
      assertEquals(
        calls[0].headers.get("authorization"),
        "Bearer gemini-test-upstream",
      );
    });
    const [row] = await usageRows(key.id, 1);
    assertEquals(row.output_tokens, 30);
    assertEquals(
      stmt(`SELECT provider_slug FROM usage_log WHERE key_id = ?`).get(key.id),
      { provider_slug: "google" },
    );
    assertAlmostEquals(row.cost_usd!, (10 * 0.25 + 30 * 1.5) / 1e6, 1e-12);
  },
  ...opts,
});

Deno.test({
  name: "jev: systemone is forwarded with the Jev key and logged per request",
  fn: async () => {
    const key = await seedKey(["jev-latest"]);
    Deno.env.set("JEV_API_KEY", "jev-test-upstream");
    const sent = {
      model: "jev-latest",
      state: "Previous: invoice question. New: thanks, paid now.",
      questions: {
        related: {
          type: "choice",
          instructions: "Is the new message part of the same conversation?",
          criteria: { yes: "Same topic", no: "A new topic" },
        },
      },
    };
    // No usage block: the row is logged anyway (per_request_cost_usd is set).
    const reply = {
      model: "jev-2026-10",
      answers: {
        related: {
          choice: "yes",
          confidence: 0.91,
          probabilities: { yes: 0.91, no: 0.09 },
        },
      },
    };
    await withUpstream(reply, async (calls) => {
      const res = await app.request("/llm/jev/v1/systemone", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(sent),
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), reply);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, "https://api.typesafe.ai/v1/systemone");
      assertEquals(
        calls[0].headers.get("authorization"),
        "Bearer jev-test-upstream",
      );
      assertEquals(
        calls[0].headers.get("typesafe-danger-zone-images"),
        null,
      );
      assertEquals(
        JSON.parse(new TextDecoder().decode(calls[0].body)),
        sent,
      );
    });
    const rows = await usageRows(key.id, 1);
    assertEquals(rows, [{
      model: "jev-latest",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    }]);
  },
  ...opts,
});

Deno.test({
  name: "jev: only /v1/systemone is reachable",
  fn: async () => {
    const key = await seedKey(["*"]);
    Deno.env.set("JEV_API_KEY", "jev-test-upstream");
    await withUpstream({}, async (calls) => {
      const res = await app.request("/llm/jev/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "jev-latest" }),
      });
      assertEquals(res.status, 403);
      assertEquals((await res.json()).error, "path_not_allowed");
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "jev: a caller can't switch images on through the regular route",
  fn: async () => {
    const key = await seedKey(["jev-latest"]);
    Deno.env.set("JEV_API_KEY", "jev-test-upstream");
    await withUpstream({}, async (calls) => {
      const res = await app.request("/llm/jev/v1/systemone", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.secret}`,
          "content-type": "application/json",
          "typesafe-danger-zone-images": "true",
        },
        body: JSON.stringify({ model: "jev-latest" }),
      });
      assertEquals(res.status, 200);
      assertEquals(
        calls[0].headers.get("typesafe-danger-zone-images"),
        null,
      );
    });
  },
  ...opts,
});

const IMAGE_QUESTION = {
  state: { img: "ref-1" },
  questions: {
    q: { type: "noul", instructions: "Is `img` mostly one colour?" },
  },
};

Deno.test({
  name:
    "jev-images: sends the danger-zone header and the base slug, logs the -images slug",
  fn: async () => {
    const key = await seedKey(["jev-latest-images"]);
    Deno.env.set("JEV_API_KEY", "jev-test-upstream");
    const sent = {
      model: "jev-latest-images",
      ...IMAGE_QUESTION,
      assets: {
        "ref-1": { type: "image", format: "png", data_base64: "iVBORw0KGgo=" },
      },
    };
    const reply = {
      answers: { q: { answer: "yes" } },
      usage: { input_tokens: 300, output_tokens: 2 },
    };
    await withUpstream(reply, async (calls) => {
      const res = await app.request("/llm/jev-images/v1/systemone", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(sent),
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), reply);
      assertEquals(calls[0].url, "https://api.typesafe.ai/v1/systemone");
      assertEquals(
        calls[0].headers.get("authorization"),
        "Bearer jev-test-upstream",
      );
      assertEquals(calls[0].headers.get("typesafe-danger-zone-images"), "true");
      assertEquals(
        JSON.parse(new TextDecoder().decode(calls[0].body)),
        { ...sent, model: "jev-latest" },
      );
    });
    const [row] = await usageRows(key.id, 1);
    assertEquals(row.model, "jev-latest-images");
    assertAlmostEquals(row.cost_usd!, 300 * 0.042 / 1e6, 1e-15);
    assertEquals(
      stmt(`SELECT provider_slug FROM usage_log WHERE key_id = ?`).get(key.id),
      { provider_slug: "jev-images" },
    );
  },
  ...opts,
});

Deno.test({
  name: "jev-images: refuses base Jev slugs and a missing model",
  fn: async () => {
    const key = await seedKey(["*"]);
    Deno.env.set("JEV_API_KEY", "jev-test-upstream");
    await withUpstream({}, async (calls) => {
      for (const body of [{ model: "jev-latest" }, {}]) {
        const res = await app.request("/llm/jev-images/v1/systemone", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, ...IMAGE_QUESTION }),
        });
        assertEquals(res.status, 400);
        assertEquals((await res.json()).error, "model_not_on_provider");
      }
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name:
    "jev-images: multipart rewrites the model in the request part, keeps the image part",
  fn: async () => {
    const key = await seedKey(["jev-1.14.0-images"]);
    Deno.env.set("JEV_API_KEY", "jev-test-upstream");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const form = new FormData();
    form.append(
      "request",
      new Blob([JSON.stringify({
        model: "jev-1.14.0-images",
        ...IMAGE_QUESTION,
        assets: { "ref-1": { type: "image", part: "shot" } },
      })], { type: "application/json" }),
    );
    form.append("shot", new File([png], "shot.png", { type: "image/png" }));
    await withUpstream({ answers: {} }, async (calls) => {
      const res = await app.request("/llm/jev-images/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${key.secret}` },
        body: form,
      });
      assertEquals(res.status, 200);
      assertEquals(calls[0].headers.get("typesafe-danger-zone-images"), "true");
      const upstream = await new Request("http://x.invalid", {
        method: "POST",
        headers: { "content-type": calls[0].headers.get("content-type")! },
        body: calls[0].body,
      }).formData();
      const request = JSON.parse(
        await (upstream.get("request") as File).text(),
      );
      assertEquals(request.model, "jev-1.14.0");
      assertEquals(request.assets, {
        "ref-1": { type: "image", part: "shot" },
      });
      const shot = upstream.get("shot") as File;
      assertEquals(shot.type, "image/png");
      assertEquals(new Uint8Array(await shot.arrayBuffer()), png);
    });
    const [row] = await usageRows(key.id, 1);
    assertEquals(row.model, "jev-1.14.0-images");
  },
  ...opts,
});

// --- Budgets (ADR 0003 §4) --------------------------------------------------

Deno.test({
  name: "budget: an over_budget key gets 402 budget_exceeded before upstream",
  fn: async () => {
    const key = await seedKey(["*"], "over_budget");
    await withUpstream(GEMINI_REPLY, async (calls) => {
      const res = await chat(key.secret);
      assertEquals(res.status, 402);
      assertEquals(await res.json(), { error: "budget_exceeded" });
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "budget: a revoked key still gets 401",
  fn: async () => {
    const key = await seedKey(["*"], "revoked");
    await withUpstream(GEMINI_REPLY, async (calls) => {
      const res = await chat(key.secret);
      assertEquals(res.status, 401);
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "budget: a derived key under an active root goes through",
  fn: async () => {
    const root = await seedKey(["*"]);
    const child = await seedChild(root);
    await withUpstream(GEMINI_REPLY, async (calls) => {
      const res = await chat(child.jwt);
      assertEquals(res.status, 200);
      assertEquals(calls.length, 1);
    });
  },
  ...opts,
});

Deno.test({
  name: "budget: an active derived key whose root is over_budget gets 402",
  fn: async () => {
    const root = await seedKey(["*"], "over_budget");
    const child = await seedChild(root);
    await withUpstream(GEMINI_REPLY, async (calls) => {
      const res = await chat(child.jwt);
      assertEquals(res.status, 402);
      assertEquals(await res.json(), { error: "budget_exceeded" });
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "budget: an active derived key whose root is revoked gets 401",
  fn: async () => {
    const root = await seedKey(["*"], "revoked");
    const child = await seedChild(root);
    await withUpstream(GEMINI_REPLY, async (calls) => {
      const res = await chat(child.jwt);
      assertEquals(res.status, 401);
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "budget: an over_budget derived key under an active root gets 402",
  fn: async () => {
    const root = await seedKey(["*"]);
    const child = await seedChild(root, "over_budget");
    await withUpstream(GEMINI_REPLY, async (calls) => {
      const res = await chat(child.jwt);
      assertEquals(res.status, 402);
      assertEquals(calls.length, 0);
    });
  },
  ...opts,
});

Deno.test({
  name: "proxy route: close pools",
  fn: async () => {
    await admin.end();
    await gateway.end();
  },
  ...opts,
});
