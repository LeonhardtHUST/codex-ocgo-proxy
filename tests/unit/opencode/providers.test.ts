import { describe, expect, it } from "vitest";
import {
  CODEX_FALLBACK_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  ProviderRegistry,
  createDefaultProviderRegistry,
  createOpenCodeProvider,
} from "@src/opencode/providers.js";

describe("provider descriptors", () => {
  it("preloads the five first-class providers in priority order", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.list().map((provider) => provider.id)).toEqual([
      CODEX_PROVIDER_ID,
      "opencode-go",
      "opencode-zen",
      CODEX_FALLBACK_PROVIDER_ID,
      "opencode-zen-free",
    ]);
  });

  it("treats the codex fallback upstream as a first-class provider", () => {
    const registry = createDefaultProviderRegistry();
    const fallback = registry.get(CODEX_FALLBACK_PROVIDER_ID);
    expect(fallback).toBeDefined();
    expect(fallback?.enabled).toBe(true);
    expect(fallback?.kind).toBe("apikey");
    expect(registry.list().some((provider) => provider.id === CODEX_FALLBACK_PROVIDER_ID)).toBe(true);
  });

  it("keeps the free tier disabled until it is switched on", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.get("opencode-zen-free")?.enabled).toBe(false);
    expect(registry.routable().map((provider) => provider.id)).not.toContain("opencode-zen-free");
    registry.setEnabled("opencode-zen-free", true);
    expect(registry.routable().map((provider) => provider.id)).toContain("opencode-zen-free");
  });

  it("describes the endpoints each opencode upstream speaks", () => {
    const descriptor = createOpenCodeProvider("go");
    expect(descriptor.kind).toBe("opencode");
    expect(descriptor.endpoints).toMatchObject({
      responses: "/openai/v1/responses",
      chat: "/openai/v1/chat/completions",
      messages: "/anthropic/v1/messages",
      google: "/google/v1beta/models",
    });
    expect(descriptor.capabilities.promptCacheKey).toBe(true);
  });

  it("reorders routing when a priority changes", () => {
    const registry = createDefaultProviderRegistry();
    registry.setEnabled("opencode-zen-free", true);
    registry.setPriority("opencode-zen-free", 1);
    expect(registry.list()[0]?.id).toBe("opencode-zen-free");
    expect(registry.routable()[0]?.id).toBe("opencode-zen-free");
  });

  it("merges endpoint and capability overrides on re-register", () => {
    const registry = new ProviderRegistry([createOpenCodeProvider("zen")]);
    registry.register({ ...createOpenCodeProvider("zen"), priority: 5, capabilities: { ...createOpenCodeProvider("zen").capabilities, images: true } });
    const provider = registry.get("opencode-zen");
    expect(provider?.priority).toBe(5);
    expect(provider?.capabilities.images).toBe(true);
    expect(provider?.endpoints.messages).toBe("/anthropic/v1/messages");
  });

  it("groups providers by kind", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.byKind("opencode").map((provider) => provider.id)).toEqual([
      "opencode-go",
      "opencode-zen",
    ]);
    expect(registry.byKind("codex-oauth").map((provider) => provider.id)).toEqual([CODEX_PROVIDER_ID]);
  });

  it("throws on unknown provider ids instead of silently ignoring them", () => {
    const registry = createDefaultProviderRegistry();
    expect(() => registry.setPriority("nope", 1)).toThrow(/Unknown provider/);
    expect(() => registry.setEnabled("nope", true)).toThrow(/Unknown provider/);
  });
});
