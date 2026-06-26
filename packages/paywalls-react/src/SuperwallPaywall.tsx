import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PlacementParams } from "@superwall/paywalls-js";
import type { PaywallPresentationHandlerHooks } from "./hooks.ts";
import { useSuperwall } from "./hooks.ts";

export interface SuperwallPaywallProps extends PaywallPresentationHandlerHooks {
  placement: string;
  params?: PlacementParams;
  /** Rendered when the user is entitled — i.e. the feature block fires. */
  children?: ReactNode;
}

/**
 * Declarative feature gate. Calls `register()` on mount and renders
 * `children` when the user is entitled (already subscribed, purchased
 * through the paywall, or the placement has no audience match).
 *
 * ```tsx
 * <SuperwallPaywall placement="campaign_trigger">
 *   <ProContent />
 * </SuperwallPaywall>
 * ```
 */
export function SuperwallPaywall({
  placement,
  params,
  children,
  onPresent,
  onDismiss,
  onSkip,
  onError,
}: SuperwallPaywallProps) {
  const sw = useSuperwall();
  const [unlocked, setUnlocked] = useState(false);

  // Keep handler callbacks stable across renders without re-running the effect.
  const handlersRef = useRef({ onPresent, onDismiss, onSkip, onError });
  handlersRef.current = { onPresent, onDismiss, onSkip, onError };

  useEffect(() => {
    let cancelled = false;
    sw.register({
      placement,
      params,
      feature: () => { if (!cancelled) setUnlocked(true); },
      handler: {
        onPresent: (info) => handlersRef.current.onPresent?.(info),
        onDismiss: (info, result) => handlersRef.current.onDismiss?.(info, result),
        onSkip: (reason) => handlersRef.current.onSkip?.(reason),
        onError: (error) => handlersRef.current.onError?.(error),
      },
    });
    return () => { cancelled = true; };
  // Re-run only if placement/params identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, params]);

  if (!unlocked) return null;
  return <>{children}</>;
}
