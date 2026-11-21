/** @vitest-environment jsdom */
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FallbackGraphPage } from "./FallbackGraphPage";

const graph = {
  version: 1,
  entrypoints: { "opencode:glm-5.3": "n1" },
  nodes: [
    { id: "n1", target: "opencode:glm-5.3", enabled: true, status: "unverified", x: 100, y: 100 },
    { id: "n2", target: "opencode-go:kimi-k3", enabled: true, x: 300, y: 100 },
  ],
  edges: [{ from: "n1", to: "n2", on: ["rate_limited"], weight: 10 }],
  limits: { maxHops: 3, budgetMs: 240_000, perHopAttempts: 2 },
};

let root: HTMLElement;
const calls: Array<{ url: string; method: string; auth: string | null }> = [];

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  document.documentElement.lang = "en";
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      auth: new Headers(init.headers as HeadersInit | undefined).get("Authorization"),
    });
    if (init.method === "PUT") {
      return new Response(JSON.stringify({ ok: true, graph }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ graph, status: { nodes: 2, edges: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

function button(text: string) {
  return [...root.querySelectorAll("button")].find((item) => item.textContent === text);
}

async function waitFor(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

it("loads the graph with the master key and renders nodes and edges", async () => {
  await act(async () => { render(<FallbackGraphPage masterApiKey="master-key" />, root); });
  await waitFor(() => root.textContent?.includes("opencode:glm-5.3") ?? false);

  expect(calls[0]).toMatchObject({ url: "/admin/opencode/fallback-graph", method: "GET", auth: "Bearer master-key" });
  const circles = root.querySelectorAll("svg circle");
  expect(circles.length).toBe(2);
  expect(root.querySelectorAll("svg line").length).toBe(1);
  expect(root.textContent).toContain("rate_limited");
});

it("adds a node on the canvas", async () => {
  await act(async () => { render(<FallbackGraphPage masterApiKey="master-key" />, root); });
  await waitFor(() => root.textContent?.includes("opencode:glm-5.3") ?? false);

  await act(async () => { button("Add node")!.click(); });
  expect(root.querySelectorAll("svg circle").length).toBe(3);
});

it("saves through PUT and reports success", async () => {
  await act(async () => { render(<FallbackGraphPage masterApiKey="master-key" />, root); });
  await waitFor(() => root.textContent?.includes("opencode:glm-5.3") ?? false);

  await act(async () => { button("Save")!.click(); });
  await waitFor(() => root.textContent?.includes("Saved") ?? false);

  const put = calls.find((call) => call.method === "PUT");
  expect(put?.auth).toBe("Bearer master-key");
});

it("surfaces validation errors by path when the server rejects the save", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === "PUT") {
      return new Response(JSON.stringify({ ok: false, errors: [{ path: "edges[0].to", message: "unknown node" }] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ graph }), { status: 200, headers: { "content-type": "application/json" } });
  }));

  await act(async () => { render(<FallbackGraphPage masterApiKey="master-key" />, root); });
  await waitFor(() => root.textContent?.includes("opencode:glm-5.3") ?? false);

  await act(async () => { button("Save")!.click(); });
  await waitFor(() => root.textContent?.includes("edges[0].to") ?? false);
  expect(root.textContent).toContain("Save rejected by validation");
});
