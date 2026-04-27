import { test, expect } from "bun:test";
import { SDK_VERSION } from "./index.ts";

test("re-exports SDK_VERSION from @superwall/paywalls-js", () => {
  expect(typeof SDK_VERSION).toBe("string");
  expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
