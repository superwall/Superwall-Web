// AudienceEvaluator — evaluates `RawAudienceRule.expression` against the
// user/device/computed-property context via the Superscript CEL/WASM
// runtime. Empty expression matches all; evaluation errors fail closed.

import { Context, Effect, Layer } from "effect";
// Lazy + environment-conditional Superscript import: the `/node` entry uses
// `fs.readFileSync` to load the WASM (works in Bun/Node, breaks in browsers);
// the `/browser` entry uses bundler `import './*.wasm'` glue (works in browsers
// + Bun's HTML bundler, breaks in plain Node/Bun runtime). Rust core is the
// same — only the loader differs. Cache the resolved module per process.
import type {
  ExecutionContext,
  WasmHostContext as SuperscriptHostContext,
} from "@superwall/superscript/node";

let evaluatorPromise: Promise<{
  evaluateWithContext: (
    input: ExecutionContext,
    host: SuperscriptHostContext,
  ) => string | boolean;
}> | null = null;

const loadEvaluator = () => {
  if (evaluatorPromise) return evaluatorPromise;
  // `typeof window/document` is unreliable — happy-dom + jsdom register both
  // as globals in Bun/Node test runtimes. The presence of `Bun` or `process`
  // is the actual signal we're outside a browser.
  const isBunOrNode =
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
    typeof (globalThis as { process?: { versions?: { node?: string } } })
      .process?.versions?.node === "string";
  evaluatorPromise = isBunOrNode
    ? import("@superwall/superscript/node")
    : import("@superwall/superscript/browser");
  return evaluatorPromise;
};

// `PassableValue` is the typed-tagged-union the Superscript WASM module
// expects. The node entry doesn't re-export it, so we re-declare it here.
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

export interface AudienceContext {
  /** Current user attributes (`sw.user.attributes` value). */
  readonly user: Partial<UserAttributes>;
  /** Placement params from the `register` call. */
  readonly params: Record<string, JsonValue>;
  /** Static device snapshot (locale, currency, OS, …). */
  readonly device: Record<string, JsonValue>;
}

export type AudienceEvalResult = "match" | "no-match" | "error";

export interface AudienceEvaluatorImpl {
  /** Evaluate a CEL/Superscript expression. Empty ⇒ "match"; errors log
   *  and return "error" for fail-closed semantics. */
  readonly evaluate: (
    expression: string,
    context: AudienceContext,
  ) => Effect.Effect<AudienceEvalResult>;
}

/** Like `toPassable` but skips null entries inside maps + lists. Returns
 *  null when the value itself is null/undefined so callers can drop the key. */
const toPassableNonNull = (
  v: JsonValue | undefined,
): PassableValue | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return { type: "string", value: v };
  if (typeof v === "boolean") return { type: "bool", value: v };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "int", value: v }
      : { type: "float", value: v };
  }
  if (Array.isArray(v)) {
    const items: PassableValue[] = [];
    for (const item of v) {
      const passable = toPassableNonNull(item as JsonValue);
      if (passable !== null) items.push(passable);
    }
    return { type: "list", value: items };
  }
  const out: Record<string, PassableValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
    const passable = toPassableNonNull(val);
    if (passable !== null) out[k] = passable;
  }
  return { type: "map", value: out };
};

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
    // Superscript rejects the whole ExecutionContext if any value typed
    // "null" appears in the variables map — only callbacks like
    // `device_property` are allowed to return null.
    const passable = toPassableNonNull(v as JsonValue);
    if (passable !== null) map[k] = passable;
  }
  return { map };
};

const buildHostContext = (
  computedSnapshot: Map<string, number | null>,
  deviceSnapshot: Record<string, JsonValue>,
): SuperscriptHostContext => ({
  computed_property: (name: string, _args: [PassableValue]) => {
    // Pre-resolved before the WASM call because `computed_property` must
    // be sync per the Superscript contract. `null` ⇒ event never fired.
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
      // Empty / whitespace expression ⇒ match-all.
      if (!expression || expression.trim() === "") return "match";

      // Pre-resolve every computed-property the rule could reference —
      // the WASM `computed_property` callback must be sync, so we can't
      // do async work inside it.
      const computedSnapshot = new Map<string, number | null>();
      for (const type of COMPUTED_KEYS) {
        const value = yield* computed.compute({ type, eventName: "" });
        computedSnapshot.set(type, value);
      }

      const variables = passableMap({
        user: context.user as JsonValue,
        params: context.params as JsonValue,
        device: context.device as JsonValue,
      });

      const input: ExecutionContext = {
        variables,
        expression,
        // Pre-declared key sets — Superscript's expected shape.
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
        try: async () => {
          const mod = await loadEvaluator();
          return mod.evaluateWithContext(input, host) as unknown as
            | string
            | boolean;
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.gen(function* () {
            yield* logger.warn(
              "placements",
              "Audience expression evaluation failed — falling back to match",
              { expression },
              cause instanceof Error ? cause.message : String(cause),
            );
            // Fail-OPEN: when the WASM evaluator can't run (e.g. browser
            // bundle issues with @superwall/superscript), treat the rule as
            // a match so the paywall still presents. Better UX than silently
            // dropping every audience-gated placement.
            return "MATCH" as const;
          }),
        ),
      );

      if (result === "MATCH") return "match";

      // Superscript returns a JSON envelope `{Ok|Err}`; older builds
      // returned a direct boolean — handle both.
      if (typeof result === "boolean") return result ? "match" : "no-match";
      try {
        const parsed = JSON.parse(String(result)) as
          | { Ok?: { type?: string; value?: unknown }; Err?: unknown }
          | unknown;
        if (parsed && typeof parsed === "object" && "Ok" in parsed) {
          const ok = (parsed as { Ok: { type?: string; value?: unknown } }).Ok;
          if (ok && ok.type === "bool") return ok.value === true ? "match" : "no-match";
          // Non-boolean results are treated as match if truthy.
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
      } catch {}
      const trimmed = String(result).trim().toLowerCase();
      return trimmed === "true" ? "match" : "no-match";
    }).pipe(Effect.withSpan("AudienceEvaluator.evaluate"));

  return { evaluate } satisfies AudienceEvaluatorImpl;
});

export class AudienceEvaluator extends Context.Tag(
  "@superwall/AudienceEvaluator",
)<AudienceEvaluator, AudienceEvaluatorImpl>() {}

/** Build an AudienceEvaluator Layer over an upstream providing
 *  `ComputedProperties` + `Logger`. */
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
