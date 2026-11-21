/**
 * Provider exposure on the model surface.
 *
 * Two gaps this locks down:
 *   - `/admin/opencode/status` used to report `providers: []` even though the registry knew
 *     about every provider, so the dashboard could not show codex-official or codex-fallback;
 *   - `codex-fallback:<model>` was routable but invisible in `/v1/models`, so a client had to
 *     know the prefix by heart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelRoutes } from "@src/routes/models.js";
import { applyBackendModelsForPlan, loadStaticModels, resetModelStoreForTesting } from "@src/models/model-store.js";
import type { ProviderDescriptor } from "@src/opencode/providers.js";

const mockConfig = {
  model: { default: "gpt-6.1-sol", aliases: {}, custom_models: [] },
  server: { proxy_api_key: null as string | null },
  opencode: {
    enabled: false,
    legacy_ocgo_prefix: true,
    cache_header_aggregation: true,
    rust_routing: { enabled: false, port: 4099, legacy_sidecar: false },
  },
};

vi.mock("@src/config.js", () => ({ getConfig: vi.fn(() => mockConfig) }));

// The status envelope's catalog fields are covered by the opencode tests; here only the
// provider inventory matters, and the real catalog needs a full opencode config section.
vi.mock("@src/opencode/catalog-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/opencode/catalog-runtime.js")>();
  return {
    ...actual,
    openCodeRuntimeStatus: (providers: unknown[] = []) => ({
      providers,
      protocolCorrections: 0,
      refreshRunning: false,
      source: "seed",
      models: 0,
      lastRefreshAt: null,
      lastError: null,
    }),
  };
});

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-models-providers-config"),
  getDataDir: vi.fn(() => "/tmp/test-models-providers-data"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []\naliases: {}\n"),
    existsSync: vi.fn(() => false),
    writeFile: vi.fn((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null)),
    mkdirSync: vi.fn(),
  };
});

const BACKEND_MODELS = [
  {
    slug: "gpt-6.1-sol",
    display_name: "GPT-6.1-Sol",
    description: "workhorse",
    default_reasoning_level: "low",
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
    input_modalities: ["text"],
    context_window: 272_000,
    visibility: "list",
    priority: 1,
    supported_in_api: true,
    shell_type: "unified_exec",
  },
];

const providers: ProviderDescriptor[] = [
  {
    id: "codex-official",
    kind: "codex",
    enabled: true,
    priority: 10,
    endpoints: { responses: "/v1/responses" },
    capabilities: { responses: true, chatCompletions: false, messages: false, streaming: true, tools: true, reasoningEfforts: [] },
    modelSource: "catalog",
    label: "Codex (official)",
  },
  {
    id: "codex-fallback",
    kind: "provider",
    enabled: true,
    priority: 20,
    endpoints: { responses: "/v1/responses" },
    capabilities: { responses: true, chatCompletions: false, messages: false, streaming: true, tools: true, reasoningEfforts: [] },
    modelSource: "static",
    label: "Codex fallback upstream",
  },
] as unknown as ProviderDescriptor[];

const AUTH = { Authorization: "Bearer test-key" };

function app(options: { listProviders?: () => ProviderDescriptor[]; fallbackUpstream?: { get: () => { baseUrl: string; apiKey: string } | null } } = {}) {
  return createModelRoutes(undefined, undefined, options);
}

beforeEach(() => {
  resetModelStoreForTesting();
  loadStaticModels();
  applyBackendModelsForPlan("plus", BACKEND_MODELS as never);
  mockConfig.server.proxy_api_key = "test-key";
});

describe("provider inventory", () => {
  it("reports every provider with its priority", async () => {
    const response = await app({ listProviders: () => providers }).request("/admin/opencode/status", { headers: AUTH });
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: Array<{ id: string; priority: number; enabled: boolean; label?: string }> };
    expect(body.providers).toHaveLength(2);
    expect(body.providers.map((p) => p.id)).toEqual(["codex-official", "codex-fallback"]);
    expect(body.providers[1].priority).toBe(20);
    expect(body.providers[0].label).toBe("Codex (official)");
  });

  it("stays empty when no registry is wired (no invented rows)", async () => {
    const response = await app().request("/admin/opencode/status", { headers: AUTH });
    const body = await response.json() as { providers: unknown[] };
    expect(body.providers).toEqual([]);
  });
});

describe("codex-fallback model rows", () => {
  it("is hidden until a fallback upstream is configured", async () => {
    const response = await app({ fallbackUpstream: { get: () => null } }).request("/v1/models", { headers: AUTH });
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.some((model) => model.id.startsWith("codex-fallback:"))).toBe(false);
  });

  it("mirrors the codex catalog under its own namespace once configured", async () => {
    const store = { get: () => ({ baseUrl: "https://fallback.test/v1", apiKey: "k" }) };
    const response = await app({ fallbackUpstream: store }).request("/v1/models", { headers: AUTH });
    const body = await response.json() as { data: Array<{ id: string; owned_by: string }> };

    const fallbackRows = body.data.filter((model) => model.id.startsWith("codex-fallback:"));
    expect(fallbackRows.length).toBeGreaterThan(0);
    expect(fallbackRows.every((model) => model.owned_by === "codex-fallback")).toBe(true);
    // The bare id must remain listable as the normal (non-fallback) route.
    expect(body.data.some((model) => model.id === "gpt-6.1-sol")).toBe(true);
    expect(fallbackRows.map((model) => model.id)).toContain("codex-fallback:gpt-6.1-sol");
  });
});
