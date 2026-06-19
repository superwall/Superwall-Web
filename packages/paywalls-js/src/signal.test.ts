// Each test names the §2 contract clause it enforces.

import { it, expect } from "@effect/vitest";
import { asReadable, createSignal } from "./signal.ts";

const tick = () => new Promise<void>((r) => queueMicrotask(r));

it("readable .value reads the current value", () => {
  const sig = createSignal(0);
  expect(sig.value).toBe(0);
  sig.set(7);
  expect(sig.value).toBe(7);
});

it("subscribe fires synchronously with the current value on attach", () => {
  const sig = createSignal({ n: 1 });
  const seen: Array<{ n: number }> = [];
  sig.subscribe((v) => seen.push(v));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual({ n: 1 });
});

it("subscribe returns an unsubscribe that stops further notifications", async () => {
  const sig = createSignal(0);
  const seen: number[] = [];
  const unsub = sig.subscribe((v) => seen.push(v));
  expect(seen).toEqual([0]);
  unsub();
  sig.set(1);
  await tick();
  expect(seen).toEqual([0]);
});

it("notifications are coalesced — N writes in one task fire one notification", async () => {
  const sig = createSignal(0);
  const seen: number[] = [];
  sig.subscribe((v) => seen.push(v));
  expect(seen).toEqual([0]); // sync-on-attach

  sig.set(1);
  sig.set(2);
  sig.set(3);
  await tick();

  // Initial sync notification + one coalesced flush with the final value.
  expect(seen).toEqual([0, 3]);
});

it("setting the same value (Object.is equal) does not notify", async () => {
  const obj = { x: 1 };
  const sig = createSignal(obj);
  const seen: Array<typeof obj> = [];
  sig.subscribe((v) => seen.push(v));
  expect(seen).toHaveLength(1);

  sig.set(obj); // identical reference
  await tick();
  expect(seen).toHaveLength(1);

  sig.set({ x: 1 }); // different reference, same shape — does notify
  await tick();
  expect(seen).toHaveLength(2);
});

it("`.value` returns the same reference between change notifications (===-stable)", async () => {
  const initial = { a: 1 };
  const sig = createSignal(initial);
  const refA1 = sig.value;
  const refA2 = sig.value;
  expect(refA1).toBe(refA2); // same instance across reads

  const next = { a: 2 };
  sig.set(next);
  // Synchronously after `set`, `.value` MUST already reflect the new
  // reference (don't wait for the microtask flush).
  expect(sig.value).toBe(next);
  await tick();
  expect(sig.value).toBe(next);
});

it("update(fn) reads-then-writes atomically", async () => {
  const sig = createSignal(10);
  const seen: number[] = [];
  sig.subscribe((v) => seen.push(v));

  sig.update((prev) => prev + 5);
  sig.update((prev) => prev * 2);
  await tick();

  expect(sig.value).toBe(30);
  expect(seen).toEqual([10, 30]); // coalesced
});

it("listeners that unsubscribe themselves don't break iteration", async () => {
  const sig = createSignal(0);
  const seen: Array<["a" | "b" | "c", number]> = [];

  const unsubB = sig.subscribe((v) => {
    seen.push(["b", v]);
    if (v === 5) unsubB();
  });
  sig.subscribe((v) => seen.push(["a", v]));
  sig.subscribe((v) => seen.push(["c", v]));

  expect(seen.length).toBe(3); // sync-on-attach × 3

  sig.set(5);
  await tick();
  // All three saw v=5; unsubscribe took effect for next round only.
  const fived = seen.filter(([, v]) => v === 5).map(([who]) => who);
  expect(fived.sort()).toEqual(["a", "b", "c"]);

  sig.set(9);
  await tick();
  const nined = seen.filter(([, v]) => v === 9).map(([who]) => who);
  expect(nined.sort()).toEqual(["a", "c"]); // b unsubscribed
});

it("asReadable() strips the writable surface", () => {
  const sig = createSignal(1);
  const ro = asReadable(sig);
  expect(ro.value).toBe(1);
  expect((ro as Partial<typeof sig>).set).toBeUndefined();
  expect((ro as Partial<typeof sig>).update).toBeUndefined();

  // Mutating via the writable still flows through the readable view.
  sig.set(42);
  expect(ro.value).toBe(42);
});

