import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OCGoKeyStore } from "@src/auth/ocgo-key-store.js";
import { OCGoConfigSchema } from "@src/ocgo-config.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { OCGoUpstream } from "@src/proxy/ocgo-upstream.js";

const selectedKey = "fake-go-key-for-loopback-contract";
const clientKey = "fake-client-access-credential";
const req: CodexResponsesRequest = {
  model: "ocgo:kimi-k2.5", input: [], stream: true, store: false,
  tools: [{ type: "function", name: "lookup" }],
};
const frame = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

const create = (base: string, seconds = 3) => new OCGoUpstream(base, selectedKey, seconds);
async function collect(upstream: OCGoUpstream, response: Response): Promise<unknown[]> {
  const events = [];
  for await (const event of upstream.parseStream(response)) events.push(event);
  return events;
}

describe("OCGo configuration and private credential store", () => {
  it("defaults off and rejects credentials in general application settings", () => {
    expect(OCGoConfigSchema.parse(undefined).enabled).toBe(false);
    expect(OCGoConfigSchema.safeParse({ api_key: selectedKey }).success).toBe(false);
    expect(OCGoConfigSchema.safeParse({ base_url: "http://[::1]:8787/v1" }).success).toBe(true);
  });

  it.each([
    "https://127.0.0.1:8787/v1", "http://localhost:8787/v1", "http://127.1:8787/v1",
    "http://127.0.0.1.example.invalid:8787/v1", "http://127.0.0.1:8787@localhost/v1",
    "http://127.0.0.1:8787/v1?q=x", "http://127.0.0.1:8787/v1/other", "http://127.0.0.1:70000/v1",
  ])("rejects the unsupported base URL %s at config and request boundaries", (url) => {
    expect(OCGoConfigSchema.safeParse({ base_url: url }).success).toBe(false);
    expect(() => create(url)).toThrow("Invalid OCGo loopback URL");
  });

  it("persists separately, rejects duplicates before writing, and sanitizes parse failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocgo-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "ocgo-keys.json");
    const store = new OCGoKeyStore(file);
    const first = { id: randomUUID(), apiKey: selectedKey, name: "Test", models: ["kimi-k2.5"], enabled: true };
    expect(store.readCredentials()).toEqual([]);
    store.replaceCredentials([first]);
    expect(new OCGoKeyStore(file).readCredentials()).toEqual([first]);
    store.replaceCredentials([{ ...first, enabled: false }]);
    expect(() => store.replaceCredentials([first, { ...first, id: randomUUID() }])).toThrow("Duplicate OCGo credentials");
    expect(new OCGoKeyStore(file).readCredentials()).toEqual([{ ...first, enabled: false }]);
    writeFileSync(file, selectedKey, "utf8");
    expect(() => store.readCredentials()).toThrow(/^Invalid OCGo credential store$/);
  });
});

describe("OCGo's isolated loopback transport", () => {
  it("bypasses the global proxy, sends only the selected Bearer, maps the model, and parses text/tools", async () => {
    let proxyHits = 0;
    const proxy = await serve((_request, response) => { proxyHits++; response.writeHead(502).end(); });
    const dispatcher = new ProxyAgent(new URL(proxy).origin);
    const original = getGlobalDispatcher();
    vi.stubEnv("HTTP_PROXY", new URL(proxy).origin);
    vi.stubEnv("http_proxy", new URL(proxy).origin);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    setGlobalDispatcher(dispatcher);
    cleanups.push(async () => { setGlobalDispatcher(original); await dispatcher.close(); });

    const requests: unknown[] = [];
    const base = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
        response.writeHead(200, { "Content-Type": "text/event-stream", "Set-Cookie": selectedKey });
        response.end(frame("response.output_text.delta", { delta: "你好" }) +
          frame("response.function_call_arguments.delta", { delta: '{"query":"test"}' }) +
          frame("response.completed", { response: { status: "completed" } }));
      });
    });
    const upstream = create(base);
    const result = await upstream.createResponse({
      ...req, store: true, client_metadata: { authorization: clientKey }, prompt_cache_key: clientKey,
      clientUserAgent: clientKey, opencodeSessionId: clientKey,
    }, AbortSignal.timeout(5_000));
    expect(requests).toMatchObject([{
      method: "POST", path: "/v1/responses", headers: { authorization: `Bearer ${selectedKey}` },
      body: JSON.stringify({ model: "opencode-go/kimi-k2.5", stream: true, store: false, input: [], tools: req.tools }),
    }]);
    expect(JSON.stringify(requests)).not.toContain(clientKey);
    expect(proxyHits).toBe(0);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(await collect(upstream, result)).toMatchObject([
      { event: "response.output_text.delta", data: { delta: "你好" } },
      { event: "response.function_call_arguments.delta", data: { delta: '{"query":"test"}' } },
      { event: "response.completed" },
    ]);
  });

  it("never follows a redirect, including to another loopback port", async () => {
    let redirected = 0;
    const target = await serve((_request, response) => { redirected++; response.end(); });
    const origin = await serve((_request, response) => response.writeHead(307, { Location: `${target}/responses` }).end());
    await expect(create(origin).createResponse(req, AbortSignal.timeout(3_000)))
      .rejects.toMatchObject({ status: 502, code: "ocgo_bad_response" });
    expect(redirected).toBe(0);
  });

  it.each([["17", 17], [selectedKey, undefined]])("sanitizes 429 diagnostics and only keeps a valid Retry-After", async (value, delay) => {
    let calls = 0;
    const base = await serve((_request, response) => {
      calls++;
      response.writeHead(429, { "Retry-After": value, "X-Diagnostic": selectedKey }).end(selectedKey);
    });
    const error = await create(base).createResponse(req, AbortSignal.timeout(3_000)).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 429, code: "ocgo_rate_limited", retryAfterSeconds: delay });
    expect(JSON.stringify(error)).not.toContain(selectedKey);
    expect(String(error)).not.toContain(selectedKey);
    expect(calls).toBe(1);
  });

  it.each([
    [401, "invalid_api_key", "invalid_key"],
    [403, "model_not_allowed", "model_denied"],
    [403, "unknown", "other"],
    [400, "cyber_policy", "policy_rejected"],
    [429, "key_rate_limited", "key_rate_limit"],
    [429, "rate_limit_exceeded", "unknown_rate_limit"],
    [429, "quota_group_exhausted", "quota_group_exhausted"],
    [402, "quota_group_exhausted", "quota_group_exhausted"],
    [502, "invalid_api_key", "other"],
  ] as const)("classifies HTTP %i with %s without retaining diagnostic data", async (status, code, failure) => {
    const base = await serve((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code, message: selectedKey } }));
    });
    const error = await create(base).createResponse(req, AbortSignal.timeout(3_000)).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status, failure });
    expect(JSON.stringify(error)).not.toContain(selectedKey);
    expect(String(error)).not.toContain(selectedKey);
  });

  it.each(["oversized", "slow"])("keeps 429 when the JSON diagnostic is %s", async (kind) => {
    const base = await serve((_request, response) => {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
      if (kind === "slow") response.write('{"error":');
      else response.end(JSON.stringify({ error: { code: "key_rate_limited", message: "a".repeat(9000) } }));
    });
    await expect(create(base).createResponse(req, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ status: 429, failure: "unknown_rate_limit", retryAfterSeconds: 7 });
  });

  it("terminates and sanitizes an error after output without replay", async () => {
    let calls = 0;
    const base = await serve((_request, response) => {
      calls++;
      response.writeHead(200, { "Content-Type": "text/event-stream" }).end(
        frame("response.output_text.delta", { delta: selectedKey }) +
        frame("response.failed", { response: { error: { message: selectedKey } } }) + frame("response.completed"),
      );
    });
    const upstream = create(base);
    const events = await collect(upstream, await upstream.createResponse(req, AbortSignal.timeout(3_000)));
    expect(events).toMatchObject([
      { event: "response.output_text.delta", data: { delta: "[redacted]" } },
      { event: "error", data: { error: { code: "ocgo_stream_failed" } } },
    ]);
    expect(JSON.stringify(events)).not.toContain(selectedKey);
    expect(calls).toBe(1);
  });

  it.each(["client abort", "deadline"])("propagates %s after SSE headers and closes the loopback stream", async (reason) => {
    let closed!: (beforeEnd: boolean) => void;
    const disconnected = new Promise<boolean>((resolve) => { closed = resolve; });
    const base = await serve((_request, response) => {
      response.once("close", () => closed(!response.writableEnded));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(frame("response.output_text.delta", { delta: "first" }));
    });
    const upstream = create(base, reason === "deadline" ? 1 : 3);
    const abort = new AbortController();
    const events = upstream.parseStream(await upstream.createResponse(req, abort.signal));
    expect(await events.next()).toMatchObject({ value: { event: "response.output_text.delta" } });
    if (reason === "client abort") abort.abort();
    expect(await events.next()).toMatchObject({ value: { event: "error" } });
    expect(await events.next()).toEqual({ done: true, value: undefined });
    expect(await disconnected).toBe(true);
  });

  it("closes the connection on a terminal frame even if the server leaves its socket open", async () => {
    let closed!: (beforeEnd: boolean) => void;
    const disconnected = new Promise<boolean>((resolve) => { closed = resolve; });
    const base = await serve((_request, response) => {
      response.once("close", () => closed(!response.writableEnded));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(frame("response.completed", { response: { status: "completed" } }));
    });
    const upstream = create(base, 30);
    expect(await collect(upstream, await upstream.createResponse(req, new AbortController().signal)))
      .toMatchObject([{ event: "response.completed" }]);
    expect(await disconnected).toBe(true);
  });

  it("rejects server-side continuation and unsupported tool types before sending", async () => {
    let calls = 0;
    const base = await serve((_request, response) => { calls++; response.end(); });
    const upstream = create(base);
    for (const body of [{ ...req, previous_response_id: "resp_fake" }, { ...req, tools: [{ type: "image_generation" }] }]) {
      await expect(upstream.createResponse(body, AbortSignal.timeout(3_000)))
        .rejects.toMatchObject({ status: 400, code: "ocgo_unsupported_request" });
    }
    expect(calls).toBe(0);
  });
});
