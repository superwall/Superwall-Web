import type { Entitlements } from "@superwall/core";
import { findMissing, normalizeSpec } from "./spec.ts";
import type {
  ConnectStyleNext,
  ConnectStyleResponse,
  EntitlementSpec,
  RequestInfo,
  RequiresOptions,
  UserIdExtractor,
} from "./types.ts";

interface RequiresFactoryDeps<TReq> {
  defaultUserIdExtractor: UserIdExtractor<TReq> | undefined;
  loadEntitlements: (
    userId: string,
  ) => Promise<{ entitlements: Entitlements; cacheHit: boolean }>;
  emitRequest: (info: RequestInfo) => void;
}

/**
 * Build the `sw.requires(spec, options?)` factory bound to the instance's
 * cache + extractor + telemetry. Returned middleware is connect-style
 * `(req, res, next)`, duck-typed so it works with Express directly and is
 * trivially adaptable to Hono / Bun.serve / Next via a thin wrapper.
 */
export const makeRequires = <TReq>(deps: RequiresFactoryDeps<TReq>) => {
  return (spec: EntitlementSpec, options: RequiresOptions<TReq> = {}) => {
    // Normalize once at registration time; validation errors surface at
    // app boot, not at first request.
    const normalized = normalizeSpec(spec);
    const extractor = options.userId ?? deps.defaultUserIdExtractor;
    const allowAnonymous = options.allowAnonymous ?? false;

    return async (
      req: TReq,
      res: ConnectStyleResponse,
      next: ConnectStyleNext,
    ): Promise<void> => {
      const start = Date.now();
      let userId: string | null = null;
      if (extractor) {
        const extracted = await extractor(req);
        if (typeof extracted === "string" && extracted.length > 0) {
          userId = extracted;
        }
      }

      if (!userId) {
        if (allowAnonymous) {
          next();
          return;
        }
        await rejectUnauthorized(req, res, options, {
          userId: null,
          entitlement: normalized.entitlements[0] ?? "",
          missing: normalized.entitlements,
          reason: "no_user_id",
        });
        return;
      }

      let ents: Entitlements;
      let cacheHit: boolean;
      try {
        const loaded = await deps.loadEntitlements(userId);
        ents = loaded.entitlements;
        cacheHit = loaded.cacheHit;
      } catch (err) {
        // Surfaced to the framework's error handler. Default Express
        // behavior is a 500; consumers can intercept via their own
        // error middleware.
        next(err);
        return;
      }

      const missing = findMissing(normalized, ents);
      deps.emitRequest({
        userId,
        entitlements: ents.active.map((e) => e.id),
        cacheHit,
        durationMs: Date.now() - start,
      });

      if (missing.length === 0) {
        next();
        return;
      }

      await rejectUnauthorized(req, res, options, {
        userId,
        entitlement: missing[0] ?? normalized.entitlements[0] ?? "",
        missing,
        reason: "not_entitled",
      });
    };
  };
};

const rejectUnauthorized = async <TReq>(
  req: TReq,
  res: ConnectStyleResponse,
  options: RequiresOptions<TReq>,
  ctx: {
    userId: string | null;
    entitlement: string;
    missing: ReadonlyArray<string>;
    reason: "no_user_id" | "not_entitled";
  },
): Promise<void> => {
  if (options.onUnauthorized) {
    await options.onUnauthorized(req, res, ctx);
    return;
  }
  res.status(403).json({
    error: "entitlement_required",
    entitlement: ctx.entitlement,
  });
};
