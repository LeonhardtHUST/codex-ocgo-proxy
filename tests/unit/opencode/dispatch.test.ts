import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { OCGoUpstream } from "@src/proxy/ocgo-upstream.js";
import { OpenCodeAdapter } from "@src/opencode/adapter.js";
import { RustRouterAdapter } from "@src/opencode/rust-adapter.js";
import { setActiveRustRouter } from "@src/opencode/rust-router.js";
import { OpenCodeCatalog } from "@src/opencode/catalog.js";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import { ProtocolMatrix } from "@src/opencode/protocol-matrix.js";
import {
  createOpenCodeUpstream,
  isOpenCodeServing,
  resolveEntryForTier,
  resolveTimeoutSeconds,
  resolveUpstreamForRequest,
} from "@src/opencode/dispatch.js";

const seedPath = resolve("config", "opencode-models.seed.json");
const catalog = (() => {
  const instance = new OpenCodeCatalog();
  instance.loadSeed(seedPath);
  return instance;
})();

describe("opencode dispatch", () => {
  it("uses the in-repo Rust router when it is ready", () => {
    const config = OpenCodeConfigSchema.parse({ enabled: true, rust_routing: { enabled: true } });
    setActiveRustRouter({ isReady: true, status: () => ({ state: "ready" }) } as never);
    try {
      const upstream = createOpenCodeUpstream({ config, modelId: "glm-5.3", apiKey: "k", catalog });
      expect(upstream).toBeInstanceOf(RustRouterAdapter);
      expect(upstream.tag).toBe("opencode-rust");
    } finally {
      setActiveRustRouter(null);
    }
  });

  it("keeps the pre-rename external sidecar for migrated installations", () => {
    const config = OpenCodeConfigSchema.parse({
      enabled: true,
      rust_routing: { enabled: true, legacy_sidecar: true, base_url: "http://127.0.0.1:8787/v1" },
    });
    const upstream = createOpenCodeUpstream({ config, modelId: "glm-5.3", apiKey: "k", catalog });
    expect(upstream).toBeInstanceOf(OCGoUpstream);
  });

  it("degrades to the TypeScript adapter when the router is enabled but not ready", () => {
    const config = OpenCodeConfigSchema.parse({ enabled: true, rust_routing: { enabled: true } });
    setActiveRustRouter(null);
    const upstream = createOpenCodeUpstream({ config, modelId: "glm-5.3", apiKey: "k", catalog, matrix: new ProtocolMatrix() });
    expect(upstream).toBeInstanceOf(OpenCodeAdapter);
  });

  it("talks to opencode.ai directly by default", () => {
    const config = OpenCodeConfigSchema.parse({ enabled: true });
    const upstream = createOpenCodeUpstream({ config, modelId: "glm-5.3", apiKey: "k", catalog, matrix: new ProtocolMatrix() });
    expect(upstream).toBeInstanceOf(OpenCodeAdapter);
    // glm-5.3 exists on both upstreams; without a tier the paid go entry wins.
    expect(upstream.tag).toBe("opencode-go");
  });

  it("picks the logical upstream from the tier or the catalog", () => {
    expect(resolveUpstreamForRequest(catalog, "go", "glm-5.3")).toBe("go");
    expect(resolveUpstreamForRequest(catalog, "zen", "glm-5.3")).toBe("zen");
    expect(resolveUpstreamForRequest(catalog, undefined, "glm-5.3")).toBe("go");
    expect(resolveUpstreamForRequest(catalog, "zen-free", "deepseek-v4.1-flash-free")).toBe("zen-free");
  });

  it("resolves the catalog entry per (upstream, model)", () => {
    expect(resolveEntryForTier(catalog, "go", "minimax-m3")?.protocols).toEqual(["messages"]);
    expect(resolveEntryForTier(catalog, "zen", "minimax-m3")?.protocols).toEqual(["chat-completions"]);
    expect(resolveEntryForTier(catalog, undefined, "minimax-m3")?.upstream).toBe("go");
    expect(resolveEntryForTier(catalog, undefined, "not-a-model")).toBeUndefined();
  });

  it("uses the opencode timeout when the family is on, the legacy one otherwise", () => {
    expect(resolveTimeoutSeconds({ opencode: OpenCodeConfigSchema.parse({ enabled: true, http_timeout_seconds: 42 }), legacyTimeoutSeconds: 180 })).toBe(42);
    expect(resolveTimeoutSeconds({ opencode: OpenCodeConfigSchema.parse({ enabled: false, http_timeout_seconds: 42 }), legacyTimeoutSeconds: 180 })).toBe(180);
    expect(resolveTimeoutSeconds({ legacyTimeoutSeconds: 180 })).toBe(180);
  });

  it("serves requests when either backend is enabled", () => {
    expect(isOpenCodeServing({ legacyEnabled: true })).toBe(true);
    expect(isOpenCodeServing({ legacyEnabled: false, opencode: { enabled: true } })).toBe(true);
    expect(isOpenCodeServing({ legacyEnabled: false, opencode: { enabled: false } })).toBe(false);
    expect(isOpenCodeServing({ legacyEnabled: false })).toBe(false);
  });
});
