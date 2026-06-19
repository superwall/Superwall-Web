import { it, expect } from "@effect/vitest";
import { SDK_VERSION } from "./index.ts";

it("SDK_VERSION is a non-empty semver-shaped string", () => {
  expect(typeof SDK_VERSION).toBe("string");
  expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
