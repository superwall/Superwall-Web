// Internal Logger — routes SDK log entries to the public
// `SuperwallDelegate.onLog` callback (if any) and, when the configured
// `LogLevel` permits, to `console`.
//
// Surface lands now so consumers can wire `delegate.onLog` for analytics
// forwarding. Internal call sites (network failures, presenter teardown,
// storage quota, etc.) will be migrated from `// swallow` comments to
// `Logger.warn(...)` calls incrementally.
//
// Internal-only — not exported from the package barrel. The PUBLIC log
// surface is the `setLogLevel` setter on `Superwall` + the delegate hook.

import { Context, Effect, Layer, Ref } from "effect";
import type { JsonValue, LogLevel, LogScope } from "../types.ts";
import { EventBus } from "./eventBus.ts";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  none: 100,
};

export interface LoggerImpl {
  readonly setLevel: (level: LogLevel) => Effect.Effect<void>;
  readonly getLevel: () => Effect.Effect<LogLevel>;
  readonly log: (
    level: LogLevel,
    scope: LogScope,
    message: string,
    info?: Record<string, JsonValue> | null,
    error?: string | null,
  ) => Effect.Effect<void>;
  readonly debug: (
    scope: LogScope,
    message: string,
    info?: Record<string, JsonValue> | null,
  ) => Effect.Effect<void>;
  readonly info: (
    scope: LogScope,
    message: string,
    info?: Record<string, JsonValue> | null,
  ) => Effect.Effect<void>;
  readonly warn: (
    scope: LogScope,
    message: string,
    info?: Record<string, JsonValue> | null,
    error?: string | null,
  ) => Effect.Effect<void>;
  readonly error: (
    scope: LogScope,
    message: string,
    info?: Record<string, JsonValue> | null,
    error?: string | null,
  ) => Effect.Effect<void>;
}

const make = (initialLevel: LogLevel) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const levelRef = yield* Ref.make<LogLevel>(initialLevel);

    const log: LoggerImpl["log"] = (level, scope, message, info, error) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(levelRef);
        if (LEVEL_RANK[level] < LEVEL_RANK[current]) return;

        // Console mirror — best-effort. Wrapped because consumers might
        // strip `console` (Workers, sandboxed iframes, etc.).
        try {
          const target =
            level === "error"
              ? console.error
              : level === "warn"
                ? console.warn
                : level === "debug"
                  ? console.debug
                  : console.info;
          if (info !== undefined && info !== null) {
            target(`[Superwall:${scope}] ${message}`, info, error ?? "");
          } else if (error !== undefined && error !== null) {
            target(`[Superwall:${scope}] ${message}`, error);
          } else {
            target(`[Superwall:${scope}] ${message}`);
          }
        } catch {
          /* console gone — drop */
        }

        // Delegate dispatch. Errors inside the delegate are absorbed by
        // EventBus.withDelegate so a buggy log sink never crashes the SDK.
        yield* bus.withDelegate((d) =>
          d.onLog?.(level, scope, message, info ?? null, error ?? null),
        );
      });

    const at =
      (level: LogLevel) =>
      (
        scope: LogScope,
        message: string,
        info?: Record<string, JsonValue> | null,
        error?: string | null,
      ) =>
        log(level, scope, message, info, error);

    return {
      setLevel: (level: LogLevel) => Ref.set(levelRef, level),
      getLevel: () => Ref.get(levelRef),
      log,
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    } satisfies LoggerImpl;
  });

export class Logger extends Context.Tag("@superwall/Logger")<
  Logger,
  LoggerImpl
>() {}

/** Build a Logger Layer that depends on the supplied EventBus. The result
 *  exposes `Logger` AND re-exposes the upstream services for downstream
 *  consumers. */
export const loggerLayer = (
  initialLevel: LogLevel,
  busLayer: Layer.Layer<EventBus>,
): Layer.Layer<Logger | EventBus, never, never> =>
  Layer.provideMerge(
    Layer.effect(Logger, make(initialLevel)),
    busLayer,
  ) as Layer.Layer<Logger | EventBus, never, never>;
