import { describe, expect, it, vi } from "vitest";
import { FallbackGraphSchema } from "@src/opencode/fallback-graph/model.js";
import {
  failureFromErrorBody,
  routeFromNode,
  runFallbackChain,
  tierOf,
} from "@src/opencode/fallback-dispatch.js";

const graph = FallbackGraphSchema.parse({
  entrypoints: { "opencode:glm-5.3": "n1" },
  nodes: [
    { id: "n1", target: "opencode:glm-5.3" },
    { id: "n2", target: "opencode-go:kimi-k3" },
    { id: "n3", target: "codex-fallback:gpt-5.1" },
  ],
  edges: [
    { from: "n1", to: "n2", on: ["rate_limited"], weight: 10 },
    { from: "n2", to: "n3", on: ["upstream_unavailable"], weight: 5 },
  ],
  limits: { maxHops: 2, budgetMs: 240_000, perHopAttempts: 1 },
});

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { code, message: "boom" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

describe("fallback dispatch", () => {
  it("maps handler error codes to graph failure classes", () => {
    expect(failureFromErrorBody(429, { error: { code: "ocgo_rate_limited" } })).toBe("rate_limited");
    expect(failureFromErrorBody(429, { error: { code: "ocgo_quota_exhausted" } })).toBe("quota_exhausted");
    expect(failureFromErrorBody(502, { error: { code: "ocgo_unreachable" } })).toBe("upstream_unavailable");
    expect(failureFromErrorBody(400, { error: { code: "ocgo_unsupported_request" } })).toBe("unsupported_capability");
    // Fallback classification when the body carries no known code.
    expect(failureFromErrorBody(429, {})).toBe("rate_limited");
    expect(failureFromErrorBody(504, null)).toBe("timeout");
    expect(failureFromErrorBody(503, null)).toBe("upstream_unavailable");
    expect(failureFromErrorBody(200, { ok: true })).toBeUndefined();
    expect(failureFromErrorBody(400, { error: { code: "ocgo_invalid_model" } })).toBeUndefined();
  });

  it("rewrites the route from a node target", () => {
    expect(routeFromNode({ id: "n2", target: "opencode-go:kimi-k3", enabled: true }, { resolvedModel: "opencode:glm-5.3", modelId: "glm-5.3" }))
      .toEqual({ resolvedModel: "opencode-go:kimi-k3", modelId: "kimi-k3", tier: "go" });
    // Targets outside the opencode namespace are not dispatched by this path yet, so the
    // current route is preserved rather than silently sending the request somewhere else.
    expect(routeFromNode({ id: "n3", target: "codex-fallback:gpt-5.1", enabled: true }, { resolvedModel: "x", tier: "zen" }))
      .toEqual({ resolvedModel: "x", tier: "zen" });
    expect(routeFromNode({ id: "n4", target: "not a model ref", enabled: true }, { resolvedModel: "x" }))
      .toEqual({ resolvedModel: "x" });
  });

  it("returns the first successful attempt without extra hops", async () => {
    const attempt = vi.fn(async () => okResponse());
    const result = await runFallbackChain({ graph, startNodeId: "n1", initialRoute: { resolvedModel: "opencode:glm-5.3" }, attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.hops).toBe(0);
    expect(result.trail).toEqual(["n1"]);
  });

  it("walks the graph when the routed failure matches", async () => {
    const seen: string[] = [];
    const attempt = vi.fn(async (route: { resolvedModel: string }) => {
      seen.push(route.resolvedModel);
      return seen.length === 1 ? errorResponse(429, "ocgo_rate_limited") : okResponse();
    });
    const result = await runFallbackChain({ graph, startNodeId: "n1", initialRoute: { resolvedModel: "opencode:glm-5.3" }, attempt });
    expect(seen).toEqual(["opencode:glm-5.3", "opencode-go:kimi-k3"]);
    expect(result.hops).toBe(1);
    expect(result.trail).toEqual(["n1", "n2"]);
    expect(result.response.status).toBe(200);
  });

  it("stops when the failure is not routed", async () => {
    const attempt = vi.fn(async () => errorResponse(400, "ocgo_invalid_model"));
    const result = await runFallbackChain({ graph, startNodeId: "n1", initialRoute: { resolvedModel: "opencode:glm-5.3" }, attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(400);
  });

  it("stops when no edge matches the next failure", async () => {
    const attempt = vi.fn(async () => errorResponse(429, "ocgo_rate_limited"));
    const result = await runFallbackChain({ graph, startNodeId: "n1", initialRoute: { resolvedModel: "opencode:glm-5.3" }, attempt });
    // n1 → n2 matches rate_limited; n2 → n3 only matches upstream_unavailable.
    expect(result.trail).toEqual(["n1", "n2"]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("stops at maxHops even when every edge keeps matching", async () => {
    const starGraph = FallbackGraphSchema.parse({
      nodes: [
        { id: "a", target: "opencode-go:a" },
        { id: "b", target: "opencode-go:b" },
        { id: "c", target: "opencode-go:c" },
      ],
      edges: [
        { from: "a", to: "b", on: ["*"], weight: 9 },
        { from: "b", to: "c", on: ["*"], weight: 9 },
      ],
      limits: { maxHops: 1, budgetMs: 240_000, perHopAttempts: 1 },
    });
    const attempt = vi.fn(async () => errorResponse(429, "ocgo_rate_limited"));
    const result = await runFallbackChain({ graph: starGraph, startNodeId: "a", initialRoute: { resolvedModel: "opencode-go:a" }, attempt });
    expect(result.trail).toEqual(["a", "b"]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("never retries after a successful stream", async () => {
    const stream = new Response("event: response.completed\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    const attempt = vi.fn(async () => stream);
    const result = await runFallbackChain({ graph, startNodeId: "n1", initialRoute: { resolvedModel: "opencode:glm-5.3" }, attempt });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(stream);
  });

  it("exposes the tier of a model reference", () => {
    expect(tierOf("opencode-go:kimi-k3")).toBe("go");
    expect(tierOf("opencode:glm-5.3")).toBeUndefined();
    expect(tierOf("nonsense")).toBeUndefined();
  });
});
