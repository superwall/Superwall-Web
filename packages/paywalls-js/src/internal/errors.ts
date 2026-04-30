// Internal Schema.TaggedError variants. Used inside Effect.gen for
// `Effect.catchTag` ergonomics; translated to the documented public
// classes in `../errors.ts` at the `Effect.runPromise` boundary.

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class StorageGetError extends Schema.TaggedError<StorageGetError>()(
  "StorageGetError",
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class StorageSetError extends Schema.TaggedError<StorageSetError>()(
  "StorageSetError",
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class StorageRemoveError extends Schema.TaggedError<StorageRemoveError>()(
  "StorageRemoveError",
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class StorageClearError extends Schema.TaggedError<StorageClearError>()(
  "StorageClearError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export class IdentityNotHydratedError extends Schema.TaggedError<IdentityNotHydratedError>()(
  "IdentityNotHydratedError",
  {
    message: Schema.String,
  },
) {}

export class IdentityHydrationError extends Schema.TaggedError<IdentityHydrationError>()(
  "IdentityHydrationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export class NetworkRequestError extends Schema.TaggedError<NetworkRequestError>()(
  "NetworkRequestError",
  {
    method: Schema.String,
    url: Schema.String,
    status: Schema.optional(Schema.Number),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class NetworkDecodingError extends Schema.TaggedError<NetworkDecodingError>()(
  "NetworkDecodingError",
  {
    url: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()(
  "ConfigParseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
