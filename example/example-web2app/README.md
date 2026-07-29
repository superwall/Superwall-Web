# example-web2app

Minimal browser example for [`@superwall/web2app`](../../packages/web2app):
presents a web2app (STRIPE-platform) paywall **embedded** on the page and
shows the **redemption codes** delivered to `onPurchaseComplete` — no
redirect.

```sh
# From the repo root — Bun.serve's HTML bundler resolves the published
# `dist/` entrypoints, so build the workspace packages once first:
bun install
bunx turbo run build

cd example/example-web2app
bun dev
```

Open http://localhost:3000, paste your web2app app's `pk_…` key (or pass
`?apiKey=pk_…&placement=…`), and hit **Show paywall**.

For real (non-test-mode) checkout, the serving origin must be listed under
the app's **Allowed Origins** in the Superwall dashboard.
