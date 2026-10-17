// UUID v4 that works everywhere the SDK runs. `crypto.randomUUID` only
// exists in secure contexts (an `http://` page has none) and on recent
// browsers (Safari 15.4+, Chrome 92+), so calling it directly fails SDK
// startup there. `crypto.getRandomValues` has no such limits; Math.random is
// the last resort for runtimes without `crypto` at all.

const fromBytes = (bytes: Uint8Array): string => {
  // RFC 4122 §4.4: version 4, variant 10.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const randomUuid = (): string => {
  const c = globalThis.crypto;
  try {
    if (typeof c?.randomUUID === "function") return c.randomUUID();
  } catch {}
  try {
    if (typeof c?.getRandomValues === "function") {
      return fromBytes(c.getRandomValues(new Uint8Array(16)));
    }
  } catch {}
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  return fromBytes(bytes);
};
