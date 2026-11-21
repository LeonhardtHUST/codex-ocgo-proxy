import { describe, expect, it } from "vitest";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import { ZenFreePool } from "@src/opencode/zen-free-pool.js";
import { createOpenCodeZenFreeRoutes } from "@src/routes/admin/opencode-zen-free.js";

function config(overrides: Record<string, unknown> = {}) {
  return OpenCodeConfigSchema.parse({
    enabled: true,
    upstreams: { zen_free: { enabled: true, pool_all_keys: true } },
    ...overrides,
  });
}

function app(pool: ZenFreePool | null, cfg = config()) {
  return createOpenCodeZenFreeRoutes({ pool, config: cfg, getMasterKey: () => "master-key" });
}

const auth = { Authorization: "Bearer master-key" };

describe("zen-free admin routes", () => {
  it("requires the master key or a dashboard session", async () => {
    const instance = app(new ZenFreePool({ readCredentials: () => [] }, { poolAllKeys: true }));
    expect((await instance.request("/admin/opencode/zen-free")).status).toBe(401);
  });

  it("reports the switch state and a null snapshot when the pool is off", async () => {
    const instance = app(null, config({ upstreams: { zen_free: { enabled: false, pool_all_keys: false } } }));
    const response = await instance.request("/admin/opencode/zen-free", { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, pool_all_keys: false, snapshot: null });
  });

  it("returns the pool snapshot when enabled", async () => {
    const pool = new ZenFreePool({
      readCredentials: () => [{ id: "k1", enabled: true, apiKey: "secret", models: ["big-pickle"], quotaGroup: null }],
    }, { poolAllKeys: true });
    const instance = app(pool);
    const response = await instance.request("/admin/opencode/zen-free", { headers: auth });
    const body = await response.json() as { enabled: boolean; snapshot: { keys: Array<{ id: string }> } };
    expect(body.enabled).toBe(true);
    expect(body.snapshot.keys).toHaveLength(1);
  });

  it("refuses to reset when the pool is disabled", async () => {
    const instance = app(null);
    const response = await instance.request("/admin/opencode/zen-free/reset", { method: "POST", headers: auth });
    expect(response.status).toBe(409);
  });

  it("resets the channel breaker by default and everything on request", async () => {
    const pool = new ZenFreePool({
      readCredentials: () => [{ id: "k1", enabled: true, apiKey: "secret", models: ["big-pickle"], quotaGroup: null }],
    }, { poolAllKeys: true, breakerThreshold: 1 });
    pool.recordFailure("k1", "free_limit", 1);
    expect(pool.snapshot().channel.open).toBe(true);

    const instance = app(pool);
    const breaker = await instance.request("/admin/opencode/zen-free/reset", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(breaker.status).toBe(200);
    expect(await breaker.json()).toMatchObject({ ok: true, scope: "breaker" });
    expect(pool.snapshot().channel.open).toBe(false);

    pool.recordFailure("k1", "rate_limited", 60);
    const all = await instance.request("/admin/opencode/zen-free/reset", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    });
    expect(await all.json()).toMatchObject({ ok: true, scope: "all" });
    expect(pool.snapshot().keys[0].cooldownSeconds).toBe(0);
  });

  it("rejects an unknown reset scope", async () => {
    const pool = new ZenFreePool({ readCredentials: () => [] }, { poolAllKeys: true });
    const instance = app(pool);
    const response = await instance.request("/admin/opencode/zen-free/reset", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "everything" }),
    });
    expect(response.status).toBe(400);
  });
});
