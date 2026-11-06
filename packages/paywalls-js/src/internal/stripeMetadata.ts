// Developer-supplied Stripe metadata for a checkout.
//
// Wire contract (paywall-next `subscriptions-api` / `paywall-server`):
//   - WEBAPP apps read `checkoutContext.stripeMetadata` from the `#init=`
//     payload; invalid metadata refuses the checkout with a 400.
//   - STRIPE apps (in-app placements, links) read `_sw_stripe_metadata=<JSON>`
//     from the paywall URL; invalid metadata is logged and dropped, the
//     paywall still shows.
// The limits below mirror the server's, so a mistake surfaces here, at
// `register()`, instead of as a refused checkout or silently missing keys.
// They keep the checkout under Stripe's 50-key cap once a checkout config's
// 20 keys and Superwall's own `_sw_*` keys are added.

import { InvalidStripeMetadataError } from "../errors.ts";

export const STRIPE_METADATA_QUERY_PARAM = "_sw_stripe_metadata";
export const STRIPE_METADATA_MAX_KEYS = 10;
export const STRIPE_METADATA_MAX_KEY_LENGTH = 40;
export const STRIPE_METADATA_MAX_VALUE_LENGTH = 500;
export const STRIPE_METADATA_RESERVED_PREFIX = "_sw_";

export type StripeMetadata = Readonly<Record<string, string>>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Validates developer metadata against the server's limits. Returns a
 *  fresh copy (so later mutation of the caller's object can't change what
 *  was validated), or `undefined` when there is nothing to send. Throws
 *  `InvalidStripeMetadataError` on the first violation. */
export const validateStripeMetadata = (
  input: unknown,
): Record<string, string> | undefined => {
  if (input === undefined || input === null) return undefined;
  if (!isPlainObject(input)) {
    throw new InvalidStripeMetadataError(
      "not_an_object",
      "stripeMetadata must be a plain object of string keys to string values.",
    );
  }
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  if (entries.length > STRIPE_METADATA_MAX_KEYS) {
    throw new InvalidStripeMetadataError(
      "too_many_keys",
      `stripeMetadata has ${entries.length} keys; at most ${STRIPE_METADATA_MAX_KEYS} are allowed.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > STRIPE_METADATA_MAX_KEY_LENGTH) {
      throw new InvalidStripeMetadataError(
        "invalid_key",
        `stripeMetadata key "${key}" must be 1–${STRIPE_METADATA_MAX_KEY_LENGTH} characters.`,
        key,
      );
    }
    if (key.startsWith(STRIPE_METADATA_RESERVED_PREFIX)) {
      throw new InvalidStripeMetadataError(
        "reserved_key",
        `stripeMetadata key "${key}" is reserved: keys starting with "${STRIPE_METADATA_RESERVED_PREFIX}" belong to Superwall.`,
        key,
      );
    }
    if (typeof value !== "string") {
      throw new InvalidStripeMetadataError(
        "invalid_value",
        `stripeMetadata["${key}"] must be a string.`,
        key,
      );
    }
    if (value.length > STRIPE_METADATA_MAX_VALUE_LENGTH) {
      throw new InvalidStripeMetadataError(
        "invalid_value",
        `stripeMetadata["${key}"] is ${value.length} characters; at most ${STRIPE_METADATA_MAX_VALUE_LENGTH} are allowed.`,
        key,
      );
    }
    out[key] = value;
  }
  return out;
};
