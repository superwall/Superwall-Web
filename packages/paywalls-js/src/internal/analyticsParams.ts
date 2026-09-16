// Analytics wire encoding. The collector's ClickHouse views read flat
// `$snake_case` attribution (`$experiment_id`, `$variant_id`, `$paywall_id`,
// `$presented_by_event_name`, …), the same shape iOS `TrackingLogic` and
// paywall-next's `EventSlice` produce. Audience-filterable keys are also
// repeated without the `$`. Only the collector payload uses this — public
// `sw.events` / delegate details keep their existing shape.

import type { AllSuperwallEvents } from "../events.ts";
import type { Experiment, JsonValue, PaywallInfo, TriggerResult } from "../types.ts";

/** Audience keys per slice — mirrors paywall-next `PaywallSlice`,
 *  `PresentmentSlice` and `PlacementParamsSlice`. */
export const PAYWALL_AUDIENCE_KEYS = ["paywallId", "paywallName", "paywallProductIds"] as const;
export const PRESENTMENT_AUDIENCE_KEYS = [
  "isFreeTrialAvailable",
  "presentationSourceType",
  "presentedBy",
] as const;
export const PLACEMENT_PARAMS_AUDIENCE_KEYS = ["placementParams"] as const;

/** paywall-next `PaywallSlice` fields, camelCase. Shared with the iframe
 *  `#init=` payload so both paths describe a paywall the same way. */
export const paywallSliceFields = (info: PaywallInfo) => ({
  // Database id when the config provides it; the slug is the legacy value.
  paywallId: info.databaseId ?? info.identifier,
  paywallIdentifier: info.identifier,
  paywallName: info.name,
  paywallProductIds: info.productIds.join(","),
  paywallUrl: info.url,
});

/** paywall-next `ExperimentSlice` fields, camelCase. */
export const experimentSliceFields = (experiment: Experiment) => ({
  experimentId: experiment.id,
  variantId: experiment.variant.id,
});

const toSnakeCase = (key: string): string =>
  key.replace(/([A-Z])/g, "_$1").toLowerCase();

/** Encode camelCase fields as `$snake_case`; `audienceKeys` are repeated
 *  unprefixed. Undefined values are dropped. */
export const encodeSlice = (
  fields: Record<string, unknown>,
  audienceKeys: ReadonlyArray<string> = [],
): Record<string, JsonValue> => {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const snake = toSnakeCase(key);
    out[`$${snake}`] = value as JsonValue;
    if (audienceKeys.includes(key)) out[snake] = value as JsonValue;
  }
  return out;
};

/** Attribution for events that carry the presented paywall. */
const paywallInfoParameters = (info: PaywallInfo): Record<string, JsonValue> => ({
  ...(info.experiment && encodeSlice(experimentSliceFields(info.experiment))),
  ...encodeSlice(paywallSliceFields(info), PAYWALL_AUDIENCE_KEYS),
  ...encodeSlice(
    {
      isFreeTrialAvailable: info.isFreeTrialAvailable,
      presentationSourceType: info.presentationSourceType,
      presentedBy: info.presentedBy,
      presentedByEventName: info.presentedByPlacementWithName,
    },
    PRESENTMENT_AUDIENCE_KEYS,
  ),
});

/** Native `trigger_fire` `$result` values. */
const TRIGGER_RESULT_NAMES: Record<TriggerResult["type"], string> = {
  paywall: "present",
  holdout: "holdout",
  noAudienceMatch: "no_rule_match",
  placementNotFound: "eventNotFound",
  error: "error",
};

/** Map a published event's detail to collector `parameters`. */
export const toWireParameters = <K extends keyof AllSuperwallEvents>(
  name: K,
  detail: AllSuperwallEvents[K],
): Record<string, JsonValue> => {
  if (name === "trigger_fire") {
    const { placementName, result } = detail as AllSuperwallEvents["trigger_fire"];
    const experiment =
      result.type === "paywall" || result.type === "holdout"
        ? result.experiment
        : undefined;
    return {
      $trigger_name: placementName,
      $result: TRIGGER_RESULT_NAMES[result.type],
      ...(experiment &&
        encodeSlice({
          ...experimentSliceFields(experiment),
          paywallIdentifier:
            result.type === "paywall" ? experiment.variant.paywallId : undefined,
        })),
    };
  }
  const { paywall_info, product, ...rest } = detail as Record<string, unknown> & {
    paywall_info?: PaywallInfo;
    product?: { id: string };
  };
  return {
    ...(rest as Record<string, JsonValue>),
    ...(product !== undefined && { $product_id: product.id }),
    ...(paywall_info !== undefined && paywallInfoParameters(paywall_info)),
  };
};
