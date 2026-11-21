import { describe, expect, it } from "vitest";
import type { OpenCodeModelEntry } from "@src/opencode/model.js";
import { buildModelViews, providerIdForUpstream, toCatalogRow, toModelView } from "@src/opencode/models-view.js";

function entry(overrides: Partial<OpenCodeModelEntry> = {}): OpenCodeModelEntry {
  return {
    id: "deepseek-v4.1-flash",
    upstream: "zen",
    protocols: ["chat-completions"],
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: true,
    reasoningEfforts: ["low", "medium", "high"],
    free: false,
    selectable: true,
    cost: { input: 0.3, cachedInput: 0.006, output: 1.2 },
    source: "catalog",
    ...overrides,
  };
}

describe("opencode model views", () => {
  it("maps upstreams to provider ids", () => {
    expect(providerIdForUpstream("go")).toBe("opencode-go");
    expect(providerIdForUpstream("zen")).toBe("opencode-zen");
    expect(providerIdForUpstream("zen-free")).toBe("opencode-zen-free");
  });

  it("emits the contract fields for one entry", () => {
    const view = toModelView(entry());
    expect(view).toMatchObject({
      id: "opencode-zen:deepseek-v4.1-flash",
      object: "model",
      owned_by: "opencode-zen",
      free: false,
      native_protocol: "chat-completions",
      supported_protocols: ["chat-completions"],
      context_window: 1_000_000,
      max_output_tokens: 64_000,
    });
    expect(view.capabilities).toEqual({ tools: true, reasoning: true });
    expect(view.supported_reasoning_efforts).toEqual([
      { reasoning_effort: "low", description: "low" },
      { reasoning_effort: "medium", description: "medium" },
      { reasoning_effort: "high", description: "high" },
    ]);
    expect(view.default_reasoning_effort).toBe("medium");
    expect(view.reasoning).toEqual({ supported: true, effort: ["low", "medium", "high"] });
    expect(view.pricing).toEqual({ input: 0.3, cached_input: 0.006, output: 1.2 });
  });

  it("carries every field alias clients read", () => {
    const view = toModelView(entry({ maxInputTokens: 900_000 }));
    expect(view.context_length).toBe(1_000_000);
    expect(view.max_context_length).toBe(1_000_000);
    expect(view.max_input_tokens).toBe(900_000);
    expect(view.max_tokens).toBe(64_000);
    expect(view.limit).toEqual({ context: 1_000_000, input: 900_000, output: 64_000 });
  });

  it("reports models without reasoning tiers honestly", () => {
    const view = toModelView(entry({ reasoningEfforts: undefined }));
    expect(view.reasoning).toEqual({ supported: false });
    expect(view.supported_reasoning_efforts).toBeUndefined();
    expect(view.default_reasoning_effort).toBeUndefined();
  });

  it("keeps Go metadata (quota, zdr) on the row", () => {
    const view = toModelView(entry({
      upstream: "go",
      go: { monthlyUsage: [100, 200, 105], zeroDataRetention: true },
    }));
    expect(view.go).toEqual({ monthly_usage: [100, 200, 105], zdr: true });
  });

  it("advertises tier-qualified ids and a bare alias only for unique ids", () => {
    const rows = buildModelViews([
      entry({ id: "minimax-m3", upstream: "zen", protocols: ["chat-completions"] }),
      entry({ id: "minimax-m3", upstream: "go", protocols: ["messages"] }),
      entry({ id: "kimi-k3", upstream: "zen" }),
    ]);
    const ids = rows.map((row) => row.id);
    expect(ids).toContain("opencode-zen:minimax-m3");
    expect(ids).toContain("opencode-go:minimax-m3");
    expect(ids).toContain("opencode-zen:kimi-k3");
    // duplicated id gets no bare alias, unique id does
    expect(ids).not.toContain("opencode:minimax-m3");
    expect(ids).toContain("opencode:kimi-k3");
  });

  it("excludes non-chat entries from the /models rows", () => {
    const rows = buildModelViews([
      entry({ id: "text-embedding-3-small", protocols: ["embeddings"], selectable: false }),
      entry({ id: "jemma-systemone", protocols: ["systemone"] }),
      entry({ id: "glm-5.3" }),
    ]);
    expect(rows.map((row) => row.model ?? row.id)).not.toContain("text-embedding-3-small");
    expect(rows.every((row) => String(row.id).includes(":glm-5.3") || String(row.id).includes(":text-embedding") === false)).toBe(true);
  });

  it("marks free models by price or the free flag", () => {
    const rows = buildModelViews([
      entry({ id: "big-pickle", free: true }),
      entry({ id: "paid-model", free: false }),
    ]);
    const free = rows.find((row) => String(row.id).endsWith(":big-pickle"));
    const paid = rows.find((row) => String(row.id).endsWith(":paid-model"));
    expect(free?.free).toBe(true);
    expect(paid?.free).toBe(false);
  });

  it("returns a superset row for the catalog endpoint", () => {
    const row = toCatalogRow(entry({ upstream: "go", source: "seed", go: { monthlyUsage: [15, 60, 20] } }));
    expect(row).toMatchObject({
      upstream: "go",
      model: "deepseek-v4.1-flash",
      selectable: true,
      source: "seed",
      monthly_usage: [15, 60, 20],
    });
    expect(row.native_protocol).toBe("chat-completions");
  });
});
