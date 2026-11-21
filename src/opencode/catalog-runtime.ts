/**
 * Process-wide OpenCode catalog + protocol-correction singletons.
 *
 * Refresh never runs on the request path: the seed is loaded lazily, one refresh is
 * kicked off after startup, and a cheap timer checks `shouldRefresh()` on an
 * interval. A failed refresh keeps the previous snapshot and reports `stale`.
 */

import { OpenCodeCatalog, type OpenCodeCatalogStatus } from "./catalog.js";
import { ProtocolMatrix } from "./protocol-matrix.js";
import type { OpenCodeConfig } from "./config.js";

/** How often the timer wakes up to check whether a refresh is due. */
const REFRESH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let catalog: OpenCodeCatalog | null = null;
let matrix: ProtocolMatrix | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** Shared catalog instance (lazily created, seed loaded once). */
export function getOpenCodeCatalog(): OpenCodeCatalog {
  if (!catalog) {
    catalog = new OpenCodeCatalog();
    catalog.loadSeed();
  }
  return catalog;
}

/** Shared protocol-correction store, keyed by (upstream, model). */
export function getProtocolMatrix(): ProtocolMatrix {
  if (!matrix) matrix = new ProtocolMatrix();
  return matrix;
}

/** Flat provider row for status output — deliberately narrower than ProviderDescriptor. */
export interface OpenCodeProviderSummary {
  id: string;
  kind: string;
  enabled: boolean;
  priority: number;
  label?: string;
}

export interface OpenCodeRuntimeStatus extends OpenCodeCatalogStatus {
  /** Provider inventory, so the dashboard can see every routable provider and its priority. */
  providers: OpenCodeProviderSummary[];
  protocolCorrections: number;
  refreshRunning: boolean;
}

/** Status snapshot for `/admin/opencode/status`. */
export function openCodeRuntimeStatus(providers: OpenCodeProviderSummary[] = []): OpenCodeRuntimeStatus {
  const instance = getOpenCodeCatalog();
  return {
    ...instance.status(),
    providers,
    protocolCorrections: getProtocolMatrix().size(),
    refreshRunning: started,
  };
}

/**
 * Start background refresh. Safe to call once at boot; repeated calls are no-ops.
 * Returns a disposer so tests can stop the timer.
 */
export function startOpenCodeCatalogRefresh(config?: Pick<OpenCodeConfig, "enabled">): () => void {
  if (started) return stopOpenCodeCatalogRefresh;
  started = true;
  const instance = getOpenCodeCatalog();
  // Load the seed synchronously so /models is populated even with no network.
  instance.loadSeed();

  const runRefresh = () => {
    if (config && config.enabled === false) return;
    void instance.refresh();
  };
  // First refresh shortly after boot, never inline with startup work.
  const kickoff = setTimeout(runRefresh, 1_000);
  kickoff.unref?.();

  timer = setInterval(() => {
    if (instance.shouldRefresh()) runRefresh();
  }, REFRESH_CHECK_INTERVAL_MS);
  timer.unref?.();

  return stopOpenCodeCatalogRefresh;
}

export function stopOpenCodeCatalogRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** Test-only: replace the shared instances and reset the scheduler. */
export function setOpenCodeRuntimeForTesting(next: { catalog?: OpenCodeCatalog; matrix?: ProtocolMatrix }): void {
  if (next.catalog) catalog = next.catalog;
  if (next.matrix) matrix = next.matrix;
}

/** Test-only: drop the singletons so the next call rebuilds them. */
export function resetOpenCodeRuntimeForTesting(): void {
  stopOpenCodeCatalogRefresh();
  catalog = null;
  matrix = null;
}
