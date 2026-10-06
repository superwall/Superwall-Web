import { it, expect } from "@effect/vitest";
import { describeCause } from "./describe.ts";

it("describes Errors and strings directly", () => {
  expect(describeCause(new Error("disk full"))).toBe("disk full");
  expect(describeCause("boom")).toBe("boom");
});

it("reads name / message off non-Error objects, including prototype getters", () => {
  // Firefox's XPCOM exceptions keep these on the prototype, which
  // `JSON.stringify` can't see (it rendered them as `{}`).
  class XpcomLikeException {
    get name() {
      return "NS_ERROR_FILE_CORRUPTED";
    }
  }
  expect(describeCause(new XpcomLikeException())).toBe("NS_ERROR_FILE_CORRUPTED");
  expect(describeCause({ name: "E", message: "m" })).toBe("E: m");
});

it("never throws, even for values JSON.stringify rejects", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => describeCause(circular)).not.toThrow();
  expect(describeCause(10n)).toBe("10");
  expect(describeCause(undefined)).toBe("undefined");
  expect(describeCause({ code: 1 })).toBe('{"code":1}');
});
