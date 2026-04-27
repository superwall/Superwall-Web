# @superwall/example-browser

Vanilla TypeScript browser example for `@superwall/paywalls-js`. Served by
`Bun.serve` with HTML imports — no Vite, no webpack.

## Run

From the workspace root:

```sh
bun install
bun --filter @superwall/example-browser dev
```

Then open <http://localhost:3000>.

Replace the `apiKey` in `src/app.ts` with your own key from the Superwall
dashboard. Test mode is on (`testModeBehavior: "always"`), so the paywall
iframe (when one exists) will use `window.confirm` for purchase simulation.
