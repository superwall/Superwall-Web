// Plain error classes shared between browser and server SDKs. The browser
// SDK has additional Effect-flavored variants in its own `internal/errors.ts`
// — those translate to these classes at the runtime boundary. Server SDK
// uses these directly.

export type SuperwallErrorCode =
  | "NETWORK"
  | "AUTH"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "DECODING";

export class SuperwallError extends Error {
  override readonly name: string = "SuperwallError";
  readonly code: SuperwallErrorCode;

  constructor(message: string, code: SuperwallErrorCode) {
    super(message);
    this.code = code;
  }
}

export class SuperwallNetworkError extends SuperwallError {
  override readonly name = "SuperwallNetworkError";
  readonly status?: number;
  readonly url?: string;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: { status?: number; url?: string; cause?: unknown } = {},
  ) {
    super(message, "NETWORK");
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.url !== undefined) this.url = opts.url;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export class SuperwallAuthError extends SuperwallError {
  override readonly name = "SuperwallAuthError";
  readonly url?: string;

  constructor(message: string, opts: { url?: string } = {}) {
    super(message, "AUTH");
    if (opts.url !== undefined) this.url = opts.url;
  }
}

export class SuperwallNotFoundError extends SuperwallError {
  override readonly name = "SuperwallNotFoundError";
  readonly url?: string;

  constructor(message: string, opts: { url?: string } = {}) {
    super(message, "NOT_FOUND");
    if (opts.url !== undefined) this.url = opts.url;
  }
}

export class SuperwallTimeoutError extends SuperwallError {
  override readonly name = "SuperwallTimeoutError";
  readonly url?: string;
  readonly timeoutMs?: number;

  constructor(
    message: string,
    opts: { url?: string; timeoutMs?: number } = {},
  ) {
    super(message, "TIMEOUT");
    if (opts.url !== undefined) this.url = opts.url;
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
  }
}

export class SuperwallDecodingError extends SuperwallError {
  override readonly name = "SuperwallDecodingError";
  readonly url?: string;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: { url?: string; cause?: unknown } = {},
  ) {
    super(message, "DECODING");
    if (opts.url !== undefined) this.url = opts.url;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}
