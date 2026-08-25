import { Hono } from "@hono/hono";
import { Layout } from "../views/layout.tsx";
import { auth } from "../lib/auth.ts";

// Login page + the sign-in POST. No sign-up route lives here on purpose — the
// only way an admin_auth.user row is created is scripts/create-admin.ts
// (no self-service signup). This route only ever calls signInEmail.
export const authRoutes = new Hono();

authRoutes.get("/login", (c) => {
  const err = c.req.query("err");
  return c.html(
    <Layout title="Sign in">
      <div class="card" style="max-width:360px;margin:64px auto">
        <h2 style="margin-top:0">llm-proxy-admin</h2>
        {err ? <div class="err">Invalid email or password.</div> : null}
        <form method="post" action="/login">
          <div style="margin-bottom:10px">
            <input
              name="email"
              type="email"
              placeholder="email"
              required
              style="width:100%;box-sizing:border-box"
            />
          </div>
          <div style="margin-bottom:10px">
            <input
              name="password"
              type="password"
              placeholder="password"
              required
              style="width:100%;box-sizing:border-box"
            />
          </div>
          <button type="submit" style="width:100%">Sign in</button>
        </form>
      </div>
    </Layout>,
  );
});

authRoutes.post("/login", async (c) => {
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  if (res.status !== 200) {
    return c.redirect("/login?err=1");
  }
  // Forward better-auth's Set-Cookie onto our own redirect response.
  const setCookie = res.headers.get("set-cookie");
  const headers = new Headers({ Location: "/" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 302, headers });
});

authRoutes.post("/logout", async (c) => {
  const res = await auth.api.signOut({
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const setCookie = res.headers.get("set-cookie");
  const headers = new Headers({ Location: "/login" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 302, headers });
});
