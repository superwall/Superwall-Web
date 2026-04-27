import { test, expect, beforeEach } from "bun:test";
import { act, render } from "@testing-library/react";
import { useSuperwall } from "./hooks.ts";
import {
  _resetProviderRegistry,
  SuperwallProvider,
} from "./provider.tsx";

const noopFetch = (() =>
  Promise.resolve(new Response("", { status: 204 }))) as unknown as typeof fetch;

beforeEach(() => {
  _resetProviderRegistry();
});

test("SuperwallProvider provides a Superwall instance via context", async () => {
  let captured: ReturnType<typeof useSuperwall> | null = null;
  const Probe = () => {
    captured = useSuperwall();
    return null;
  };

  await act(async () => {
    render(
      <SuperwallProvider apiKey="pk_test" fetch={noopFetch}>
        <Probe />
      </SuperwallProvider>,
    );
  });

  expect(captured).not.toBeNull();
  expect(captured!.apiKey).toBe("pk_test");
});

test("useSuperwall outside <SuperwallProvider> throws a clear error", () => {
  const Probe = () => {
    useSuperwall();
    return null;
  };
  expect(() => render(<Probe />)).toThrow(/SuperwallProvider/);
});

test("registry reuses the instance across re-mounts with the same apiKey (HMR)", async () => {
  let first: ReturnType<typeof useSuperwall> | null = null;
  let second: ReturnType<typeof useSuperwall> | null = null;

  const Probe = ({ slot }: { slot: 1 | 2 }) => {
    const sw = useSuperwall();
    if (slot === 1) first = sw;
    else second = sw;
    return null;
  };

  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <SuperwallProvider apiKey="pk_hmr" fetch={noopFetch}>
        <Probe slot={1} />
      </SuperwallProvider>,
    );
  });
  // Unmount, re-mount with same key — registry should hand back the same instance.
  await act(async () => {
    view!.unmount();
    render(
      <SuperwallProvider apiKey="pk_hmr" fetch={noopFetch}>
        <Probe slot={2} />
      </SuperwallProvider>,
    );
  });

  expect(first).not.toBeNull();
  expect(second).toBe(first); // same instance
});

test("different apiKeys produce different instances", async () => {
  let a: ReturnType<typeof useSuperwall> | null = null;
  let b: ReturnType<typeof useSuperwall> | null = null;
  const Probe = ({ tag }: { tag: "a" | "b" }) => {
    const sw = useSuperwall();
    if (tag === "a") a = sw;
    else b = sw;
    return null;
  };

  await act(async () => {
    render(
      <>
        <SuperwallProvider apiKey="pk_a" fetch={noopFetch}>
          <Probe tag="a" />
        </SuperwallProvider>
        <SuperwallProvider apiKey="pk_b" fetch={noopFetch}>
          <Probe tag="b" />
        </SuperwallProvider>
      </>,
    );
  });

  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a).not.toBe(b);
});
