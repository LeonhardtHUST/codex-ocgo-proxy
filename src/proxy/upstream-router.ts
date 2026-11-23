/**
 * UpstreamRouter — routes a model name to the appropriate UpstreamAdapter.
 *
 * Priority (highest to lowest):
 *   - When enabled, the reserved OpenCode namespace is resolved without selecting credentials.
 *   0. ApiKeyPool entry matching the exact model name
 *   1. Explicit provider prefix: "openai:gpt-4o", "anthropic:claude-3-5-sonnet"
 *   2. Model aliases: { "claude-opus-4-7": "gpt-5.5" }
 *   3. model_routing config table: { "deepseek-chat": "deepseek" }
 *   4. Known Codex model IDs
 *   5. Custom provider `models` list
 *   6. Built-in name pattern rules: "claude-*" → anthropic, "gemini-*" → gemini
 *   7. Default (codex)
 */

import type { UpstreamAdapter } from "./upstream-adapter.js";
import type { ApiKeyPool, ApiKeyEntry } from "../auth/api-key-pool.js";
import { getModelAliases, getModelCatalog, getModelInfo, stripKnownModelSuffixes } from "../models/model-store.js";
import { hasOpenCodeModelPrefix, isOpenCodeModelId, OPENCODE_MODEL_PREFIX } from "../opencode-legacy-config.js";
import { parseOpenCodeModelRef, tierToProviderId } from "../opencode/namespace.js";
import {
  CODEX_FALLBACK_PROVIDER_ID,
  createDefaultProviderRegistry,
  type ProviderDescriptor,
  type ProviderRegistry,
} from "../opencode/providers.js";

/** Factory that creates an UpstreamAdapter for a given ApiKeyEntry. */
export type AdapterFactory = (entry: ApiKeyEntry) => UpstreamAdapter;

export type UpstreamRouteMatch =
  | { kind: "api-key"; adapter: UpstreamAdapter; entry: ApiKeyEntry; resolvedModel?: string }
  | { kind: "adapter"; adapter: UpstreamAdapter; resolvedModel?: string }
  | { kind: "codex"; adapter?: UpstreamAdapter; resolvedModel?: string }
  | { kind: "opencode"; adapter?: never; resolvedModel: string; modelId?: string; tier?: string }
  /**
   * First-class provider route. `providerId` names a descriptor from the registry
   * (`opencode-go` / `opencode-zen` / `opencode-zen-free` / `codex-fallback`).
   * Route handlers translate this into the provider's credential + adapter.
   */
  | { kind: "provider"; adapter?: never; providerId: string; descriptor?: ProviderDescriptor; resolvedModel: string; modelId?: string }
  | { kind: "not-found" };

export class UpstreamRouter {
  private apiKeyPool: ApiKeyPool | null = null;
  private adapterFactory: AdapterFactory | null = null;
  private openCodeNamespaceEnabled = false;
  /** Provider descriptors — single source of truth for what a provider is. */
  private readonly providers: ProviderRegistry = createDefaultProviderRegistry();
  /** Accept the legacy `ocgo:` prefix as an alias of `opencode:`. */
  private legacyOpenCodePrefix = true;
  /** Cache: apiKeyEntry.id → adapter instance. Invalidated when key or proxyId changes. */
  private dynamicAdapters = new Map<string, { apiKey: string; proxyId?: string | null; adapter: UpstreamAdapter }>();

  /** Provider descriptors in routing order (dashboard / admin surfaces). */
  listProviders(): ProviderDescriptor[] {
    return this.providers.list();
  }

  getProvider(id: string): ProviderDescriptor | undefined {
    return this.providers.get(id);
  }

  /** Lower priority runs first when several providers can serve one model. */
  setProviderPriority(id: string, priority: number): void {
    this.providers.setPriority(id, priority);
  }

  /** Toggle the legacy `ocgo:` alias (config: `opencode.legacy_prefix`). */
  setLegacyOpenCodePrefix(enabled: boolean): void {
    this.legacyOpenCodePrefix = enabled;
  }

  private splitExplicitProvider(model: string): { tag: string; bareModel: string } | null {
    const colonIdx = model.indexOf(":");
    if (colonIdx <= 0) return null;
    const tag = model.slice(0, colonIdx);
    if (!this.adapters.has(tag) && tag !== "antigravity") return null;
    return { tag, bareModel: model.slice(colonIdx + 1) };
  }

  private resolvePoolModelCandidates(model: string): string[] {
    const explicitProvider = this.splitExplicitProvider(model);
    return explicitProvider ? [model, explicitProvider.bareModel] : [model];
  }

  constructor(
    private readonly adapters: Map<string, UpstreamAdapter>,
    private readonly modelRouting: Record<string, string>,
    private readonly defaultTag: string,
  ) {}

  /** Attach the runtime API key pool for dynamic model resolution. */
  setApiKeyPool(pool: ApiKeyPool, factory: AdapterFactory): void {
    if (this.openCodeNamespaceEnabled) throw new Error("Attach the API key pool before enabling OpenCode");
    this.apiKeyPool = pool;
    this.adapterFactory = factory;
  }

  /** Opt in at startup. An existing name must be migrated explicitly, not hijacked. */
  enableOpenCodeNamespace(): void {
    if (this.adapters.has("opencode-sidecar") ||
        Object.entries(this.modelRouting).some(([model, provider]) => hasOpenCodeModelPrefix(model) || provider === "opencode-sidecar") ||
        Object.entries(getModelAliases()).some(([alias, target]) => hasOpenCodeModelPrefix(alias) || hasOpenCodeModelPrefix(target)) ||
        getModelCatalog().some(({ id }) => hasOpenCodeModelPrefix(id)) ||
        this.apiKeyPool?.getAll().some(({ model }) => hasOpenCodeModelPrefix(model))) {
      throw new Error("Cannot enable OpenCode: migrate existing ocgo: model names, alias bindings or the ocgo Custom provider first");
    }
    this.apiKeyPool?.reserveOpenCodeNamespace();
    this.openCodeNamespaceEnabled = true;
  }

  isOpenCodeModel(model: string): boolean {
    return this.openCodeNamespaceEnabled && hasOpenCodeModelPrefix(model);
  }

  resolveMatch(model: string): UpstreamRouteMatch {
    const normalized = model.trim();

    // `codex-fallback:<model>` selects the promoted fallback upstream explicitly.
    if (normalized.startsWith(`${CODEX_FALLBACK_PROVIDER_ID}:`)) {
      const bare = normalized.slice(CODEX_FALLBACK_PROVIDER_ID.length + 1).trim();
      if (bare.length === 0) return { kind: "not-found" };
      const descriptor = this.providers.get(CODEX_FALLBACK_PROVIDER_ID);
      return {
        kind: "provider",
        providerId: CODEX_FALLBACK_PROVIDER_ID,
        ...(descriptor ? { descriptor } : {}),
        // Keep the full reference for logging, and the bare id for the upstream request.
        resolvedModel: normalized,
        modelId: bare,
      };
    }

    if (this.openCodeNamespaceEnabled) {
      // All opencode namespaces (legacy `ocgo:` plus `opencode*:`) stay on the OpenCode
      // dispatch path during the migration; route handlers are switched over separately.
      const ref = parseOpenCodeModelRef(normalized, { legacyOpenCode: this.legacyOpenCodePrefix });
      if (ref) {
        return {
          kind: "opencode",
          resolvedModel: normalized,
          modelId: ref.modelId,
          ...(ref.tier ? { tier: ref.tier } : {}),
        };
      }
      if (hasOpenCodeModelPrefix(normalized) &&
          (this.legacyOpenCodePrefix || !normalized.startsWith(OPENCODE_MODEL_PREFIX))) {
        return { kind: "opencode", resolvedModel: normalized };
      }
    }

    return this.resolveMatchInternal(normalized, new Set<string>());
  }

  recordApiKeyUsage(entryId: string, usage: { input_tokens?: number; output_tokens?: number }, imageRequest = false): void {
    this.apiKeyPool?.recordUsage(entryId, usage, imageRequest);
  }

  private resolveMatchInternal(model: string, seenAliases: Set<string>): UpstreamRouteMatch {
    // A runtime alias must not bypass the explicit OpenCode model and its client ACL.
    if (this.openCodeNamespaceEnabled && hasOpenCodeModelPrefix(model)) return { kind: "not-found" };
    const explicitProvider = this.splitExplicitProvider(model);

    if (this.apiKeyPool && this.adapterFactory) {
      for (const candidate of this.resolvePoolModelCandidates(model)) {
        const entries = explicitProvider?.tag === "antigravity"
          ? this.apiKeyPool.getByModel(candidate).filter((entry) => entry.provider === "antigravity")
          : this.apiKeyPool.getByModel(candidate);
        if (entries.length > 0) {
          const entry = pickLeastRecentlyUsed(entries);
          this.apiKeyPool.markUsed(entry.id);
          return {
            kind: "api-key",
            adapter: this.getOrCreateDynamicAdapter(entry),
            entry,
            ...(candidate === model ? {} : { resolvedModel: candidate }),
          };
        }
      }
    }

    if (explicitProvider?.tag === "antigravity") return { kind: "not-found" };

    if (explicitProvider) {
      const adapter = this.adapters.get(explicitProvider.tag);
      if (adapter) {
        return { kind: "adapter", adapter, resolvedModel: explicitProvider.bareModel };
      }
    }

    const aliases = getModelAliases();
    const aliasTarget = aliases[model]?.trim();
    if (aliasTarget) {
      if (seenAliases.has(model) || seenAliases.has(aliasTarget)) {
        return { kind: "not-found" };
      }
      seenAliases.add(model);
      const match = this.resolveMatchInternal(aliasTarget, seenAliases);
      return withResolvedModel(match, match.kind === "not-found" ? aliasTarget : match.resolvedModel ?? aliasTarget);
    }

    const suffixBase = stripKnownModelSuffixes(model).modelName;
    const suffixAliasTarget = suffixBase !== model ? aliases[suffixBase]?.trim() : undefined;
    if (suffixAliasTarget) {
      if (seenAliases.has(suffixBase) || seenAliases.has(suffixAliasTarget)) {
        return { kind: "not-found" };
      }
      seenAliases.add(suffixBase);
      const match = this.resolveMatchInternal(suffixAliasTarget, seenAliases);
      if (match.kind === "codex") {
        return withResolvedModel(match, match.resolvedModel ?? suffixAliasTarget);
      }
    }

    const routedTag = this.modelRouting[model];
    if (routedTag) {
      const adapter = this.adapters.get(routedTag);
      if (adapter) return { kind: routedTag === this.defaultTag ? "codex" : "adapter", adapter };
    }

    if (this.isKnownCodexModel(model)) {
      return { kind: "codex" };
    }

    if (/^claude/i.test(model) && this.adapters.has("anthropic")) {
      return { kind: "adapter", adapter: this.adapters.get("anthropic")! };
    }
    if (/^gemini/i.test(model) && this.adapters.has("gemini")) {
      return { kind: "adapter", adapter: this.adapters.get("gemini")! };
    }

    return { kind: "not-found" };
  }

  resolve(model: string): UpstreamAdapter {
    const match = this.resolveMatch(model);
    if (match.kind === "not-found" || !match.adapter) {
      throw new Error(`No upstream adapter available for model \"${model}\"`);
    }
    return match.adapter;
  }

  isCodexModel(model: string): boolean {
    return this.resolveMatch(model).kind === "codex";
  }

  hasApiKeyModel(model: string): boolean {
    return this.resolveMatch(model).kind === "api-key";
  }

  private isKnownCodexModel(model: string): boolean {
    const aliases = getModelAliases();
    const trimmed = model.trim();
    if (aliases[trimmed]) return true;
    if (getModelInfo(trimmed)) return true;

    const stripped = stripKnownModelSuffixes(trimmed);
    if (stripped.modelName !== trimmed && getModelInfo(stripped.modelName)) return true;

    if (/^(gpt|o\d|codex)/i.test(trimmed)) return true;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0 && !this.adapters.has(trimmed.slice(0, colonIdx))) {
      return getModelInfo(trimmed) !== undefined;
    }

    return false;
  }

  private getOrCreateDynamicAdapter(entry: ApiKeyEntry): UpstreamAdapter {
    const cached = this.dynamicAdapters.get(entry.id);
    if (cached && cached.apiKey === entry.apiKey && cached.proxyId === entry.proxyId) return cached.adapter;
    const adapter = this.adapterFactory!(entry);
    this.dynamicAdapters.set(entry.id, { apiKey: entry.apiKey, proxyId: entry.proxyId, adapter });
    return adapter;
  }
}

function pickLeastRecentlyUsed(entries: ApiKeyEntry[]): ApiKeyEntry {
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    if (!e.lastUsedAt) return e; // never used → pick immediately
    if (!best.lastUsedAt || e.lastUsedAt < best.lastUsedAt) best = e;
  }
  return best;
}

function withResolvedModel(match: UpstreamRouteMatch, resolvedModel: string): UpstreamRouteMatch {
  if (match.kind === "not-found") return match;
  if (match.resolvedModel) return match;
  return { ...match, resolvedModel };
}
