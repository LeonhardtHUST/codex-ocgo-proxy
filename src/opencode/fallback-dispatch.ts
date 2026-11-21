/**
 * Fallback graph dispatch.
 *
 * Wraps the OpenCode request handler so a failed attempt can move to the next node of
 * the graph. Deliberately a wrapper instead of surgery inside the handler: the handler's
 * key-retry semantics are covered by their own tests and stay untouched.
 *
 * Safety rules:
 *   - only error responses are inspected; a streamed 200 is returned as-is and never retried;
 *   - traversal is bounded by maxHops and budgetMs from the graph itself;
 *   - a node that produced a response is marked visited so the chain cannot loop.
 */

import type { Context } from "hono";
import { handleOCGoResponses, type OCGoResponsesOptions } from "../routes/ocgo-responses.js";
import { parseOpenCodeModelRef, type OpenCodeTier } from "./namespace.js";
import type { FallbackGraph, FallbackNode } from "./fallback-graph/model.js";
import type { FallbackGraphStore } from "./fallback-graph/store.js";
import { chooseNextNode, createTraversalState, entryNodeFor, markVisited } from "./fallback-graph/runtime.js";

export interface FallbackAwareOptions extends OCGoResponsesOptions {
  graphStore?: Pick<FallbackGraphStore, "read">;
}

export interface RouteLike {
  resolvedModel: string;
  modelId?: string;
  tier?: string;
}

/** Error codes emitted by the OpenCode handler mapped to graph failure classes. */
const CODE_TO_FAILURE: Record<string, string> = {
  ocgo_rate_limited: "rate_limited",
  ocgo_quota_exhausted: "quota_exhausted",
  ocgo_model_denied: "model_denied",
  ocgo_invalid_key: "invalid_key",
  ocgo_free_limit: "free_limit",
  ocgo_unreachable: "upstream_unavailable",
  ocgo_timeout: "timeout",
  ocgo_policy_rejected: "policy_rejected",
  ocgo_unsupported_request: "unsupported_capability",
  ocgo_bad_response: "upstream_unavailable",
  ocgo_request_failed: "upstream_unavailable",
};

/** Read the failure class out of an error response body, if it is routable. */
export function failureFromErrorBody(status: number, body: unknown): string | undefined {
  if (status < 400) return undefined;
  const root = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const error = root?.error && typeof root.error === "object" ? root.error as Record<string, unknown> : undefined;
  const code = typeof error?.code === "string" ? error.code : typeof root?.error === "string" ? root.error : undefined;
  if (code && CODE_TO_FAILURE[code]) return CODE_TO_FAILURE[code];
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 504) return "timeout";
  if (status >= 500) return "upstream_unavailable";
  return undefined;
}

/** Rewrite the request route to target one graph node. */
export function routeFromNode(node: FallbackNode, fallback: RouteLike): RouteLike {
  const ref = parseOpenCodeModelRef(node.target, { legacyOcgo: true });
  if (!ref) return fallback;
  return {
    resolvedModel: node.target,
    modelId: ref.modelId,
    ...(ref.tier ? { tier: ref.tier } : (fallback.tier ? { tier: fallback.tier } : {})),
  };
}

export interface FallbackChainOptions {
  graph: FallbackGraph;
  startNodeId: string;
  initialRoute: RouteLike;
  /** One attempt; returns the response the client would receive. */
  attempt: (route: RouteLike) => Promise<Response>;
  now?: () => number;
}

export interface FallbackChainResult {
  response: Response;
  hops: number;
  /** Node ids actually attempted, in order. */
  trail: string[];
}

/**
 * Run attempts along the graph until one succeeds or the graph runs out.
 * Kept free of Hono/Context so it can be unit-tested directly.
 */
export async function runFallbackChain(options: FallbackChainOptions): Promise<FallbackChainResult> {
  const now = options.now ?? (() => Date.now());
  const state = createTraversalState(now());
  let currentRoute = options.initialRoute;
  let currentNodeId = options.startNodeId;
  const trail: string[] = [];
  let response = await options.attempt(currentRoute);
  trail.push(currentNodeId);

  while (true) {
    if (response.status < 400) break;
    const body = await response.clone().json().catch(() => null);
    const failure = failureFromErrorBody(response.status, body);
    if (!failure) break;

    markVisited(state, currentNodeId);
    const hop = chooseNextNode(options.graph, currentNodeId, failure, state, now());
    if (!hop) break;

    state.hops += 1;
    currentNodeId = hop.node.id;
    currentRoute = routeFromNode(hop.node, options.initialRoute);
    response = await options.attempt(currentRoute);
    trail.push(currentNodeId);
  }

  return { response, hops: trail.length - 1, trail };
}

/**
 * Route handler entry point: falls back to the plain handler when no graph applies,
 * so behaviour is byte-identical for installations that never open the editor.
 */
export async function handleWithFallback(
  c: Context,
  body: Record<string, unknown>,
  route: RouteLike,
  options?: FallbackAwareOptions,
): Promise<Response> {
  const graph = options?.graphStore?.read();
  if (!graph || graph.nodes.length === 0) return handleOCGoResponses(c, body, route, options);

  const entry = entryNodeFor(graph, route.resolvedModel);
  if (!entry) return handleOCGoResponses(c, body, route, options);

  const initialRoute: RouteLike = {
    resolvedModel: route.resolvedModel,
    ...(route.modelId ? { modelId: route.modelId } : {}),
    ...(route.tier ? { tier: route.tier } : {}),
  };
  const startRoute = routeFromNode(entry, initialRoute);

  const result = await runFallbackChain({
    graph,
    startNodeId: entry.id,
    initialRoute: startRoute,
    attempt: (attemptRoute) => handleOCGoResponses(c, body, attemptRoute, options),
  });
  if (result.trail.length > 1) {
    c.header("x-opencode-fallback-trail", result.trail.join(">"));
  }
  return result.response;
}

/** Tier of an arbitrary model reference, for admin/diagnostics surfaces. */
export function tierOf(modelRef: string): OpenCodeTier | undefined {
  return parseOpenCodeModelRef(modelRef, { legacyOcgo: true })?.tier;
}
