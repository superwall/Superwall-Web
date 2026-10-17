// Human-readable text for a thrown value, for error messages. Never throws.
//
// Browser errors aren't always `Error`s — Firefox throws XPCOM exceptions
// whose `name` / `message` live on the prototype, so `JSON.stringify`
// renders them as `{}`. Read those fields directly first, and survive
// values `JSON.stringify` can't handle (circular, BigInt).
export const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (cause !== null && typeof cause === "object") {
    const { name, message } = cause as { name?: unknown; message?: unknown };
    const parts = [name, message].filter(
      (p): p is string => typeof p === "string" && p !== "",
    );
    if (parts.length > 0) return parts.join(": ");
  }
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
};
