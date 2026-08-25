// admin/scripts/create-admin.ts
//
// Seeds the first (or an additional) admin_auth.user via better-auth's own
// signUpEmail, called programmatically (not over HTTP) so this stays a local
// script, not a route anyone else can hit. This is the ONLY way to create an
// admin_auth.user row — there is no self-service signup surface in the app
// itself (routes/auth.tsx exposes login/logout only).
//
// Usage (from admin/):
//   deno run --allow-net --allow-env --allow-read --allow-sys \
//     --env-file scripts/create-admin.ts --email you@kamuhub.dev --password 'xxxxxxxx'
//
// Mirrors scripts/dev-token.ts's style: parseArgs, fail-fast on missing
// required input, one line of output on success.

import { parseArgs } from "@std/cli/parse_args";
import { auth } from "../src/lib/auth.ts";

const args = parseArgs(Deno.args, {
  string: ["email", "password", "name"],
  default: { name: "Admin" },
});

if (!args.email || !args.password) {
  console.error(
    "Usage: create-admin.ts --email <email> --password <password> [--name <name>]",
  );
  Deno.exit(1);
}
if (args.password.length < 8) {
  console.error(
    "password must be at least 8 characters (better-auth's default minimum)",
  );
  Deno.exit(1);
}

const res = await auth.api.signUpEmail({
  body: { email: args.email, password: args.password, name: args.name },
  asResponse: true,
});

if (res.status !== 200) {
  console.error(`create-admin failed: HTTP ${res.status}`);
  console.error(await res.text());
  Deno.exit(1);
}

const body = await res.json();
console.log(
  `Created admin_auth.user: ${body.user?.email} (id=${body.user?.id})`,
);
