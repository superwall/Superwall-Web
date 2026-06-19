// Error taxonomy. See API.md §10.7.
//
// All errors extend SuperwallError and carry a stable `code` field for
// non-TS consumers. Use `instanceof` for TS discrimination.
// `_tag` fields are added for Effect.catchTag compatibility without
// changing the public API or switching to Schema.TaggedError.

import type { PaywallInfo } from "./types.ts";

export type SuperwallErrorCode =
  | "NOT_CONFIGURED"
  | "NO_PRESENTER"
  | "PAYWALL_ALREADY_PRESENTED"
  | "NO_DEFAULT_INSTANCE"
  | "NETWORK"
  | "CONFIG_FETCH"
  | "PRESENTER"
  | "STORAGE"
  | "PAYWALL_NOT_AVAILABLE";

export class SuperwallError extends Error {
  // Typed as string on the base so subclass literal tags remain assignable here.
  // Subclasses narrow to their own literal for Effect.catchTag compatibility.
  readonly _tag: string = "SuperwallError";
  override readonly name: string = "SuperwallError";
  readonly code: SuperwallErrorCode;

  constructor(message: string, code: SuperwallErrorCode) {
    super(message);
    this.code = code;
  }
}

export class NotConfiguredError extends SuperwallError {
  override readonly _tag = "NotConfiguredError" as const;
  override readonly name = "NotConfiguredError";
  override readonly cause?: Error;

  constructor(cause?: Error) {
    super("Superwall is not configured (sw.ready rejected).", "NOT_CONFIGURED");
    if (cause !== undefined) this.cause = cause;
  }
}

export class NoPresenterRegisteredError extends SuperwallError {
  override readonly _tag = "NoPresenterRegisteredError" as const;
  override readonly name = "NoPresenterRegisteredError";
  readonly placement: string;

  constructor(placement: string) {
    super(
      `No PaywallPresenter registered; cannot present "${placement}".`,
      "NO_PRESENTER",
    );
    this.placement = placement;
  }
}

export class PaywallAlreadyPresentedError extends SuperwallError {
  override readonly _tag = "PaywallAlreadyPresentedError" as const;
  override readonly name = "PaywallAlreadyPresentedError";
  readonly attemptedPlacement: string;
  readonly currentPaywallInfo: PaywallInfo;

  constructor(attemptedPlacement: string, currentPaywallInfo: PaywallInfo) {
    super(
      `Paywall already presented (${currentPaywallInfo.identifier}); cannot present "${attemptedPlacement}".`,
      "PAYWALL_ALREADY_PRESENTED",
    );
    this.attemptedPlacement = attemptedPlacement;
    this.currentPaywallInfo = currentPaywallInfo;
  }
}

export class NoDefaultSuperwallError extends SuperwallError {
  override readonly _tag = "NoDefaultSuperwallError" as const;
  override readonly name = "NoDefaultSuperwallError";

  constructor() {
    super(
      "No default Superwall instance — call createSuperwall() before using named exports.",
      "NO_DEFAULT_INSTANCE",
    );
  }
}

export class NetworkError extends SuperwallError {
  override readonly _tag = "NetworkError" as const;
  override readonly name = "NetworkError";
  readonly status?: number;
  override readonly cause?: Error;

  constructor(message: string, status?: number, cause?: Error) {
    super(message, "NETWORK");
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConfigurationFetchError extends SuperwallError {
  override readonly _tag = "ConfigurationFetchError" as const;
  override readonly name = "ConfigurationFetchError";
  override readonly cause: Error;
  readonly attempt: number;

  constructor(cause: Error, attempt: number) {
    super(
      `Failed to fetch SDK configuration (attempt ${attempt}).`,
      "CONFIG_FETCH",
    );
    this.cause = cause;
    this.attempt = attempt;
  }
}

export class PresenterError extends SuperwallError {
  override readonly _tag = "PresenterError" as const;
  override readonly name = "PresenterError";
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, "PRESENTER");
    if (cause !== undefined) this.cause = cause;
  }
}

export class PaywallNotAvailableError extends SuperwallError {
  override readonly _tag = "PaywallNotAvailableError" as const;
  override readonly name = "PaywallNotAvailableError";
  readonly placement: string;
  readonly reason: "no_config" | "no_paywall_in_config" | "no_paywall_id_on_variant";

  constructor(placement: string, reason: PaywallNotAvailableError["reason"]) {
    super(
      `No paywall available for "${placement}" (${reason}).`,
      "PAYWALL_NOT_AVAILABLE",
    );
    this.placement = placement;
    this.reason = reason;
  }
}

export class StorageError extends SuperwallError {
  override readonly _tag = "StorageError" as const;
  override readonly name = "StorageError";
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, "STORAGE");
    if (cause !== undefined) this.cause = cause;
  }
}
