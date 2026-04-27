// NetworkService — wraps `fetch` for the four Superwall HTTP endpoints
// (config, collector, enrichment, confirm_assignments). v0 ships the
// header builder + `getStaticConfig` + `postEvents`. Enrichment and
// confirm-assignments land alongside their callers.
//
// Per API.md §11.1 / §11.3 / §11.4. Retries (`Schedule.exponential` honoring
// `maxConfigRetryCount`) and the 500ms / 1s fresh-window cache from §11.7
// land in §2 follow-up — added once the config consumer exists to drive them.

import { Context, Effect, Layer } from "effect";
import { SDK_VERSION } from "../version.ts";
import type { JsonValue, NetworkEnvironment } from "../types.ts";
import {
  IdentityNotHydratedError,
  NetworkDecodingError,
  NetworkRequestError,
} from "./errors.ts";
import { IdentityService } from "./identity.ts";

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

interface EnvironmentHosts {
  readonly base: string;
  readonly collector: string;
  readonly enrichment: string;
  readonly subscriptions: string;
}

const RELEASE_HOSTS: EnvironmentHosts = {
  base: "api.superwall.me",
  collector: "collector.superwall.me",
  enrichment: "enrichment-api.superwall.com",
  subscriptions: "subscriptions-api.superwall.com",
};

const RC_HOSTS: EnvironmentHosts = {
  base: "api.superwallcanary.com",
  collector: "collector.superwallcanary.com",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
};

const DEV_HOSTS: EnvironmentHosts = {
  base: "api.superwall.dev",
  collector: "collector.superwall.dev",
  enrichment: "enrichment-api.superwall.dev",
  subscriptions: "subscriptions-api.superwall.dev",
};

export const resolveHosts = (env: NetworkEnvironment): EnvironmentHosts => {
  if (typeof env === "string") {
    switch (env) {
      case "release":
        return RELEASE_HOSTS;
      case "releaseCandidate":
        return RC_HOSTS;
      case "developer":
        return DEV_HOSTS;
    }
  }
  return env.custom;
};

// ---------------------------------------------------------------------------
// Config (per-instance data)
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  readonly apiKey: string;
  readonly environment: NetworkEnvironment;
  readonly appVersion?: string;
  readonly bundleId?: string;
  readonly urlScheme?: string;
  /** Override fetch (tests); falls back to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Browser / BE-safe globals fallbacks
// ---------------------------------------------------------------------------

const safeReadString = (read: () => string | undefined): string => {
  try {
    return read() ?? "";
  } catch {
    return "";
  }
};

const resolveBundleId = (config: NetworkConfig): string =>
  config.bundleId ??
  safeReadString(() =>
    typeof globalThis !== "undefined" && "location" in globalThis
      ? (globalThis as { location: { hostname: string } }).location?.hostname
      : undefined,
  );

const resolveUrlScheme = (config: NetworkConfig): string =>
  config.urlScheme ??
  safeReadString(() =>
    typeof globalThis !== "undefined" && "location" in globalThis
      ? (globalThis as { location: { origin: string } }).location?.origin
      : undefined,
  );

const resolveLocale = (): string =>
  safeReadString(() =>
    typeof globalThis !== "undefined" && "navigator" in globalThis
      ? (globalThis as { navigator: { language: string } }).navigator?.language
      : undefined,
  ) || "en-US";

const resolveLanguageCode = (locale: string): string =>
  locale.split("-")[0] ?? "en";

const resolveCurrency = (locale: string): string => {
  try {
    return new Intl.NumberFormat(locale).resolvedOptions().currency ?? "";
  } catch {
    return "";
  }
};

const resolveTimezoneOffsetSeconds = (): number =>
  -new Date().getTimezoneOffset() * 60;

const resolveInterfaceStyle = (): "light" | "dark" => {
  try {
    if (
      typeof globalThis !== "undefined" &&
      "matchMedia" in globalThis &&
      (globalThis as { matchMedia: (q: string) => { matches: boolean } }).matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches
    ) {
      return "dark";
    }
  } catch {
    // no-op
  }
  return "light";
};

const isSandbox = (env: NetworkEnvironment): boolean =>
  typeof env === "string" ? env !== "release" : true;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = (config: NetworkConfig) =>
  Effect.gen(function* () {
    const identity = yield* IdentityService;
    const fetchImpl =
      config.fetch ??
      (typeof globalThis !== "undefined" && "fetch" in globalThis
        ? (globalThis.fetch.bind(globalThis) as typeof fetch)
        : null);

    // fetch availability is checked lazily inside requireFetch() below —
    // building headers etc. still works without a fetch impl.

    const buildHeaders = Effect.fn("NetworkService.buildHeaders")(function* (
      extra?: Record<string, string>,
    ) {
      const snap = yield* identity.current();
      const locale = resolveLocale();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Platform": "Web",
        "X-Platform-Environment": "SDK",
        "X-Platform-Wrapper": "Web",
        "X-App-User-ID": snap.appUserId,
        "X-Alias-ID": snap.aliasId,
        "X-URL-Scheme": resolveUrlScheme(config),
        "X-Vendor-ID": snap.vendorId,
        "X-App-Version": config.appVersion ?? "",
        "X-Device-Locale": locale,
        "X-Device-Language-Code": resolveLanguageCode(locale),
        "X-Device-Currency-Code": resolveCurrency(locale),
        "X-Device-Timezone-Offset": String(resolveTimezoneOffsetSeconds()),
        "X-Device-Interface-Style": resolveInterfaceStyle(),
        "X-SDK-Version": SDK_VERSION,
        "X-Bundle-ID": resolveBundleId(config),
        "X-Is-Sandbox": String(isSandbox(config.environment)),
        "X-Current-Time": new Date().toISOString(),
        ...extra,
      };
      return headers;
    });

    const requireFetch = (): typeof fetch => {
      if (!fetchImpl) {
        throw new NetworkRequestError({
          method: "?",
          url: "?",
          message:
            "No fetch implementation available — provide config.fetch or run in an environment with globalThis.fetch.",
        });
      }
      return fetchImpl;
    };

    /** GET /api/v1/static_config?pk={apiKey} on the base host. */
    const getStaticConfig = Effect.fn("NetworkService.getStaticConfig")(
      function* () {
        const hosts = resolveHosts(config.environment);
        const url = `https://${hosts.base}/api/v1/static_config?pk=${encodeURIComponent(config.apiKey)}`;
        const headers = yield* buildHeaders();

        const response = yield* Effect.tryPromise({
          try: async () => requireFetch()(url, { method: "GET", headers }),
          catch: (cause) =>
            new NetworkRequestError({
              method: "GET",
              url,
              message: `static_config network error: ${describe(cause)}`,
              cause,
            }),
        });

        if (!response.ok) {
          return yield* Effect.fail(
            new NetworkRequestError({
              method: "GET",
              url,
              status: response.status,
              message: `static_config returned ${response.status}`,
            }),
          );
        }

        return yield* Effect.tryPromise({
          try: () => response.json() as Promise<JsonValue>,
          catch: (cause) =>
            new NetworkDecodingError({
              url,
              message: `static_config JSON decode failed: ${describe(cause)}`,
              cause,
            }),
        });
      },
    );

    /** POST /api/v1/events on the collector host.
     *  `events` is the array shape from API.md §11.4. */
    const postEvents = Effect.fn("NetworkService.postEvents")(function* (
      events: ReadonlyArray<EventEnvelope>,
    ) {
      const hosts = resolveHosts(config.environment);
      const url = `https://${hosts.collector}/api/v1/events`;
      const headers = yield* buildHeaders();

      const response = yield* Effect.tryPromise({
        try: async () =>
          requireFetch()(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ events }),
          }),
        catch: (cause) =>
          new NetworkRequestError({
            method: "POST",
            url,
            message: `events network error: ${describe(cause)}`,
            cause,
          }),
      });

      if (!response.ok) {
        return yield* Effect.fail(
          new NetworkRequestError({
            method: "POST",
            url,
            status: response.status,
            message: `events returned ${response.status}`,
          }),
        );
      }
    });

    /** POST /api/v1/enrich on the enrichment host.
     *  Body: `{ user, device }`; response: `{ user, device }` of enriched
     *  attributes that the SDK merges into local state. Per API.md §11.6. */
    const postEnrichment = Effect.fn("NetworkService.postEnrichment")(
      function* (payload: EnrichmentRequest) {
        const hosts = resolveHosts(config.environment);
        const url = `https://${hosts.enrichment}/api/v1/enrich`;
        const headers = yield* buildHeaders();

        const response = yield* Effect.tryPromise({
          try: async () =>
            requireFetch()(url, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
            }),
          catch: (cause) =>
            new NetworkRequestError({
              method: "POST",
              url,
              message: `enrichment network error: ${describe(cause)}`,
              cause,
            }),
        });

        if (!response.ok) {
          return yield* Effect.fail(
            new NetworkRequestError({
              method: "POST",
              url,
              status: response.status,
              message: `enrichment returned ${response.status}`,
            }),
          );
        }

        return yield* Effect.tryPromise({
          try: () => response.json() as Promise<EnrichmentResponse>,
          catch: (cause) =>
            new NetworkDecodingError({
              url,
              message: `enrichment JSON decode failed: ${describe(cause)}`,
              cause,
            }),
        });
      },
    );

    return {
      buildHeaders,
      getStaticConfig,
      postEvents,
      postEnrichment,
    } as const;
  });

/** Body of `POST /api/v1/enrich`. */
export interface EnrichmentRequest {
  readonly user: Record<string, JsonValue>;
  readonly device: Record<string, JsonValue>;
}

/** Response from `POST /api/v1/enrich`. Server-known augmentations the SDK
 *  merges into its local user/device attribute snapshots. */
export interface EnrichmentResponse {
  readonly user: Record<string, JsonValue | null>;
  readonly device: Record<string, JsonValue | null>;
}

export interface EventEnvelope {
  readonly event_id: string;
  readonly event_name: string;
  readonly parameters: Record<string, JsonValue>;
  readonly created_at: string;
}

export interface NetworkServiceImpl {
  readonly buildHeaders: (
    extra?: Record<string, string>,
  ) => Effect.Effect<Record<string, string>, IdentityNotHydratedError>;
  readonly getStaticConfig: () => Effect.Effect<
    JsonValue,
    NetworkRequestError | NetworkDecodingError | IdentityNotHydratedError
  >;
  readonly postEvents: (
    events: ReadonlyArray<EventEnvelope>,
  ) => Effect.Effect<void, NetworkRequestError | IdentityNotHydratedError>;
  readonly postEnrichment: (
    payload: EnrichmentRequest,
  ) => Effect.Effect<
    EnrichmentResponse,
    NetworkRequestError | NetworkDecodingError | IdentityNotHydratedError
  >;
}

/**
 * Network service is runtime-injected per `createSuperwall` (apiKey +
 * environment vary per instance), so it's a `Context.Tag` rather than an
 * `Effect.Service` with a Default — see effect-best-practices skill on
 * "runtime injection" / "factory patterns" exception.
 */
export class NetworkService extends Context.Tag("@superwall/NetworkService")<
  NetworkService,
  NetworkServiceImpl
>() {}

/** Build a Layer that exposes NetworkService given runtime config + an
 *  IdentityService Layer. The IdentityService is provided to NetworkService
 *  internally; the resulting Layer outputs both for downstream consumers. */
export const networkServiceLayer = (
  config: NetworkConfig,
  identityLayer: Layer.Layer<IdentityService>,
): Layer.Layer<NetworkService | IdentityService> =>
  Layer.provideMerge(
    Layer.effect(NetworkService, make(config)),
    identityLayer,
  );

const describe = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : JSON.stringify(cause);
