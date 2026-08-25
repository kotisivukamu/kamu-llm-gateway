/** @jsxImportSource @hono/hono/jsx */
import type { FC, PropsWithChildren } from "@hono/hono/jsx";

const style = `
  body { font-family: system-ui, sans-serif; margin: 0; background: #0b0d12; color: #e6e8eb; }
  header { padding: 12px 24px; border-bottom: 1px solid #2a2e37; display: flex; gap: 20px; align-items: center; }
  header a { color: #9fb4ff; text-decoration: none; font-size: 14px; }
  header a.brand { color: #fff; font-weight: 600; font-size: 15px; }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2a2e37; font-size: 13px; }
  th { color: #9098a8; font-weight: 500; }
  form.inline { display: inline; }
  input, button, select { background: #171a21; color: #e6e8eb; border: 1px solid #2a2e37; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  button { cursor: pointer; }
  button.danger { background: #3a1418; border-color: #7a2a30; color: #ffb4ba; }
  .card { background: #12141a; border: 1px solid #2a2e37; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .muted { color: #9098a8; font-size: 12px; }
  .flash { background: #14251a; border: 1px solid #2b5c3a; color: #b7f0c6; padding: 8px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  .err { background: #2a1416; border: 1px solid #6c2a30; color: #ffb4ba; padding: 8px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  code { background: #1c1f28; padding: 2px 6px; border-radius: 4px; }
`;

export const Layout: FC<PropsWithChildren<{ title: string; admin?: string }>> =
  (
    { title, admin, children },
  ) => (
    <html>
      <head>
        <meta charset="utf-8" />
        <title>{title} — llm-proxy-admin</title>
        <style>{style}</style>
      </head>
      <body>
        {admin
          ? (
            <header>
              <a class="brand" href="/">llm-proxy-admin</a>
              <a href="/usage">Usage</a>
              <a href="/keys">Keys</a>
              <a href="/settings">Settings</a>
              <span class="muted" style="margin-left:auto">{admin}</span>
              <form method="post" action="/logout" class="inline">
                <button type="submit">Sign out</button>
              </form>
            </header>
          )
          : null}
        <main>{children}</main>
      </body>
    </html>
  );
