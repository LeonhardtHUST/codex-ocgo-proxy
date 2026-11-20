import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { ClientKeyPool } from "@src/auth/client-key-pool.js";
import type { OCGoCredential } from "@src/auth/ocgo-key-store.js";
import { OCGoPool } from "@src/auth/ocgo-pool.js";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import { createResponsesRoutes } from "@src/routes/responses.js";
import { ApiKeyPool } from "@src/auth/api-key-pool.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createEmbeddingsRoutes } from "@src/routes/embeddings.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import { createImagesRoutes } from "@src/routes/images.js";
import { createMessagesRoutes } from "@src/routes/messages.js";

vi.mock("@src/config.js", () => ({ getConfig: () => ({ server: { proxy_api_key: "fake-master" } }) }));
const { codex, direct } = vi.hoisted(() => ({ codex: vi.fn(), direct: vi.fn() }));
vi.mock("@src/routes/shared/proxy-handler.js", () => ({ handleProxyRequest: codex }));
vi.mock("@src/routes/shared/direct-request-handler.js", () => ({ handleDirectRequest: direct }));

const model = "ocgo:kimi-k2.5";
const key = "fake-ocgo-selected-key";
const clientKey = "fake-client";
const sse = (type: string, fields: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const master = "fake-master";
const credential = { id: "test", name: "Test", apiKey: key, enabled: true, models: ["kimi-k2.5"] };

describe("OCGo Responses via the app route and real loopback transport", () => {
  let server: Server;
  let app: ReturnType<typeof createResponsesRoutes>;
  let received: { headers: unknown; raw: string }[];
  let credentials: OCGoCredential[];
  let behavior: "ok" | "429" | "hold" | "stream-error";
  let failures: Record<string, { status: number; code: string; delayMs?: number }>;
  let timeoutConfig: { enabled: boolean; base_url: string; timeout_seconds: number };
  let now: number;
  let ocgoPool: OCGoPool;
  let closed: Promise<boolean>;
  const releaseSlot = vi.fn();
  const recordUsage = vi.fn();
  const store = { readCredentials: vi.fn(() => credentials) };

  beforeEach(async () => {
    vi.clearAllMocks();
    received = [];
    credentials = [credential];
    failures = {}; now = 0;
    behavior = "ok";
    let disconnected!: (value: boolean) => void;
    closed = new Promise((resolve) => { disconnected = resolve; });
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, raw: Buffer.concat(chunks).toString() });
        const failure = failures[request.headers.authorization ?? ""];
        if (failure) {
          const reply = () => response.writeHead(failure.status, { "Content-Type": "application/json", "Retry-After": "17" })
            .end(JSON.stringify({ error: { code: failure.code, message: "private diagnostic" } }));
          if (failure.delayMs) {
            const timer = setTimeout(reply, failure.delayMs);
            response.once("close", () => clearTimeout(timer));
          } else reply();
          return;
        }
        if (behavior === "429") {
          response.writeHead(429, { "Retry-After": "17", "X-Secret": key }).end(key);
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(sse("response.output_text.delta", { delta: "Hello" }));
        if (behavior === "hold") {
          response.once("close", () => disconnected(!response.writableEnded));
          return;
        }
        if (behavior === "stream-error") {
          response.end(sse("response.failed", { response: { error: { code: "invalid_api_key" } } }));
          return;
        }
        response.end(sse("response.function_call_arguments.delta", { delta: "{}" }) + sse("response.completed", {
          response: { id: "resp_mock", status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
        }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const router = new UpstreamRouter(new Map(), {}, "codex");
    router.enableOCGoNamespace();
    const pool = { validateProxyApiKey: (value: string) => value === master } as AccountPool;
    const clientPool = {
      getByKey: (value: string) => value === clientKey ? { id: "client-id", allowed_models: [model] } : undefined,
      validateAccess: () => ({ allowed: true }), acquireSlot: () => true, releaseSlot, recordUsage,
    } as unknown as ClientKeyPool;
    timeoutConfig = { enabled: true, base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, timeout_seconds: 30 };
    ocgoPool = new OCGoPool(store, () => now);
    app = createResponsesRoutes(pool, undefined, undefined, router, clientPool, undefined, {
      config: timeoutConfig, pool: ocgoPool,
    });
    app.route("/", createChatRoutes(pool, undefined, undefined, router, clientPool));
    app.route("/", createMessagesRoutes(pool, undefined, undefined, router, clientPool));
    app.route("/", createGeminiRoutes(pool, undefined, undefined, router, clientPool));
    app.route("/", createImagesRoutes(pool, undefined, undefined, clientPool, router));
    app.route("/", createEmbeddingsRoutes(pool, new ApiKeyPool({ load: () => [], save: () => {} }), clientPool, undefined, router));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  });

  const send = (extra: object = {}, token = master, path = "/v1/responses") => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Cookie: `access=${token}` },
    body: JSON.stringify({ model, input: "Hello", ...extra }),
  });

  it("authorizes a client key without OAuth, forwards only the Go Bearer and emits text and tool SSE", async () => {
    const reply = await send({ stream: true, tools: [{ type: "function", name: "lookup" }], client_metadata: { auth: clientKey } }, clientKey);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toContain("text/event-stream");
    const body = await reply.text();
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.function_call_arguments.delta");
    expect(body).toContain("event: response.completed");
    expect(received).toHaveLength(1);
    expect(received[0].headers).toMatchObject({ authorization: `Bearer ${key}` });
    expect(JSON.stringify(received[0])).not.toContain(clientKey);
    expect(JSON.parse(received[0].raw)).toMatchObject({ model: "opencode-go/kimi-k2.5", store: false, stream: true });
    expect(recordUsage).toHaveBeenCalledWith("client-id", model, { input_tokens: 5, output_tokens: 3, cached_tokens: 0 }, undefined);
    expect(releaseSlot).toHaveBeenCalledOnce();
  });

  it("round-robins fresh requests and keeps affinity separate for the same session across callers", async () => {
    const secondKey = "fake-ocgo-second-key";
    credentials.push({ ...credential, id: "another", apiKey: secondKey });
    const session = { prompt_cache_key: "same-session" };
    for (const token of [master, clientKey, master, clientKey]) {
      const response = await send(session, token);
      expect(response.status).toBe(200);
      await response.json();
    }
    expect(received.map(({ headers }) => (headers as { authorization: string }).authorization))
      .toEqual([key, secondKey, key, secondKey].map((bearer) => `Bearer ${bearer}`));
    expect(received.every(({ raw }) => !raw.includes("same-session"))).toBe(true);
  });

  it("collects JSON when stream is not requested", async () => {
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "resp_mock", output_text: "Hello" });
  });

  it("does not read the credential pool on auth or model ACL failure", async () => {
    expect((await send({}, "fake-wrong")).status).toBe(401);
    expect((await send({ model: "ocgo:other" }, clientKey)).status).toBe(403);
    expect(store.readCredentials).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it("returns an OCGo error without Codex or Custom fallback when no key is eligible", async () => {
    credentials = [{ ...credential, enabled: false }];
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "ocgo_no_credential" } });
    expect(received).toEqual([]);
    expect(codex).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("preserves a sanitized pre-stream 429 without replay", async () => {
    credentials.push({ ...credential, id: "second", apiKey: "fake-second" });
    behavior = "429";
    const response = await send({ stream: true });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.text()).not.toContain(key);
    expect(received).toHaveLength(1);
    behavior = "ok";
    const backedOff = await send();
    expect(backedOff.status).toBe(429);
    expect(await backedOff.json()).toMatchObject({ error: { code: "ocgo_backoff" } });
    expect(received).toHaveLength(1);
    now += 17_000;
    expect((await send()).status).toBe(200);
    expect(received).toHaveLength(2);
  });

  it.each([
    [401, "invalid_api_key"], [403, "model_not_allowed"], [429, "key_rate_limited"],
  ] as const)("switches once after a structured %i %s before output", async (status, code) => {
    credentials.push({ ...credential, id: "second", apiKey: "fake-second" });
    failures[`Bearer ${key}`] = { status, code };
    const response = await send({ stream: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    expect(received.map(({ headers }) => (headers as { authorization: string }).authorization))
      .toEqual([`Bearer ${key}`, "Bearer fake-second"]);
    const snapshot = ocgoPool.snapshot();
    expect(snapshot).toMatchObject({
      officialQuota: null,
      clientRequests: { started: 1, succeeded: 1, failed: 0, cancelled: 0, inFlight: 0 },
      credentials: [
        { upstreamAttempts: { started: 1, failed: 1, inputTokens: { total: null, unknown: 1 } } },
        { upstreamAttempts: { started: 1, succeeded: 1, inputTokens: { total: 5, unknown: 0 }, cachedTokens: { total: null, unknown: 1 } } },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain(key);
    expect(JSON.stringify(snapshot)).not.toContain("fake-second");
  });

  it("retries known quota exhaustion only in a confirmed different group", async () => {
    credentials = [{ ...credential, quotaGroup: "shared" },
      { ...credential, id: "same-group", apiKey: "fake-same-group", quotaGroup: "shared" },
      { ...credential, id: "unknown-group", apiKey: "fake-unknown-group" },
      { ...credential, id: "independent", apiKey: "fake-independent", quotaGroup: "separate" }];
    failures[`Bearer ${key}`] = { status: 429, code: "quota_group_exhausted" };
    expect((await send()).status).toBe(200);
    expect(received.map(({ headers }) => (headers as { authorization: string }).authorization))
      .toEqual([`Bearer ${key}`, "Bearer fake-independent"]);
  });

  it("keeps the first quota error when no separate confirmed group is available", async () => {
    credentials = [{ ...credential, quotaGroup: "shared" },
      { ...credential, id: "same-group", apiKey: "fake-same-group", quotaGroup: "shared" },
      { ...credential, id: "unknown-group", apiKey: "fake-unknown-group" }];
    failures[`Bearer ${key}`] = { status: 429, code: "quota_group_exhausted" };
    const response = await send();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "ocgo_quota_exhausted" } });
    expect(received).toHaveLength(1);
  });

  it("preserves the final error without trying a third credential", async () => {
    credentials.push({ ...credential, id: "second", apiKey: "fake-second" }, { ...credential, id: "third", apiKey: "fake-third" });
    failures[`Bearer ${key}`] = { status: 401, code: "invalid_api_key" };
    failures["Bearer fake-second"] = { status: 403, code: "model_not_allowed" };
    const response = await send();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "ocgo_model_denied" } });
    expect(received).toHaveLength(2);
  });

  it.each([[400, "content_policy_violation"], [502, "invalid_api_key"]] as const)("does not switch for HTTP %i %s", async (status, code) => {
    credentials.push({ ...credential, id: "second", apiKey: "fake-second" });
    failures[`Bearer ${key}`] = { status, code };
    expect((await send()).status).toBe(status);
    expect(received).toHaveLength(1);
  });

  it("uses one deadline across both attempts", async () => {
    timeoutConfig.timeout_seconds = 1;
    credentials.push({ ...credential, id: "second", apiKey: "fake-second" });
    failures[`Bearer ${key}`] = { status: 401, code: "invalid_api_key", delayMs: 450 };
    failures["Bearer fake-second"] = { status: 403, code: "model_not_allowed", delayMs: 800 };
    const response = await send();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "ocgo_timeout" } });
    expect(received).toHaveLength(2);
  });

  it("does not replay after an SSE failure, even for an otherwise eligible second key", async () => {
    credentials.push({ ...credential, id: "second", apiKey: "fake-second" });
    behavior = "stream-error";
    const response = await send({ stream: true });
    const text = await response.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("ocgo_stream_failed");
    expect(received).toHaveLength(1);
  });

  it("cancels a pending upstream stream on downstream body cancellation", async () => {
    behavior = "hold";
    const response = await send({ stream: true }, clientKey);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.output_text.delta");
    const busy = await send();
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: { code: "ocgo_busy" } });
    await reader.cancel();
    expect(await closed).toBe(true);
    expect(releaseSlot).toHaveBeenCalledOnce();
    expect(received).toHaveLength(1);
    expect(ocgoPool.snapshot()).toMatchObject({
      clientRequests: { started: 2, failed: 1, cancelled: 1, succeeded: 0, inFlight: 0 },
      credentials: [{ upstreamAttempts: { started: 1, cancelled: 1, inFlight: 0 } }],
    });
    behavior = "ok";
    expect((await send()).status).toBe(200);
  });

  it.each(["/v1/responses/compact", "/v1/responses/review", "/v1/alpha/search"])("rejects OCGo on %s without contacting any provider", async (path) => {
    const response = await send({}, master, path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "ocgo_unsupported_endpoint" } });
    expect(store.readCredentials).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it.each([
    ["/v1/chat/completions", { messages: [{ role: "user", content: "Hello" }] }],
    ["/v1/messages", { max_tokens: 10, messages: [{ role: "user", content: "Hello" }] }],
    ["/v1/messages/count_tokens", { messages: [{ role: "user", content: "Hello" }] }],
    [`/v1beta/models/${model}:generateContent`, {}],
    [`/v1beta/models/${model}:countTokens`, {}],
    ["/v1/images/generations", { prompt: "Hello" }],
    ["/v1/images/edits", {}],
    ["/v1/embeddings", {}],
  ] as const)("rejects OCGo on incompatible endpoint %s", async (path, body) => {
    const response = await send(body, master, path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "ocgo_unsupported_endpoint" } });
    expect(store.readCredentials).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(codex).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("rejects keyed continuation and inline compaction before selection", async () => {
    for (const body of [{ previous_response_id: "resp_mock" }, { input: [{ type: "compaction_trigger" }] }]) {
      const response = await send(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "ocgo_unsupported_request" } });
    }
    expect(store.readCredentials).not.toHaveBeenCalled();
  });
});
