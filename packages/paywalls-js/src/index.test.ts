import { test, expect } from "bun:test";
import { SDK_VERSION } from "./index.ts";

test("SDK_VERSION is a non-empty semver-shaped string", () => {
  expect(typeof SDK_VERSION).toBe("string");
  expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
