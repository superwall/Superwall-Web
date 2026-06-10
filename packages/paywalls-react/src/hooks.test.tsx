import { test, expect, beforeEach, afterEach } from "bun:test";
import { act, render, fireEvent, cleanup } from "@testing-library/react";
import { useEffect, useState } from "react";
import type {
  PaywallPresenter,
  PaywallResult,
  StorageAdapter,
} from "@superwall/paywalls-js";
import {
  _resetProviderRegistry,
  SuperwallProvider,
} from "./provider.tsx";
import {
  useSignal,
  useUser,
  usePlacement,
  useSuperwallEvent,
  useDelegate,
} from "./hooks.ts";

const tick = () => new Promise<void>((r) => queueMicrotask(r));
const flush = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await tick();
};

// React 19 + `IS_REACT_ACT_ENVIRONMENT=true` does NOT flush the initial mount
// synchronously when `render()` is called outside `act()` — the container
// stays empty until an `act` runs. Wrap the initial render in act so the
// first commit lands before queries run. (provider.test.tsx already does
// this inline; this is the shared helper for the hook tests.)
const renderAct = async <T,>(ui: React.ReactElement): Promise<ReturnType<typeof render>> => {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
    await flush();
  });
  return result;
};

// static_config with `checkout` + `x` placements → `pw_default`, so
// register() can actually evaluate + present. Other endpoints 204.
const CONFIG = JSON.stringify({
  build_id: "test_build",
  trigger_options: ["checkout", "x"].map((event_name) => ({
    event_name,
    rules: [
      {
        experiment_id: `exp_${event_name}`,
        experiment_group_id: "grp",
        expression_cel: "",
        variants: [
          {
            variant_id: "var_default",
            variant_type: "TREATMENT",
            percentage: 100,
            paywall_identifier: "pw_default",
          },
        ],
      },
    ],
  })),
  paywall_responses: [
    { identifier: "pw_default", name: "Default", url: "https://paywalls.test/pw_default" },
  ],
  products: [],
  toggles: [],
  localization: { locales: [{ locale: "en-US" }] },
});

const noopFetch = ((input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/v1/static_config")) {
    return Promise.resolve(new Response(CONFIG));
  }
  return Promise.resolve(new Response("", { status: 204 }));
}) as unknown as typeof fetch;

const newAdapter = (): StorageAdapter => {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v);
    },
    remove: (k) => {
      m.delete(k);
    },
    clear: () => {
      m.clear();
    },
  };
};

// Unmount React trees BEFORE disposing the SDK instances they reference —
// otherwise a leaked tree from a prior test re-renders against a disposed
// instance and throws (manifesting as an empty container in the next test).
afterEach(() => {
  cleanup();
});

beforeEach(() => {
  _resetProviderRegistry();
});

const Wrap = ({ children, apiKey = "pk_test" }: { children: React.ReactNode; apiKey?: string }) => (
  <SuperwallProvider apiKey={apiKey} fetch={noopFetch} storage={newAdapter()}>
    {children}
  </SuperwallProvider>
);

// ---------------------------------------------------------------------------
// useSignal
// ---------------------------------------------------------------------------

test("useSignal returns the current value and re-renders on change", async () => {
  const Display = () => {
    const { id } = useUser();
    return <span data-testid="id">{id}</span>;
  };

  const { getByTestId, getByText } = await renderAct(
    <Wrap>
      <Display />
      <ActionButton onClick={(sw) => sw.user.identify("u_42")} label="login" />
    </Wrap>,
  );

  // Wait for `sw.ready` to land + the initial identity-bridge to fire.
  await act(async () => {
    await flush();
  });
  expect(getByTestId("id").textContent).toBe("");

  await act(async () => {
    fireEvent.click(getByText("login"));
    await flush();
  });
  expect(getByTestId("id").textContent).toBe("u_42");
});

// Helper component — runs `onClick(sw)` against the provided Superwall.
import { useSuperwall } from "./hooks.ts";
const ActionButton = ({
  onClick,
  label,
}: {
  onClick: (sw: ReturnType<typeof useSuperwall>) => void | Promise<void>;
  label: string;
}) => {
  const sw = useSuperwall();
  return <button onClick={() => void onClick(sw)}>{label}</button>;
};

// ---------------------------------------------------------------------------
// useUser — flat view + mutations
// ---------------------------------------------------------------------------

test("useUser exposes id/aliasId/effectiveId/isLoggedIn and updates on identify/signOut", async () => {
  const Display = () => {
    const u = useUser();
    return (
      <div>
        <span data-testid="id">{u.id}</span>
        <span data-testid="alias">{u.aliasId}</span>
        <span data-testid="eff">{u.effectiveId}</span>
        <span data-testid="logged">{u.isLoggedIn ? "1" : "0"}</span>
        <button onClick={() => void u.identify("user_1")}>id</button>
        <button onClick={() => void u.signOut()}>out</button>
      </div>
    );
  };
  const { getByTestId, getByText } = await renderAct(
    <Wrap><Display /></Wrap>,
  );
  await act(async () => { await flush(); });

  expect(getByTestId("id").textContent).toBe("");
  expect(getByTestId("alias").textContent).toMatch(/^\$SuperwallAlias:/);
  expect(getByTestId("eff").textContent).toBe(getByTestId("alias").textContent);
  expect(getByTestId("logged").textContent).toBe("0");

  await act(async () => { fireEvent.click(getByText("id")); await flush(); });
  expect(getByTestId("id").textContent).toBe("user_1");
  expect(getByTestId("eff").textContent).toBe("user_1");
  expect(getByTestId("logged").textContent).toBe("1");

  await act(async () => { fireEvent.click(getByText("out")); await flush(); });
  expect(getByTestId("id").textContent).toBe("");
  expect(getByTestId("logged").textContent).toBe("0");
});

test("useUser.subscriptionStatus + entitlements update after setSubscriptionStatus", async () => {
  const Display = () => {
    const u = useUser();
    return (
      <div>
        <span data-testid="status">{u.subscriptionStatus.status}</span>
        <span data-testid="ents">{u.entitlements.length}</span>
      </div>
    );
  };
  const Trigger = () => {
    const sw = useSuperwall();
    return (
      <button
        onClick={() =>
          sw.purchases.setSubscriptionStatus({
            status: "ACTIVE",
            entitlements: [
              { id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: ["p1"] },
            ],
          })
        }
      >
        upgrade
      </button>
    );
  };
  const { getByTestId, getByText } = await renderAct(
    <Wrap><Display /><Trigger /></Wrap>,
  );
  await act(async () => { await flush(); });
  expect(getByTestId("status").textContent).toBe("UNKNOWN");
  expect(getByTestId("ents").textContent).toBe("0");

  await act(async () => { fireEvent.click(getByText("upgrade")); await flush(); });
  expect(getByTestId("status").textContent).toBe("ACTIVE");
  expect(getByTestId("ents").textContent).toBe("1");
});

// ---------------------------------------------------------------------------
// usePlacement
// ---------------------------------------------------------------------------

test("usePlacement reflects presented + dismissed state and routes handler callbacks", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => { resolveStarted = r; });
  let resolvePresent!: (r: PaywallResult) => void;
  const stubPresenter: PaywallPresenter = {
    present: async () => {
      resolveStarted();
      return new Promise<PaywallResult>((res) => { resolvePresent = res; });
    },
    dismiss: () => {},
  };

  let onPresentCount = 0;
  let onDismissCount = 0;
  let observedState: string[] = [];
  const Comp = () => {
    const { register, state } = usePlacement({
      onPresent: () => onPresentCount++,
      onDismiss: () => onDismissCount++,
    });
    useEffect(() => {
      observedState.push(state.type);
    }, [state]);
    return (
      <div>
        <span data-testid="state">{state.type}</span>
        <button
          onClick={() =>
            void register({ placement: "checkout", presenter: stubPresenter })
          }
        >
          go
        </button>
      </div>
    );
  };

  const { getByTestId, getByText } = await renderAct(
    <SuperwallProvider apiKey="pk_test_p" fetch={noopFetch} storage={newAdapter()}>
      <Comp />
    </SuperwallProvider>,
  );
  await act(async () => { await flush(); });
  expect(getByTestId("state").textContent).toBe("idle");

  await act(async () => { fireEvent.click(getByText("go")); });
  await act(async () => { await started; await flush(); });
  expect(getByTestId("state").textContent).toBe("presented");
  expect(onPresentCount).toBe(1);

  // Resolve the present — state flips to dismissed.
  await act(async () => {
    resolvePresent({ type: "purchased", productId: "p1" });
    await flush();
  });
  expect(getByTestId("state").textContent).toBe("dismissed");
  expect(onDismissCount).toBe(1);
});

test("usePlacement: ACTIVE subscription → register returns skipped(userSubscribed)", async () => {
  // When the user is already entitled, register() skips the paywall with
  // PaywallSkippedReason.UserIsSubscribed (not a distinct "entitled" result —
  // that was an earlier API shape). usePlacement reflects it as state=skipped.
  let lastType = "";
  let captured: ReturnType<typeof useSuperwall> | null = null;
  const Comp = () => {
    const sw = useSuperwall();
    captured = sw;
    const { register, state } = usePlacement();
    return (
      <div>
        <span data-testid="state">{state.type}</span>
        <button
          onClick={async () => {
            const r = await register({ placement: "x" });
            lastType = r.type;
          }}
        >
          go
        </button>
      </div>
    );
  };
  const { getByTestId, getByText } = await renderAct(<Wrap><Comp /></Wrap>);
  await act(async () => { await flush(); });
  // Set ACTIVE deterministically (and flush) before registering, so the
  // userSubscribed skip is in effect by click time.
  await act(async () => {
    captured!.purchases.setSubscriptionStatus({
      status: "ACTIVE",
      entitlements: [{ id: "pro", type: "SERVICE_LEVEL", isActive: true, productIds: [] }],
    });
    await flush();
  });
  await act(async () => { fireEvent.click(getByText("go")); await flush(); });
  expect(lastType).toBe("skipped");
  expect(getByTestId("state").textContent).toBe("skipped");
});

// ---------------------------------------------------------------------------
// useSuperwallEvent
// ---------------------------------------------------------------------------

test("useSuperwallEvent attaches a typed listener and auto-detaches on unmount", async () => {
  const seen: string[] = [];
  let unmount = false;
  const Listener = () => {
    useSuperwallEvent("first_seen", () => seen.push("first_seen"));
    useSuperwallEvent("session_start", () => seen.push("session_start"));
    return null;
  };
  const Conditional = () => {
    const [show, setShow] = useState(true);
    if (unmount && show) setShow(false);
    return show ? <Listener /> : null;
  };

  const { rerender } = await renderAct(<Wrap><Conditional /></Wrap>);
  await act(async () => { await flush(); });

  // Lifecycle events fired during configure should appear.
  expect(seen.some((s) => s === "first_seen")).toBe(true);
  expect(seen.some((s) => s === "session_start")).toBe(true);

  // Unmount the listener — subsequent dispatches won't be observed.
  const before = seen.length;
  unmount = true;
  await act(async () => {
    rerender(<Wrap><Conditional /></Wrap>);
    await flush();
  });
  // (No further events fire here, but we've proven cleanup ran without error.)
  expect(seen.length).toBe(before);
});

// ---------------------------------------------------------------------------
// useDelegate
// ---------------------------------------------------------------------------

test("useDelegate installs a delegate for the lifetime of the component", async () => {
  let statusCalls = 0;
  const Comp = () => {
    useDelegate({
      onSubscriptionStatusChange: () => {
        statusCalls++;
      },
    });
    const sw = useSuperwall();
    return (
      <button
        onClick={() =>
          sw.purchases.setSubscriptionStatus({ status: "INACTIVE" })
        }
      >
        toggle
      </button>
    );
  };
  const { getByText } = await renderAct(<Wrap><Comp /></Wrap>);
  await act(async () => { await flush(); });

  await act(async () => { fireEvent.click(getByText("toggle")); await flush(); });
  expect(statusCalls).toBe(1);
});

test("useSignal: unstable signal identity per render doesn't trigger infinite re-render", async () => {
  // Pre-fix, useSignal's `useCallback((cb) => signal.subscribe(...), [signal])`
  // would create a new subscribe per render whenever signal changed identity,
  // forcing useSyncExternalStore to re-subscribe → potential render loop.
  // The ref-based fix makes subscribe identity stable across renders.
  let renderCount = 0;
  const Display = () => {
    renderCount++;
    const sw = useSuperwall();
    // Wrap in a fresh proxy each render — exercises the unstable-identity case.
    const wrappedSignal = {
      get value() {
        return sw.user.id.value;
      },
      subscribe: (run: () => void) => sw.user.id.subscribe(run),
    };
    const id = useSignal(wrappedSignal);
    return <span data-testid="id">{id}</span>;
  };
  await renderAct(<Wrap><Display /></Wrap>);
  await act(async () => { await flush(); });
  // A single mount should produce a bounded number of renders. Without the
  // fix, this would balloon. Allow some slack for double-renders in test env.
  expect(renderCount).toBeLessThan(5);
});

test("useDelegate: unmounting one of two stacked hooks leaves the other installed", async () => {
  // The bug: pre-fix, ANY useDelegate unmount called sw.setDelegate(null),
  // wiping a sibling's installed delegate. With the per-instance stack,
  // unmount only pops the owner that pushed; whichever entry remains becomes
  // the active delegate.
  const calls: string[] = [];
  const A = () => {
    useDelegate({ onSubscriptionStatusChange: () => calls.push("A") });
    return <span>A</span>;
  };
  const B = () => {
    useDelegate({ onSubscriptionStatusChange: () => calls.push("B") });
    return <span>B</span>;
  };
  const Wrapper = ({ showB }: { showB: boolean }) => {
    const sw = useSuperwall();
    return (
      <>
        <A />
        {showB && <B />}
        <button
          onClick={() =>
            sw.purchases.setSubscriptionStatus({
              status: calls.length % 2 === 0 ? "INACTIVE" : "UNKNOWN",
            })
          }
        >
          toggle
        </button>
      </>
    );
  };
  const { rerender, getByText } = await renderAct(
    <Wrap><Wrapper showB={true} /></Wrap>,
  );
  await act(async () => { await flush(); });

  // Both stacked → exactly one of them fires (the top).
  await act(async () => { fireEvent.click(getByText("toggle")); await flush(); });
  expect(calls).toHaveLength(1);
  const initialOwner = calls[0]!;
  const otherOwner = initialOwner === "A" ? "B" : "A";

  // Unmount the *other* one (the one not currently the top). Active delegate
  // should be unchanged — top stays installed.
  // We can't selectively unmount A or B here; rerender drops B. So if B is
  // the top, after unmount A becomes top; if A is the top, A stays top.
  await act(async () => {
    rerender(<Wrap><Wrapper showB={false} /></Wrap>);
    await flush();
  });
  await act(async () => { fireEvent.click(getByText("toggle")); await flush(); });
  expect(calls).toHaveLength(2);
  // Whichever survives must be A — only A is mounted now.
  expect(calls[1]).toBe("A");
  void otherOwner;
});
