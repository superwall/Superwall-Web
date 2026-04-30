import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { STORAGE_KEYS } from "../types.ts";
import {
  ComputedProperties,
  computedPropertiesLayer,
} from "./computed.ts";
import { createMemoryStorage, StorageService } from "./storage.ts";

const stack = (storage = StorageService.fromAdapter(createMemoryStorage())) =>
  computedPropertiesLayer(storage);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("daysSince_<event>: latest matching record drives the value", async () => {
  const layer = stack();
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      // Three days ago.
      yield* c.record("paywall_open", Date.now() - 3 * DAY);
      // One day ago.
      yield* c.record("paywall_open", Date.now() - 1 * DAY);
      return yield* c.compute({
        type: "daysSince",
        eventName: "paywall_open",
      });
    }).pipe(Effect.provide(layer)) as Effect.Effect<number | null, never, never>,
  );
  expect(out).toBe(1);
});

test("daysSince_<event>: returns null when the event has never fired", async () => {
  const layer = stack();
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      return yield* c.compute({
        type: "daysSince",
        eventName: "paywall_open",
      });
    }).pipe(Effect.provide(layer)) as Effect.Effect<number | null, never, never>,
  );
  expect(out).toBeNull();
});

test("paywallsInHour counts trigger_fire records inside the window", async () => {
  const layer = stack();
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      const now = Date.now();
      yield* c.record("trigger_fire", now - 30 * 60 * 1000); // 30m ago — inside hour
      yield* c.record("trigger_fire", now - 90 * 60 * 1000); // 90m ago — outside hour
      yield* c.record("trigger_fire", now - 5 * 60 * 1000); // 5m ago — inside
      yield* c.record("paywall_open", now); // not a trigger_fire — ignored
      return yield* c.compute(
        { type: "placementsInHour", eventName: "" },
        now,
      );
    }).pipe(Effect.provide(layer)) as Effect.Effect<number | null, never, never>,
  );
  expect(out).toBe(2);
});

test("placementsInDay / inWeek / inMonth scale the window", async () => {
  const layer = stack();
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      const now = Date.now();
      yield* c.record("trigger_fire", now - 12 * HOUR); // ½ day
      yield* c.record("trigger_fire", now - 5 * DAY); //  5 days
      yield* c.record("trigger_fire", now - 20 * DAY); // 20 days
      yield* c.record("trigger_fire", now - 40 * DAY); // 40 days
      const inDay = yield* c.compute(
        { type: "placementsInDay", eventName: "" },
        now,
      );
      const inWeek = yield* c.compute(
        { type: "placementsInWeek", eventName: "" },
        now,
      );
      const inMonth = yield* c.compute(
        { type: "placementsInMonth", eventName: "" },
        now,
      );
      return { inDay, inWeek, inMonth };
    }).pipe(Effect.provide(layer)) as Effect.Effect<
      { inDay: number | null; inWeek: number | null; inMonth: number | null },
      never,
      never
    >,
  );
  expect(out.inDay).toBe(1);
  expect(out.inWeek).toBe(2);
  expect(out.inMonth).toBe(3);
});

test("placementsSinceInstall counts every trigger_fire ever", async () => {
  const layer = stack();
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      const now = Date.now();
      yield* c.record("trigger_fire", now - 365 * DAY);
      yield* c.record("trigger_fire", now - 30 * DAY);
      yield* c.record("trigger_fire", now - 1 * DAY);
      yield* c.record("paywall_open", now); // not a trigger
      return yield* c.compute(
        { type: "placementsSinceInstall", eventName: "" },
        now,
      );
    }).pipe(Effect.provide(layer)) as Effect.Effect<number | null, never, never>,
  );
  expect(out).toBe(3);
});

test("history persists across runtime materializations (replays from storage)", async () => {
  const adapter = createMemoryStorage();
  const sharedStorage = StorageService.fromAdapter(adapter);

  // First runtime — record into storage.
  await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      yield* c.record("trigger_fire", 1700000000000);
      yield* c.record("paywall_open", 1700000060000);
    }).pipe(Effect.provide(computedPropertiesLayer(sharedStorage))) as Effect.Effect<
      void,
      never,
      never
    >,
  );

  // Second runtime — verify history is replayed.
  const replayed = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      return yield* c.history();
    }).pipe(Effect.provide(computedPropertiesLayer(sharedStorage))) as Effect.Effect<
      ReadonlyArray<{ name: string; ts: number }>,
      never,
      never
    >,
  );
  expect(replayed.length).toBe(2);
  expect(replayed[0]!.name).toBe("trigger_fire");
  expect(replayed[1]!.name).toBe("paywall_open");
});

test("corrupt storage JSON is silently dropped (history starts empty)", async () => {
  const adapter = createMemoryStorage();
  await adapter.set(STORAGE_KEYS.computedProperties, "{not valid json");
  const layer = computedPropertiesLayer(StorageService.fromAdapter(adapter));
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      return yield* c.history();
    }).pipe(Effect.provide(layer)) as Effect.Effect<
      ReadonlyArray<{ name: string; ts: number }>,
      never,
      never
    >,
  );
  expect(out.length).toBe(0);
});

test("reset() wipes the history + storage", async () => {
  const adapter = createMemoryStorage();
  const sharedStorage = StorageService.fromAdapter(adapter);
  await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* ComputedProperties;
      yield* c.record("paywall_open");
      yield* c.record("trigger_fire");
      yield* c.reset();
      const remaining = yield* c.history();
      expect(remaining.length).toBe(0);
    }).pipe(Effect.provide(computedPropertiesLayer(sharedStorage))) as Effect.Effect<
      void,
      never,
      never
    >,
  );
  expect(await adapter.get(STORAGE_KEYS.computedProperties)).toBeNull();
});

void Layer; // imported for tests that may grow
