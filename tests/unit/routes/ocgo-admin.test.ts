import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, _resetForTest } from "@src/auth/dashboard-session.js";
import { OCGoKeyStore } from "@src/auth/ocgo-key-store.js";
import { OCGoPool } from "@src/auth/ocgo-pool.js";
import { createOCGoAdminRoutes } from "@src/routes/admin/ocgo.js";

vi.mock("@src/config.js", () => ({ getConfig: () => ({ session: { ttl_minutes: 5 } }) }));

const path = "/admin/ocgo/keys";
const input = { name: "Go test", apiKey: "fake-ocgo-primary-key", models: ["mock-model"], quotaGroup: "confirmed-owner" };
const master = { Authorization: "Bearer fake-app-master" };

describe("OCGo administrator endpoints", () => {
  let dir: string;
  let server: Server | undefined;
  let app: ReturnType<typeof createOCGoAdminRoutes>;
  let store: OCGoKeyStore;
  let config: { enabled: boolean; base_url: string; timeout_seconds: number };

  function mount() {
    store = new OCGoKeyStore(join(dir, "ocgo-keys.json"));
    app = createOCGoAdminRoutes({ config, store, pool: new OCGoPool(store), getMasterKey: () => "fake-app-master" });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ocgo-admin-test-"));
    config = { enabled: false, base_url: "http://127.0.0.1:8787/v1", timeout_seconds: 2 };
    mount();
  });
  afterEach(async () => {
    if (server) {
      const active = server;
      server = undefined;
      await new Promise<void>((resolve) => { active.close(() => resolve()); active.closeAllConnections(); });
    }
    _resetForTest();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const request = (method: string, suffix = "", body?: unknown, headers: Record<string, string> = master) =>
    app.request(`${path}${suffix}`, {
      method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function add(data = input) {
    const response = await request("POST", "", data);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["id"]);
    return body.id as string;
  }

  it("requires a master or dashboard session, including on local and nested routes", async () => {
    for (const headers of [{}, { Authorization: "Bearer fake-client" }, { Authorization: "fake-app-master" }]) {
      expect((await request("GET", "", undefined, headers)).status).toBe(401);
      expect((await request("POST", "", input, headers)).status).toBe(401);
      expect((await request("POST", "/id/verify", { model: "mock-model" }, headers)).status).toBe(401);
      expect((await request("PATCH", "/id", { enabled: false }, headers)).status).toBe(401);
      expect((await request("DELETE", "/id", undefined, headers)).status).toBe(401);
    }
    expect((await request("GET", "?key=fake-app-master", undefined, {})).status).toBe(401);
    const cookie = { Cookie: `_codex_session=${createSession().id}` };
    expect((await request("GET", "", undefined, cookie)).status).toBe(200);
    expect((await request("POST", "", input, { ...cookie, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await request("POST", "", input, { ...cookie, "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
  });

  it("reopens a saved store, masks list and writes, and forgets unreconfirmed quota ownership on replacement", async () => {
    const id = await add();
    expect((await request("POST", "", input)).status).toBe(409);
    expect((await request("PATCH", `/${id}`, { name: "Renamed", enabled: false })).status).toBe(200);
    mount(); // New store and pool, equivalent to reinitializing these components on restart.
    const list = await request("GET");
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    const text = await list.text();
    expect(text).not.toContain(input.apiKey);
    expect(JSON.parse(text)).toMatchObject({ enabled: false, officialQuota: null, credentials: [{ id, name: "Renamed", enabled: false, quotaGroup: "confirmed-owner" }] });
    const updated = await request("PATCH", `/${id}`, { apiKey: "fake-new-ocgo-secret", enabled: true });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ id });
    expect(store.readCredentials()).toMatchObject([{ id, apiKey: "fake-new-ocgo-secret", enabled: true, quotaGroup: null }]);
    expect((await request("DELETE", `/${id}`)).status).toBe(204);
    mount();
    expect(await (await request("GET")).json()).toMatchObject({ credentials: [] });
  });

  it("bounds and sanitizes invalid write requests", async () => {
    const invalid = await request("POST", "", { ...input, id: input.apiKey });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(input.apiKey);
    expect((await request("POST", "", { ...input, name: "x".repeat(34_000) })).status).toBe(413);
    expect(store.readCredentials()).toEqual([]);
  });

  it("verifies only the selected stored Key through one real loopback request", async () => {
    const first = await add();
    const second = await add({ ...input, apiKey: "fake-ocgo-other-key" });
    expect((await request("POST", `/${second}/verify`, { model: "mock-model" })).status).toBe(503);
    const seen: string[] = [];
    let deny = false;
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push(req.headers.authorization ?? "");
        if (deny) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "invalid_api_key", message: input.apiKey } }));
        } else {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    config.base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    config.enabled = true;
    expect((await request("POST", `/${second}/verify`, { model: "unassigned" })).status).toBe(400);
    const ok = await request("POST", `/${second}/verify`, { model: "mock-model" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    deny = true;
    const failure = await request("POST", `/${first}/verify`, { model: "mock-model" });
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain(input.apiKey);
    expect(seen).toEqual(["Bearer fake-ocgo-other-key", `Bearer ${input.apiKey}`]);
    const list = await (await request("GET")).json();
    expect(list).toMatchObject({ clientRequests: { started: 0 }, credentials: [
      { id: first, invalid: true, busy: false, upstreamAttempts: { started: 1, failed: 1 } },
      { id: second, busy: false, upstreamAttempts: { started: 1, succeeded: 1 } },
    ] });
  });
});
