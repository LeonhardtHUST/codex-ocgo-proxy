/**
 * OpenCode protocol contract (route C: "reduce drift").
 *
 * One golden fixture drives two implementations:
 *   - the TypeScript adapter path (`OpenCodeAdapter` → per-protocol upstream classes)
 *   - the in-repo Rust router (`native/ocx-router` + `RustRouterAdapter`)
 *
 * A fixture diff means a behaviour change. The Rust half is skipped when the binary has
 * not been built, but the TypeScript half always runs, so the contract stays enforced in
 * CI images without a Rust toolchain.
 */

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexApiError, type CodexResponsesRequest } from "@src/proxy/codex-types.js";
import type { OpenCodeModelEntry, OpenCodeWire } from "@src/opencode/model.js";
import { OpenCodeAdapter } from "@src/opencode/adapter.js";
import { ProtocolMatrix } from "@src/opencode/protocol-matrix.js";
import { RustRouterAdapter } from "@src/opencode/rust-adapter.js";
import { RustRouterProcess, resolveRustRouterBinary } from "@src/opencode/rust-router.js";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";

interface Scenario {
  name: string;
  protocol: OpenCodeWire;
  expectedPath: string;
  status: number;
  contentType: string;
  body: string;
  expectedEvents: string[];
  expectedErrorStatus?: number;
}

const fixture = JSON.parse(
  readFileSync(resolve("tests", "contract", "fixtures", "opencode-protocol-parity.json"), "utf8"),
) as { model: string; scenarios: Scenario[] };

const MODEL = fixture.model;
const rustBinary = resolveRustRouterBinary();

interface Observed {
  method: string;
  path: string;
  body: unknown;
}

let mock: Server;
let mockRoot = "";
let observed: Observed[] = [];
let responder: { status: number; contentType: string; body: string } | null = null;

let rustRouter: RustRouterProcess | null = null;
let rustBase = "";

function entryFor(protocol: OpenCodeWire): OpenCodeModelEntry {
  return {
    id: MODEL,
    upstream: "zen",
    protocols: [protocol],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: true,
    free: false,
    selectable: true,
    source: "seed",
  };
}

function request(): CodexResponsesRequest {
  return {
    model: MODEL,
    // Array input: the chat/messages translators iterate items, a bare string would blow up.
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
  } as unknown as CodexResponsesRequest;
}

function tsAdapter(protocol: OpenCodeWire): OpenCodeAdapter {
  return new OpenCodeAdapter({
    upstream: "zen",
    apiKey: "test-key",
    root: mockRoot,
    entry: entryFor(protocol),
    matrix: new ProtocolMatrix(),
  });
}

function rustAdapter(protocol: OpenCodeWire): RustRouterAdapter {
  return new RustRouterAdapter({
    baseUrl: rustBase,
    upstream: "zen",
    protocol: protocol === "responses" ? "responses" : protocol === "chat-completions" ? "chat-completions" : "messages",
    modelId: MODEL,
    apiKey: "test-key",
    transform: () => ({ messages: [{ role: "user", content: "hi" }] }),
  });
}

async function drain(adapter: OpenCodeAdapter | RustRouterAdapter, response: Response): Promise<string[]> {
  const events: string[] = [];
  for await (const event of adapter.parseStream(response)) events.push(event.event);
  return events;
}

async function runScenario(adapter: OpenCodeAdapter | RustRouterAdapter): Promise<string[]> {
  const response = await adapter.createResponse(request(), new AbortController().signal);
  return drain(adapter, response);
}

function serve(protocol: OpenCodeWire) {
  const scenario = fixture.scenarios.find((item) => item.protocol === protocol && !item.expectedErrorStatus);
  const failing = fixture.scenarios.find((item) => item.protocol === protocol && item.expectedErrorStatus);
  return { scenario, failing };
}

beforeAll(async () => {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      let parsed: unknown = undefined;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      observed.push({ method: req.method ?? "", path: req.url ?? "", body: parsed });
      const script = responder;
      if (!script) { res.writeHead(500); res.end("no scenario"); return; }
      res.writeHead(script.status, { "content-type": script.contentType });
      res.end(script.body);
    });
  });
  await new Promise<void>((done) => mock.listen(0, "127.0.0.1", () => done()));
  const address = mock.address();
  mockRoot = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  if (rustBinary) {
    const probe = createServer();
    const port = await new Promise<number>((done) => {
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        const value = typeof addr === "object" && addr ? addr.port : 0;
        probe.close(() => done(value));
      });
    });
    rustBase = `http://127.0.0.1:${port}/v1`;
    const routing = OpenCodeConfigSchema.parse({
      enabled: true,
      rust_routing: { enabled: true, port, base_url: rustBase, startup_timeout_ms: 8000 },
    }).rust_routing;
    rustRouter = new RustRouterProcess({
      config: routing,
      upstreamRoots: { go: mockRoot, zen: mockRoot },
      pollIntervalMs: 100,
    });
    const started = await rustRouter.start();
    if (!started) {
      console.warn(`[contract] ocx-router unavailable: ${rustRouter.status().lastError ?? "start failed"}`);
      rustRouter = null;
    }
  }
}, 30_000);

afterAll(async () => {
  await rustRouter?.stop();
  await new Promise<void>((done) => mock?.close(() => done()));
});

describe("opencode protocol contract — TypeScript path", () => {
  for (const scenario of fixture.scenarios) {
    it(`matches the fixture for ${scenario.name}`, async () => {
      observed = [];
      responder = { status: scenario.status, contentType: scenario.contentType, body: scenario.body };
      const adapter = tsAdapter(scenario.protocol);

      if (scenario.expectedErrorStatus) {
        await expect(runScenario(adapter)).rejects.toMatchObject({ status: scenario.expectedErrorStatus });
      } else {
        expect(await runScenario(adapter)).toEqual(scenario.expectedEvents);
      }

      expect(observed).toHaveLength(1);
      expect(observed[0].method).toBe("POST");
      expect(observed[0].path).toBe(scenario.expectedPath);
      expect((observed[0].body as { model?: string }).model).toBe(MODEL);
    });
  }
});

describe.runIf(Boolean(rustBinary))("opencode protocol contract — Rust router parity", () => {
  for (const scenario of fixture.scenarios) {
    it(`agrees with the TypeScript path for ${scenario.name}`, async () => {
      expect(rustRouter).not.toBeNull();

      // TypeScript observation
      observed = [];
      responder = { status: scenario.status, contentType: scenario.contentType, body: scenario.body };
      const ts = tsAdapter(scenario.protocol);
      let tsEvents: string[] = [];
      let tsStatus: number | undefined;
      try {
        tsEvents = await runScenario(ts);
      } catch (error) {
        tsStatus = (error as CodexApiError).status;
      }
      const tsObserved = observed.at(-1);

      // Rust observation
      observed = [];
      const rust = rustAdapter(scenario.protocol);
      let rustEvents: string[] = [];
      let rustStatus: number | undefined;
      try {
        rustEvents = await runScenario(rust);
      } catch (error) {
        rustStatus = (error as CodexApiError).status;
      }
      const rustObserved = observed.at(-1);

      expect(rustObserved?.path).toBe(tsObserved?.path);
      expect((rustObserved?.body as { model?: string }).model).toBe(MODEL);
      expect(rustStatus).toBe(tsStatus);
      if (!scenario.expectedErrorStatus) expect(rustEvents).toEqual(tsEvents);
    });
  }
});
