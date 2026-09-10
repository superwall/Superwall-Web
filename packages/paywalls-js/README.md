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
    isSandbox: true,                 // purchases aren't real money — see below
    paywalls: {
      postPurchaseRedirect: "navigate", // or "newTab" — see Post-purchase behaviors
    },
  },
});
```

`isSandbox` tells the backend to route this surface's transactions and
redemptions to its test environment. It defaults to whether the SDK is in test
mode (`testModeBehavior: "always"`). Set it yourself when your checkout runs on
Stripe **test keys** — that lives server-side, so the SDK can't detect it.

`platformWrapper` (default `"Web"`) identifies a wrapper SDK built on this one;
`@superwall/paywalls-react` sets it to `"React"`. Apps using the SDK directly
don't need it.

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

## Post-purchase behaviors

Each paywall's checkout is configured in the dashboard with what happens after a
successful purchase. The SDK acts on it when the purchase completes:

| Behavior | What the SDK does |
|---|---|
| `GRANT_ACCESS` | Nothing extra — access comes through web entitlements. |
| `REDIRECT` | Navigates the current tab to your configured URL. |
| `REDEEM` | Hands you redemption codes to attach the purchase to a user in your app. |
| `CUSTOM` | Hands you redemption codes; you decide what to do with them. No navigation. |

Whatever the behavior, the SDK refreshes entitlements after every successful
purchase, so `subscriptionStatus` reflects what the backend actually granted.

The resolved behavior and any codes ride the purchased result, so they reach
both `register()`'s return value and `handler.onDismiss`:

```ts
const result = await sw.register({ placement: "upgrade" });
if (result.type === "presented" && result.result.type === "purchased") {
  const { postPurchaseBehavior, redemptionCodes } = result.result;
  // postPurchaseBehavior: "GRANT_ACCESS" | "REDIRECT" | "REDEEM" | "CUSTOM"
  if (redemptionCodes) sendToYourApp(redemptionCodes); // ["redemption_…"]
}
```

Codes also arrive through the `redemptionCodesReceived` event and the
`onRedemptionCodesReceived` delegate method — useful when purchases can start
from places other than your own `register()` call:

```ts
sw.events.addEventListener("redemptionCodesReceived", (e) => {
  const { codes, productId, checkoutContextId, paywallInfo, behavior } = e.detail;
});
```

Codes are prefixed `redemption_…` — pass them along as-is. The event is
local-only: it's never sent to Superwall's collector, since the backend already
records the redemption itself. `postPurchaseBehavior` and `behavior` are absent
on paywalls that predate the field.

### Redirects

`REDIRECT` navigates the **current tab** by default. The SDK resolves the
purchase before it starts navigating, but the page is on its way out — do
anything that must finish before leaving (saving state, analytics) in a
`paywallWillOpenURL` listener, which fires first.

A new tab isn't the default because the completion message arrives without a
user gesture, so browsers popup-block `window.open` — the redirect would silently
vanish. If your page can't afford to lose state, opt in anyway and accept that
some browsers will block it:

```ts
createSuperwall({ apiKey, options: { paywalls: { postPurchaseRedirect: "newTab" } } });
```

Or route it yourself — `paywallWillOpenURL` (and the `onPaywallWillOpenURL`
delegate method) fires with the URL before the SDK navigates:

```ts
sw.events.addEventListener("paywallWillOpenURL", (e) => router.push(e.detail.url));
```

### Redeeming a code

`sw.redeem(code)` redeems a `redemption_…` code for the current user — for codes
you received from a `REDEEM` / `CUSTOM` purchase, from another device, or from
your own backend:

```ts
const r = await sw.redeem("redemption_abc123");
// { type: "success", code, entitlements }
// { type: "expired" | "invalid", code }
// { type: "error", code, error }
```

On success, `customerInfo` updates from the response and `subscriptionStatus`
flips to `ACTIVE` if the code granted entitlements. It never throws — failures
resolve with the types above — and it fires the `onWillRedeemLink` /
`onDidRedeemLink` delegate methods. It works whether or not you supply a custom
`purchaseController`.

With the default purchase controller, a page loaded with a `?code=redemption_…`
URL param is redeemed automatically at startup, so you only need `sw.redeem()`
for codes that reach you some other way. A custom `purchaseController` skips the
automatic redeem — call `sw.redeem()` yourself in that case.

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
  onPaywallWillOpenURL(url) {},               // also fires before a REDIRECT
  onPaywallWillOpenDeepLink(url) {},          // you route it into your app

  // redemption
  onRedemptionCodesReceived(codes, info) {},  // REDEEM / CUSTOM purchase completed
  onWillRedeemLink() {},                      // about to redeem a code
  onDidRedeemLink(result) {},                 // { type: "success" | "expired" | "invalid" | "error", code, … }

  // misc
  onCustomPaywallAction(name) {},
  onEvent(name, detail) {},                   // every event sent to Superwall
  onLog(level, scope, message, info, error) {},
};
```

`onWillRedeemLink` / `onDidRedeemLink` fire for both a `sw.redeem(code)` call
and the automatic `?code=redemption_…` redeem at startup (default controller
only). `onEvent` receives
every event that's sent to Superwall's collector, including your own
`sw.track(...)` calls. It skips local-only events —
`redemptionCodesReceived`, `paywallWillOpenURL`, `paywallWillOpenDeepLink`,
`customPaywallAction` — which have their own delegate methods above.

Or subscribe to the typed event bus directly:

```ts
sw.events.addEventListener("transaction_complete", (e) => { ... });
// paywall_open, paywall_close, transaction_start/complete/abandon/fail,
// subscription_start, trigger_fire, restore_*,
// discount_redeem_complete/fail, redemptionCodesReceived, …
```

## License

MIT
