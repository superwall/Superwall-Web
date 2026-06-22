# @superwall/paywalls-js

Superwall SDK for the web — present paywalls, run placements, and track
subscription status from the browser. Framework-agnostic (vanilla TS/JS). For
React, use [`@superwall/paywalls-react`](https://www.npmjs.com/package/@superwall/paywalls-react).

```sh
bun add @superwall/paywalls-js   # or npm / pnpm / yarn
```

## Quick start

```ts
import { createSuperwall } from "@superwall/paywalls-js";
import { createBrowserStorage } from "@superwall/paywalls-js/browser";

const sw = createSuperwall({
  apiKey: "pk_your_public_key",
  storage: createBrowserStorage(), // persists identity + status across reloads
});

await sw.ready;

// Show the paywall configured for this placement (if the user matches).
await sw.register({ placement: "campaign_trigger" });
```

`register()` runs the full pipeline — audience rules, holdouts, assignments,
feature gating, analytics — and presents the paywall only when the user matches
a treatment variant. Checkout is handled for you inside the paywall.

## Configuration

```ts
createSuperwall({
  apiKey: "pk_...",                  // required — your public API key
  storage,                           // optional — see @superwall/paywalls-js/browser
  delegate,                          // optional — lifecycle callbacks (below)
  identity: { appUserId, aliasId },  // optional — seed identity
  options: {
    testModeBehavior: "always",      // "automatic" | "always" | "never"
    logging: { level: "info" },
    networkEnvironment: "release",   // or { custom: { base, collector, ... } }
  },
});
```

## Placements

```ts
const result = await sw.register({
  placement: "campaign_trigger",
  params: { source: "home" },                 // audience-rule inputs
  feature: () => unlockProFeature(),          // runs when entitled / non-gated
  handler: {
    onPresent: (info) => {},
    onDismiss: (info, result) => {},
    onSkip: (reason) => {},                    // no match / holdout / subscribed
    onError: (err) => {},
  },
});
// result.type: "presented" | "skipped" | "error"
```

## Subscription status & entitlements

Status is reactive and persists across reloads — gate your UI on it.

```ts
sw.subscriptionStatus.value;                  // { status: "ACTIVE" | "INACTIVE" | "UNKNOWN", ... }
sw.subscriptionStatus.subscribe((s) => { ... });
sw.entitlements.active.value;                 // Entitlement[]

if (sw.subscriptionStatus.value.status === "ACTIVE") showPro();
```

> Client-side status is for UX only — it's editable from devtools. Gate real
> server resources with [`@superwall/server`](https://www.npmjs.com/package/@superwall/server)
> or [`@superwall/verify`](https://www.npmjs.com/package/@superwall/verify).

## Identity

```ts
await sw.user.identify("app_user_123");
sw.user.setAttributes({ plan: "pro", email: "a@b.co" });
await sw.user.signOut();
await sw.reset();                             // clear user state (keeps config)
```

## Delegate methods

Pass `delegate` to `createSuperwall` (or `sw.setDelegate(...)`). All optional:

```ts
const delegate = {
  // subscription / customer
  onSubscriptionStatusChange(from, to) {},
  onCustomerInfoChange(from, to) {},
  onUserAttributesChange(attrs) {},

  // paywall lifecycle
  onPaywallWillPresent(info) {},
  onPaywallDidPresent(info) {},
  onPaywallWillDismiss(info) {},
  onPaywallDidDismiss(info) {},
  onPaywallWillOpenURL(url) {},
  onPaywallWillOpenDeepLink(url) {},          // you route it into your app

  // misc
  onCustomPaywallAction(name) {},
  onLog(level, scope, message, info, error) {},
};
```

Or subscribe to the typed event bus directly:

```ts
sw.events.addEventListener("transaction_complete", (e) => { ... });
// paywall_open, paywall_close, transaction_start/complete/abandon/fail,
// subscription_start, trigger_fire, restore_*, …
```

## License

MIT
