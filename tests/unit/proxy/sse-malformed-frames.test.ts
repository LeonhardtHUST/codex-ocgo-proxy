/**
 * Malformed-frame resilience.
 *
 * Counterpart of the `ocgo2api-rs` failure "Error reading response: malformed server-sent
 * event json": both halves of that class matter here.
 *
 *   - emitting it: writing `data: <non-JSON>` into our own SSE breaks every client, so the
 *     WebSocket passthrough paths guard against it (covered in ws-transport/ws-pool tests);
 *   - choking on it: a keepalive, a proxy's HTML error page or a truncated frame must not
 *     kill an otherwise healthy dialogue.
 */

import { describe, expect, it } from "vitest";
import { isJsonText, parseSSEStream, sseSnippet, type CodexSSEEvent } from "@src/proxy/codex-sse.js";
import { OCGoUpstream } from "@src/proxy/ocgo-upstream.js";

const sseResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });

async function collect(stream: AsyncGenerator<CodexSSEEvent>): Promise<CodexSSEEvent[]> {
  const events: CodexSSEEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("SSE payload guards", () => {
  it("accepts any JSON value and rejects plain text", () => {
    expect(isJsonText('{"a":1}')).toBe(true);
    expect(isJsonText("[1,2]")).toBe(true);
    expect(isJsonText("42")).toBe(true);
    expect(isJsonText('"a string"')).toBe(true);
    expect(isJsonText("<html>502 Bad Gateway</html>")).toBe(false);
    expect(isJsonText("")).toBe(false);
    expect(isJsonText("   ")).toBe(false);
    expect(isJsonText('{"truncated":')).toBe(false);
  });

  it("snippets stay single-line and bounded", () => {
    expect(sseSnippet("a\n  b\tc")).toBe("a b c");
    const long = "x".repeat(200);
    expect(sseSnippet(long).length).toBeLessThanOrEqual(121);
    expect(sseSnippet(long).endsWith("…")).toBe(true);
  });
});

describe("parseSSEStream with malformed frames", () => {
  it("does not throw on a non-JSON data frame", async () => {
    const events = await collect(parseSSEStream(sseResponse(
      'event: response.created\ndata: {"type":"response.created"}\n\n' +
        "data: <html>oops</html>\n\n",
    )));
    expect(events).toHaveLength(2);
    // The parser degrades to the raw payload instead of throwing.
    expect(events[1]?.data).toBe("<html>oops</html>");
  });

  it("ignores comment-only blocks", async () => {
    const events = await collect(parseSSEStream(sseResponse(": keep-alive\n\n")));
    expect(events).toHaveLength(0);
  });
});

describe("OCGoUpstream.parseStream resilience", () => {
  const upstream = new OCGoUpstream("http://127.0.0.1:1/v1", "test-key", 3);

  it("skips a malformed frame and still completes the dialogue", async () => {
    const body =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
      "data: <html>502 Bad Gateway</html>\n\n" +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n';

    const events = await collect(upstream.parseStream(sseResponse(body)));
    expect(events.map((event) => event.event)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
  });

  it("reports the skipped count when the stream ends without completing", async () => {
    const events = await collect(upstream.parseStream(sseResponse("data: <html>nope</html>\n\n")));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("error");
    expect(JSON.stringify(events[0]?.data)).toContain("skipping 1 non-JSON frame");
  });

  it("never echoes the credential in the diagnostic", async () => {
    const events = await collect(upstream.parseStream(sseResponse("data: boom test-key boom\n\n")));
    expect(JSON.stringify(events[0]?.data)).not.toContain("test-key");
    expect(JSON.stringify(events[0]?.data)).toContain("[redacted]");
  });
});
