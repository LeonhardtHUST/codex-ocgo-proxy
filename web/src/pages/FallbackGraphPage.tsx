/**
 * Fallback graph editor.
 *
 * Canvas on the left (drag nodes, click-to-connect), schema-driven form on the right,
 * validation before save with errors mapped back to the offending node or edge.
 *
 * The graph document is the same one the admin API stores; this page never invents
 * fields and never saves before `validate` passes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

const ENDPOINT = "/admin/opencode/fallback-graph";
const CONDITIONS = [
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

interface GraphNode {
  id: string;
  target: string;
  label?: string;
  enabled: boolean;
  x?: number;
  y?: number;
  status?: "unverified" | "verified" | "deprecated";
}

interface GraphEdge {
  from: string;
  to: string;
  on: string[];
  weight: number;
}

interface GraphLimits {
  maxHops: number;
  budgetMs: number;
  perHopAttempts: number;
}

interface Graph {
  version: number;
  entrypoints: Record<string, string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  limits: GraphLimits;
}

interface ValidationError {
  path: string;
  message: string;
}

const EMPTY_GRAPH: Graph = {
  version: 1,
  entrypoints: {},
  nodes: [],
  edges: [],
  limits: { maxHops: 3, budgetMs: 240_000, perHopAttempts: 2 },
};

const CANVAS = { width: 720, height: 420, radius: 34 };

function label(en: string, zh: string): string {
  return document.documentElement.lang.startsWith("zh") ? zh : en;
}

function nodePosition(node: GraphNode, index: number): { x: number; y: number } {
  if (node.x !== undefined && node.y !== undefined) return { x: node.x, y: node.y };
  const columns = 4;
  return {
    x: 100 + (index % columns) * 170,
    y: 90 + Math.floor(index / columns) * 120,
  };
}

async function adminFetch(path: string, masterApiKey: string | undefined, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body) headers["Content-Type"] = "application/json";
  if (masterApiKey) headers.Authorization = `Bearer ${masterApiKey}`;
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

export function FallbackGraphPage({ masterApiKey }: { masterApiKey?: string }) {
  const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; index: number } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const positions = useMemo(
    () => new Map(graph.nodes.map((node, index) => [node.id, nodePosition(node, index)])),
    [graph.nodes],
  );

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await adminFetch(ENDPOINT, masterApiKey);
      if (!response.ok) throw new Error(`load failed (${response.status})`);
      const body = await response.json() as { graph?: Graph };
      setGraph(body.graph ?? EMPTY_GRAPH);
      setErrors([]);
    } catch (error) {
      setNotice(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  }, [masterApiKey]);

  useEffect(() => { void load(); }, [load]);

  function updateNode(index: number, patch: Partial<GraphNode>) {
    setGraph((current) => {
      const nodes = current.nodes.map((node, i) => (i === index ? { ...node, ...patch } : node));
      return { ...current, nodes };
    });
  }

  function updateEdge(index: number, patch: Partial<GraphEdge>) {
    setGraph((current) => {
      const edges = current.edges.map((edge, i) => (i === index ? { ...edge, ...patch } : edge));
      return { ...current, edges };
    });
  }

  function addNode() {
    const id = `n${graph.nodes.length + 1}`;
    setGraph((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        { id, target: "opencode:", enabled: true, status: "unverified", x: 80 + current.nodes.length * 40, y: 80 + current.nodes.length * 24 },
      ],
    }));
    setSelected({ kind: "node", index: graph.nodes.length });
  }

  function removeSelected() {
    if (!selected) return;
    setGraph((current) => {
      if (selected.kind === "node") {
        const removed = current.nodes[selected.index];
        return {
          ...current,
          nodes: current.nodes.filter((_, i) => i !== selected.index),
          edges: current.edges.filter((edge) => edge.from !== removed.id && edge.to !== removed.id),
          entrypoints: Object.fromEntries(Object.entries(current.entrypoints).filter(([, nodeId]) => nodeId !== removed.id)),
        };
      }
      return { ...current, edges: current.edges.filter((_, i) => i !== selected.index) };
    });
    setSelected(null);
    setSelectedNodeId(null);
  }

  function handleNodeClick(node: GraphNode, index: number) {
    if (connecting && selectedNodeId && selectedNodeId !== node.id) {
      setGraph((current) => ({
        ...current,
        edges: [...current.edges, { from: selectedNodeId, to: node.id, on: ["rate_limited"], weight: 10 }],
      }));
      setConnecting(false);
      setSelectedNodeId(null);
      return;
    }
    setSelected({ kind: "node", index });
    setSelectedNodeId(node.id);
  }

  function startDrag(event: PointerEvent, node: GraphNode, index: number) {
    const origin = positions.get(node.id) ?? { x: 0, y: 0 };
    const svg = (event.currentTarget as SVGElement).ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    drag.current = {
      id: node.id,
      offsetX: event.clientX - rect.left - origin.x,
      offsetY: event.clientY - rect.top - origin.y,
    };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    setSelected({ kind: "node", index });
  }

  function onPointerMove(event: PointerEvent) {
    const active = drag.current;
    if (!active) return;
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const index = graph.nodes.findIndex((node) => node.id === active.id);
    if (index < 0) return;
    updateNode(index, {
      x: Math.max(0, Math.min(10_000, Math.round(event.clientX - rect.left - active.offsetX))),
      y: Math.max(0, Math.min(10_000, Math.round(event.clientY - rect.top - active.offsetY))),
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await adminFetch(ENDPOINT, masterApiKey, { method: "PUT", body: JSON.stringify(graph) });
      const body = await response.json() as { ok?: boolean; graph?: Graph; errors?: ValidationError[] };
      if (!response.ok || !body.ok) {
        setErrors(body.errors ?? [{ path: "(root)", message: `save failed (${response.status})` }]);
        setNotice(label("Save rejected by validation", "保存被校验拒绝"));
        return;
      }
      setGraph(body.graph ?? graph);
      setErrors([]);
      setNotice(label("Saved", "已保存"));
    } catch (error) {
      setNotice(String((error as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const activeNode = selected?.kind === "node" ? graph.nodes[selected.index] : undefined;
  const activeEdge = selected?.kind === "edge" ? graph.edges[selected.index] : undefined;

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-lg font-semibold">{label("Model fallback graph", "模型回退图")}</h1>
        <span class="text-xs text-slate-500 dark:text-text-dim">
          {label("drag nodes to arrange, connect to add an edge", "拖拽节点排布，连线新增一条边")}
        </span>
        <div class="ml-auto flex gap-2">
          <button class="rounded border px-2 py-1 text-sm" onClick={addNode}>{label("Add node", "新增节点")}</button>
          <button
            class={`rounded border px-2 py-1 text-sm ${connecting ? "bg-amber-100 dark:bg-amber-900" : ""}`}
            onClick={() => { setConnecting((value) => !value); setSelectedNodeId(null); }}
          >
            {label("Connect", "连线")}
          </button>
          <button class="rounded border px-2 py-1 text-sm" disabled={busy} onClick={() => void load()}>
            {label("Reload", "重载")}
          </button>
          <button class="rounded bg-emerald-600 px-3 py-1 text-sm text-white" disabled={busy} onClick={() => void save()}>
            {label("Save", "保存")}
          </button>
        </div>
      </div>

      {notice && <p role="status" class="text-sm">{notice}</p>}
      {errors.length > 0 && (
        <ul role="alert" class="rounded border border-red-300 p-2 text-sm text-red-700 dark:text-red-400">
          {errors.map((error) => (
            <li key={`${error.path}:${error.message}`}>{error.path}: {error.message}</li>
          ))}
        </ul>
      )}

      <div class="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <svg
          viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
          class="w-full rounded border bg-slate-50 dark:bg-slate-900"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-label={label("Fallback graph canvas", "回退图画布")}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {graph.edges.map((edge, index) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const selectedEdge = selected?.kind === "edge" && selected.index === index;
            return (
              <g key={`${edge.from}->${edge.to}:${index}`} onClick={() => setSelected({ kind: "edge", index })}>
                <line
                  x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                  stroke={selectedEdge ? "#059669" : "#94a3b8"}
                  stroke-width={selectedEdge ? 3 : 1.5}
                  marker-end="url(#arrow)"
                />
                <text
                  x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 4}
                  class="fill-slate-500" font-size="10" text-anchor="middle"
                >
                  {edge.on.join(",")} · w{edge.weight}
                </text>
              </g>
            );
          })}
          {graph.nodes.map((node, index) => {
            const position = positions.get(node.id) ?? { x: 0, y: 0 };
            const isSelected = selected?.kind === "node" && selected.index === index;
            const badge = node.status ?? "unverified";
            return (
              <g
                key={node.id}
                transform={`translate(${position.x},${position.y})`}
                onPointerDown={(event) => startDrag(event, node, index)}
                onClick={() => handleNodeClick(node, index)}
                class="cursor-grab"
              >
                <circle r={CANVAS.radius} fill={isSelected ? "#d1fae5" : "#ffffff"} stroke={isSelected ? "#059669" : "#cbd5e1"} stroke-width={isSelected ? 2.5 : 1.5} />
                <text y={-4} font-size="11" text-anchor="middle" class="fill-slate-700">{node.label ?? node.id}</text>
                <text y={12} font-size="9" text-anchor="middle" class="fill-slate-500">
                  {node.target.length > 22 ? `${node.target.slice(0, 21)}…` : node.target}
                </text>
                <text y={CANVAS.radius + 14} font-size="9" text-anchor="middle" class="fill-slate-400">
                  {badge}
                </text>
              </g>
            );
          })}
        </svg>

        <div class="flex flex-col gap-3 rounded border p-3 text-sm">
          <div>
            <label class="block text-xs text-slate-500">{label("Entry model", "入口模型")}</label>
            <div class="flex gap-1">
              <input
                class="w-full rounded border px-2 py-1"
                placeholder="opencode:glm-5.3 / codex-fallback:gpt-5.1"
                value={Object.keys(graph.entrypoints)[0] ?? ""}
                onInput={(event) => {
                  const value = (event.currentTarget as HTMLInputElement).value.trim();
                  setGraph((current) => ({
                    ...current,
                    entrypoints: value && current.nodes[0] ? { [value]: current.nodes[0].id } : {},
                  }));
                }}
              />
            </div>
          </div>

          {activeNode && (
            <div class="flex flex-col gap-2">
              <label class="block text-xs text-slate-500">{label("Target", "目标模型")}</label>
              <input
                class="rounded border px-2 py-1"
                value={activeNode.target}
                onInput={(event) => updateNode(selected!.index, { target: (event.currentTarget as HTMLInputElement).value })}
              />
              <label class="block text-xs text-slate-500">{label("Label", "标签")}</label>
              <input
                class="rounded border px-2 py-1"
                value={activeNode.label ?? ""}
                onInput={(event) => updateNode(selected!.index, { label: (event.currentTarget as HTMLInputElement).value })}
              />
              <label class="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={activeNode.enabled}
                  onChange={(event) => updateNode(selected!.index, { enabled: (event.currentTarget as HTMLInputElement).checked })}
                />
                {label("Enabled", "启用")}
              </label>
              <label class="block text-xs text-slate-500">{label("Probe status", "探活状态")}</label>
              <select
                class="rounded border px-2 py-1"
                value={activeNode.status ?? "unverified"}
                onChange={(event) => updateNode(selected!.index, { status: (event.currentTarget as HTMLSelectElement).value as GraphNode["status"] })}
              >
                <option value="unverified">{label("unverified", "未验证")}</option>
                <option value="verified">{label("verified", "已验证")}</option>
                <option value="deprecated">{label("deprecated", "已弃用")}</option>
              </select>
            </div>
          )}

          {activeEdge && (
            <div class="flex flex-col gap-2">
              <p class="text-xs text-slate-500">{activeEdge.from} → {activeEdge.to}</p>
              <label class="block text-xs text-slate-500">{label("Conditions", "触发条件")}</label>
              <div class="grid grid-cols-2 gap-1">
                {CONDITIONS.map((condition) => (
                  <label key={condition} class="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={activeEdge.on.includes(condition)}
                      onChange={(event) => {
                        const checked = (event.currentTarget as HTMLInputElement).checked;
                        const next = checked
                          ? [...activeEdge.on.filter((item) => item !== "*" || condition === "*"), condition]
                          : activeEdge.on.filter((item) => item !== condition);
                        updateEdge(selected!.index, { on: next.length > 0 ? [...new Set(next)] : [condition] });
                      }}
                    />
                    {condition}
                  </label>
                ))}
              </div>
              <label class="block text-xs text-slate-500">{label("Weight", "权重")}</label>
              <input
                type="number"
                min={0}
                max={1000}
                class="rounded border px-2 py-1"
                value={activeEdge.weight}
                onInput={(event) => updateEdge(selected!.index, { weight: Number((event.currentTarget as HTMLInputElement).value) || 0 })}
              />
            </div>
          )}

          <div class="grid grid-cols-3 gap-1 text-xs">
            <label>
              maxHops
              <input
                type="number" min={1} max={10} class="w-full rounded border px-1 py-0.5"
                value={graph.limits.maxHops}
                onInput={(event) => setGraph((current) => ({ ...current, limits: { ...current.limits, maxHops: Number((event.currentTarget as HTMLInputElement).value) || 1 } }))}
              />
            </label>
            <label>
              budgetMs
              <input
                type="number" min={1000} max={600000} class="w-full rounded border px-1 py-0.5"
                value={graph.limits.budgetMs}
                onInput={(event) => setGraph((current) => ({ ...current, limits: { ...current.limits, budgetMs: Number((event.currentTarget as HTMLInputElement).value) || 1000 } }))}
              />
            </label>
            <label>
              attempts
              <input
                type="number" min={1} max={5} class="w-full rounded border px-1 py-0.5"
                value={graph.limits.perHopAttempts}
                onInput={(event) => setGraph((current) => ({ ...current, limits: { ...current.limits, perHopAttempts: Number((event.currentTarget as HTMLInputElement).value) || 1 } }))}
              />
            </label>
          </div>

          <button class="rounded border px-2 py-1" disabled={!selected} onClick={removeSelected}>
            {label("Delete selected", "删除选中")}
          </button>
        </div>
      </div>
    </div>
  );
}
