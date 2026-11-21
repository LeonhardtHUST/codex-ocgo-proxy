/**
 * Loopback contract test: real `ocx-router` binary ↔ local mock upstream.
 *
 * Skipped (explicitly) when the release binary has not been built, so CI without a Rust
 * toolchain reports "skipped" instead of a fake pass.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import { RustRouterAdapter } from "@src/opencode/rust-adapter.js";
import { RustRouterProcess, resolveRustRouterBinary } from "@src/opencode/rust-router.js";
import { OpenCodeError } from "@src/opencode/errors.js";

const binary = resolveRustRouterBinary(process.env.OCX_ROUTER_BIN);

interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let mock: Server;
let mockPort = 0;
let seen: Seen[] = [];
let nextStatus = 200;
let nextBody = "";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

let rustPort = 0;
let router: RustRouterProcess;

const describeIfBinary = binary ? describe : describe.skip;

describeIfBinary("ocx-router loopback contract", () => {
  beforeAll(async () => {
    mock = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        if (nextStatus !== 200) {
          res.writeHead(nextStatus, { "content-type": "application/json" });
          res.end(nextBody);
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n');
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
        res.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
    const address = mock.address();
    mockPort = typeof address === "object" && address ? address.port : 0;

    rustPort = await freePort();
    router = new RustRouterProcess({
      config: OpenCodeConfigSchema.parse({
        enabled: true,
        rust_routing: {
          enabled: true,
          port: rustPort,
          base_url: `http://127.0.0.1:${rustPort}/v1`,
          startup_timeout_ms: 8000,
        },
      }).rust_routing,
      upstreamRoots: {
        go: `http://127.0.0.1:${mockPort}/go`,
        zen: `http://127.0.0.1:${mockPort}/zen`,
      },
      pollIntervalMs: 100,
    });
    const started = await router.start();
    if (!started) throw new Error(`ocx-router did not start: ${router.status().lastError ?? "unknown"}`);
  }, 30_000);

  afterAll(async () => {
    await router?.stop();
    await new Promise<void>((resolve) => mock?.close(() => resolve()));
  });

  it("reports health and accepts a catalogue push", async () => {
    const health = await router.health();
    expect(health.ok).toBe(true);

    const pushed = await router.pushCatalog({
      list: () => [
        { id: "glm-5.3", upstream: "zen", protocols: ["chat-completions"], free: false, contextWindow: 1_000_000, inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, selectable: true, source: "seed" },
      ],
    } as never);
    expect(pushed).toBe(true);

    const response = await fetch(`http://127.0.0.1:${rustPort}/v1/models`);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toContain("glm-5.3");
  });

  it("forwards a responses request with the upstream/header contract", async () => {
    seen = [];
    nextStatus = 200;
    const adapter = new RustRouterAdapter({
      baseUrl: `http://127.0.0.1:${rustPort}/v1`,
      upstream: "go",
      modelId: "glm-5.3",
      apiKey: "fake-key",
      sessionId: "ses_0123456789ababcdefghijklmn",
    });
    const request = { model: "opencode-go:glm-5.3", input: "hello", stream: true, store: false } as unknown as CodexResponsesRequest;
    const response = await adapter.createResponse(request, new AbortController().signal);

    const events: string[] = [];
    for await (const event of adapter.parseStream(response)) events.push(event.event);
    expect(events).toContain("response.created");
    expect(events.at(-1)).toBe("response.completed");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/go/openai/v1/responses");
    expect(seen[0].headers.authorization).toBe("Bearer fake-key");
    expect(seen[0].headers["x-opencode-session"]).toBe("ses_0123456789ababcdefghijklmn");
    expect(JSON.parse(seen[0].body)).toMatchObject({ model: "glm-5.3", stream: true });
  });

  it("maps an upstream free-limit rejection to the canonical error shape", async () => {
    seen = [];
    nextStatus = 429;
    nextBody = JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "limit reached" } });
    const adapter = new RustRouterAdapter({
      baseUrl: `http://127.0.0.1:${rustPort}/v1`,
      upstream: "zen-free",
      modelId: "big-pickle",
    });
    try {
      await adapter.createResponse({ model: "opencode-zen-free:big-pickle", input: "hi" } as unknown as CodexResponsesRequest, new AbortController().signal);
      throw new Error("expected the adapter to throw");
    } catch (error) {
      // The direct path must surface the same error class every other adapter uses, so
      // the existing classification / retry layer keeps working unchanged.
      expect(error).toBeInstanceOf(CodexApiError);
      expect((error as CodexApiError).status).toBe(429);
      // The router classifies the upstream envelope and re-emits its own code; the original
      // message survives for diagnostics.
      expect((error as CodexApiError).body).toContain("opencode_free_limit");
      expect((error as CodexApiError).body).toContain("limit reached");
    } finally {
      nextStatus = 200;
      nextBody = "";
    }
  });

  it("targets the chat and messages endpoints", async () => {
    seen = [];
    const chat = new RustRouterAdapter({
      baseUrl: `http://127.0.0.1:${rustPort}/v1`,
      upstream: "zen",
      protocol: "chat-completions",
      modelId: "glm-5.3",
      transform: () => ({ messages: [{ role: "user", content: "hi" }] }),
    });
    const response = await chat.createResponse({ model: "opencode:glm-5.3" } as unknown as CodexResponsesRequest, new AbortController().signal);
    for await (const _event of chat.parseStream(response)) { /* drain */ }
    expect(seen[0].url).toBe("/zen/openai/v1/chat/completions");

    seen = [];
    const messages = new RustRouterAdapter({
      baseUrl: `http://127.0.0.1:${rustPort}/v1`,
      upstream: "zen",
      protocol: "messages",
      modelId: "claude-sonnet-5-5",
      transform: () => ({ messages: [{ role: "user", content: "hi" }] }),
    });
    const messageResponse = await messages.createResponse({ model: "opencode:claude-sonnet-5-5" } as unknown as CodexResponsesRequest, new AbortController().signal);
    for await (const _event of messages.parseStream(messageResponse)) { /* drain */ }
    expect(seen[0].url).toBe("/zen/anthropic/v1/messages");
  });
});
