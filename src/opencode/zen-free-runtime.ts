/**
 * zen-free integration: expose the aggregated pool through the same `acquire` shape the
 * OCGo handler already expects, so the switch becomes effective without touching the
 * tested request path.
 *
 * Selection rule: a model that the catalogue marks free goes to the zen-free pool when
 * `upstreams.zen_free.pool_all_keys` is on; everything else keeps using the per-model
 * credential pool exactly as before.
 */

import type { OCGoLease, OCGoPool, OCGoSelection, OCGoSession } from "../auth/ocgo-pool.js";
import type { OpenCodeConfig } from "./config.js";
import type { OpenCodeCatalog } from "./catalog.js";
import { ZenFreePool, type ZenFreeCredentialSource, type ZenFreeFailure } from "./zen-free-pool.js";

export interface KeySelectorOptions {
  /** Existing per-model credential pool (unchanged behaviour). */
  pool: Pick<OCGoPool, "acquire" | "beginClientRequest" | "snapshot">;
  /** Free-tier pool; null when the switch is off. */
  zenFree: ZenFreePool | null;
  /** Catalogue lookup used to decide whether a model is free. */
  isFreeModel: (modelId: string) => boolean;
}

/** Build the free-tier pool from the credential store and current config. */
export function createZenFreePool(
  source: ZenFreeCredentialSource,
  config: OpenCodeConfig | undefined,
): ZenFreePool | null {
  if (!config?.enabled) return null;
  if (!config.upstreams.zen_free.enabled || !config.upstreams.zen_free.pool_all_keys) return null;
  return new ZenFreePool(source, { poolAllKeys: true });
}

/** Wrap a zen-free lease so it satisfies the OCGo lease contract. */
function leaseFromZenFree(
  pool: ZenFreePool,
  credentialId: string,
  apiKey: string,
  models: readonly string[],
): OCGoLease {
  let settled = false;
  let failed = false;
  return {
    credentialId,
    apiKey,
    quotaGroup: null,
    beginAttempt() {
      return (outcome, usage) => {
        if (settled) return;
        settled = true;
        if (outcome === "succeeded") {
          pool.recordSuccess(credentialId);
        } else if (failed) {
          // already reported through reportFailure
        } else if (outcome === "failed") {
          pool.recordFailure(credentialId, "unknown");
        }
      };
    },
    complete() {
      pool.recordSuccess(credentialId);
    },
    reportFailure(kind: string, retryAfterSeconds?: number) {
      failed = true;
      pool.recordFailure(credentialId, mapFailure(kind), retryAfterSeconds);
    },
    release() {
      pool.release(credentialId);
      void models;
    },
  };
}

function mapFailure(kind: string): ZenFreeFailure {
  switch (kind) {
    case "invalid_key": return "invalid_key";
    case "model_denied": return "model_denied";
    case "key_rate_limit": return "rate_limited";
    case "quota_group_exhausted": return "quota_group_exhausted";
    case "unknown_rate_limit": return "rate_limited";
    default: return "unknown";
  }
}

/**
 * `acquire` facade: free models go through zen-free, everything else delegates.
 * `beginClientRequest` always delegates (bookkeeping belongs to the original pool).
 */
export function createKeySelector(options: KeySelectorOptions): Pick<OCGoPool, "acquire" | "beginClientRequest" | "snapshot"> {
  const { pool, zenFree, isFreeModel } = options;
  return {
    beginClientRequest: () => pool.beginClientRequest(),
    snapshot: () => pool.snapshot(),
    acquire: (modelId: string, session?: OCGoSession, opts?): OCGoSelection => {
      if (!zenFree || !isFreeModel(modelId)) return pool.acquire(modelId, session, opts);
      const result = zenFree.acquire(modelId);
      if (result.kind === "channel_blocked") {
        return { kind: "backoff", retryAfterSeconds: result.retryAfterSeconds };
      }
      if (result.kind !== "selected") return { kind: result.kind };
      return {
        kind: "selected",
        lease: leaseFromZenFree(zenFree, result.key.id, result.key.apiKey, result.key.models),
      };
    },
  };
}

/** Catalogue-backed free check; missing entries are treated as paid. */
export function freeModelPredicate(catalog: Pick<OpenCodeCatalog, "findAny">): (modelId: string) => boolean {
  return (modelId: string) => catalog.findAny(modelId)?.free === true;
}
