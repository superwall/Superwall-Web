// Wraps a public StorageAdapter (sync-or-async) into an Effect.Service
// whose methods take branded StorageKey and return tagged-error Effects.
// Default Layer is in-memory (tests / Node / edge); browser Layer ships
// from /browser via createBrowserStorage(); custom adapters via
// `StorageService.fromAdapter(myAdapter)`.

import { Effect, Layer } from "effect";
import type { StorageAdapter } from "../types.ts";
import type { StorageKey } from "./brands.ts";
import {
  StorageGetError,
  StorageSetError,
  StorageRemoveError,
  StorageClearError,
} from "./errors.ts";

/** In-memory adapter — used as the Default and in tests. */
export const createMemoryStorage = (): StorageAdapter => {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value);
    },
    remove: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
};

/** Coerce sync-or-async return values into an Effect, tagging failures. */
const tryAdapterCall = <T, E>(
  call: () => T | Promise<T>,
  toError: (cause: unknown) => E,
): Effect.Effect<T, E> =>
  Effect.tryPromise({
    try: async () => await call(),
    catch: toError,
  });

const make = (adapter: StorageAdapter) => {
  const get = Effect.fn("StorageService.get")(function* (key: StorageKey) {
    return yield* tryAdapterCall(
      () => adapter.get(key),
      (cause) =>
        new StorageGetError({
          key,
          message: `Failed to read storage key "${key}": ${describe(cause)}`,
          cause,
        }),
    );
  });

  const set = Effect.fn("StorageService.set")(function* (
    key: StorageKey,
    value: string,
  ) {
    yield* tryAdapterCall(
      () => adapter.set(key, value),
      (cause) =>
        new StorageSetError({
          key,
          message: `Failed to write storage key "${key}": ${describe(cause)}`,
          cause,
        }),
    );
  });

  const remove = Effect.fn("StorageService.remove")(function* (key: StorageKey) {
    yield* tryAdapterCall(
      () => adapter.remove(key),
      (cause) =>
        new StorageRemoveError({
          key,
          message: `Failed to remove storage key "${key}": ${describe(cause)}`,
          cause,
        }),
    );
  });

  // `clear` is optional on the adapter; absence fails with a tagged error
  // rather than a silent no-op.
  const clear = Effect.fn("StorageService.clear")(function* () {
    if (!adapter.clear) {
      return yield* Effect.fail(
        new StorageClearError({
          message: "StorageAdapter does not implement clear()",
        }),
      );
    }
    yield* tryAdapterCall(
      () => adapter.clear!(),
      (cause) =>
        new StorageClearError({
          message: `Failed to clear storage: ${describe(cause)}`,
          cause,
        }),
    );
  });

  return { get, set, remove, clear } as const;
};

export class StorageService extends Effect.Service<StorageService>()(
  "@superwall/StorageService",
  {
    accessors: true,
    effect: Effect.sync(() => make(createMemoryStorage())),
  },
) {
  /** Build a Layer over a custom public StorageAdapter. */
  static fromAdapter(adapter: StorageAdapter): Layer.Layer<StorageService> {
    return Layer.effect(
      StorageService,
      Effect.sync(() => new StorageService(make(adapter))),
    );
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : JSON.stringify(cause);
