/**
 * Fallback graph traversal.
 *
 * Pure decision logic: given the current node and the failure the request just hit,
 * decide the next node. All I/O and the "was the response already committed?" question
 * stay with the caller — a committed response must never traverse.
 */

import type { OpenCodeFailure } from "../errors.js";
import {
  type FallbackEdge,
  type FallbackGraph,
  type FallbackNode,
  edgeMatches,
  findNode,
  outgoingEdges,
  resolveEntryNode,
} from "./model.js";

export interface FallbackTraversalState {
  /** Node ids already tried in this request. */
  visited: Set<string>;
  hops: number;
  startedAt: number;
}

export interface FallbackHop {
  node: FallbackNode;
  edge: FallbackEdge;
}

export function createTraversalState(now: number = Date.now()): FallbackTraversalState {
  return { visited: new Set<string>(), hops: 0, startedAt: now };
}

/** Record that a node was attempted, so a later failure can move past it. */
export function markVisited(state: FallbackTraversalState, nodeId: string): void {
  state.visited.add(nodeId);
}

/** Entry node for the requested model, when the graph has one. */
export function entryNodeFor(graph: FallbackGraph, requestedModel: string): FallbackNode | undefined {
  return resolveEntryNode(graph, requestedModel);
}

/**
 * Next node to try after `fromNodeId` failed with `failure`.
 * Returns undefined when the failure is not routed out of this node, the graph limits
 * are exhausted, or every candidate was already tried.
 */
export function chooseNextNode(
  graph: FallbackGraph,
  fromNodeId: string,
  failure: OpenCodeFailure | string,
  state: FallbackTraversalState,
  now: number = Date.now(),
): FallbackHop | undefined {
  if (state.hops >= graph.limits.maxHops) return undefined;
  if (now - state.startedAt > graph.limits.budgetMs) return undefined;

  for (const edge of outgoingEdges(graph, fromNodeId)) {
    if (!edgeMatches(edge, failure)) continue;
    if (state.visited.has(edge.to)) continue;
    const node = findNode(graph, edge.to);
    if (!node || !node.enabled) continue;
    return { node, edge };
  }
  return undefined;
}

/**
 * Walk from the entry node until a node accepts this failure, returning the full
 * remaining path in order. Used by the admin "simulate" surface and by tests.
 * The runtime uses `chooseNextNode` one hop at a time so it can stop on success.
 */
export function planPath(
  graph: FallbackGraph,
  requestedModel: string,
  failure: OpenCodeFailure | string,
  now: number = Date.now(),
): FallbackNode[] {
  const entry = entryNodeFor(graph, requestedModel);
  if (!entry) return [];
  const state = createTraversalState(now);
  markVisited(state, entry.id);
  const path: FallbackNode[] = [entry];
  let current = entry;
  while (true) {
    const hop = chooseNextNode(graph, current.id, failure, state, now);
    if (!hop) break;
    markVisited(state, hop.node.id);
    state.hops += 1;
    path.push(hop.node);
    current = hop.node;
  }
  return path;
}
