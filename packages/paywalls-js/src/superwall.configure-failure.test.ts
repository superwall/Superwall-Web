// A configure() that fails partway must still let register() settle. It
// drained its Configuration pending item only on success, and register()
// waits on that, so any startup failure left every register() pending forever
// (and spinning). The known failures are fixed elsewhere; this injects one —
// a throw inside configure()'s attribution step, which bypasses that step's
// catchAll as a defect — to pin the guarantee for whatever fails next.

import { it, expect } from "@effect/vitest";
import { vi } from "vitest";
import { createSuperwall } from "./index.ts";

vi.mock("./internal/attributionAttributes.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./internal/attributionAttributes.ts")>()),
  collectCurrentAttribution: () => {
    throw new Error("injected configure() failure");
  },
}));

const fetch = ((input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/v1/static_config")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          build_id: "test_build",
          trigger_options: [],
          paywall_responses: [],
          products: [],
          toggles: [],
        }),
      ),
    );
  }
  return Promise.resolve(new Response("", { status: 204 }));
}) as unknown as typeof globalThis.fetch;

it("register() settles instead of hanging when configure() fails", async () => {
  const sw = createSuperwall({ apiKey: "pk_test", fetch });
  await expect(sw.ready).rejects.toThrow("injected configure() failure");
  expect(sw.configurationStatus.value).toBe("failed");

  const outcome = await Promise.race([
    sw.register({ placement: "checkout" }).then(
      () => "settled",
      () => "settled",
    ),
    new Promise((r) => setTimeout(() => r("hung"), 2000)),
  ]);
  expect(outcome).toBe("settled");
  await sw.dispose();
});
