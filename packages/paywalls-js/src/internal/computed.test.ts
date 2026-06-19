import { it, expect } from "@effect/vitest";
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

it.effect("daysSince_<event>: latest matching record drives the value", () => {
  const layer = stack();
  return Effect.gen(function* () {
    const c = yield* ComputedProperties;
    // Three days ago.
    yield* c.record("paywall_open", Date.now() - 3 * DAY);
    // One day ago.
    yield* c.record("paywall_open", Date.now() - 1 * DAY);
    const out = yield* c.compute({
      type: "daysSince",
      eventName: "paywall_open",
    });
    expect(out).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("daysSince_<event>: returns null when the event has never fired", () => {
  const layer = stack();
  return Effect.gen(function* () {
    const c = yield* ComputedProperties;
    const out = yield* c.compute({
      type: "daysSince",
      eventName: "paywall_open",
    });
    expect(out).toBeNull();
  }).pipe(Effect.provide(layer));
});

it.effect("paywallsInHour counts trigger_fire records inside the window", () => {
  const layer = stack();
  return Effect.gen(function* () {
    const c = yield* ComputedProperties;
    const now = Date.now();
    yield* c.record("trigger_fire", now - 30 * 60 * 1000); // 30m ago — inside hour
    yield* c.record("trigger_fire", now - 90 * 60 * 1000); // 90m ago — outside hour
    yield* c.record("trigger_fire", now - 5 * 60 * 1000); // 5m ago — inside
    yield* c.record("paywall_open", now); // not a trigger_fire — ignored
    const out = yield* c.compute(
      { type: "placementsInHour", eventName: "" },
      now,
    );
    expect(out).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("placementsInDay / inWeek / inMonth scale the window", () => {
  const layer = stack();
  return Effect.gen(function* () {
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
    expect(inDay).toBe(1);
    expect(inWeek).toBe(2);
    expect(inMonth).toBe(3);
  }).pipe(Effect.provide(layer));
});

it.effect("placementsSinceInstall counts every trigger_fire ever", () => {
  const layer = stack();
  return Effect.gen(function* () {
    const c = yield* ComputedProperties;
    const now = Date.now();
    yield* c.record("trigger_fire", now - 365 * DAY);
    yield* c.record("trigger_fire", now - 30 * DAY);
    yield* c.record("trigger_fire", now - 1 * DAY);
    yield* c.record("paywall_open", now); // not a trigger
    const out = yield* c.compute(
      { type: "placementsSinceInstall", eventName: "" },
      now,
    );
    expect(out).toBe(3);
  }).pipe(Effect.provide(layer));
});

it.effect("history persists across runtime materializations (replays from storage)", () => {
  const adapter = createMemoryStorage();
  const sharedStorage = StorageService.fromAdapter(adapter);

  return Effect.gen(function* () {
    // First runtime — record into storage.
    yield* Effect.gen(function* () {
      const c = yield* ComputedProperties;
      yield* c.record("trigger_fire", 1700000000000);
      yield* c.record("paywall_open", 1700000060000);
    }).pipe(Effect.provide(computedPropertiesLayer(sharedStorage)));

    // Second runtime — verify history is replayed.
    const replayed = yield* Effect.gen(function* () {
      const c = yield* ComputedProperties;
      return yield* c.history();
    }).pipe(Effect.provide(computedPropertiesLayer(sharedStorage)));

    expect(replayed.length).toBe(2);
    expect(replayed[0]!.name).toBe("trigger_fire");
    expect(replayed[1]!.name).toBe("paywall_open");
  });
});

it.effect("corrupt storage JSON is silently dropped (history starts empty)", () => {
  const adapter = createMemoryStorage();
  return Effect.gen(function* () {
    yield* Effect.promise(() => Promise.resolve(adapter.set(STORAGE_KEYS.computedProperties, "{not valid json")));
    const layer = computedPropertiesLayer(StorageService.fromAdapter(adapter));
    const out = yield* Effect.gen(function* () {
      const c = yield* ComputedProperties;
      return yield* c.history();
    }).pipe(Effect.provide(layer));
    expect(out.length).toBe(0);
  });
});

it.effect("reset() wipes the history + storage", () => {
  const adapter = createMemoryStorage();
  const sharedStorage = StorageService.fromAdapter(adapter);
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const c = yield* ComputedProperties;
      yield* c.record("paywall_open");
      yield* c.record("trigger_fire");
      yield* c.reset();
      const remaining = yield* c.history();
      expect(remaining.length).toBe(0);
    }).pipe(Effect.provide(computedPropertiesLayer(sharedStorage)));
    const cached = yield* Effect.promise(() => Promise.resolve(adapter.get(STORAGE_KEYS.computedProperties)));
    expect(cached).toBeNull();
  });
});

void Layer; // imported for tests that may grow
