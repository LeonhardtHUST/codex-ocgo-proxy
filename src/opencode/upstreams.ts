/**
 * Logical upstream definitions for the OpenCode provider family.
 *
 * All three share the host `opencode.ai`; only the path prefix differs:
 *   go        https://opencode.ai/inference/go
 *   zen       https://opencode.ai/inference
 *   zen-free  same root as zen, used for zero-price models only
 *
 * Protocol → path mapping is fixed by the gateway, so it lives here instead of
 * being derived from the model id.
 */

import type { OpenCodeConfig } from "./config.js";
import type { OpenCodeUpstreamId, OpenCodeWire } from "./model.js";

export const OPENCODE_GO_ROOT = "https://opencode.ai/inference/go";
export const OPENCODE_ZEN_ROOT = "https://opencode.ai/inference";

/** Root base URL for a logical upstream, honouring configuration overrides. */
export function resolveUpstreamRoot(config: OpenCodeConfig, upstream: OpenCodeUpstreamId): string {
  if (upstream === "go") return trimSlash(config.upstreams.go.base_url || OPENCODE_GO_ROOT);
  if (upstream === "zen-free") return trimSlash(config.upstreams.zen.base_url || OPENCODE_ZEN_ROOT);
  return trimSlash(config.upstreams.zen.base_url || OPENCODE_ZEN_ROOT);
}

/** Configured static key for a logical upstream, when the pool has none. */
export function resolveUpstreamApiKey(config: OpenCodeConfig, upstream: OpenCodeUpstreamId): string | undefined {
  if (upstream === "go") return config.upstreams.go.api_key;
  return config.upstreams.zen.api_key;
}

/**
 * Whether a logical upstream is enabled in configuration.
 *
 * Only the per-upstream switch counts: the family-wide `opencode.enabled` is deprecated
 * (always true), and keeping a check here would silently resurrect it.
 */
export function isUpstreamEnabled(config: OpenCodeConfig, upstream: OpenCodeUpstreamId): boolean {
  if (upstream === "go") return config.upstreams.go.enabled;
  if (upstream === "zen-free") return config.upstreams.zen_free.enabled;
  return config.upstreams.zen.enabled;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Base URL the existing adapters expect: each adapter appends its own path
 * (`/chat/completions`, `/messages`, `/responses`, `:generateContent`).
 */
export function wireBaseUrl(root: string, wire: OpenCodeWire): string | undefined {
  switch (wire) {
    case "chat-completions":
    case "responses":
      return `${root}/openai/v1`;
    case "messages":
      return `${root}/anthropic/v1`;
    case "google":
      return `${root}/google/v1beta`;
    default:
      return undefined;
  }
}

/** Full request URL for a wire protocol and model (Google embeds the model in the path). */
export function buildRequestUrl(root: string, wire: OpenCodeWire, modelId: string): string | undefined {
  const base = wireBaseUrl(root, wire);
  if (!base) return undefined;
  switch (wire) {
    case "chat-completions": return `${base}/chat/completions`;
    case "responses": return `${base}/responses`;
    case "messages": return `${base}/messages`;
    case "google": return `${base}/models/${encodeURIComponent(modelId)}:generateContent`;
    default: return undefined;
  }
}

/** Wire protocols this router can actually forward today. */
export const FORWARDABLE_WIRES: readonly OpenCodeWire[] = ["responses", "chat-completions", "messages", "google"];

export function isForwardableWire(wire: OpenCodeWire): boolean {
  return FORWARDABLE_WIRES.includes(wire);
}

/**
 * Pick the forwardable protocol closest to the entry's native one.
 * Returns undefined when the entry only speaks non-chat protocols (systemone,
 * images, embeddings, live) which this router does not proxy.
 */
export function firstForwardableWire(protocols: readonly OpenCodeWire[]): OpenCodeWire | undefined {
  return protocols.find(isForwardableWire);
}

/** Logical upstreams in routing order for a model id, paid before free. */
export function upstreamCandidates(preferTier: OpenCodeUpstreamId | undefined, entryUpstreams: readonly OpenCodeUpstreamId[]): OpenCodeUpstreamId[] {
  if (preferTier) return [preferTier];
  const order: OpenCodeUpstreamId[] = ["go", "zen", "zen-free"];
  return order.filter((upstream) => entryUpstreams.includes(upstream));
}
