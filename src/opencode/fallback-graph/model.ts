/**
 * Fallback graph — data model.
 *
 * A graph, not a chain: nodes name a concrete model target, edges carry the failure
 * classes that may cross them plus a weight that orders competing edges. That shape is
 * what makes the editor possible and what existing projects do not have (their
 * fallbacks are array order or one-level aliases).
 *
 * See docs/OPENCODEX_ROUTER_DESIGN.md §7.
 */

import { z } from "zod";
import type { OpenCodeFailure } from "../errors.js";

/** Failure classes an edge can match, plus the catch-all. */
export const FALLBACK_CONDITIONS = [
  "rate_limited",
  "quota_exhausted",
  "model_denied",
  "invalid_key",
  "auth_failed",
  "free_limit",
  "upstream_unavailable",
  "timeout",
  "policy_rejected",
  "unsupported_protocol",
  "unsupported_capability",
  "unknown",
  "*",
] as const;

export type FallbackCondition = (typeof FALLBACK_CONDITIONS)[number];

const CONDITION_SET = new Set<string>(FALLBACK_CONDITIONS);

export const FallbackConditionSchema = z.string().refine((value) => CONDITION_SET.has(value), {
  message: `condition must be one of ${FALLBACK_CONDITIONS.join(", ")}`,
});

export const FallbackNodeSchema = z.object({
  id: z.string().min(1).max(64),
  /** Model reference to run, e.g. "opencode:glm-5.3" or "codex-fallback:gpt-5.1". */
  target: z.string().min(1).max(200),
  label: z.string().max(80).optional(),
  enabled: z.boolean().default(true),
  /** Canvas position, persisted so the editor reopens the same layout. */
  x: z.number().min(0).max(10_000).optional(),
  y: z.number().min(0).max(10_000).optional(),
  /** Last probe verdict shown as a badge in the editor. */
  status: z.enum(["unverified", "verified", "deprecated"]).optional(),
}).strict();

export const FallbackEdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  /** Failures that may cross this edge. "*" matches everything. */
  on: z.array(FallbackConditionSchema).min(1).max(FALLBACK_CONDITIONS.length),
  /** Higher runs first; ties break deterministically by target id. */
  weight: z.number().int().min(0).max(1000).default(10),
}).strict();

export const FallbackLimitsSchema = z.object({
  maxHops: z.number().int().min(1).max(10).default(3),
  budgetMs: z.number().int().min(1_000).max(600_000).default(240_000),
  perHopAttempts: z.number().int().min(1).max(5).default(2),
}).strict().default({});

export const FallbackGraphSchema = z.object({
  version: z.literal(1).default(1),
  /** Requested model reference → starting node id. */
  entrypoints: z.record(z.string(), z.string()).default({}),
  nodes: z.array(FallbackNodeSchema).default([]),
  edges: z.array(FallbackEdgeSchema).default([]),
  limits: FallbackLimitsSchema,
}).strict();

export type FallbackNode = z.infer<typeof FallbackNodeSchema>;
export type FallbackEdge = z.infer<typeof FallbackEdgeSchema>;
export type FallbackLimits = z.infer<typeof FallbackLimitsSchema>;
export type FallbackGraph = z.infer<typeof FallbackGraphSchema>;

/** Empty graph used when no file exists yet. */
export function emptyFallbackGraph(): FallbackGraph {
  return FallbackGraphSchema.parse({});
}

/**
 * Deterministic edge order: weight descending, then target id ascending.
 * Tests and the runtime both depend on this, so it must not be randomised.
 */
export function sortEdges(edges: readonly FallbackEdge[]): FallbackEdge[] {
  return [...edges].sort((a, b) => b.weight - a.weight || a.to.localeCompare(b.to));
}

/** Edges leaving a node, ordered. */
export function outgoingEdges(graph: FallbackGraph, nodeId: string): FallbackEdge[] {
  return sortEdges(graph.edges.filter((edge) => edge.from === nodeId));
}

/** Whether an edge accepts this failure class. */
export function edgeMatches(edge: FallbackEdge, failure: OpenCodeFailure | string): boolean {
  return edge.on.includes("*") || edge.on.includes(failure);
}

/** Node lookup by id. */
export function findNode(graph: FallbackGraph, nodeId: string): FallbackNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

/** Entry node for a requested model reference, when configured. */
export function resolveEntryNode(graph: FallbackGraph, requestedModel: string): FallbackNode | undefined {
  const nodeId = graph.entrypoints[requestedModel];
  if (!nodeId) return undefined;
  const node = findNode(graph, nodeId);
  return node?.enabled ? node : undefined;
}
