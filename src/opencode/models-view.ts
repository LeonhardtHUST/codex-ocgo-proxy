/**
 * `/v1/models` view of the OpenCode catalog.
 *
 * Contract (docs/OPENCODEX_ROUTER_DESIGN.md §4.2): every opencode model must expose
 * context window, output limit, modalities, capabilities, reasoning tiers, native
 * protocol, free flag and pricing — plus the field aliases clients actually read
 * (`context_length`, `max_context_length`, `max_input_tokens`, `max_tokens`,
 * `limit{...}`, `reasoning`).
 *
 * Id policy: an id that exists on several upstreams is advertised only in its
 * tier-qualified form (`opencode-go:minimax-m3`), because the entries differ in
 * protocol and context window. Ids unique to one upstream also get the bare
 * `opencode:<id>` alias so clients can keep using the namespace without a tier.
 */

import type { OpenCodeModelEntry, OpenCodeUpstreamId } from "./model.js";
import { isChatSelectable, isFreeModel } from "./model.js";

export const OPENCODE_NAMESPACE_PREFIX = "opencode:";

/** Provider id for the logical upstream an entry belongs to. */
export function providerIdForUpstream(upstream: OpenCodeUpstreamId): string {
  return upstream === "go" ? "opencode-go" : upstream === "zen" ? "opencode-zen" : "opencode-zen-free";
}

/** Preferred reasoning effort when the catalog does not name one. */
function preferredEffort(efforts: string[] | undefined): string | undefined {
  if (!efforts || efforts.length === 0) return undefined;
  for (const candidate of ["medium", "high", "low", "minimal", "xhigh", "max", "none"]) {
    if (efforts.includes(candidate)) return candidate;
  }
  return efforts[0];
}

export interface ModelView {
  [key: string]: unknown;
}

/** Build the OpenAI-envelope row for one catalog entry, including alias fields. */
export function toModelView(entry: OpenCodeModelEntry, aliases: string[] = []): ModelView {
  const providerId = providerIdForUpstream(entry.upstream);
  const id = `${providerId}:${entry.id}`;
  const view: ModelView = {
    id,
    object: "model",
    created: 1700000000,
    owned_by: providerId,
    display_name: entry.id,
    free: isFreeModel(entry),
    native_protocol: entry.protocols[0],
    supported_protocols: [...entry.protocols],
    input_modalities: [...entry.inputModalities],
    output_modalities: [...entry.outputModalities],
    capabilities: {
      tools: entry.toolCalling,
      reasoning: Boolean(entry.reasoningEfforts && entry.reasoningEfforts.length > 0),
      ...(entry.structuredOutput !== undefined ? { structured_output: entry.structuredOutput } : {}),
    },
  };

  if (entry.contextWindow !== undefined) {
    view.context_window = entry.contextWindow;
    // Alias matrix: different clients read different names for the same number.
    view.context_length = entry.contextWindow;
    view.max_context_length = entry.contextWindow;
  }
  if (entry.maxInputTokens !== undefined) view.max_input_tokens = entry.maxInputTokens;
  if (entry.maxOutputTokens !== undefined) {
    view.max_output_tokens = entry.maxOutputTokens;
    view.max_tokens = entry.maxOutputTokens;
  }
  view.limit = {
    ...(entry.contextWindow !== undefined ? { context: entry.contextWindow } : {}),
    ...(entry.maxInputTokens !== undefined ? { input: entry.maxInputTokens } : {}),
    ...(entry.maxOutputTokens !== undefined ? { output: entry.maxOutputTokens } : {}),
  };

  if (entry.reasoningEfforts && entry.reasoningEfforts.length > 0) {
    view.supported_reasoning_efforts = entry.reasoningEfforts.map((effort) => ({
      reasoning_effort: effort,
      description: effort,
    }));
    const preferred = preferredEffort(entry.reasoningEfforts);
    if (preferred) view.default_reasoning_effort = preferred;
    view.reasoning = {
      supported: true,
      effort: [...entry.reasoningEfforts],
    };
  } else {
    view.reasoning = { supported: false };
  }

  if (entry.cost) {
    view.pricing = {
      ...(entry.cost.input !== undefined ? { input: entry.cost.input } : {}),
      ...(entry.cost.cachedInput !== undefined ? { cached_input: entry.cost.cachedInput } : {}),
      ...(entry.cost.cacheWrite !== undefined ? { cached_write: entry.cost.cacheWrite } : {}),
      ...(entry.cost.output !== undefined ? { output: entry.cost.output } : {}),
    };
  }
  if (entry.go) {
    view.go = {
      ...(entry.go.monthlyUsage ? { monthly_usage: [...entry.go.monthlyUsage] } : {}),
      ...(entry.go.zeroDataRetention !== undefined ? { zdr: entry.go.zeroDataRetention } : {}),
      ...(entry.go.training !== undefined ? { training: entry.go.training } : {}),
      ...(entry.go.limitedRegions !== undefined ? { limited_regions: entry.go.limitedRegions } : {}),
    };
  }
  if (aliases.length > 0) view.aliases = aliases;
  return view;
}

/**
 * Rows to advertise on `/v1/models`: selectable chat models only, with the bare
 * alias added for ids that live on exactly one upstream.
 */
export function buildModelViews(entries: readonly OpenCodeModelEntry[]): ModelView[] {
  const selectable = entries.filter(isChatSelectable);
  const counts = new Map<string, number>();
  for (const entry of selectable) {
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  const rows: ModelView[] = [];
  for (const entry of selectable) {
    const unique = counts.get(entry.id) === 1;
    const bareAlias = `${OPENCODE_NAMESPACE_PREFIX}${entry.id}`;
    rows.push(toModelView(entry, unique ? [bareAlias] : []));
    if (unique) {
      rows.push({
        ...toModelView(entry),
        id: bareAlias,
        aliases: [`${providerIdForUpstream(entry.upstream)}:${entry.id}`],
      });
    }
  }
  return rows;
}

/** Full matrix row for `GET /v1/opencode/catalog` (superset of the /models row). */
export function toCatalogRow(entry: OpenCodeModelEntry): ModelView {
  const view = toModelView(entry);
  return {
    ...view,
    upstream: entry.upstream,
    model: entry.id,
    selectable: isChatSelectable(entry),
    source: entry.source,
    ...(entry.go?.monthlyUsage ? { monthly_usage: [...entry.go.monthlyUsage] } : {}),
  };
}

/** Lookup key used to match a client-supplied namespaced id back to an entry. */
export function catalogLookupKey(upstream: OpenCodeUpstreamId, modelId: string): string {
  return `${upstream}:${modelId}`;
}
