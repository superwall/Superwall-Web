import { it, expect, afterEach } from "@effect/vitest";
import { vi } from "vitest";
import { randomUuid } from "./uuid.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses crypto.randomUUID when available", () => {
  expect(randomUuid()).toMatch(UUID_V4);
  expect(randomUuid()).not.toBe(randomUuid());
});

// `crypto.randomUUID` is missing on `http://` pages and before Safari 15.4 /
// Chrome 92; calling it directly used to fail SDK startup there.
it("falls back to getRandomValues without crypto.randomUUID", () => {
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: real.getRandomValues.bind(real),
  });
  expect(randomUuid()).toMatch(UUID_V4);
  expect(randomUuid()).not.toBe(randomUuid());
});

it("falls back to Math.random without crypto at all", () => {
  vi.stubGlobal("crypto", undefined);
  expect(randomUuid()).toMatch(UUID_V4);
  expect(randomUuid()).not.toBe(randomUuid());
});
