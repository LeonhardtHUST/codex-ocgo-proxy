import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as directFetch } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountPool } from "@src/auth/account-pool.js";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import { OpenCodePool } from "@src/auth/opencode-pool.js";
import { LegacyOpenCodeConfigSchema } from "@src/opencode-legacy-config.js";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

vi.mock("@src/config.js", () => ({ getConfig: () => ({ server: { proxy_api_key: "fake-app-key" } }) }));

const binary = process.env.OPENCODE_TEST_RUST_BINARY;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function bind(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

async function startRust(backend: RequestListener) {
  if (!binary || !isAbsolute(binary)) throw new Error("Provide an absolute OPENCODE_TEST_RUST_BINARY path");
  const dir = await mkdtemp(join(tmpdir(), "ocgo-rust-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const upstream = createServer(backend);
  const upstreamUrl = `http://127.0.0.1:${await bind(upstream)}`;
  cleanup.push(() => closeServer(upstream));
  const reservation = createServer();
  const rustPort = await bind(reservation);
  const config = join(dir, "config.toml");
  await writeFile(config, `version = 1\nstate_dir = "state"\n[server]\nbind = "127.0.0.1"\nport = ${rustPort}\ntimeout_sec = 20\nmax_retries = 0\nretry_window_sec = 0\nkeepalive_sec = 1\n[upstream]\ngo_base_url = "${upstreamUrl}/go"\nzen_base_url = "${upstreamUrl}/zen"\nnative_base_url = "${upstreamUrl}/native"\n[identity]\nsession_mode = "per_key"\n[monitor]\nenabled = false\n[[models]]\nid = "ocgo-fixture-model"\nprovider = "go"\nfamily = "chat"\n`, "utf8");
  await closeServer(reservation);
  // Do not inherit any external endpoint, credential, proxy, or service config.
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : []));
  const rust: ChildProcess = spawn(binary, ["--config", config, "serve"], { cwd: dir, env, stdio: "ignore", windowsHide: true });
  const exited = new Promise<void>((resolve) => {
    rust.once("close", () => resolve());
    rust.once("error", () => resolve());
  });
  cleanup.push(async () => { if (rust.exitCode === null && rust.signalCode === null) rust.kill(); await exited; });
  const root = `http://127.0.0.1:${rustPort}`;
  const dispatcher = new Agent();
  cleanup.push(() => dispatcher.destroy());
  const stop = async () => {
    await dispatcher.destroy();
    await writeFile(join(dir, "state", "stop-request"), "");
    const stopped = await Promise.race([exited.then(() => true), delay(3_000, false, { ref: false })]);
    expect(stopped).toBe(true);
    expect(rust.exitCode).toBe(0);
  };
  for (let i = 0; i < 60; i++) {
    if (rust.exitCode !== null || rust.signalCode !== null || !rust.pid) throw new Error("Isolated Rust process did not start; confirm executable supports the fixture TOML");
    const health = await directFetch(`${root}/health`, { dispatcher, signal: AbortSignal.timeout(200), redirect: "error" }).catch(() => null);
    if (health?.ok && (await health.json()).implementation === "rust") return { baseUrl: `${root}/v1`, stop };
    await delay(50);
  }
  throw new Error("Isolated Rust process did not become ready");
}

it.skipIf(!binary)("uses actual Rust for Go translation, selected Bearers, 429 and cancellation with no replay", async () => {
  const modelId = "ocgo-fixture-model";
  const requests: { path?: string; authorization?: string; session?: string; body: Record<string, unknown> }[] = [];
  let behavior: "ok" | "429" | "hold-headers" | "hold-stream" = "ok";
  let observed: () => void = () => {};
  let disconnected: (closedEarly: boolean) => void = () => {};
  const { baseUrl, stop } = await startRust((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url, authorization: request.headers.authorization,
        session: request.headers["x-opencode-session"] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const onDisconnect = disconnected;
      response.once("close", () => onDisconnect(!response.writableEnded));
      observed();
      if (behavior === "hold-headers") return;
      if (behavior === "429") {
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "17" }).end(JSON.stringify({ error: { message: "fake upstream limit" } }));
        return;
      }
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(chunk({ content: "Hello from the fixture" }));
      if (behavior === "hold-stream") return;
      response.end(chunk({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: '{"word":"test"}' } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    });
  });
  const router = new UpstreamRouter(new Map(), {}, "codex");
  router.enableOpenCodeNamespace();
  const pool = { validateProxyApiKey: (key: string) => key === "fake-app-key" } as AccountPool;
  let selectedKey = "fake-go-a";
  let now = 0;
  const app = createResponsesRoutes(pool, undefined, undefined, router, undefined, undefined, {
    config: { enabled: true, base_url: baseUrl, timeout_seconds: 15 },
    pool: new OpenCodePool({ readCredentials: () => [{ id: "fixture", enabled: true, name: "Test", apiKey: selectedKey, models: [modelId] }] }, () => now),
  });
  const send = (signal = AbortSignal.timeout(5_000)) => app.request("/v1/responses", {
    method: "POST", headers: { Authorization: "Bearer fake-app-key", "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ model: `ocgo:${modelId}`, input: "Hello", stream: true, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] }),
  });
  const ok = await send();
  expect(ok.status).toBe(200);
  const events = await ok.text();
  expect(events).toContain("response.output_text.delta");
  expect(events).toContain("response.function_call_arguments.delta");
  expect(events).toContain("response.completed");
  expect(requests[0]).toMatchObject({ path: "/go/chat/completions", authorization: "Bearer fake-go-a", body: { model: modelId, stream: true } });
  expect(requests[0].session).toBeTruthy();

  behavior = "429";
  selectedKey = "fake-go-b";
  const limited = await send();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("17");
  expect(requests).toHaveLength(2);
  expect(requests[1].authorization).toBe("Bearer fake-go-b");
  expect(requests[1].session).not.toBe(requests[0].session);

  now += 17_000;
  behavior = "hold-stream";
  const streamClosed = new Promise<boolean>((resolve) => { disconnected = resolve; });
  const active = await send();
  const reader = active.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  expect(await Promise.race([streamClosed, delay(2_000, false)])).toBe(true);

  behavior = "hold-headers";
  const headersArrived = new Promise<void>((resolve) => { observed = resolve; });
  const headersClosed = new Promise<boolean>((resolve) => { disconnected = resolve; });
  const abort = new AbortController();
  const pending = send(abort.signal);
  await Promise.race([headersArrived, delay(2_000).then(() => { throw new Error("mock did not receive pending headers request"); })]);
  abort.abort();
  expect((await pending).status).toBe(499);
  expect(await Promise.race([headersClosed, delay(2_000, false)])).toBe(true);
  expect(requests).toHaveLength(4);
  expect(JSON.stringify(requests)).not.toContain("fake-app-key");
  await stop();
  expect((await send()).status).toBe(502);
  expect(requests).toHaveLength(4);

  // Reconstruct the routing layer as on restart with the flag omitted.
  const rollbackConfig = LegacyOpenCodeConfigSchema.parse(undefined);
  expect(rollbackConfig.enabled).toBe(false);
  const legacy = new ApiKeyPool({ load: () => [], save: () => {} });
  const rolledBack = new UpstreamRouter(new Map(), {}, "codex");
  rolledBack.setApiKeyPool(legacy, () => ({
    tag: "custom",
    createResponse: async () => { throw new Error("Unexpected legacy network request"); },
    async *parseStream() {},
  }));
  if (rollbackConfig.enabled) rolledBack.enableOpenCodeNamespace();
  const rollbackApp = createResponsesRoutes(pool, undefined, undefined, rolledBack);
  const disabled = await rollbackApp.request("/v1/responses", {
    method: "POST", headers: { Authorization: "Bearer fake-app-key", "Content-Type": "application/json" },
    body: JSON.stringify({ model: `ocgo:${modelId}`, input: "Hello" }),
  });
  expect(disabled.status).toBe(404);
  expect(await disabled.json()).toMatchObject({ error: { code: "model_not_found" } });
  expect(rolledBack.resolveMatch("gpt-5.5").kind).toBe("codex");
  const previousCustom = legacy.add({ provider: "custom", model: `ocgo:${modelId}`, apiKey: "fake-custom", baseUrl: "http://127.0.0.1:1/v1" });
  expect(rolledBack.resolveMatch(`ocgo:${modelId}`)).toMatchObject({ kind: "api-key", entry: { id: previousCustom.id } });
  expect(requests).toHaveLength(4);
}, 15_000);
