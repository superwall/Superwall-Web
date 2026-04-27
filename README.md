# Superwall Web SDK

TypeScript SDK for **Superwall** in the browser, on the server, and inside React. Wire-compatible with the iOS / Android / Flutter SDKs (same config, collector, and enrichment endpoints) but designed for modern web — factory-created instances, reactive signals, `EventTarget`, module augmentation for typed user/placement params, React 19 Suspense.

> **Status: 0.0.1-alpha.** The headless core, browser presenter, React bindings, and a runnable example all ship. Real config-driven placement evaluation (audience rules, experiments) is **deferred** — see [`MISSING.md`](./MISSING.md). The full design spec lives in [`API.md`](./API.md).

---

## Packages

| Package | What | Runs in |
|---|---|---|
| [`@superwall/paywalls-js`](./packages/paywalls-js) | Headless core: factory, signals, `EventTarget`, identity, network, presenter contract. **No DOM refs at module load.** | Node, Bun, edge, workers, SSR, browser |
| [`@superwall/paywalls-js/browser`](./packages/paywalls-js/src/browser) | `createBrowserPresenter` (iframe overlay + postMessage v1) + `createBrowserStorage` (localStorage + cookie mirror). | Browser only |
| [`@superwall/paywalls-react`](./packages/paywalls-react) | `<SuperwallProvider>`, `useSuperwall`, `useSignal`, `useUser`, `usePlacement`, `useSuperwallEvent`, `useDelegate`. React 19. | Browser (SSR-safe imports) |
| [`@superwall/example-browser`](./example/example-browser) | Runnable Bun + vanilla TS demo. | Browser |

ESM-only.

---

## Install

```bash
# In your app:
bun add @superwall/paywalls-js                 # headless + browser subpath
bun add @superwall/paywalls-react react        # if you're using React
```

Workspace dev install:

```bash
bun install        # from the workspace root
```

---

## Quick start — vanilla TS

```ts
import { createSuperwall } from "@superwall/paywalls-js";
import { createBrowserPresenter, createBrowserStorage } from "@superwall/paywalls-js/browser";

const sw = createSuperwall({
  apiKey: "pk_web_…",
  presenter: createBrowserPresenter({ presentation: "modal" }),
  storage: createBrowserStorage(),
  options: {
    testModeBehavior: "automatic",      // shows window.confirm for purchases when active
    networkEnvironment: "release",
  },
});

// Optional — block until config + identity hydration land. Most methods
// internally `await sw.ready` so you don't need to.
await sw.ready;

await sw.user.identify("user_42");

// Listen on lifecycle events (typed CustomEvent)
const ac = new AbortController();
sw.events.addEventListener("subscriptionStatus_didChange", () => {
  console.log("status changed →", sw.subscriptionStatus.value);
}, { signal: ac.signal });

// Show a paywall (or skip if entitled)
const result = await sw.placements.register({
  placement: "checkout",
  feature: () => unlock(),                 // runs on entitled / purchased / non-gated skip
});

if (result.type === "presented" && result.result.type === "purchased") {
  console.log("Bought:", result.result.productId);
}
```

### Tree-shakeable singleton (Expo-style)

```ts
import { createSuperwall, user, placements, events } from "@superwall/paywalls-js";

createSuperwall({ apiKey: "pk_web_…" });   // first call registers the default

await user.identify("user_42");
const r = await placements.register({ placement: "checkout" });
events.addEventListener("paywall_close", (e) => console.log(e.detail));
```

If you only `import { user }`, the rest is dead code → ESM bundlers drop it.

---

## Quick start — React 19

```tsx
import { SuperwallProvider, useUser, usePlacement } from "@superwall/paywalls-react";
import { createBrowserPresenter } from "@superwall/paywalls-js/browser";

function App() {
  return (
    <SuperwallProvider
      apiKey="pk_web_…"
      presenter={createBrowserPresenter({ presentation: "modal" })}
    >
      <Home />
    </SuperwallProvider>
  );
}

function Home() {
  const { id, isLoggedIn, identify } = useUser();
  const { register, state } = usePlacement({
    onPresent: (info) => console.log("opened:", info.identifier),
    onDismiss: (_info, result) => console.log("dismissed:", result),
  });

  return (
    <>
      <button onClick={() => identify("user_42")}>Sign in</button>
      <button onClick={() => register({ placement: "checkout" })}>Upgrade</button>
      <p>userId: {id || "anonymous"} • paywall: {state.type}</p>
    </>
  );
}
```

### Gating render on configuration (optional)

By default every method internally awaits `sw.ready`, so you don't need a Suspense boundary. Use it only if you want a fallback while initial config + enrichment land:

```tsx
import { use, Suspense } from "react";
import { useSuperwall } from "@superwall/paywalls-react";

function ConfigGate({ children }: { children: React.ReactNode }) {
  use(useSuperwall().ready);                 // suspends until ready
  return <>{children}</>;
}

<SuperwallProvider apiKey="pk_web_…">
  <Suspense fallback={<Loading />}>
    <ConfigGate><Home /></ConfigGate>
  </Suspense>
</SuperwallProvider>
```

> **SSR caveat.** `use(sw.ready)` will suspend during server render — render eagerly server-side. The Provider hydrates with seeded identity from cookies; client-side re-render is automatic if the resolved identity differs.

---

## Common recipes

### Observer mode (no `PurchaseController`)

The default. Paywall purchase clicks dispatch `transaction_start` + a custom callback; you run your own checkout (Stripe, Paddle, …) and tell Superwall the result:

```ts
sw.events.addEventListener("transaction_start", async (e) => {
  const product = e.detail.product;
  const ok = await myStripe.checkout(product.id);
  if (ok) {
    sw.purchases.setSubscriptionStatus({
      status: "ACTIVE",
      entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: [product.id] }],
    });
  }
});
```

### Custom user / placement types

Module augmentation closes the shape — no generics on call sites:

```ts
// types.d.ts
declare module "@superwall/paywalls-js" {
  interface UserAttributes {
    email?: string;
    plan?: "free" | "pro" | "enterprise";
  }
  interface PlacementParams {
    screen?: string;
    referrer?: string;
  }
}

sw.user.setAttributes({ email: "a@b.co", plan: "pro" });    // ✅ typed
sw.user.setAttributes({ email: "a@b.co", plan: "premium" }); // ❌ TS error
```

### Custom presenter (BE / RN Web / test fixture)

Implement the `PaywallPresenter` interface:

```ts
import type { PaywallPresenter } from "@superwall/paywalls-js";

const myPresenter: PaywallPresenter = {
  async present(info, ctx) {
    // ... show your UI; return when the user dismisses
    return { type: "purchased", productId: "pro_yearly" };
  },
  dismiss() { /* tear down */ },
};

const sw = createSuperwall({ apiKey, presenter: myPresenter });
```

### Test mode

```ts
const sw = createSuperwall({
  apiKey,
  presenter: createBrowserPresenter({
    testMode: true,
    onTestPurchase: async (product) => {
      // Replace window.confirm with your own modal in tests / Storybook.
      return userClickedYes ? "purchased" : "declined";
    },
  }),
  options: { testModeBehavior: "always" },
});
```

### Global delegate (analytics / logging firehose)

```ts
sw.setDelegate({
  onEvent(name, detail) { analytics.track(name, detail); },
  onSubscriptionStatusChange(from, to) { /* … */ },
  onPaywallDidPresent(info) { /* … */ },
});
```

In React, prefer the hook (auto-cleanup):
```tsx
useDelegate({ onEvent: (name) => analytics.track(name) });
```

### Backend / SSR

```ts
import { createSuperwall } from "@superwall/paywalls-js";

// No /browser import; no presenter; pre-seed identity from cookies.
const sw = createSuperwall({
  apiKey,
  identity: {
    aliasId: req.cookies["_sw_alias_id"],
    appUserId: req.cookies["_sw_user_id"],
  },
});

// `register` requires a presenter — use getPresentationResult instead for
// pure server-side decisions:
const decision = await sw.placements.getPresentationResult("checkout");
// → { type: "paywallNotAvailable" } in v0 alpha (config processing pending — see MISSING.md)
```

---

## Architecture

Two distinct surfaces, separated by an `Effect.runPromise` firewall:

- **Public API: vanilla TS.** Promises, `EventTarget`, plain error classes (`NoPresenterRegisteredError`, `PaywallAlreadyPresentedError`, `NetworkError`, …), a minimal `Readable<T>` signal type. **No Effect types ever leak past the public surface.**
- **Internals: Effect.** `Effect.Service` + `Layer` + `SubscriptionRef` + `Schema.TaggedError` + `ManagedRuntime`. The `effect-best-practices` skill at [`.claude/skills/`](./.claude/skills) is the reference.
- **Translation:** internal tagged errors are caught at every `Effect.runPromise` boundary and rethrown as the documented public class (`StorageGetError → StorageError`, `IdentityNotHydratedError → NotConfiguredError`, etc.).

Why: idiomatic Effect inside (clean services, layered DI, structured concurrency, retry policies) without forcing consumers to learn Effect or pay a public-API churn cost when we upgrade `effect`.

Full architecture spec: [`API.md`](./API.md), §0 + §0.1.

---

## Development

```bash
bun install                                # workspace install (Bun workspaces)
bun run typecheck                          # turbo run typecheck (all packages)
bun run test                               # turbo run test (all packages)
bun run build                              # turbo run build (no-op in v0; ESM source ships as-is)

# Run the example (vanilla TS)
bun --filter @superwall/example-browser dev
# → http://localhost:3000
```

### Layout

```
Superwall-Web/
  package.json                            # workspace root, Bun + Turbo
  turbo.json
  tsconfig.base.json                      # strict TS + Effect language service plugin
  API.md                                  # full design spec
  MISSING.md                              # what's not in v0 alpha
  packages/
    paywalls-js/                          # headless core + /browser subpath
      src/                                # public modules
      src/internal/                       # Effect-only (not exported from barrel)
      src/browser/                        # browser presenter + storage
    paywalls-react/                       # React 19 bindings
  example/
    example-browser/                      # runnable Bun + TS demo
```

### Tests

`bun test` (no Jest, no vitest — Bun has a built-in runner). Browser-package tests use `@happy-dom/global-registrator` registered via `bunfig.toml` preload. React tests use `@testing-library/react`.

165 tests across the workspace.

### Effect language service

The `effect-language-service` TS plugin is wired into `tsconfig.base.json`. In VS Code: `F1 → "TypeScript: Select TypeScript Version" → "Use Workspace Version"` to get Effect-specific diagnostics.

---

## Wire compatibility

The web SDK shares config + collector + enrichment endpoints with iOS / Android / Flutter. Event names on the wire are taken **verbatim** from Android's `SuperwallEvent.kt` `rawName` (mixed `snake_case` + `camelSnake_suffix` per Android's convention) and reproduced exactly in `SuperwallEventMap` so dashboards, audience filters, and CEL expressions match cross-platform. See [`API.md`](./API.md) §11 for the full wire protocol.

---

## License

MIT
