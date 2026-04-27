// Internal → public error translation.
//
// Internals throw Schema.TaggedError variants for clean Effect.catchTag
// ergonomics. At every public API surface (Promise-returning façade) we
// catch those and rethrow the documented public TS classes from §10.7.
// Consumers `catch (e) { if (e instanceof StorageError) ... }` and never
// see a `_tag` field or any Effect convention.

import {
  ConfigurationFetchError,
  NetworkError,
  NotConfiguredError,
  PresenterError,
  StorageError,
  SuperwallError,
} from "../errors.ts";
import * as Internal from "./errors.ts";

/** Translate any internal tagged error to its public counterpart. Unknown
 *  errors pass through (caller chooses to wrap or not). */
export const translateInternalError = (cause: unknown): unknown => {
  // Internal storage errors → public StorageError (cause-wrap)
  if (
    cause instanceof Internal.StorageGetError ||
    cause instanceof Internal.StorageSetError ||
    cause instanceof Internal.StorageRemoveError ||
    cause instanceof Internal.StorageClearError
  ) {
    return new StorageError(cause.message, asError(cause.cause));
  }

  // Internal network errors → public NetworkError
  if (cause instanceof Internal.NetworkRequestError) {
    return new NetworkError(cause.message, cause.status, asError(cause.cause));
  }
  if (cause instanceof Internal.NetworkDecodingError) {
    return new NetworkError(cause.message, undefined, asError(cause.cause));
  }

  // Identity not hydrated typically means "called before sw.ready"
  if (cause instanceof Internal.IdentityNotHydratedError) {
    return new NotConfiguredError();
  }
  if (cause instanceof Internal.IdentityHydrationError) {
    return new ConfigurationFetchError(asError(cause.cause) ?? new Error(cause.message), 1);
  }

  // Already a public SuperwallError? leave it.
  if (cause instanceof SuperwallError) return cause;

  // Wrap arbitrary thrown values so consumers always catch an Error subclass.
  if (cause instanceof Error) return cause;
  return new PresenterError(`Unknown internal error: ${describe(cause)}`);
};

const asError = (cause: unknown): Error | undefined => {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return cause;
  return new Error(describe(cause));
};

const describe = (cause: unknown): string =>
  typeof cause === "string"
    ? cause
    : (() => {
        try {
          return JSON.stringify(cause);
        } catch {
          return String(cause);
        }
      })();
