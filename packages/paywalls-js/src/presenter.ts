// Public PaywallPresenter contract. Per API.md §3.
//
// Core calls into a presenter to actually display a paywall. The default
// implementation (`createBrowserPresenter` in `/browser`) renders an iframe
// overlay; consumers can supply their own (BE HTTP-response presenter,
// React Native Web, test fixtures, etc.).

import type { PaywallInfo, PaywallResult, PlacementParams } from "./types.ts";
import type { SuperwallEventMap } from "./events.ts";

/** Forward an event from inside the presenter (e.g. a postMessage from the
 *  paywall iframe) into the SDK's event bus. */
export type SuperwallEventEmit = <K extends keyof SuperwallEventMap>(
  name: K,
  detail: SuperwallEventMap[K],
) => void;

export interface PresentationContext {
  readonly placement: string;
  readonly params: PlacementParams;
  /** Aborts when the SDK gives up on the presentation (timeout, dismiss
   *  request, sw.dispose, etc.). Presenters should clean up + reject. */
  readonly signal: AbortSignal;
  /** Forward paywall → SDK events into the public bus. */
  readonly emit: SuperwallEventEmit;
}

export interface PaywallPresenter {
  /** Show the paywall and resolve when the user dismisses it. The single-
   *  paywall invariant (API.md §3) guarantees `present` is never called
   *  while a previous call hasn't resolved. */
  present(
    info: PaywallInfo,
    ctx: PresentationContext,
  ): Promise<PaywallResult>;

  /** Force-dismiss the active paywall (e.g. from `sw.dismiss()`). The
   *  in-flight `present` call should resolve, typically with `declined`. */
  dismiss(reason?: string): void;

  /** Optional: warm a paywall before it's needed. The default browser
   *  presenter mounts a hidden iframe; custom presenters may no-op. */
  preload?(info: PaywallInfo): Promise<void>;
}
