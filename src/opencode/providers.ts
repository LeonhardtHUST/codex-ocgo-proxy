/**
 * Provider descriptor registry — the single representation of "a provider".
 *
 * Before this module the code had three unrelated representations (adapter map tag,
 * `ApiKeyEntry.provider`, and the OCGo boolean flag). Everything router-facing now
 * reads descriptors from here, so a new provider is added in exactly one place.
 *
 * See docs/OPENCODEX_ROUTER_DESIGN.md §2.
 */

import type { OpenCodeTier } from "./namespace.js";
import { tierToProviderId } from "./namespace.js";

/** `codex-oauth`: ChatGPT 账号池；`opencode`: opencode 三逻辑上游；`apikey`: 第三方 key。 */
export type ProviderKind = "codex-oauth" | "opencode" | "apikey";

/** Wire protocols a provider can speak upstream. */
export type ProviderWire = "responses" | "chat" | "messages" | "google";

export interface ProviderCapabilities {
  tools: boolean;
  images: boolean;
  reasoning: boolean;
  streaming: boolean;
  /** Whether the upstream accepts a prompt-cache key / session header. */
  promptCacheKey: boolean;
}

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  /** Lower runs first when several providers can serve the same model. */
  priority: number;
  endpoints: Partial<Record<ProviderWire, string>>;
  capabilities: ProviderCapabilities;
  modelSource: "catalog" | "pool" | "static";
  /** Human label for the dashboard. */
  label?: string;
}

export const CODEX_PROVIDER_ID = "codex-official";
export const CODEX_FALLBACK_PROVIDER_ID = "codex-fallback";

const NO_UPSTREAM_ENDPOINTS: Partial<Record<ProviderWire, string>> = {};

export const CODEX_OFFICIAL_PROVIDER: ProviderDescriptor = {
  id: CODEX_PROVIDER_ID,
  kind: "codex-oauth",
  enabled: true,
  priority: 10,
  endpoints: NO_UPSTREAM_ENDPOINTS,
  capabilities: { tools: true, images: true, reasoning: true, streaming: true, promptCacheKey: true },
  modelSource: "catalog",
  label: "Codex (ChatGPT account pool)",
};

/**
 * The former hidden "last resort" upstream. Promoted to a first-class provider:
 * it can be selected explicitly (`codex-fallback:<model>`), carries its own
 * priority, and may appear in the fallback graph.
 */
export const CODEX_FALLBACK_PROVIDER: ProviderDescriptor = {
  id: CODEX_FALLBACK_PROVIDER_ID,
  kind: "apikey",
  enabled: true,
  priority: 30,
  endpoints: NO_UPSTREAM_ENDPOINTS,
  capabilities: { tools: true, images: false, reasoning: true, streaming: true, promptCacheKey: true },
  modelSource: "static",
  label: "Codex fallback upstream",
};

const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  images: false,
  reasoning: true,
  streaming: true,
  promptCacheKey: true,
};

const OPENCODE_ENDPOINTS: Partial<Record<ProviderWire, string>> = {
  responses: "/openai/v1/responses",
  chat: "/openai/v1/chat/completions",
  messages: "/anthropic/v1/messages",
  google: "/google/v1beta/models",
};

const OPENCODE_LABELS: Record<OpenCodeTier, string> = {
  go: "OpenCode Go (subscription)",
  zen: "OpenCode Zen (pay as you go)",
  "zen-free": "OpenCode Zen free tier",
};

const OPENCODE_PRIORITIES: Record<OpenCodeTier, number> = { go: 20, zen: 20, "zen-free": 40 };

/** Build the descriptor for one logical opencode upstream. */
export function createOpenCodeProvider(
  tier: OpenCodeTier,
  options: { enabled?: boolean; baseUrl?: string; priority?: number } = {},
): ProviderDescriptor {
  const id = tierToProviderId(tier);
  const endpoints: Partial<Record<ProviderWire, string>> = { ...OPENCODE_ENDPOINTS };
  return {
    id,
    kind: "opencode",
    enabled: options.enabled ?? tier !== "zen-free",
    priority: options.priority ?? OPENCODE_PRIORITIES[tier],
    endpoints,
    capabilities: OPENCODE_CAPABILITIES,
    modelSource: "catalog",
    label: OPENCODE_LABELS[tier],
  };
}

/** Registry ordered by id; every lookup is by id, ordering only matters for listing. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();

  constructor(initial: readonly ProviderDescriptor[] = []) {
    for (const provider of initial) this.register(provider);
  }

  register(provider: ProviderDescriptor): ProviderDescriptor {
    const existing = this.providers.get(provider.id);
    const merged: ProviderDescriptor = existing
      ? { ...existing, ...provider, endpoints: { ...existing.endpoints, ...provider.endpoints } }
      : { ...provider };
    this.providers.set(merged.id, merged);
    return merged;
  }

  get(id: string): ProviderDescriptor | undefined {
    return this.providers.get(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): ProviderDescriptor[] {
    return [...this.providers.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** Enabled providers only, in routing order. */
  routable(): ProviderDescriptor[] {
    return this.list().filter((provider) => provider.enabled);
  }

  setPriority(id: string, priority: number): void {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider "${id}"`);
    provider.priority = priority;
  }

  setEnabled(id: string, enabled: boolean): void {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider "${id}"`);
    provider.enabled = enabled;
  }

  /** First enabled provider that can serve a model id, honouring priority. */
  resolveByModel(modelId: string): ProviderDescriptor | undefined {
    return this.routable().find((provider) => provider.kind !== "codex-oauth" || modelId.length > 0);
  }

  /** Enabled providers of one kind, in routing order. */
  byKind(kind: ProviderKind): ProviderDescriptor[] {
    return this.routable().filter((provider) => provider.kind === kind);
  }
}

/** Registry preloaded with the five built-in providers. */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    CODEX_OFFICIAL_PROVIDER,
    CODEX_FALLBACK_PROVIDER,
    createOpenCodeProvider("go"),
    createOpenCodeProvider("zen"),
    createOpenCodeProvider("zen-free"),
  ]);
}
