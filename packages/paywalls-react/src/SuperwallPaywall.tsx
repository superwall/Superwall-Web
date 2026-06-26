import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PlacementParams } from "@superwall/paywalls-js";
import { createBrowserPresenter } from "@superwall/paywalls-js/browser";
import type { PaywallPresentationHandlerHooks } from "./hooks.ts";
import { useSuperwall } from "./hooks.ts";

export interface SuperwallPaywallProps extends PaywallPresentationHandlerHooks {
  placement: string;
  params?: PlacementParams;
  /** Rendered when the user is entitled — i.e. the feature block fires. */
  children?: ReactNode;
  /** Rendered while the paywall is loading. Swapped out the moment the paywall presents. */
  loading?: ReactNode;
  /**
   * When true the paywall iframe is mounted inside this component instead of
   * as a full-viewport overlay. Default: false.
   */
  inline?: boolean;
}

/**
 * Declarative feature gate. Calls `register()` on mount and renders
 * `children` when the user is entitled (already subscribed, purchased
 * through the paywall, or the placement has no audience match).
 *
 * ```tsx
 * <SuperwallPaywall placement="campaign_trigger" loading={<Spinner />}>
 *   <ProContent />
 * </SuperwallPaywall>
 * ```
 */
export function SuperwallPaywall({
  placement,
  params,
  children,
  loading = null,
  inline = false,
  onPresent,
  onDismiss,
  onSkip,
  onError,
}: SuperwallPaywallProps) {
  const sw = useSuperwall();
  const [unlocked, setUnlocked] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handlersRef = useRef({ onPresent, onDismiss, onSkip, onError });
  handlersRef.current = { onPresent, onDismiss, onSkip, onError };

  const presenter = useMemo(
    () =>
      inline
        ? createBrowserPresenter({ container: () => containerRef.current ?? document.body, inline: true })
        : undefined,
    [inline],
  );

  useEffect(() => {
    let cancelled = false;
    sw.register({
      placement,
      params,
      feature: () => { if (!cancelled) setUnlocked(true); },
      ...(presenter && { presenter }),
      handler: {
        onPresent: (info) => { if (!cancelled) setPresenting(true); handlersRef.current.onPresent?.(info); },
        onDismiss: (info, result) => { handlersRef.current.onDismiss?.(info, result); },
        onSkip: (reason) => { handlersRef.current.onSkip?.(reason); },
        onError: (error) => { handlersRef.current.onError?.(error); },
      },
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, params, presenter]);

  if (unlocked) return <>{children}</>;

  // Container always stays in the DOM so the presenter can append the iframe
  // before onPresent fires. We swap loading ↔ iframe via display:none.
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={containerRef}
        style={{ display: presenting ? "block" : "none", width: "100%", height: "100%" }}
      />
      {!presenting && (
        <div style={{ position: "absolute", inset: 0 }}>
          {loading}
        </div>
      )}
    </div>
  );
}
