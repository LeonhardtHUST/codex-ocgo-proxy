import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FallbackGraphSchema,
  emptyFallbackGraph,
  edgeMatches,
  outgoingEdges,
  resolveEntryNode,
  sortEdges,
  type FallbackGraph,
} from "@src/opencode/fallback-graph/model.js";
import { longestPath, validateGraph } from "@src/opencode/fallback-graph/validate.js";
import { FallbackGraphStore } from "@src/opencode/fallback-graph/store.js";
import { chooseNextNode, createTraversalState, markVisited, planPath } from "@src/opencode/fallback-graph/runtime.js";
import { createOpenCodeFallbackGraphRoutes } from "@src/routes/admin/opencode-fallback-graph.js";

function graph(overrides: Record<string, unknown> = {}): FallbackGraph {
  return FallbackGraphSchema.parse({
    entrypoints: { "opencode:glm-5.3": "n1" },
    nodes: [
      { id: "n1", target: "opencode:glm-5.3" },
      { id: "n2", target: "opencode-go:kimi-k3" },
      { id: "n3", target: "codex-fallback:gpt-5.1" },
    ],
    edges: [
      { from: "n1", to: "n2", on: ["rate_limited", "model_denied"], weight: 10 },
      { from: "n2", to: "n3", on: ["*"], weight: 1 },
    ],
    ...overrides,
  });
}

describe("fallback graph schema", () => {
  it("applies documented defaults", () => {
    const parsed = emptyFallbackGraph();
    expect(parsed.version).toBe(1);
    expect(parsed.limits).toEqual({ maxHops: 3, budgetMs: 240_000, perHopAttempts: 2 });
    expect(parsed.nodes).toEqual([]);
    expect(parsed.entrypoints).toEqual({});
  });

  it("rejects unknown conditions and malformed nodes", () => {
    expect(FallbackGraphSchema.safeParse({ edges: [{ from: "a", to: "b", on: ["nope"] }] }).success).toBe(false);
    expect(FallbackGraphSchema.safeParse({ nodes: [{ id: "", target: "x" }] }).success).toBe(false);
    expect(FallbackGraphSchema.safeParse({ nodes: [{ id: "n", target: "x", extra: 1 }] }).success).toBe(false);
  });

  it("sorts edges deterministically by weight then target", () => {
    const edges = [
      { from: "a", to: "z", on: ["*"] as const, weight: 5 },
      { from: "a", to: "b", on: ["*"] as const, weight: 5 },
      { from: "a", to: "m", on: ["*"] as const, weight: 9 },
    ].map((edge) => ({ ...edge, on: [...edge.on] }));
    expect(sortEdges(edges).map((edge) => edge.to)).toEqual(["m", "b", "z"]);
  });

  it("matches wildcard and concrete failures", () => {
    const edge = { from: "a", to: "b", on: ["rate_limited"], weight: 1 };
    expect(edgeMatches(edge, "rate_limited")).toBe(true);
    expect(edgeMatches(edge, "timeout")).toBe(false);
    expect(edgeMatches({ ...edge, on: ["*"] }, "timeout")).toBe(true);
  });

  it("resolves the entry node and ignores disabled ones", () => {
    expect(resolveEntryNode(graph(), "opencode:glm-5.3")?.id).toBe("n1");
    expect(resolveEntryNode(graph(), "unknown:model")).toBeUndefined();
    const disabled = graph({
      nodes: [
        { id: "n1", target: "opencode:glm-5.3", enabled: false },
        { id: "n2", target: "b" },
      ],
    });
    expect(resolveEntryNode(disabled, "opencode:glm-5.3")).toBeUndefined();
  });
});

describe("fallback graph validation", () => {
  it("accepts the reference graph", () => {
    expect(validateGraph(graph())).toEqual({ ok: true, errors: [] });
  });

  it("detects duplicate ids, dangling edges and bad entrypoints", () => {
    const result = validateGraph(graph({
      nodes: [{ id: "n1", target: "a" }, { id: "n1", target: "b" }],
      edges: [{ from: "n1", to: "ghost", on: ["*"], weight: 1 }],
      entrypoints: { "m": "nope" },
    }));
    expect(result.ok).toBe(false);
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain("nodes[1].id");
    expect(paths).toContain("edges[0].to");
    expect(paths).toContain("entrypoints.m");
  });

  it("detects cycles", () => {
    const result = validateGraph(graph({
      edges: [
        { from: "n1", to: "n2", on: ["*"], weight: 1 },
        { from: "n2", to: "n1", on: ["*"], weight: 1 },
      ],
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes("cycle"))).toBe(true);
  });

  it("flags a chain longer than maxHops", () => {
    const result = validateGraph(graph({ limits: { maxHops: 1, budgetMs: 1000, perHopAttempts: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === "limits.maxHops")).toBe(true);
  });

  it("flags disconnected nodes but tolerates a single-node graph", () => {
    const disconnected = validateGraph(graph({
      entrypoints: { "opencode:glm-5.3": "n1" },
      nodes: [{ id: "n1", target: "a" }, { id: "lonely", target: "b" }],
      edges: [],
    }));
    expect(disconnected.ok).toBe(false);
    expect(disconnected.errors[0].message).toContain("not connected");

    const single = validateGraph(graph({ nodes: [{ id: "n1", target: "a" }], edges: [] }));
    expect(single.ok).toBe(true);
  });

  it("measures the longest path", () => {
    expect(longestPath(graph())).toBe(2);
  });
});

describe("fallback graph store", () => {
  function store() {
    const dir = mkdtempSync(join(tmpdir(), "fallback-graph-"));
    return { dir, store: new FallbackGraphStore(join(dir, "graph.json")) };
  }

  it("returns an empty graph when the file is missing", () => {
    const { store: instance } = store();
    expect(instance.read().nodes).toEqual([]);
    expect(instance.status().nodes).toBe(0);
  });

  it("persists atomically and validates before writing", () => {
    const { dir, store: instance } = store();
    const saved = instance.save({ entrypoints: { "a:b": "n1" }, nodes: [{ id: "n1", target: "a:b" }], edges: [] });
    expect(saved.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")) as { nodes: unknown[] };
    expect(onDisk.nodes).toHaveLength(1);

    const rejected = instance.save({ edges: [{ from: "x", to: "y", on: ["*"], weight: 1 }] });
    expect(rejected.ok).toBe(false);
    // previous content survived
    expect(JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")).nodes).toHaveLength(1);
  });

  it("falls back to an empty graph on corrupt or invalid files", () => {
    const { dir, store: instance } = store();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "graph.json"), "{ not json", "utf8");
    expect(instance.read().nodes).toEqual([]);
    expect(instance.status().lastError).toContain("parse");

    writeFileSync(join(dir, "graph.json"), JSON.stringify({ edges: [{ from: "a", to: "b", on: ["*"] }], nodes: [] }), "utf8");
    instance.invalidate();
    expect(instance.read().nodes).toEqual([]);
    expect(instance.status().lastError).toContain("invalid");
  });
});

describe("fallback traversal", () => {
  it("moves along the weighted edge that accepts the failure", () => {
    const state = createTraversalState(0);
    markVisited(state, "n1");
    const hop = chooseNextNode(graph(), "n1", "rate_limited", state, 0);
    expect(hop?.node.id).toBe("n2");
    expect(hop?.edge.from).toBe("n1");
  });

  it("does not traverse for an unrouted failure", () => {
    const state = createTraversalState(0);
    markVisited(state, "n1");
    expect(chooseNextNode(graph(), "n1", "policy_rejected", state, 0)).toBeUndefined();
  });

  it("respects maxHops", () => {
    const state = createTraversalState(0);
    state.hops = 3;
    markVisited(state, "n1");
    expect(chooseNextNode(graph(), "n1", "rate_limited", state, 0)).toBeUndefined();
  });

  it("respects the budget", () => {
    const state = createTraversalState(0);
    markVisited(state, "n1");
    expect(chooseNextNode(graph(), "n1", "rate_limited", state, 240_001)).toBeUndefined();
  });

  it("skips nodes already visited", () => {
    const state = createTraversalState(0);
    markVisited(state, "n1");
    markVisited(state, "n2");
    expect(chooseNextNode(graph(), "n1", "rate_limited", state, 0)).toBeUndefined();
  });

  it("plans the full path for the admin simulator", () => {
    expect(planPath(graph(), "opencode:glm-5.3", "rate_limited", 0).map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
    expect(planPath(graph(), "opencode:glm-5.3", "policy_rejected", 0).map((node) => node.id)).toEqual(["n1"]);
    expect(planPath(graph(), "missing:model", "rate_limited", 0)).toEqual([]);
  });

  it("exposes outgoing edges in deterministic order", () => {
    expect(outgoingEdges(graph(), "n1").map((edge) => edge.to)).toEqual(["n2"]);
  });
});

describe("fallback graph admin routes", () => {
  function app() {
    const dir = mkdtempSync(join(tmpdir(), "fallback-route-"));
    const store = new FallbackGraphStore(join(dir, "graph.json"));
    return { app: createOpenCodeFallbackGraphRoutes({ store, getMasterKey: () => "master-key" }), store };
  }

  it("requires auth", async () => {
    const { app: instance } = app();
    expect((await instance.request("/admin/opencode/fallback-graph")).status).toBe(401);
  });

  it("returns the stored graph", async () => {
    const { app: instance } = app();
    const response = await instance.request("/admin/opencode/fallback-graph", {
      headers: { Authorization: "Bearer master-key" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { graph: { nodes: unknown[] }; status: { nodes: number } };
    expect(body.graph.nodes).toEqual([]);
    expect(body.status.nodes).toBe(0);
  });

  it("rejects an invalid graph and keeps the previous one", async () => {
    const { app: instance } = app();
    const invalid = await instance.request("/admin/opencode/fallback-graph", {
      method: "PUT",
      headers: { Authorization: "Bearer master-key", "Content-Type": "application/json" },
      body: JSON.stringify({ edges: [{ from: "x", to: "y", on: ["*"], weight: 1 }] }),
    });
    expect(invalid.status).toBe(400);
    const body = await invalid.json() as { ok: boolean; errors: Array<{ path: string }> };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("saves a valid graph", async () => {
    const { app: instance } = app();
    const payload = {
      entrypoints: { "opencode:glm-5.3": "n1" },
      nodes: [{ id: "n1", target: "opencode:glm-5.3" }, { id: "n2", target: "opencode-go:kimi-k3" }],
      edges: [{ from: "n1", to: "n2", on: ["rate_limited"], weight: 5 }],
    };
    const saved = await instance.request("/admin/opencode/fallback-graph", {
      method: "PUT",
      headers: { Authorization: "Bearer master-key", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json() as { ok: boolean; graph: { nodes: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.graph.nodes).toHaveLength(2);
  });

  it("validates a candidate document without saving it", async () => {
    const { app: instance } = app();
    const response = await instance.request("/admin/opencode/fallback-graph/validate", {
      method: "POST",
      headers: { Authorization: "Bearer master-key", "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [{ id: "n1", target: "a" }, { id: "n1", target: "b" }] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; source: string; errors: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.source).toBe("body");
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
