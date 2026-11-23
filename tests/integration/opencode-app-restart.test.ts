import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { setPaths } from "@src/paths.js";
import type { ServerHandle } from "@src/index.js";

// Never probe system proxies, start update jobs or open the native Codex transport.
vi.mock("@src/tls/proxy.js", () => ({ initProxy: async () => {}, getProxyUrl: () => null }));
vi.mock("@src/tls/transport.js", () => {
  const denied = async () => { throw new Error("Native transport is disabled for the OpenCode fixture"); };
  const transport = { get: denied, post: denied, simplePost: denied, isImpersonate: () => false };
  return { initTransport: async () => transport, getTransport: () => transport, getTransportInfo: () => ({ type: "none", initialized: true, impersonate: false }) };
});
vi.mock("@src/update-checker.js", async (original) => ({
  ...await original<typeof import("@src/update-checker.js")>(), startUpdateChecker: () => {},
}));
vi.mock("@src/self-update.js", async (original) => ({
  ...await original<typeof import("@src/self-update.js")>(), startProxyUpdateChecker: () => {},
}));

it("restarts the actual App with saved OpenCode credentials and restores the legacy Custom route when disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocgo-app-restart-"));
  const dataDir = join(dir, "data");
  const realFetch = globalThis.fetch;
  const permitted = new Set<string>();
  const unexpected: string[] = [];
  let app: ServerHandle | undefined;
  const calls: { url?: string; auth?: string }[] = [];
  const fake = createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization });
      const reply = { type: "response.completed", response: { id: "resp_fake", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } } };
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(`event: response.completed\ndata: ${JSON.stringify(reply)}\n\n`);
    });
  });
  try {
    await mkdir(dataDir);
    setPaths({ rootDir: dir, dataDir, binDir: dir, publicDir: dir, configDir: resolve("config"), embedded: false });
    for (const key of ["CODEX_JWT_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "CODEX_PROXY_HOST", "OLLAMA_BRIDGE_ENABLED"]) vi.stubEnv(key, undefined);
    vi.stubEnv("CODEX_HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("HOME", dir);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input.toString());
      if (!permitted.has(target.origin)) {
        unexpected.push(target.origin);
        throw new Error("Non-fixture network request blocked");
      }
      return realFetch(input, { ...init, redirect: "error" });
    });
    fake.listen(0, "127.0.0.1");
    await once(fake, "listening");
    const backend = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    permitted.add(backend);
    const { startServer } = await import("@src/index.js");
    const { resetConfigForTesting } = await import("@src/config.js");
    async function boot(enabled: boolean) {
      await app?.close();
      app = undefined;
      resetConfigForTesting();
      await writeFile(join(dataDir, "local.yaml"), `
api:
  base_url: ${backend}/codex
server:
  host: 127.0.0.1
  proxy_api_key: fake-restart-master
model:
  official_catalog_sync: false
pricing:
  auto_sync: false
api_keys:
  memo_auto_refresh: false
auth:
  refresh_enabled: false
account_keepalive:
  enabled: false
ollama:
  enabled: false
ocgo:
  enabled: ${enabled}
  base_url: ${backend}/v1
`);
      app = await startServer({ host: "127.0.0.1", port: 0 });
      const origin = `http://127.0.0.1:${app.port}`;
      return (path: string, body?: object) => realFetch(origin + path, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(3_000),
        headers: { Authorization: "Bearer fake-restart-master", Connection: "close", "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
    const path = "/admin/opencode/keys";
    const model = "ocgo:restart-fixture";
    let request = await boot(true);
    const added = await request(path, { name: "Restart fixture", apiKey: "fake-go-restart", models: ["restart-fixture"] });
    expect(added.status).toBe(201);
    const { id } = await added.json();
    const custom = await request("/auth/api-keys", { provider: "custom", models: ["custom-restart-fixture"], apiKey: "fake-custom-restart", baseUrl: backend + "/custom/v1", wire: "responses", proxyId: "direct" });
    expect(custom.status).toBe(200);
    expect(await custom.json()).toMatchObject({ added: 1 });

    request = await boot(true);
    const persisted = await (await request(path)).text();
    expect(persisted).not.toContain("fake-go-restart");
    expect(JSON.parse(persisted)).toMatchObject({ enabled: true, credentials: [{ id, name: "Restart fixture" }] });
    const go = await request("/v1/responses", { model, input: "hello", stream: true });
    expect(go.status).toBe(200);
    expect(await go.text()).toContain("response.completed");
    expect(calls).toEqual([{ url: "/v1/responses", auth: "Bearer fake-go-restart" }]);

    // `ocgo.enabled` is retired: a stale false is ignored, so the namespace stays registered
    // and the credentials stay usable instead of the prefix being released.
    request = await boot(false);
    expect(await (await request(path)).json()).toMatchObject({ enabled: true, credentials: [{ id }] });
    const stillServed = await request("/v1/responses", { model, input: "hello" });
    expect(stillServed.status).not.toBe(404);
    expect(await stillServed.json()).not.toMatchObject({ error: { code: "model_not_found" } });
    const legacy = await request("/v1/responses", { model: "custom-restart-fixture", input: "hello", stream: true });
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain("response.completed");
    expect(calls).toEqual([
      { url: "/v1/responses", auth: "Bearer fake-go-restart" },
      { url: "/custom/v1/responses", auth: "Bearer fake-custom-restart" },
    ]);
    expect(unexpected).toEqual([]);
  } finally {
    try { await app?.close(); } finally {
      await new Promise<void>((done) => { fake.close(() => done()); fake.closeAllConnections(); });
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 15_000);
