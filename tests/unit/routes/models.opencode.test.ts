import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ConfigSchema, resetConfigForTesting, setConfigForTesting } from "@src/config.js";
import { createModelRoutes } from "@src/routes/models.js";
import { OpenCodeCatalog } from "@src/opencode/catalog.js";
import {
  resetOpenCodeRuntimeForTesting,
  setOpenCodeRuntimeForTesting,
} from "@src/opencode/catalog-runtime.js";

const seedPath = resolve("config", "opencode-models.seed.json");

function makeCatalog(): OpenCodeCatalog {
  const catalog = new OpenCodeCatalog();
  catalog.loadSeed(seedPath);
  return catalog;
}

/** ConfigSchema has five required sections with no defaults; mirror the other route tests. */
function parseConfig(overrides: { opencode?: Record<string, unknown>; server?: Record<string, unknown> } = {}) {
  return ConfigSchema.parse({
    api: {},
    client: {},
    model: {},
    auth: {},
    session: {},
    server: { ...(overrides.server ?? {}) },
    ...(overrides.opencode ? { opencode: overrides.opencode } : {}),
  });
}

function appWith(overrides: Parameters<typeof parseConfig>[0] = {}) {
  setConfigForTesting(parseConfig(overrides));
  return createModelRoutes();
}

beforeEach(() => {
  resetConfigForTesting();
  resetOpenCodeRuntimeForTesting();
  setOpenCodeRuntimeForTesting({ catalog: makeCatalog() });
});

afterEach(() => {
  resetConfigForTesting();
  resetOpenCodeRuntimeForTesting();
});

describe("/v1/models with the OpenCode provider family", () => {
  it("advertises opencode models with metadata when enabled", async () => {
    const app = appWith({ opencode: { enabled: true } });
    const response = await app.request("/v1/models");
    expect(response.status).toBe(200);
    const body = await response.json() as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");

    const opencodeRows = body.data.filter((row) => String(row.owned_by).startsWith("opencode-"));
    expect(opencodeRows.length).toBeGreaterThan(50);
    const deepseek = opencodeRows.find((row) => String(row.id).endsWith("deepseek-v4.1-flash"));
    expect(deepseek).toBeDefined();
    expect(deepseek?.context_window).toBeGreaterThan(0);
    expect(deepseek?.context_length).toBe(deepseek?.context_window);
    expect(deepseek?.object).toBe("model");
  });

  it("lists the family even when a stale enabled:false is still in the config", async () => {
    const app = appWith({ opencode: { enabled: false } });
    const response = await app.request("/v1/models");
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.filter((row) => String(row.owned_by).startsWith("opencode-")).length).toBeGreaterThan(0);
  });

  it("serves the full capability matrix on /v1/opencode/catalog", async () => {
    const app = appWith({ opencode: { enabled: true } });
    const response = await app.request("/v1/opencode/catalog");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      enabled: boolean;
      status: { counts: Record<string, number>; source: string };
      data: Array<Record<string, unknown>>;
    };
    expect(body.enabled).toBe(true);
    expect(body.data.length).toBeGreaterThan(100);
    expect(body.status.counts.zen).toBeGreaterThanOrEqual(100);
    expect(body.status.counts.go).toBeGreaterThanOrEqual(30);
    expect(body.status.source).toBe("seed");

    const rows = body.data.filter((row) => row.model === "minimax-m3");
    const zen = rows.find((row) => row.upstream === "zen");
    const go = rows.find((row) => row.upstream === "go");
    expect(zen?.native_protocol).toBe("chat-completions");
    expect(go?.native_protocol).toBe("messages");
  });

  it("ignores a leftover enabled:false in the config (deprecated switch)", async () => {
    // The switch used to gate the whole family; it is now retired, so a stale
    // `opencode.enabled: false` in someone's data/local.yaml must not hide the catalog.
    const app = appWith({ opencode: { enabled: false } });
    const response = await app.request("/v1/opencode/catalog");
    expect(response.status).toBe(200);
    const body = await response.json() as { object: string; enabled: boolean; data: unknown[] };
    expect(body.object).toBe("list");
    expect(body.enabled).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("reports status behind the admin key", async () => {
    const app = appWith({ opencode: { enabled: true, cache_header_aggregation: false }, server: { proxy_api_key: "master-key" } });

    const denied = await app.request("/admin/opencode/status");
    expect(denied.status).toBe(401);

    const ok = await app.request("/admin/opencode/status", { headers: { Authorization: "Bearer master-key" } });
    expect(ok.status).toBe(200);
    const body = await ok.json() as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.cache_header_aggregation).toBe(false);
    expect(body.source).toBe("seed");
    expect(body.protocolCorrections).toBe(0);
    expect((body.counts as Record<string, number>).zen).toBeGreaterThanOrEqual(100);
  });
});
