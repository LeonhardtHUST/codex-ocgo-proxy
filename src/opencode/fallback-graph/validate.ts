/**
 * Fallback graph validation.
 *
 * Pure functions: the editor and the admin API both call this before saving, so a
 * broken graph can never reach the request path. Errors carry a JSON path so the
 * canvas can highlight the offending node or edge.
 */

import type { FallbackGraph } from "./model.js";

export interface GraphValidationError {
  /** Dotted path into the graph document, e.g. "edges[2].to". */
  path: string;
  message: string;
}

export interface GraphValidationResult {
  ok: boolean;
  errors: GraphValidationError[];
}

/** Depth-first cycle detection over enabled edges. */
function findCycle(graph: FallbackGraph): string[] | undefined {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const walk = (node: string): string[] | undefined => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start === -1 ? 0 : start), node];
    }
    if (done.has(node)) return undefined;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return undefined;
  };

  for (const node of adjacency.keys()) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Validate structural integrity of a parsed graph. */
export function validateGraph(graph: FallbackGraph): GraphValidationResult {
  const errors: GraphValidationError[] = [];
  const ids = new Set<string>();

  graph.nodes.forEach((node, index) => {
    if (ids.has(node.id)) {
      errors.push({ path: `nodes[${index}].id`, message: `duplicate node id "${node.id}"` });
    }
    ids.add(node.id);
    if (node.target.trim().length === 0) {
      errors.push({ path: `nodes[${index}].target`, message: "target must not be empty" });
    }
  });

  graph.edges.forEach((edge, index) => {
    if (!ids.has(edge.from)) {
      errors.push({ path: `edges[${index}].from`, message: `edge starts at unknown node "${edge.from}"` });
    }
    if (!ids.has(edge.to)) {
      errors.push({ path: `edges[${index}].to`, message: `edge ends at unknown node "${edge.to}"` });
    }
    if (edge.from === edge.to) {
      errors.push({ path: `edges[${index}]`, message: "self edges are not allowed" });
    }
  });

  for (const [model, nodeId] of Object.entries(graph.entrypoints)) {
    if (!ids.has(nodeId)) {
      errors.push({ path: `entrypoints.${model}`, message: `entrypoints to unknown node "${nodeId}"` });
    }
  }

  const referenced = new Set<string>();
  for (const edge of graph.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  for (const nodeId of Object.values(graph.entrypoints)) referenced.add(nodeId);
  graph.nodes.forEach((node, index) => {
    if (!referenced.has(node.id) && graph.nodes.length > 1) {
      errors.push({ path: `nodes[${index}]`, message: `node "${node.id}" is not connected to any entrypoint or edge` });
    }
  });

  const cycle = findCycle(graph);
  if (cycle) {
    errors.push({ path: "edges", message: `fallback cycle detected: ${cycle.join(" → ")}` });
  }

  // Longest simple path must fit inside maxHops, otherwise the limit silently truncates
  // a chain the user believes is reachable.
  const longest = longestPath(graph);
  if (longest > graph.limits.maxHops) {
    errors.push({
      path: "limits.maxHops",
      message: `longest fallback path is ${longest} hops but limits.maxHops is ${graph.limits.maxHops}`,
    });
  }

  return { ok: errors.length === 0, errors };
}

/** Longest simple path length in edges (graph is acyclic at this point). */
export function longestPath(graph: FallbackGraph): number {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const memo = new Map<string, number>();
  const walk = (node: string, seen: Set<string>): number => {
    if (seen.has(node)) return 0;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    seen.add(node);
    let best = 0;
    for (const next of adjacency.get(node) ?? []) {
      best = Math.max(best, 1 + walk(next, seen));
    }
    seen.delete(node);
    memo.set(node, best);
    return best;
  };
  let best = 0;
  for (const node of graph.nodes) best = Math.max(best, walk(node.id, new Set()));
  return best;
}
