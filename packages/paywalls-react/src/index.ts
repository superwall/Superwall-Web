// @superwall/paywalls-react — React 19 bindings for the Superwall Web SDK.
// See /Users/ianrumac/Workspace/Superwall/Superwall-Web/API.md §9.

export { SDK_VERSION } from "@superwall/paywalls-js";

export {
  SuperwallProvider,
  type SuperwallProviderProps,
  useSuperwallContext,
} from "./provider.tsx";

export {
  useSuperwall,
  useSignal,
  useUser,
  usePlacement,
  useCustomPaywall,
  useSuperwallEvent,
  useDelegate,
  type UseUserResult,
  type UsePlacementResult,
  type UseCustomPaywallOptions,
  type UseCustomPaywallResult,
  type CustomPaywallMountSnapshot,
  type PaywallState,
  type PaywallPresentationHandlerHooks,
} from "./hooks.ts";

export {
  SuperwallPaywall,
  type SuperwallPaywallProps,
} from "./SuperwallPaywall.tsx";

// Re-export everything public from paywalls-js so React consumers don't
// need to depend on both packages directly. Tree-shakeable per ESM rules.
export * from "@superwall/paywalls-js";
