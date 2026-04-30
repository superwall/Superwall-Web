// AudienceEvaluator — evaluates a `RawAudienceRule.expression` against
// the user/device/computed-property context using the same Superscript
// CEL runtime that iOS/Android/Flutter ship. Cross-platform parity for
// audience filters.
//
// Implementation:
//   - The browser export of `@superwall/superscript` is a Promise-returning
//     evaluator backed by a WASM module loaded on first use. We wrap it in
//     an `Effect.Service` so the rest of the SDK can compose with it.
//   - The host context bridges into our internal services:
//       - `computed_property("daysSince_X")` → `ComputedPropertiesService`
//       - `device_property("X")` → device-attribute snapshot (TBD; for v0
//          we route through the user-attributes signal so simple rules
//          like `user.plan == "free"` work today; richer device attrs
//          land with the device-attributes builder in MISSING.md).
//   - Expressions with empty string match-all (Android parity); rules with
//     an unparseable expression fail closed (no audience match).
//
// Public surface: `AudienceEvaluator` is internal-only. The placement
// engine in `superwall.ts` calls `evaluate(rule, context)` to get a yes/no
// for each rule and picks the first match.

import { Context, Effect, Layer } from "effect";
// We intentionally import the `/node` entry rather than `/browser` because:
//   - The node target uses CommonJS-style WASM init (`require('./*.wasm')`)
//     which Bun handles natively in `bun test` AND which bundlers (Bun
//     bundler, Vite, Webpack 5, Next.js) all polyfill into something they
//     can resolve. The browser target uses bundler-specific
//     `import './*.wasm'` glue that breaks in plain Node / Bun.
//   - All Superscript builds share one Rust core; node and browser only
//     differ in the JS glue layer. CEL semantics are identical.
import {
  evaluateWithContext,
  type ExecutionContext,
  type WasmHostContext as SuperscriptHostContext,
} from "@superwall/superscript/node";

// `PassableValue` is the typed-tagged-union the Superscript WASM module
// expects. The browser entry doesn't re-export it, so we re-declare it
// here mirroring `@superwall/superscript/dist/types/types.d.ts`.
type ValueType =
  | "uint"
  | "string"
  | "bool"
  | "map"
  | "int"
  | "float"
  | "list"
  | "function"
  | "bytes"
  | "timestamp"
  | "null";

interface PassableValue {
  type: ValueType;
  value: unknown;
}
import type { JsonValue, UserAttributes } from "../types.ts";
import { ComputedProperties } from "./computed.ts";
import { Logger } from "./logger.ts";

// ---------------------------------------------------------------------------
// Public-facing context shape — we accept plain TS objects, not PassableValue
// ---------------------------------------------------------------------------

export interface AudienceContext {
  /** Current user attributes (`sw.user.attributes` value). */
  readonly user: Partial<UserAttributes>;
  /** Placement params from the `register` call. */
  readonly params: Record<string, JsonValue>;
  /** Static device snapshot (locale, currency, OS, …). v0 alpha is the
   *  thin device payload from headers; full builder lands in MISSING.md. */
  readonly device: Record<string, JsonValue>;
}

export type AudienceEvalResult = "match" | "no-match" | "error";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AudienceEvaluatorImpl {
  /** Evaluate a single CEL/Superscript expression against the context.
   *  Empty expression ⇒ "match" (Android parity). Errors during
   *  evaluation log + return "error" so the placement engine can choose
   *  fail-closed semantics. */
  readonly evaluate: (
    expression: string,
    context: AudienceContext,
  ) => Effect.Effect<AudienceEvalResult>;
}

// ---------------------------------------------------------------------------
// PassableValue conversion — from arbitrary JSON to Superscript's typed
// `PassableValue` tree. Used to lift our `AudienceContext` into the
// `ExecutionContext.variables` payload the WASM module expects.
// ---------------------------------------------------------------------------

const toPassable = (v: JsonValue | undefined): PassableValue => {
  if (v === undefined || v === null) return { type: "null", value: null };
  if (typeof v === "string") return { type: "string", value: v };
  if (typeof v === "boolean") return { type: "bool", value: v };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "int", value: v }
      : { type: "float", value: v };
  }
  if (Array.isArray(v)) {
    return {
      type: "list",
      value: v.map((item) => toPassable(item as JsonValue)),
    };
  }
  // Plain object → map
  const out: Record<string, PassableValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
    out[k] = toPassable(val);
  }
  return { type: "map", value: out };
};

const passableMap = (
  obj: Record<string, JsonValue | undefined>,
): { map: Record<string, PassableValue> } => {
  const map: Record<string, PassableValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    map[k] = toPassable(v as JsonValue);
  }
  return { map };
};

// ---------------------------------------------------------------------------
// Host context bridge — Superscript callbacks back into SDK state
// ---------------------------------------------------------------------------

const buildHostContext = (
  computedSnapshot: Map<string, number | null>,
  deviceSnapshot: Record<string, JsonValue>,
): SuperscriptHostContext => ({
  computed_property: (name: string, _args: [PassableValue]) => {
    // Computed properties (daysSince_*, paywallsInHour, etc.) were
    // pre-resolved into `computedSnapshot` synchronously before the WASM
    // call, since `computed_property` itself is sync per the Superscript
    // contract. `null` ⇒ event has never fired.
    const value = computedSnapshot.get(name);
    if (value === null || value === undefined) {
      return { type: "null", value: null };
    }
    return { type: "uint", value };
  },
  device_property: (name: string, _args: [PassableValue]) => {
    const v = deviceSnapshot[name];
    if (v === undefined || v === null) return { type: "null", value: null };
    return toPassable(v);
  },
});

// ---------------------------------------------------------------------------
// `make` — builds the service. `computed` is consulted up-front to gather
// every reference the Superscript runtime might ask for.
// ---------------------------------------------------------------------------

const COMPUTED_KEYS = [
  "minutesSince",
  "hoursSince",
  "daysSince",
  "monthsSince",
  "yearsSince",
  "placementsInHour",
  "placementsInDay",
  "placementsInWeek",
  "placementsInMonth",
  "placementsSinceInstall",
] as const;

const make = Effect.gen(function* () {
  const computed = yield* ComputedProperties;
  const logger = yield* Logger;

  const evaluate: AudienceEvaluatorImpl["evaluate"] = (expression, context) =>
    Effect.gen(function* () {
      // Empty / whitespace expression ⇒ match-all (Android parity).
      if (!expression || expression.trim() === "") return "match";

      // Pre-resolve every computed-property the rule could reference. We
      // can't do async work inside the WASM `computed_property` callback,
      // so we eagerly fetch what's likely needed. For v0 we simply pull
      // every supported computed property — the cost is a single pass
      // over the (in-memory) history per evaluation.
      const computedSnapshot = new Map<string, number | null>();
      for (const type of COMPUTED_KEYS) {
        const value = yield* computed.compute({ type, eventName: "" });
        computedSnapshot.set(type, value);
      }
      // For `daysSince_<eventName>` style references, we'd need to know
      // the event name in advance. v0 supports the canonical names above;
      // event-specific lookups land alongside the placement engine. Track
      // in MISSING.md.

      const variables = passableMap({
        user: context.user as JsonValue,
        params: context.params as JsonValue,
        device: context.device as JsonValue,
      });

      const input: ExecutionContext = {
        variables,
        expression,
        // Pre-declared computed/device key sets — matches the Superscript
        // example's `computed: { daysSinceEvent: [...] }` shape.
        computed: COMPUTED_KEYS.reduce<Record<string, PassableValue[]>>(
          (acc, k) => {
            acc[k] = [];
            return acc;
          },
          {},
        ),
        device: Object.keys(context.device).reduce<
          Record<string, PassableValue[]>
        >((acc, k) => {
          acc[k] = [];
          return acc;
        }, {}),
      };

      const host = buildHostContext(
        computedSnapshot,
        context.device as Record<string, JsonValue>,
      );

      const result = yield* Effect.tryPromise({
        try: () =>
          evaluateWithContext(input, host) as unknown as Promise<
            string | boolean
          >,
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.gen(function* () {
            yield* logger.warn(
              "placements",
              "Audience expression evaluation failed",
              { expression },
              cause instanceof Error ? cause.message : String(cause),
            );
            return "ERROR" as const;
          }),
        ),
      );

      if (result === "ERROR") return "error";

      // Superscript returns a JSON-encoded result envelope:
      //   `{ "Ok": { "type": "bool", "value": true } }` on success
      //   `{ "Err": { "kind": "...", "message": "..." } }` on error
      // (Direct booleans appear from older builds — handle both.)
      if (typeof result === "boolean") return result ? "match" : "no-match";
      try {
        const parsed = JSON.parse(String(result)) as
          | { Ok?: { type?: string; value?: unknown }; Err?: unknown }
          | unknown;
        if (parsed && typeof parsed === "object" && "Ok" in parsed) {
          const ok = (parsed as { Ok: { type?: string; value?: unknown } }).Ok;
          if (ok && ok.type === "bool") return ok.value === true ? "match" : "no-match";
          // Non-boolean expressions ("true" / "false" string literals,
          // numeric, etc.) are treated as match if truthy.
          return ok && ok.value ? "match" : "no-match";
        }
        if (parsed && typeof parsed === "object" && "Err" in parsed) {
          yield* logger.warn(
            "placements",
            "Audience expression returned an Err envelope",
            { expression },
            JSON.stringify((parsed as { Err: unknown }).Err),
          );
          return "error";
        }
      } catch {
        // Fallthrough — try the raw-string-true path below.
      }
      const trimmed = String(result).trim().toLowerCase();
      return trimmed === "true" ? "match" : "no-match";
    }).pipe(Effect.withSpan("AudienceEvaluator.evaluate"));

  return { evaluate } satisfies AudienceEvaluatorImpl;
});

export class AudienceEvaluator extends Context.Tag(
  "@superwall/AudienceEvaluator",
)<AudienceEvaluator, AudienceEvaluatorImpl>() {}

/** Build an AudienceEvaluator Layer. Depends on `ComputedProperties` +
 *  `Logger` from the upstream Layer. */
export const audienceEvaluatorLayer = (
  upstream: Layer.Layer<ComputedProperties | Logger>,
): Layer.Layer<
  AudienceEvaluator | ComputedProperties | Logger,
  never,
  never
> =>
  Layer.provideMerge(
    Layer.effect(AudienceEvaluator, make),
    upstream,
  ) as Layer.Layer<
    AudienceEvaluator | ComputedProperties | Logger,
    never,
    never
  >;
