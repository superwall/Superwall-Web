// Error taxonomy. See API.md §10.7.
//
// All errors extend SuperwallError and carry a stable `code` field for
// non-TS consumers. Use `instanceof` for TS discrimination.

import type { PaywallInfo } from "./types.ts";

export type SuperwallErrorCode =
  | "NOT_CONFIGURED"
  | "NO_PRESENTER"
  | "PAYWALL_ALREADY_PRESENTED"
  | "NO_DEFAULT_INSTANCE"
  | "NETWORK"
  | "CONFIG_FETCH"
  | "PRESENTER"
  | "STORAGE";

export class SuperwallError extends Error {
  override readonly name: string = "SuperwallError";
  readonly code: SuperwallErrorCode;

  constructor(message: string, code: SuperwallErrorCode) {
    super(message);
    this.code = code;
  }
}

export class NotConfiguredError extends SuperwallError {
  override readonly name = "NotConfiguredError";
  override readonly cause?: Error;

  constructor(cause?: Error) {
    super("Superwall is not configured (sw.ready rejected).", "NOT_CONFIGURED");
    if (cause !== undefined) this.cause = cause;
  }
}

export class NoPresenterRegisteredError extends SuperwallError {
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
  override readonly name = "NoDefaultSuperwallError";

  constructor() {
    super(
      "No default Superwall instance — call createSuperwall() before using named exports.",
      "NO_DEFAULT_INSTANCE",
    );
  }
}

export class NetworkError extends SuperwallError {
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
  override readonly name = "PresenterError";
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, "PRESENTER");
    if (cause !== undefined) this.cause = cause;
  }
}

export class StorageError extends SuperwallError {
  override readonly name = "StorageError";
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, "STORAGE");
    if (cause !== undefined) this.cause = cause;
  }
}
