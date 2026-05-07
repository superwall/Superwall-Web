// React hooks — sugar over the public `Superwall` instance + `Readable<T>`.
// Per API.md §9.3.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AllSuperwallEvents,
  CustomerInfo,
  Entitlement,
  IdentityOptions,
  IntegrationAttribute,
  PaywallInfo,
  PaywallResult,
  PaywallSkippedReason,
  Readable,
  RegisterPlacementArgs,
  RegisterPlacementResult,
  Superwall,
  SuperwallCustomEvent,
  SuperwallDelegate,
  SubscriptionStatus,
  UserAttributes,
} from "@superwall/paywalls-js";
import { useSuperwallContext } from "./provider.tsx";

// ---------------------------------------------------------------------------
// useSuperwall — raw instance access
// ---------------------------------------------------------------------------

export const useSuperwall = (): Superwall => useSuperwallContext();

// ---------------------------------------------------------------------------
// useSignal — bridge `Readable<T>` to React via useSyncExternalStore
// ---------------------------------------------------------------------------

/**
 * Subscribe to a `Readable<T>` and re-render on change. Stores the signal
 * in a ref so an unstable `signal` identity per render doesn't cause
 * `useSyncExternalStore` to re-subscribe on every render (which would
 * spin into an infinite re-render loop). The ref always points at the
 * latest signal; subscribe + getSnapshot read through it.
 */
export const useSignal = <T,>(signal: Readable<T>): T => {
  const ref = useRef(signal);
  ref.current = signal;
  const subscribe = useCallback(
    (onChange: () => void) => ref.current.subscribe(() => onChange()),
    [],
  );
  const getSnapshot = useCallback(() => ref.current.value, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

// ---------------------------------------------------------------------------
// useUser — flat view of the user namespace + bound methods
// ---------------------------------------------------------------------------

export interface UseUserResult {
  id: string;
  aliasId: string;
  effectiveId: string;
  isLoggedIn: boolean;
  attributes: UserAttributes;
  integrationAttributes: Partial<Record<IntegrationAttribute, string>>;
  subscriptionStatus: SubscriptionStatus;
  customerInfo: CustomerInfo | null;
  /** Active entitlements convenience — derived from subscriptionStatus. */
  entitlements: Entitlement[];

  identify: (userId: string, opts?: IdentityOptions) => Promise<void>;
  signOut: () => Promise<void>;
  setAttributes: (attrs: Partial<UserAttributes>) => void;
  setIntegrationAttribute: (
    attr: IntegrationAttribute,
    value: string | null,
  ) => void;
  setIntegrationAttributes: (
    attrs: Partial<Record<IntegrationAttribute, string | null>>,
  ) => void;
}

export const useUser = (): UseUserResult => {
  const sw = useSuperwall();
  return {
    id: useSignal(sw.user.id),
    aliasId: useSignal(sw.user.aliasId),
    effectiveId: useSignal(sw.user.effectiveId),
    isLoggedIn: useSignal(sw.user.isLoggedIn),
    attributes: useSignal(sw.user.attributes),
    integrationAttributes: useSignal(sw.user.integrationAttributes),
    subscriptionStatus: useSignal(sw.subscriptionStatus),
    customerInfo: useSignal(sw.customerInfo),
    entitlements: useSignal(sw.entitlements.active),
    identify: sw.user.identify,
    signOut: sw.user.signOut,
    setAttributes: sw.user.setAttributes,
    setIntegrationAttribute: sw.user.setIntegrationAttribute,
    setIntegrationAttributes: sw.user.setIntegrationAttributes,
  };
};

// ---------------------------------------------------------------------------
// usePlacement — per-component register + lifecycle state
// ---------------------------------------------------------------------------

export interface PaywallPresentationHandlerHooks {
  onPresent?(info: PaywallInfo): void;
  onDismiss?(info: PaywallInfo, result: PaywallResult): void;
  onError?(error: Error): void;
  onSkip?(reason: PaywallSkippedReason): void;
}

export type PaywallState =
  | { type: "idle" }
  | { type: "presented"; info: PaywallInfo }
  | { type: "dismissed"; info: PaywallInfo; result: PaywallResult }
  | { type: "skipped"; reason: PaywallSkippedReason }
  | { type: "error"; error: Error };

export interface UsePlacementResult {
  register: (args: RegisterPlacementArgs) => Promise<RegisterPlacementResult>;
  state: PaywallState;
}

/**
 * Returns a `register` function bound to the active Superwall + a `state`
 * reflecting the latest placement outcome from THIS hook's calls. Handler
 * callbacks fire alongside the global delegate. State is local to the
 * hook (one component's state, not the SDK's).
 */
export const usePlacement = (
  handler?: PaywallPresentationHandlerHooks,
): UsePlacementResult => {
  const sw = useSuperwall();
  const [state, setState] = useState<PaywallState>({ type: "idle" });

  // Latest-handler ref so the user can rely on closure-captured values
  // without re-binding `register` on every render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const register = useCallback(
    async (args: RegisterPlacementArgs): Promise<RegisterPlacementResult> => {
      const r = await sw.placements.register({
        ...args,
        handler: {
          onPresent: (info) => {
            setState({ type: "presented", info });
            try {
              handlerRef.current?.onPresent?.(info);
            } catch {
              /* swallow */
            }
          },
          onDismiss: (info, result) => {
            setState({ type: "dismissed", info, result });
            try {
              handlerRef.current?.onDismiss?.(info, result);
            } catch {
              /* swallow */
            }
          },
          onError: (error) => {
            setState({ type: "error", error });
            try {
              handlerRef.current?.onError?.(error);
            } catch {
              /* swallow */
            }
          },
          onSkip: (reason) => {
            setState({ type: "skipped", reason });
            try {
              handlerRef.current?.onSkip?.(reason);
            } catch {
              /* swallow */
            }
          },
        },
      });
      // For cases where the SDK returned a non-presented result without
      // firing handler callbacks (e.g. `entitled`), reflect that in state.
      if (r.type === "entitled") {
        setState({ type: "idle" });
      }
      return r;
    },
    [sw],
  );

  return { register, state };
};

// ---------------------------------------------------------------------------
// useSuperwallEvent — typed addEventListener with auto-cleanup
// ---------------------------------------------------------------------------

export const useSuperwallEvent = <K extends keyof AllSuperwallEvents>(
  type: K,
  listener: (event: SuperwallCustomEvent<K>) => void,
): void => {
  const sw = useSuperwall();
  // Latest-listener ref so the user can capture fresh closures without
  // re-attaching the listener every render.
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => {
    const ac = new AbortController();
    sw.events.addEventListener(
      type,
      (e) => listenerRef.current(e),
      { signal: ac.signal },
    );
    return () => ac.abort();
  }, [sw, type]);
};

// ---------------------------------------------------------------------------
// useDelegate — install a global SuperwallDelegate for the lifetime of the
// component. Multiple hooks can mount concurrently: each pushes onto a
// per-instance stack. The active delegate is always the top; unmount pops
// only the owner that pushed and re-installs whatever was below.
// ---------------------------------------------------------------------------

interface DelegateEntry {
  readonly id: symbol;
  readonly delegate: SuperwallDelegate | null;
}

const delegateStacks = new WeakMap<Superwall, DelegateEntry[]>();

const applyTop = (sw: Superwall): void => {
  const stack = delegateStacks.get(sw) ?? [];
  const top = stack.length === 0 ? null : (stack[stack.length - 1]!.delegate);
  sw.setDelegate(top);
};

export const useDelegate = (delegate: SuperwallDelegate | null): void => {
  const sw = useSuperwall();
  const ref = useRef(delegate);
  ref.current = delegate;
  useEffect(() => {
    const id = Symbol("useDelegate");
    // Always read latest delegate from the ref so callbacks see the current
    // closure values without re-mounting.
    const wrapped: SuperwallDelegate | null =
      ref.current === null
        ? null
        : new Proxy({} as SuperwallDelegate, {
            get(_t, prop: string) {
              const d = ref.current;
              return d ? (d as Record<string, unknown>)[prop] : undefined;
            },
          });
    const stack = delegateStacks.get(sw) ?? [];
    stack.push({ id, delegate: wrapped });
    delegateStacks.set(sw, stack);
    applyTop(sw);
    return () => {
      const current = delegateStacks.get(sw) ?? [];
      const next = current.filter((e) => e.id !== id);
      if (next.length === 0) delegateStacks.delete(sw);
      else delegateStacks.set(sw, next);
      applyTop(sw);
    };
  }, [sw]);
};
