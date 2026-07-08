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

const sw = createSuperwall({ apiKey: "pk_your_public_key" });

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
  storage,                           // optional — defaults to localStorage in browser
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

## Discounts (Stripe promotion codes)

While a paywall is presented, `sw.activePaywall` is a reactive handle
(`null` when nothing is up) that lets the host page apply a Stripe promotion
code programmatically — e.g. from a `?promo=SUMMER20` URL param or your own
redemption UI. (Paywall designers can also build fully in-paywall redemption
with a text input + a "Redeem Discount" action, which needs no SDK code.)

```ts
const paywall = sw.activePaywall.value;         // null when no paywall is presented
if (paywall) {
  const result = await paywall.redeemDiscount("SUMMER20");
  // { code, valid, reason?, appliedProductCount? }
  if (result.valid) showDiscountApplied(result.appliedProductCount);

  paywall.clearDiscount();                       // remove it (fire-and-forget)
}

// React to results — including in-paywall "Redeem Discount" button redemptions:
sw.activePaywall.subscribe((p) => { /* present / dismiss */ });
sw.events.addEventListener("discount_redeem_complete", (e) => {
  console.log(e.detail);                         // { code, appliedProductCount?, paywall_info }
});
sw.events.addEventListener("discount_redeem_fail", (e) => {
  console.log(e.detail);                         // { code, reason?, paywall_info }
});
```

Redemptions surface as the wire-bound `discount_redeem_complete` /
`discount_redeem_fail` events (mirroring `transaction_complete` /
`transaction_fail`) — they POST to the collector for analytics, hit the
`onEvent` delegate firehose, and carry `$presentation_id` auto-context so you
can correlate a redemption to its paywall session. They fire for SDK-initiated
redeems **and** in-paywall button redemptions, including failed attempts.

- **`redeemDiscount(code)`** validates the code against the checkout backend,
  re-prices the paywall's Stripe products, and forwards the code to every
  subsequent Stripe **web** checkout session. Resolves with the result, or after
  ~10s with `{ valid: false, reason: "timeout" }`. A second call supersedes an
  in-flight one (`reason: "superseded"`); dismissing the paywall settles a
  pending redeem as `reason: "paywall_dismissed"`. Rejects with a `DiscountError`
  on an empty code (use `clearDiscount()`), when no paywall is presented, or when
  a custom presenter has no message channel. Invalid `reason`s from the paywall:
  `code_not_found`, `code_invalid`, `no_valid_products`,
  `no_applicable_products`, `error` (the `reason` field is an open string union,
  so future paywall-runtime reasons pass through unchanged).
- **`clearDiscount()`** removes an applied discount (restores prices, re-enables
  Apple Pay). Fire-and-forget — the paywall doesn't acknowledge the clear.

**Scope:** Stripe web checkout only — native/StoreKit purchases are never
affected, and Apple Pay is automatically bypassed while a discount is applied
(the deferred Apple Pay quote flow can't carry a promotion code). The discount
does **not** survive dismissal — re-call `redeemDiscount(...)` after each
presentation (subscribe to `sw.activePaywall` or the `paywall_open` event).

For paywall designers, discount state is exposed to templates as
`products.{ref}.discountedPrice`, `originalPrice`, `hasDiscount`,
`discountDuration` (`"forever" | "once" | "repeating"`),
`discountDurationInMonths`, `discountPercentOff`, plus paywall-level
`state.hasAppliedDiscount` / `state.appliedDiscountCode`. Note `price`/`rawPrice`
are only rewritten for `forever` coupons — `once`/`repeating` keep the recurring
price and expose `discountedPrice` separately so templates don't overstate the
discount.

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
// subscription_start, trigger_fire, restore_*,
// discount_redeem_complete/fail, …
```

## License

MIT
