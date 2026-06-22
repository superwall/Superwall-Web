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

`SuperwallProvider` takes the same config as `createSuperwall`
(`apiKey`, `storage`, `delegate`, `identity`, `options`).

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
