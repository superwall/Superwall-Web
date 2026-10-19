// Verifies that consumers can augment UserAttributes / PlacementParams /
// CustomCallbacks via TS module augmentation, and that the augmented shape
// flows through the type system end-to-end.

import { it, expect } from "@effect/vitest";
import type {
  CustomCallbackHandlers,
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

it("UserAttributes augmentation flows through", () => {
  const u: UserAttributes = { email: "a@b.co", plan: "pro" };
  expect(u.email).toBe("a@b.co");
  // @ts-expect-error — "premium" is not in the augmented union
  const _bad: UserAttributes = { plan: "premium" };
  expect(_bad).toBeTruthy();
});

it("PlacementParams augmentation flows through", () => {
  const p: PlacementParams = { screen: "home" };
  expect(p.screen).toBe("home");
});

it("CustomCallbacks augmentation produces a typed handler-map shape", () => {
  type Handler = NonNullable<CustomCallbacks["submitEmail"]["output"]>;
  const result: Handler = { ok: true };
  expect(result.ok).toBe(true);
});

it("CustomCallbackHandlers types each handler from its CustomCallbacks entry", async () => {
  const handlers: CustomCallbackHandlers = {
    submitEmail: ({ email }) => ({ status: "success", data: { ok: email.includes("@") } }),
  };
  expect(await handlers.submitEmail!({ email: "a@b.co" }, { name: "submitEmail" })).toEqual({
    status: "success",
    data: { ok: true },
  });

  const _wrongOutput: CustomCallbackHandlers = {
    // @ts-expect-error — `ok` must be a boolean
    submitEmail: () => ({ status: "success", data: { ok: "yes" } }),
  };
  const _wrongInput: CustomCallbackHandlers = {
    // @ts-expect-error — `phone` isn't in submitEmail's input
    submitEmail: ({ phone }) => ({ status: "failure", data: { phone } }),
  };
  const _unknownName: CustomCallbackHandlers = {
    // @ts-expect-error — not declared on CustomCallbacks
    notDeclared: () => ({ status: "failure" }),
  };
  // Failure data isn't tied to the output type.
  const _failure: CustomCallbackHandlers = {
    submitEmail: () => ({ status: "failure", data: { reason: "invalid" } }),
  };
  expect([_wrongOutput, _wrongInput, _unknownName, _failure]).toHaveLength(4);
});
