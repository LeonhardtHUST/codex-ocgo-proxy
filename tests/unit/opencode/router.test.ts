import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";

vi.mock("@src/models/model-store.js", () => ({
  getModelAliases: () => ({}),
  getModelCatalog: () => [],
  getModelInfo: () => undefined,
  stripKnownModelSuffixes: (model: string) => ({ modelName: model }),
}));

const stubAdapter: UpstreamAdapter = {
  tag: "stub",
  async createResponse() { return new Response(""); },
  async *parseStream() { /* empty */ },
};

function makeRouter(): UpstreamRouter {
  return new UpstreamRouter(new Map([["openai", stubAdapter]]), {}, "codex");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opencode namespace in the router", () => {
  it("keeps the legacy ocgo shape untouched", () => {
    const router = makeRouter();
    router.enableOCGoNamespace();
    expect(router.resolveMatch("ocgo:kimi-k2.5")).toEqual({
      kind: "ocgo",
      resolvedModel: "ocgo:kimi-k2.5",
      modelId: "kimi-k2.5",
    });
    expect(router.resolveMatch(" ocgo:shared-model ")).toEqual({
      kind: "ocgo",
      resolvedModel: "ocgo:shared-model",
      modelId: "shared-model",
    });
  });

  it("routes every opencode namespace to the ocgo dispatch path", () => {
    const router = makeRouter();
    router.enableOCGoNamespace();
    expect(router.resolveMatch("opencode:glm-5.3")).toMatchObject({ kind: "ocgo", modelId: "glm-5.3" });
    expect(router.resolveMatch("opencode-zen:glm-5.3")).toMatchObject({ kind: "ocgo", modelId: "glm-5.3", tier: "zen" });
    expect(router.resolveMatch("opencode-go:minimax-m3")).toMatchObject({ kind: "ocgo", modelId: "minimax-m3", tier: "go" });
    expect(router.resolveMatch("opencode-zen-free:big-pickle")).toMatchObject({ kind: "ocgo", modelId: "big-pickle", tier: "zen-free" });
  });

  it("rejects the legacy prefix when the switch is off", () => {
    const router = makeRouter();
    router.enableOCGoNamespace();
    router.setLegacyOCGoPrefix(false);
    expect(router.resolveMatch("ocgo:kimi-k2.5")).toMatchObject({ kind: "not-found" });
    expect(router.resolveMatch("opencode:kimi-k2.5")).toMatchObject({ kind: "ocgo" });
  });

  it("keeps invalid ids on the ocgo path so the handler can reject them", () => {
    const router = makeRouter();
    router.enableOCGoNamespace();
    expect(router.resolveMatch("ocgo:")).toEqual({ kind: "ocgo", resolvedModel: "ocgo:" });
    expect(router.resolveMatch("ocgo:zen/wrong")).toEqual({ kind: "ocgo", resolvedModel: "ocgo:zen/wrong" });
  });

  it("exposes the codex fallback provider as an explicit route", () => {
    const router = makeRouter();
    const match = router.resolveMatch("codex-fallback:gpt-5.1");
    expect(match).toMatchObject({ kind: "provider", providerId: "codex-fallback", modelId: "gpt-5.1" });
  });

  it("lists the provider descriptors for the dashboard", () => {
    const router = makeRouter();
    const ids = router.listProviders().map((provider) => provider.id);
    expect(ids).toContain("codex-official");
    expect(ids).toContain("codex-fallback");
    expect(ids).toContain("opencode-zen-free");
  });
});
