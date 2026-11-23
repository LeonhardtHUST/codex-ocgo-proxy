import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexApiError, type CodexResponsesRequest } from "@src/proxy/codex-types.js";
import { ResponsesUpstream } from "@src/proxy/responses-upstream.js";

// M0: the generic Responses adapter, not a claim that the App routes OpenCode yet.
// Callers must supply the Rust model slug here; mapping from ocgo: belongs in M1.
const goKey = "fake-selected-go-key";
const clientKey = "fake-client-access-key";
const model = "opencode-go/kimi-k2.5";
const tools = [{ type: "function", name: "lookup", parameters: { type: "object" } }];
const request: CodexResponsesRequest = {
  model,
  input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  tools,
  stream: true,
  store: false,
  client_metadata: { authorization: `Bearer ${clientKey}` },
};

const frames = [
  { type: "response.output_text.delta", delta: "你好" },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"query":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a"}' },
  { type: "response.completed", response: { id: "resp_fake", status: "completed" } },
];
const encodeFrame = (data: (typeof frames)[number]) =>
  `event: ${data.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

describe("OpenCode M0: Responses adapter against a real loopback HTTP server", () => {
  let server: Server;
  let adapter: ResponsesUpstream;
  let mode: "sse" | "hold" | "rate-limit";
  let received: { url?: string; method?: string; headers: IncomingHttpHeaders; body: string }[];
  let disconnected: Promise<boolean>;

  beforeEach(async () => {
    mode = "sse";
    received = [];
    let closed!: (beforeEnd: boolean) => void;
    disconnected = new Promise<boolean>((resolve) => { closed = resolve; });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (mode === "rate-limit") {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "17" });
          res.end(JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (mode === "hold") {
          res.once("close", () => closed(!res.writableEnded));
          res.write(encodeFrame(frames[0]));
          return;
        }
        const payload = Buffer.from(frames.map(encodeFrame).join(""));
        const split = payload.indexOf(Buffer.from("你")) + 1;
        res.write(payload.subarray(0, split));
        setImmediate(() => res.end(payload.subarray(split)));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    adapter = new ResponsesUpstream("custom", goKey, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });

  it("sends only the selected Bearer, preserves the supplied Rust model slug and parses text/tool events", async () => {
    const response = await adapter.createResponse(request, AbortSignal.timeout(3_000));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const parsed = [];
    for await (const event of adapter.parseStream(response)) parsed.push(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ url: "/v1/responses", method: "POST" });
    expect(received[0].headers).toMatchObject({ authorization: `Bearer ${goKey}`, accept: "text/event-stream" });
    expect(received[0].headers).not.toHaveProperty("x-api-key");
    expect(JSON.stringify(received)).not.toContain(clientKey);
    expect(JSON.parse(received[0].body)).toEqual({ model, tools, input: request.input, stream: true, store: false });
    expect(parsed).toEqual(frames.map((data) => ({ event: data.type, data })));
  });

  it("aborting an in-progress adapter read closes the server response without a replay", async () => {
    mode = "hold";
    const abort = new AbortController();
    const response = await adapter.createResponse(request, AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]));
    const events = adapter.parseStream(response);
    expect(await events.next()).toMatchObject({ value: { event: frames[0].type } });
    const pending = events.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(disconnected).resolves.toBe(true);
    expect(received).toHaveLength(1);
  });

  it("preserves pre-stream HTTP 429 and Retry-After without adapter retries", async () => {
    mode = "rate-limit";
    const result = await adapter.createResponse(request, AbortSignal.timeout(3_000)).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CodexApiError);
    const error = result as CodexApiError;
    expect(error.status).toBe(429);
    expect(error.headers?.get("retry-after")).toBe("17");
    expect(JSON.parse(error.body)).toEqual({ error: { code: "rate_limit_exceeded" } });
    expect(received).toHaveLength(1);
  });
});
