import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelAliases, getModelCatalog } from "@src/models/model-store.js";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import type { ApiKeyEntry, ApiKeyPersistence } from "@src/auth/api-key-pool.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { CodexResponsesRequest, CodexSSEEvent } from "@src/proxy/codex-types.js";
import { createRuntimeUpstreamRouter } from "@src/proxy/upstream-router-bootstrap.js";

vi.mock("@src/models/model-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/models/model-store.js")>();
  return { ...actual, getModelAliases: vi.fn(actual.getModelAliases), getModelCatalog: vi.fn(actual.getModelCatalog) };
});

afterEach(() => {
  vi.mocked(getModelAliases).mockClear();
  vi.mocked(getModelCatalog).mockClear();
});

function createMemoryPersistence(): ApiKeyPersistence {
  let stored: ApiKeyEntry[] = [];
  return {
    load: () => [...stored],
    save: (keys) => {
      stored = [...keys];
    },
  };
}

function mockAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: (_req: CodexResponsesRequest) => Promise.resolve(new Response()),
    async *parseStream(): AsyncGenerator<CodexSSEEvent> { /* no events */ },
  };
}

function addCustom(pool: ApiKeyPool, model: string) {
  return pool.add({ provider: "custom", model, apiKey: "fake-custom-key", baseUrl: "https://example.invalid/v1" });
}

const makeRuntime = (pool = new ApiKeyPool(createMemoryPersistence()), routing = {}, adapters = new Map<string, UpstreamAdapter>()) =>
  createRuntimeUpstreamRouter(adapters, routing, pool, () => mockAdapter("custom"));

describe("OCGo namespace preparation", () => {
  it("leaves old prefixed entries and their routing intact by default", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    const router = makeRuntime(pool);
    const entry = addCustom(pool, "ocgo:legacy-model");
    expect(router.resolveMatch("ocgo:legacy-model")).toMatchObject({ kind: "api-key", entry: { id: entry.id } });
  });

  it("selects a supplier but no key and never picks the unprefixed Custom entry", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    const router = makeRuntime(pool);
    const entry = addCustom(pool, "shared-model");
    router.enableOCGoNamespace();
    expect(router.resolveMatch(" ocgo:shared-model ")).toEqual({
      kind: "ocgo", resolvedModel: "ocgo:shared-model", modelId: "shared-model",
    });
    expect(pool.getEntry(entry.id)?.lastUsedAt).toBeNull();
    expect(router.resolveMatch("ocgo:")).toEqual({ kind: "ocgo", resolvedModel: "ocgo:" });
    expect(router.resolveMatch("ocgo:zen/wrong")).toEqual({ kind: "ocgo", resolvedModel: "ocgo:zen/wrong" });
    expect(router.resolveMatch("shared-model").kind).toBe("api-key");
    expect(router.resolveMatch("gpt-5.5").kind).toBe("codex");
    expect(() => addCustom(pool, " ocgo:late-entry ")).toThrow(/prefix is reserved/);
    vi.mocked(getModelAliases).mockReturnValueOnce({ "late-alias": "ocgo:shared-model" });
    expect(router.resolveMatch("late-alias").kind).toBe("not-found");
  });

  it("refuses to enable over a persisted Custom key, including a disabled one", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    const entry = addCustom(pool, "ocgo:legacy-model");
    pool.setStatus(entry.id, "disabled");
    const router = makeRuntime(pool);
    expect(() => router.enableOCGoNamespace()).toThrow(/Cannot enable OCGo/);
    pool.setStatus(entry.id, "active");
    expect(router.resolveMatch("ocgo:legacy-model").kind).toBe("api-key");
  });

  it("refuses existing model routing, Custom provider, aliases and catalog IDs", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    expect(() => makeRuntime(pool, { "ocgo:legacy": "openai" }).enableOCGoNamespace()).toThrow(/Cannot enable OCGo/);
    expect(() => makeRuntime(pool, {}, new Map([["ocgo", mockAdapter("ocgo")]])).enableOCGoNamespace()).toThrow(/Cannot enable OCGo/);
    vi.mocked(getModelAliases).mockReturnValueOnce({ "ocgo:legacy": "gpt-5.5" });
    expect(() => makeRuntime(pool).enableOCGoNamespace()).toThrow(/Cannot enable OCGo/);
    vi.mocked(getModelAliases).mockReturnValueOnce({ "legacy": "ocgo:model" });
    expect(() => makeRuntime(pool).enableOCGoNamespace()).toThrow(/Cannot enable OCGo/);
    const model = getModelCatalog()[0];
    vi.mocked(getModelCatalog).mockReturnValueOnce([{ ...model, id: "ocgo:legacy" }]);
    expect(() => makeRuntime(pool).enableOCGoNamespace()).toThrow(/Cannot enable OCGo/);
  });
});

describe("createRuntimeUpstreamRouter", () => {
  it("creates a router even when startup has no configured adapters or persisted API keys", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    const router = createRuntimeUpstreamRouter(new Map(), {}, pool, (entry) => mockAdapter(`dynamic-${entry.model}`));

    expect(router.resolveMatch("late-runtime-model").kind).toBe("not-found");

    pool.add({
      provider: "custom",
      model: "late-runtime-model",
      apiKey: "secret",
      baseUrl: "https://example.com/v1",
    });

    const match = router.resolveMatch("late-runtime-model");
    expect(match.kind).toBe("api-key");
    if (match.kind === "api-key") {
      expect(match.adapter.tag).toBe("dynamic-late-runtime-model");
    }
  });

  it("supports passing proxyPool directly as 4th argument without adapterFactory", () => {
    const pool = new ApiKeyPool(createMemoryPersistence());
    const mockProxyPool = {
      resolveProxyUrlById: () => undefined,
    };
    const router = createRuntimeUpstreamRouter(new Map(), {}, pool, mockProxyPool as never);

    pool.add({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "sk-openai",
    });

    const match = router.resolveMatch("gpt-5.5");
    expect(match.kind).toBe("api-key");
  });
});
