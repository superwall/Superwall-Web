// `<SuperwallProvider>` — constructs a `Superwall` instance on mount and
// exposes it via React Context. Per API.md §9.1.
//
// HMR / Fast Refresh resilient (normative §9.1): the Provider holds the
// instance in a module-level registry keyed by `apiKey`. On unmount it
// disposes; on re-mount with the same `apiKey` (e.g. dev-server hot
// reload) it reuses the existing instance instead of building a new one,
// so iframes don't leak and event listeners don't stack.
//
// SSR-safe: on the server, `createSuperwall` is called with whatever
// identity seed the consumer passes; rendered children are eager (don't
// gate with `use(sw.ready)` server-side per API.md §9.2).

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  createSuperwall,
  type CreateSuperwallOptions,
  type Superwall,
} from "@superwall/paywalls-js";

const SuperwallContext = createContext<Superwall | null>(null);

// ---------------------------------------------------------------------------
// HMR-resilient registry — instances live for the page's lifetime.
//
// Production: a host app has one Provider per apiKey, mounted once, never
// unmounted until page navigation. Disposing on unmount is unnecessary
// and fights HMR (Fast Refresh tears down + re-mounts; the iframe and
// listeners would leak if we re-created the instance each time). Memory
// "leak" of one Superwall instance per apiKey for the page's lifetime is
// the intended trade-off.
//
// Tests use `_resetProviderRegistry()` between cases to avoid leakage.
// ---------------------------------------------------------------------------

const registry = new Map<string, Superwall>();

const acquire = (apiKey: string, opts: CreateSuperwallOptions): Superwall => {
  const existing = registry.get(apiKey);
  if (existing) return existing;
  const sw = createSuperwall(opts);
  registry.set(apiKey, sw);
  return sw;
};

/** Test-only — dispose every registered instance and clear the registry. */
export const _resetProviderRegistry = (): void => {
  for (const sw of registry.values()) {
    void sw.dispose();
  }
  registry.clear();
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SuperwallProviderProps extends CreateSuperwallOptions {
  children: ReactNode;
}

export const SuperwallProvider = ({
  children,
  ...opts
}: SuperwallProviderProps) => {
  // Acquire the registry-cached instance for this apiKey (first call
  // creates; subsequent calls reuse — see registry comment above).
  // `useMemo` keyed by apiKey is sufficient: changing `apiKey` swaps the
  // context value to the next instance; other config props are ignored
  // post-mount (config changes don't reconfigure the SDK in v0).
  const sw = useMemo(
    () => acquire(opts.apiKey, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.apiKey],
  );

  return (
    <SuperwallContext.Provider value={sw}>{children}</SuperwallContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Context consumer
// ---------------------------------------------------------------------------

export const useSuperwallContext = (): Superwall => {
  const sw = useContext(SuperwallContext);
  if (sw === null) {
    throw new Error(
      "useSuperwall (or its callers) must be used inside <SuperwallProvider>",
    );
  }
  return sw;
};
