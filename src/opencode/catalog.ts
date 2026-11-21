/**
 * OpenCode model catalog.
 *
 * Two sources, one normalized shape:
 *   1. the upstream model list (`/inference/v1/models`, `/inference/go/v1/models`)
 *      decides *whether a model is usable*, and carries protocol + limits + price;
 *   2. the bundled seed (`config/opencode-models.seed.json`) covers cold start and
 *      upstream outages.
 *
 * Rules that come from recon (docs/recon/OPENCODE_UPSTREAM_MATRIX.md):
 *   - the same model id can live on several upstreams with different protocols, so
 *     every entry carries its own `upstream` and the catalog is keyed by the pair;
 *   - free tier is decided by price (`cost.text.input.price === 0`), the `-free`
 *     suffix is only a fallback;
 *   - catalog refresh never blocks an inference request; on failure the previous
 *     snapshot keeps serving and is flagged stale.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfigDir } from "../paths.js";
import {
  isChatSelectable,
  type OpenCodeModelEntry,
  type OpenCodeUpstreamId,
  type OpenCodeWire,
} from "./model.js";

export const OPENCODE_CATALOG_SEED_FILE = "opencode-models.seed.json";
export const OPENCODE_LIVE_MODELS_URL = "https://opencode.ai/inference/v1/models";
export const OPENCODE_LIVE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const TTL_JITTER = 0.15;

/** Map a models.dev / Console `api` key to our wire enum. */
const API_KEY_TO_WIRE: Record<string, OpenCodeWire> = {
  "chat-completions": "chat-completions",
  "responses": "responses",
  "messages": "messages",
  "generate-content": "google",
  "interactions": "google",
  "systemone": "systemone",
  "images": "images",
  "live": "live",
  "embeddings": "embeddings",
};

const enc = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

/** Extract protocol list from the `api` map; native protocol first when declared. */
function parseProtocols(api: unknown): OpenCodeWire[] {
  const record = enc(api);
  if (!record) return [];
  const out: OpenCodeWire[] = [];
  for (const key of Object.keys(record)) {
    const wire = API_KEY_TO_WIRE[key];
    if (wire && !out.includes(wire)) out.push(wire);
  }
  return out;
}

/** Order so the native chat protocol is first, matching the catalog's own preference. */
function orderProtocols(protocols: OpenCodeWire[]): OpenCodeWire[] {
  const priority: OpenCodeWire[] = ["chat-completions", "responses", "messages", "google", "systemone", "images", "embeddings", "live"];
  return [...protocols].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
}

/** Normalize one live catalog payload into entries for a single logical upstream. */
export function normalizeCatalogPayload(
  payload: unknown,
  upstream: OpenCodeUpstreamId,
  source: "catalog" | "seed" = "catalog",
): OpenCodeModelEntry[] {
  const root = enc(payload);
  const data = Array.isArray(root?.data) ? root.data : Array.isArray(payload) ? payload : [];
  const entries: OpenCodeModelEntry[] = [];
  for (const raw of data) {
    const item = enc(raw);
    const id = str(item?.id);
    if (!item || !id) continue;

    const protocols = orderProtocols(parseProtocols(item.api));
    const limits = enc(item.limit);
    const modalities = enc(item.modalities);
    const capabilities = enc(item.capabilities);
    const reasoning = enc(capabilities?.reasoning);
    const cost = enc(item.cost);
    const textCost = enc(cost?.text);
    const inputCost = enc(textCost?.input);
    const cacheCost = enc(inputCost?.cache);
    const outputCost = enc(textCost?.output);
    const go = enc(item.go);

    const inputPrice = num(inputCost?.price);
    const outputPrice = num(outputCost?.price);
    const monthlyUsage = stringArray(go?.monthly_usage) === undefined && Array.isArray(go?.monthly_usage)
      ? (go?.monthly_usage as unknown[]).map((value) => num(value)).filter((value): value is number => value !== undefined)
      : undefined;

    const entry: OpenCodeModelEntry = {
      id,
      upstream,
      protocols: protocols.length > 0 ? protocols : ["chat-completions"],
      inputModalities: stringArray(modalities?.input) ?? ["text"],
      outputModalities: stringArray(modalities?.output) ?? ["text"],
      toolCalling: bool(enc(capabilities?.tools)?.supported) ?? true,
      free: inputPrice === 0 && (outputPrice === undefined || outputPrice === 0),
      selectable: true,
      source,
    };

    const context = num(limits?.context);
    if (context !== undefined) entry.contextWindow = context;
    const maxInput = num(limits?.input);
    if (maxInput !== undefined) entry.maxInputTokens = maxInput;
    const maxOutput = num(limits?.output);
    if (maxOutput !== undefined) entry.maxOutputTokens = maxOutput;

    const efforts = stringArray(reasoning?.effort);
    if (efforts && efforts.length > 0) entry.reasoningEfforts = efforts;
    const structured = bool(capabilities?.structured_output);
    if (structured !== undefined) entry.structuredOutput = structured;

    if (inputPrice !== undefined || outputPrice !== undefined) {
      entry.cost = {
        ...(inputPrice !== undefined ? { input: inputPrice } : {}),
        ...(num(cacheCost?.read) !== undefined ? { cachedInput: num(cacheCost?.read) } : {}),
        ...(num(cacheCost?.write) !== undefined ? { cacheWrite: num(cacheCost?.write) } : {}),
        ...(outputPrice !== undefined ? { output: outputPrice } : {}),
      };
    }

    if (monthlyUsage && monthlyUsage.length > 0) {
      entry.go = {
        monthlyUsage,
        ...(bool(go?.zdr) !== undefined ? { zeroDataRetention: bool(go?.zdr) } : {}),
        ...(bool(go?.training) !== undefined ? { training: bool(go?.training) } : {}),
        ...(bool(go?.limited_regions) !== undefined ? { limitedRegions: bool(go?.limited_regions) } : {}),
      };
    }
    if (!isChatSelectable(entry)) entry.selectable = false;
    if (item.type === "embedding" || item.type === "image" || item.type === "realtime") entry.selectable = false;

    entries.push(entry);
  }
  return entries;
}

interface SeedFile {
  version?: number;
  models?: Array<Record<string, unknown>>;
}

/** Normalize one seed row into an entry. Seed rows are already close to our shape. */
export function normalizeSeedRow(raw: Record<string, unknown>): OpenCodeModelEntry | undefined {
  const id = str(raw.id);
  const upstream = str(raw.upstream);
  if (!id || (upstream !== "go" && upstream !== "zen")) return undefined;
  const protocol = str(raw.protocol) as OpenCodeWire | undefined;
  const wire: OpenCodeWire = protocol && protocol in API_KEY_TO_WIRE
    ? protocol
    : "chat-completions";
  const efforts = stringArray(raw.reasoningEfforts);
  const entry: OpenCodeModelEntry = {
    id,
    upstream,
    protocols: [wire],
    inputModalities: stringArray(raw.inputModalities) ?? ["text"],
    outputModalities: stringArray(raw.outputModalities) ?? ["text"],
    toolCalling: true,
    free: bool(raw.free) ?? false,
    selectable: bool(raw.selectable) ?? true,
    source: "seed",
  };
  const context = num(raw.contextWindow);
  if (context !== undefined) entry.contextWindow = context;
  if (efforts && efforts.length > 0) entry.reasoningEfforts = efforts;
  const monthly = Array.isArray(raw.goMonthlyUsage)
    ? (raw.goMonthlyUsage as unknown[]).map((value) => num(value)).filter((value): value is number => value !== undefined)
    : [];
  const zdr = bool(raw.zeroDataRetention);
  if (monthly.length > 0 || zdr !== undefined) {
    entry.go = {
      ...(monthly.length > 0 ? { monthlyUsage: monthly } : {}),
      ...(zdr !== undefined ? { zeroDataRetention: zdr } : {}),
    };
  }
  return entry;
}

/** Parse the bundled seed file into entries. Malformed rows are skipped, never invented. */
export function parseSeed(contents: string): OpenCodeModelEntry[] {
  let parsed: SeedFile;
  try {
    parsed = JSON.parse(contents) as SeedFile;
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed.models) ? parsed.models : [];
  const entries: OpenCodeModelEntry[] = [];
  for (const row of rows) {
    const entry = normalizeSeedRow(row);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Merge live entries over seed entries: live wins per (upstream, id). */
export function mergeCatalog(
  seed: readonly OpenCodeModelEntry[],
  live: readonly OpenCodeModelEntry[],
): OpenCodeModelEntry[] {
  const merged = new Map<string, OpenCodeModelEntry>();
  for (const entry of seed) merged.set(`${entry.upstream}:${entry.id}`, entry);
  for (const entry of live) merged.set(`${entry.upstream}:${entry.id}`, entry);
  return [...merged.values()];
}

export interface OpenCodeCatalogStatus {
  /** Entries per logical upstream (zen-free mirrors free zen models). */
  counts: Record<OpenCodeUpstreamId, number>;
  fetchedAt: string | null;
  stale: boolean;
  /** "live" once a refresh succeeded, "seed" while only the bundled snapshot is loaded. */
  source: "live" | "seed";
  lastError?: string;
}

export interface OpenCodeCatalogOptions {
  seedPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Deterministic jitter source for tests. */
  jitter?: () => number;
}

type ResolvedCatalogOptions = OpenCodeCatalogOptions & {
  now: () => number;
  ttlMs: number;
  jitter: () => number;
};

export class OpenCodeCatalog {
  readonly #options: ResolvedCatalogOptions;
  #entries: OpenCodeModelEntry[] = [];
  #fetchedAt: number | null = null;
  #source: "live" | "seed" = "seed";
  #lastError: string | undefined;
  #refreshing: Promise<boolean> | null = null;

  constructor(options: OpenCodeCatalogOptions = {}) {
    this.#options = {
      ...options,
      now: options.now ?? (() => Date.now()),
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      jitter: options.jitter ?? Math.random,
    };
  }

  /** Load the bundled seed. Safe to call repeatedly; live data is never discarded. */
  loadSeed(path?: string): number {
    const file = path ?? this.#options.seedPath ?? resolve(getConfigDir(), OPENCODE_CATALOG_SEED_FILE);
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch (error) {
      this.#lastError = `seed-unreadable: ${(error as Error).message}`;
      return 0;
    }
    const seedEntries = parseSeed(contents);
    if (seedEntries.length === 0) return 0;
    const live = this.#entries.filter((entry) => entry.source === "catalog");
    this.#entries = mergeCatalog(seedEntries, live);
    return seedEntries.length;
  }

  /**
   * Fetch both upstream catalogs. Never throws: on failure the previous snapshot is
   * kept and flagged stale so inference keeps working.
   */
  async refresh(): Promise<boolean> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#refreshInternal().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #refreshInternal(): Promise<boolean> {
    const doFetch = this.#options.fetchImpl ?? fetch;
    try {
      const [zen, go] = await Promise.all([
        fetchCatalog(doFetch, OPENCODE_LIVE_MODELS_URL, "zen"),
        fetchCatalog(doFetch, OPENCODE_LIVE_GO_MODELS_URL, "go"),
      ]);
      const live = [...zen, ...go];
      if (live.length === 0) {
        this.#lastError = "empty-catalog";
        return false;
      }
      const seed = this.#entries.filter((entry) => entry.source === "seed");
      this.#entries = mergeCatalog(seed, live);
      this.#fetchedAt = this.#options.now();
      this.#source = "live";
      this.#lastError = undefined;
      return true;
    } catch (error) {
      this.#lastError = (error as Error).message;
      return false;
    }
  }

  /** True when a refresh is due (ttl plus deterministic jitter). */
  shouldRefresh(): boolean {
    if (this.#fetchedAt === null) return true;
    const ttl = this.#options.ttlMs * (1 + TTL_JITTER * (this.#options.jitter() * 2 - 1));
    return this.#options.now() - this.#fetchedAt >= ttl;
  }

  /** All entries (both logical upstreams). */
  list(): OpenCodeModelEntry[] {
    return [...this.#entries];
  }

  /** Entries for one logical upstream; `zen-free` mirrors the free zen subset. */
  listForUpstream(upstream: OpenCodeUpstreamId): OpenCodeModelEntry[] {
    if (upstream === "zen-free") {
      return this.#entries
        .filter((entry) => entry.upstream === "zen" && entry.free)
        .map((entry) => ({ ...entry, upstream: "zen-free" as const }));
    }
    return this.#entries.filter((entry) => entry.upstream === upstream);
  }

  /** Selectable chat models for one upstream (what /models advertises). */
  listSelectable(upstream?: OpenCodeUpstreamId): OpenCodeModelEntry[] {
    const entries = upstream ? this.listForUpstream(upstream) : this.#entries;
    return entries.filter(isChatSelectable);
  }

  /** Look up one entry by the (upstream, id) pair. */
  find(upstream: OpenCodeUpstreamId, id: string): OpenCodeModelEntry | undefined {
    const target = upstream === "zen-free" ? "zen" : upstream;
    const entry = this.#entries.find((candidate) => candidate.upstream === target && candidate.id === id);
    if (!entry) return undefined;
    return upstream === "zen-free" ? { ...entry, upstream: "zen-free" } : entry;
  }

  /** Find an entry on any upstream, preferring paid zen/go over the free tier. */
  findAny(id: string): OpenCodeModelEntry | undefined {
    return this.#entries.find((entry) => entry.upstream === "go" && entry.id === id)
      ?? this.#entries.find((entry) => entry.upstream === "zen" && entry.id === id);
  }

  status(): OpenCodeCatalogStatus {
    const counts: Record<OpenCodeUpstreamId, number> = {
      go: this.listForUpstream("go").length,
      zen: this.listForUpstream("zen").length,
      "zen-free": this.listForUpstream("zen-free").length,
    };
    const stale = this.#source === "seed" || this.shouldRefresh();
    return {
      counts,
      fetchedAt: this.#fetchedAt === null ? null : new Date(this.#fetchedAt).toISOString(),
      stale,
      source: this.#source,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }
}

async function fetchCatalog(
  doFetch: typeof fetch,
  url: string,
  upstream: OpenCodeUpstreamId,
): Promise<OpenCodeModelEntry[]> {
  const response = await doFetch(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`catalog ${upstream} HTTP ${response.status}`);
  const payload: unknown = await response.json();
  return normalizeCatalogPayload(payload, upstream, "catalog");
}
