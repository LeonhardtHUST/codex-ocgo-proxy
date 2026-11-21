/**
 * Decide where an OpenCode model is actually forwarded.
 *
 * Two backends, chosen by configuration:
 *   - `rust_routing.enabled` → the loopback `ocx-router` sidecar (legacy OCGo path);
 *   - otherwise              → opencode.ai directly, on the protocol the catalog
 *                              declares for that (upstream, model) pair.
 */

import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { OCGoUpstream } from "../proxy/ocgo-upstream.js";
import type { OpenCodeConfig } from "./config.js";
import type { OpenCodeCatalog } from "./catalog.js";
import { getOpenCodeCatalog, getProtocolMatrix } from "./catalog-runtime.js";
import type { OpenCodeTier } from "./namespace.js";
import { OpenCodeAdapter } from "./adapter.js";
import { RustRouterAdapter } from "./rust-adapter.js";
import { getActiveRustRouter } from "./rust-router.js";
import type { OpenCodeUpstreamId } from "./model.js";
import { resolveUpstreamRoot } from "./upstreams.js";

/** Catalog entry for a tier-qualified or bare model id. */
export function resolveEntryForTier(
  catalog: Pick<OpenCodeCatalog, "find" | "findAny">,
  tier: OpenCodeTier | undefined,
  modelId: string,
) {
  if (tier) return catalog.find(tier, modelId);
  // No tier: prefer the paid go entry, then zen, then anything.
  return catalog.find("go", modelId) ?? catalog.find("zen", modelId) ?? catalog.findAny(modelId);
}

/** Effective logical upstream for a request. */
export function resolveUpstreamForRequest(
  catalog: Pick<OpenCodeCatalog, "find" | "findAny">,
  tier: OpenCodeTier | undefined,
  modelId: string,
): OpenCodeUpstreamId {
  return resolveEntryForTier(catalog, tier, modelId)?.upstream ?? tier ?? "zen";
}

export interface CreateOpenCodeUpstreamOptions {
  config: OpenCodeConfig;
  modelId: string;
  tier?: OpenCodeTier;
  apiKey: string;
  /** Stable cache identity forwarded to the Rust router as x-ocx-session. */
  sessionId?: string;
  /** Injectable for tests. */
  catalog?: Pick<OpenCodeCatalog, "find" | "findAny">;
  matrix?: ReturnType<typeof getProtocolMatrix>;
}

/**
 * Build the adapter for one attempt. Returns the Rust sidecar adapter when
 * `rust_routing` is on, otherwise a direct opencode.ai adapter.
 */
export function createOpenCodeUpstream(options: CreateOpenCodeUpstreamOptions): UpstreamAdapter {
  const { config, modelId, tier, apiKey } = options;
  const catalog = options.catalog ?? getOpenCodeCatalog();
  const entry = resolveEntryForTier(catalog, tier, modelId);
  const upstream = entry?.upstream ?? tier ?? "zen";

  if (config.rust_routing.enabled) {
    const router = getActiveRustRouter();
    if (router?.isReady) {
      // In-repo Rust service: Node already decided upstream + protocol + credential.
      return new RustRouterAdapter({
        baseUrl: config.rust_routing.base_url,
        upstream,
        protocol: "responses",
        modelId,
        apiKey,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        timeoutSeconds: config.http_timeout_seconds,
      });
    }
    if (config.rust_routing.legacy_sidecar) {
      // Pre-rename installations point at the external ocgo2api-rs binary.
      return new OCGoUpstream(config.rust_routing.base_url, apiKey, config.http_timeout_seconds);
    }
    // Router requested but not healthy: degrade to the TypeScript adapter, explicitly.
  }

  return new OpenCodeAdapter({
    upstream,
    apiKey,
    root: resolveUpstreamRoot(config, upstream),
    ...(entry ? { entry } : {}),
    matrix: options.matrix ?? getProtocolMatrix(),
    cache: { aggregation: config.cache_header_aggregation, ...(config.project_seed ? { projectSeed: config.project_seed } : {}) },
  });
}

/** Timeout that applies to an OpenCode request. */
export function resolveTimeoutSeconds(options: {
  opencode?: OpenCodeConfig;
  legacyTimeoutSeconds: number;
}): number {
  if (options.opencode?.enabled) return options.opencode.http_timeout_seconds;
  return options.legacyTimeoutSeconds;
}

/** Whether the OpenCode provider family should serve requests at all. */
export function isOpenCodeServing(options: {
  legacyEnabled: boolean;
  opencode?: Pick<OpenCodeConfig, "enabled">;
}): boolean {
  return options.legacyEnabled || (options.opencode?.enabled ?? false);
}
