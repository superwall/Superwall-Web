// Internal → public error translation. Called at every Promise-returning
// façade so consumers only ever see the documented public error classes —
// never a `_tag` field or any Effect convention.

import {
  ConfigurationFetchError,
  NetworkError,
  NotConfiguredError,
  PresenterError,
  StorageError,
  SuperwallError,
} from "../errors.ts";
import * as Internal from "./errors.ts";

/** Translate an internal tagged error to its public counterpart. Unknown
 *  errors pass through. */
export const translateInternalError = (cause: unknown): unknown => {
  if (
    cause instanceof Internal.StorageGetError ||
    cause instanceof Internal.StorageSetError ||
    cause instanceof Internal.StorageRemoveError ||
    cause instanceof Internal.StorageClearError
  ) {
    return new StorageError(cause.message, asError(cause.cause));
  }

  if (cause instanceof Internal.NetworkRequestError) {
    return new NetworkError(cause.message, cause.status, asError(cause.cause));
  }
  if (cause instanceof Internal.NetworkDecodingError) {
    return new NetworkError(cause.message, undefined, asError(cause.cause));
  }

  // Not-hydrated typically means "called before sw.ready".
  if (cause instanceof Internal.IdentityNotHydratedError) {
    return new NotConfiguredError();
  }
  if (cause instanceof Internal.IdentityHydrationError) {
    return new ConfigurationFetchError(asError(cause.cause) ?? new Error(cause.message), 1);
  }
  if (cause instanceof Internal.ConfigParseError) {
    return new ConfigurationFetchError(
      asError(cause.cause) ?? new Error(cause.message),
      1,
    );
  }

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
