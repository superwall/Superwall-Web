# @superwall/paywalls-react

React 19 bindings for the Superwall web SDK — a provider + hooks over
[`@superwall/paywalls-js`](https://www.npmjs.com/package/@superwall/paywalls-js).

```sh
bun add @superwall/paywalls-react   # or npm / pnpm / yarn
```

## Quick start

Wrap your app once:

```tsx
import { SuperwallProvider } from "@superwall/paywalls-react";

export function Root() {
  return (
    <SuperwallProvider apiKey="pk_your_public_key">
      <App />
    </SuperwallProvider>
  );
}
```

`SuperwallProvider` accepts the following props:

| Prop      | Type                | Description                                                                                          | Example                                     |
|-----------|---------------------|------------------------------------------------------------------------------------------------------|---------------------------------------------|
| `apiKey`  | `string`            | **Required.** Your Superwall public key.                                                             | `"pk_your_public_key"`                      |
| `storage` | `StorageAdapter?`   | Optional. Provide a storage layer to customize persistence behavior (defaults to localStorage).       | `myCustomStorage`                           |
| `delegate`| `SuperwallDelegate?`| Optional. Receives paywall and subscription events (like callbacks for onPresent, onDismiss, etc).   | `myDelegate`                                |
| `identity`| `{ appUserId?, aliasId?, vendorId? }?` | Optional. Seed identity on configure, e.g. from cookies on SSR hydration. | `{ appUserId: 'abc123' }` |
| `options` | `object?`           | Optional. Additional options for advanced configuration (see the paywalls-js docs for details).       | `{ networkEnvironment: "release" }`         |

Most apps will only need to provide `apiKey`, but you can pass the optional extras as needed.

```tsx
<SuperwallProvider
  apiKey="pk_your_public_key"
  storage={myCustomStorage}
  delegate={myDelegate}
  identity={{ appUserId: "123" }}
  options={{ networkEnvironment: "release" }}
>
  <App />
</SuperwallProvider>
```
## Placements

```tsx
import { usePlacement } from "@superwall/paywalls-react";

function GoPro() {
  const { register, state } = usePlacement({
    onPresent: (info) => {},
    onDismiss: (info, result) => {},
    onSkip: (reason) => {},
  });

  return (
    <button onClick={() => register({ placement: "campaign_trigger" })}>
      Go Pro {state.type === "presented" && "(open)"}
    </button>
  );
}
```

### Feature block

Pass a `feature` callback to run code when the user is entitled to access the
feature — i.e. already subscribed, or after a successful purchase/restore.
Mirrors the feature block in Superwall's native SDKs.

```tsx
function GoPro() {
  const { register, state } = usePlacement();

  return (
    <button
      onClick={() =>
        register({
          placement: "campaign_trigger",
          feature: () => router.push("/pro-content"),
        })
      }
    >
      Go Pro {state.type === "presented" && "(open)"}
    </button>
  );
}
```

`feature()` fires when:
- The user is already subscribed — paywall is skipped and the feature runs immediately
- The placement has no audience match / holdout — feature runs without showing a paywall
- The user completes a purchase or restore through the paywall

## SuperwallPaywall component

Declarative alternative to `usePlacement`. Calls `register()` on mount and
renders `children` when the user is entitled — i.e. the feature block fires.

```tsx
import { SuperwallPaywall } from "@superwall/paywalls-react";

function App() {
  return (
    <SuperwallPaywall placement="campaign_trigger" loading={<LoadingSpinner />}>
      <ProContent />
    </SuperwallPaywall>
  );
}
```

`loading` renders while the paywall is loading and is swapped out the moment it presents. `children` render once the user is entitled. Pass `inline` to mount the paywall iframe inside the component instead of as a full-viewport overlay. Optional handler props (`onPresent`, `onDismiss`, `onSkip`, `onError`) work the same as in `usePlacement`.

## Subscription status & user

```tsx
import { useUser } from "@superwall/paywalls-react";

function Status() {
  const { id, isLoggedIn, subscriptionStatus, entitlements, identify, signOut } =
    useUser();

  if (subscriptionStatus.status === "ACTIVE") return <Pro />;
  return <button onClick={() => identify("app_user_123")}>Log in</button>;
}
```

## Hooks

| Hook | What it gives you |
|------|-------------------|
| `useSuperwall()` | the raw `Superwall` instance |
| `usePlacement(handler?)` | `{ register, state }` |
| `useUser()` | reactive identity + subscription + `identify`/`signOut`/`setAttributes` |
| `useSignal(signal)` | subscribe to any SDK `Readable<T>` |
| `useSuperwallEvent(name, fn)` | typed event listener, auto-cleanup |
| `useDelegate(delegate)` | install [delegate callbacks](https://www.npmjs.com/package/@superwall/paywalls-js#delegate-methods) for the component's lifetime |

All of `@superwall/paywalls-js` is re-exported, so you don't need to depend on
both packages directly.

## License

MIT
