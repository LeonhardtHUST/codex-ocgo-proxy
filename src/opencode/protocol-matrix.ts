/**
 * Protocol matrix — decides which wire protocol a request uses for a given
 * (logical upstream, model) pair, and remembers upstream corrections.
 *
 * Why the key is a pair and not a model id: the OpenCode gateway exposes the same
 * model id on different wires depending on the upstream. `minimax-m3` is
 * chat-completions on zen and messages on go; `qwen3.8-max` is the same. Caching a
 * correction under the bare id would send go traffic to a zen-only protocol.
 *
 * See docs/OPENCODEX_ROUTER_DESIGN.md §3.
 */

import type { OpenCodeModelEntry, OpenCodeUpstreamId, OpenCodeWire } from "./model.js";

/** Sibling preference when the native protocol is rejected: Responses first. */
const PROTOCOL_PREFERENCE: readonly OpenCodeWire[] = [
  "responses",
  "messages",
  "chat-completions",
  "google",
  "systemone",
  "images",
  "embeddings",
  "live",
];

export interface ProtocolCorrection {
  wire: OpenCodeWire;
  expiresAt: number;
}

export interface ProtocolMatrixOptions {
  now?: () => number;
  ttlMs?: number;
}

/** Cache key rule: (upstream, modelId). Never model id alone. */
export function protocolCacheKey(upstream: OpenCodeUpstreamId, modelId: string): string {
  return `${upstream}\u0000${modelId}`;
}

export class ProtocolMatrix {
  readonly #corrections = new Map<string, ProtocolCorrection>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: ProtocolMatrixOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  }

  /** Effective protocol: a live correction wins, then the caller's request, then native. */
  resolve(entry: OpenCodeModelEntry, requested?: OpenCodeWire): OpenCodeWire {
    const correction = this.correctionFor(entry.upstream, entry.id);
    if (correction) return correction.wire;
    if (requested && entry.protocols.includes(requested)) return requested;
    return entry.protocols[0] ?? "chat-completions";
  }

  /** Remember that this (upstream, model) rejected `wire` and answered on another. */
  recordCorrection(upstream: OpenCodeUpstreamId, modelId: string, wire: OpenCodeWire): void {
    this.#corrections.set(protocolCacheKey(upstream, modelId), { wire, expiresAt: this.#now() + this.#ttlMs });
  }

  correctionFor(upstream: OpenCodeUpstreamId, modelId: string): ProtocolCorrection | undefined {
    const key = protocolCacheKey(upstream, modelId);
    const entry = this.#corrections.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#corrections.delete(key);
      return undefined;
    }
    return entry;
  }

  clear(upstream?: OpenCodeUpstreamId, modelId?: string): void {
    if (upstream && modelId) {
      this.#corrections.delete(protocolCacheKey(upstream, modelId));
      return;
    }
    if (upstream) {
      for (const key of this.#corrections.keys()) {
        if (key.startsWith(`${upstream}\u0000`)) this.#corrections.delete(key);
      }
      return;
    }
    this.#corrections.clear();
  }

  /** Number of live corrections (admin/status surface). */
  size(): number {
    return this.#corrections.size;
  }
}

/**
 * The second protocol to try after `attempted` failed with an upstream
 * "not supported for format" style rejection. Returns undefined when the entry has
 * no other chat-capable protocol, in which case the caller must surface the error.
 */
export function nextProtocol(entry: OpenCodeModelEntry, attempted: OpenCodeWire): OpenCodeWire | undefined {
  const candidates = PROTOCOL_PREFERENCE.filter((wire) => wire !== attempted && entry.protocols.includes(wire));
  return candidates[0];
}

/**
 * Recognize the upstream's "wrong protocol for this model" rejection.
 * Kept narrow on purpose: a broad match would retry on unrelated 400s.
 */
export function isUnsupportedProtocolError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 415) return false;
  const text = body.toLowerCase();
  if (text.includes("not supported for format")) return true;
  if (text.includes("unsupported_protocol") || text.includes("invalid_protocol")) return true;
  if (text.includes("is not supported for") && (text.includes("format") || text.includes("protocol") || text.includes("endpoint"))) return true;
  return false;
}
