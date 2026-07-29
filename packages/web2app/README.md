# @superwall/web2app

The Superwall Web SDK, packaged for **web2app**: present the paywalls you
built in Superwall **embedded on your own site** — iframe overlay with
embedded Stripe checkout — and receive the **redemption code in a callback**
when the purchase completes. By default your page never navigates away.

This is a thin wrapper over [`@superwall/paywalls-js`](../paywalls-js) with
defaults for the web2app (STRIPE-platform) flow. The full Web SDK surface
stays available via the `superwall` escape hatch.

## Install

```sh
npm install @superwall/web2app
```

## Quick start

```ts
import { createWeb2App } from "@superwall/web2app";

const web2app = createWeb2App({
  // Your web2app app's PUBLIC key (Dashboard → your STRIPE-platform app →
  // Settings → Keys). Keys from other platforms won't present embedded.
  apiKey: "pk_...",

  onPurchaseComplete: ({ redemptionCodes, deepLinks, redemptionUrl }) => {
    // The purchase is redeemed in your MOBILE app with this code.
    console.log("purchased!", redemptionCodes);
    // e.g. show your own "check your phone" UI, or send the user onward:
    // location.href = deepLinks?.ios ?? redemptionUrl!;
  },
});

// Present a paywall for a placement — embedded, not a redirect:
await web2app.register({ placement: "pro_feature" });
```

Your site's origin must be listed under **Allowed Origins** in the app's
dashboard settings — that both authorizes checkout from your page and
registers the domain with your Stripe account so Apple Pay / Google Pay
render in the embedded checkout.

## Post-purchase behavior

By default (`afterPurchase: "stay"`) nothing happens to your page after
`onPurchaseComplete` — you own the UX. Alternatives:

```ts
createWeb2App({
  apiKey: "pk_...",
  onPurchaseComplete: handleResult,
  afterPurchase: "navigate",                       // dashboard-configured
                                                   // redirect URL, else the
                                                   // hosted redeem page
  // afterPurchase: { url: "/thanks" },            // always your URL
});
```

`onPurchaseComplete` receives every destination the backend resolved:

| Field             | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `redemptionCodes` | Public `redemption_…` codes the mobile app redeems                 |
| `redemptionUrl`   | Hosted redeem page (same codes, pre-encoded)                       |
| `deepLinks`       | `{ ios?, android? }` deep links straight into your app             |
| `manageUrl`       | Hosted subscription-management page                                |
| `redirectUrl`     | Your dashboard-configured post-purchase URL (codes appended), if set |

## What web2app does NOT do

Web2app purchases are **redeemed in your mobile app** — they never become
*web* entitlements. `subscriptionStatus` / `customerInfo` on the underlying
SDK won't flip on a web2app purchase; treat `onPurchaseComplete` as the
source of truth on this surface.

## Everything else

Identity, attributes, analytics, and dismissal proxy straight through:

```ts
await web2app.identify("user_123");
web2app.setUserAttributes({ plan_hint: "annual" });
web2app.track("onboarding_done");
web2app.dismiss();
```

Anything not on the wrapper is on `web2app.superwall` — the full
`@superwall/paywalls-js` instance.
