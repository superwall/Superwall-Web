// Defensive readers for the untyped JSON the SDK hosts a paywall with — the
// `#init` payload it built and the messages the paywall posts.

export type Slice = Record<string, unknown>;

export const isRecord = (value: unknown): value is Slice =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const recordOf = (value: unknown): Slice => (isRecord(value) ? value : {});

export const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
