// Verifies that consumers can augment UserAttributes / PlacementParams /
// CustomCallbacks via TS module augmentation, and that the augmented shape
// flows through the type system end-to-end.

import { test, expect } from "bun:test";
import type {
  CustomCallbacks,
  PlacementParams,
  UserAttributes,
} from "./types.ts";

declare module "./types.ts" {
  interface UserAttributes {
    email?: string;
    plan?: "free" | "pro";
  }
  interface PlacementParams {
    screen?: string;
    referrer?: string;
  }
  interface CustomCallbacks {
    submitEmail: { input: { email: string }; output: { ok: boolean } };
  }
}

test("UserAttributes augmentation flows through", () => {
  const u: UserAttributes = { email: "a@b.co", plan: "pro" };
  expect(u.email).toBe("a@b.co");
  // @ts-expect-error — "premium" is not in the augmented union
  const _bad: UserAttributes = { plan: "premium" };
  expect(_bad).toBeTruthy();
});

test("PlacementParams augmentation flows through", () => {
  const p: PlacementParams = { screen: "home" };
  expect(p.screen).toBe("home");
});

test("CustomCallbacks augmentation produces a typed handler-map shape", () => {
  type Handler = NonNullable<CustomCallbacks["submitEmail"]["output"]>;
  const result: Handler = { ok: true };
  expect(result.ok).toBe(true);
});
