import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  OPENCODE_CATALOG_SEED_FILE,
  OpenCodeCatalog,
  mergeCatalog,
  normalizeCatalogPayload,
  normalizeSeedRow,
  parseSeed,
} from "@src/opencode/catalog.js";
import { getConfigDir } from "@src/paths.js";

const seedPath = resolve(getConfigDir(), OPENCODE_CATALOG_SEED_FILE);

/** models.dev / Console v2 shaped payload (trimmed to the fields we consume). */
const livePayload = {
  object: "list",
  data: [
    {
      id: "minimax-m3",
      object: "model",
      name: "MiniMax M3",
      type: "chat",
      api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
      modalities: { input: ["text"], output: ["text"] },
      capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ["low", "high"] } },
      limit: { context: 512000, output: 64000 },
      cost: { text: { input: { price: 0.3, cache: { read: 0.06 } }, output: { price: 1.2 } } },
    },
    {
      id: "some-free-model",
      object: "model",
      name: "Free",
      type: "chat",
      api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
      limit: { context: 128000 },
      cost: { text: { input: { price: 0 }, output: { price: 0 } } },
    },
  ],
};

describe("opencode catalog", () => {
  it("parses the bundled seed with real coverage", () => {
    const catalog = new OpenCodeCatalog();
    const loaded = catalog.loadSeed(seedPath);
    expect(loaded).toBeGreaterThan(100);
    const status = catalog.status();
    expect(status.counts.zen).toBeGreaterThanOrEqual(100);
    expect(status.counts.go).toBeGreaterThanOrEqual(30);
    expect(status.source).toBe("seed");
    expect(status.stale).toBe(true);
  });

  it("keeps the per-upstream protocol split for the same model id", () => {
    const catalog = new OpenCodeCatalog();
    catalog.loadSeed(seedPath);
    const zen = catalog.find("zen", "minimax-m3");
    const go = catalog.find("go", "minimax-m3");
    expect(zen?.protocols).toEqual(["chat-completions"]);
    expect(go?.protocols).toEqual(["messages"]);
    expect(zen?.contextWindow).not.toBe(go?.contextWindow);
  });

  it("mirrors free zen models into the zen-free upstream without duplicating paid ones", () => {
    const catalog = new OpenCodeCatalog();
    catalog.loadSeed(seedPath);
    const free = catalog.listForUpstream("zen-free");
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((entry) => entry.free)).toBe(true);
    expect(free.every((entry) => entry.upstream === "zen-free")).toBe(true);
    expect(catalog.listForUpstream("zen").some((entry) => entry.free)).toBe(true);
  });

  it("normalizes a live payload into entries keyed by upstream", () => {
    const entries = normalizeCatalogPayload(livePayload, "zen", "catalog");
    expect(entries).toHaveLength(2);
    const paid = entries[0];
    expect(paid.id).toBe("minimax-m3");
    expect(paid.protocols).toEqual(["chat-completions"]);
    expect(paid.contextWindow).toBe(512000);
    expect(paid.maxOutputTokens).toBe(64000);
    expect(paid.reasoningEfforts).toEqual(["low", "high"]);
    expect(paid.free).toBe(false);
    expect(paid.cost).toEqual({ input: 0.3, cachedInput: 0.06, output: 1.2 });
    expect(entries[1].free).toBe(true);
  });

  it("detects free models by price even without the -free suffix", () => {
    const [entry] = normalizeCatalogPayload({ data: [{ id: "big-pickle", api: { "chat-completions": {} }, cost: { text: { input: { price: 0 }, output: { price: 0 } } } }] }, "zen");
    expect(entry.id).toBe("big-pickle");
    expect(entry.free).toBe(true);
  });

  it("prefers live entries over seed rows and keeps seed rows that have no live counterpart", () => {
    const seed = [normalizeSeedRow({ id: "a", upstream: "zen", protocol: "responses", contextWindow: 1000 })!];
    const live = [{ ...seed[0], id: "b", source: "catalog" as const }];
    const merged = mergeCatalog(seed, live);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b"]);

    const overridden = mergeCatalog(seed, [{ ...seed[0], contextWindow: 9999, source: "catalog" as const }]);
    expect(overridden).toHaveLength(1);
    expect(overridden[0].contextWindow).toBe(9999);
  });

  it("skips malformed seed rows instead of inventing values", () => {
    expect(parseSeed("not json")).toEqual([]);
    expect(parseSeed(JSON.stringify({ models: [{ id: "ok", upstream: "zen" }, { id: "bad", upstream: "nope" }, { upstream: "zen" }] })))
      .toHaveLength(1);
    expect(normalizeSeedRow({ id: "x", upstream: "zen", protocol: "unknown-protocol" })?.protocols).toEqual(["chat-completions"]);
  });

  it("marks itself stale again once the ttl expires", () => {
    let now = 1_000_000;
    const catalog = new OpenCodeCatalog({ now: () => now, ttlMs: 1000, jitter: () => 0.5 });
    catalog.loadSeed(seedPath);
    expect(catalog.shouldRefresh()).toBe(true);
    now += 2000;
    expect(catalog.shouldRefresh()).toBe(true);
  });

  it("keeps serving the previous snapshot when refresh fails", async () => {
    const catalog = new OpenCodeCatalog({
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    catalog.loadSeed(seedPath);
    const before = catalog.list().length;
    await expect(catalog.refresh()).resolves.toBe(false);
    expect(catalog.list()).toHaveLength(before);
    expect(catalog.status().source).toBe("seed");
    expect(catalog.status().lastError).toContain("500");
  });

  it("switches to live data on a successful refresh", async () => {
    const calls: string[] = [];
    const catalog = new OpenCodeCatalog({
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify(livePayload), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      now: () => 5_000,
      jitter: () => 0.5,
    });
    await expect(catalog.refresh()).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(catalog.status().source).toBe("live");
    expect(catalog.status().fetchedAt).toBe(new Date(5_000).toISOString());
    expect(catalog.find("zen", "minimax-m3")?.source).toBe("catalog");
  });
});
