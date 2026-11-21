/**
 * UpstreamAdapter that routes through the in-repo Rust service (`native/ocx-router`).
 *
 * Node keeps deciding who serves the request; this adapter only carries the decision to
 * Rust as `x-ocx-*` headers and relays the SSE stream back. When the caller needs a
 * non-Responses wire, it must supply the already-translated body (`transform`), because
 * protocol conversion stays on the Node side.
 */

import type { Dispatcher } from "undici";
import { Agent, fetch as directFetch } from "undici";
import type { CodexResponsesRequest, CodexSSEEvent } from "../proxy/codex-types.js";
import { CodexApiError } from "../proxy/codex-types.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { OpenAIUpstream } from "../proxy/openai-upstream.js";
import { AnthropicUpstream } from "../proxy/anthropic-upstream.js";
import { ResponsesUpstream } from "../proxy/responses-upstream.js";
import { OpenCodeError } from "./errors.js";
import type { OpenCodeUpstreamId, OpenCodeWire } from "./model.js";

const loopbackDispatcher = new Agent();

export interface RustRouterAdapterOptions {
  /** Sidecar base URL, e.g. http://127.0.0.1:8790/v1 */
  baseUrl: string;
  upstream: OpenCodeUpstreamId;
  /** Wire protocol the sidecar should hit upstream. Defaults to responses. */
  protocol?: Extract<OpenCodeWire, "responses" | "chat-completions" | "messages">;
  /** Bare upstream model id (namespace already stripped). */
  modelId: string;
  apiKey?: string;
  /** Stable cache/session identity forwarded as x-opencode-session. */
  sessionId?: string;
  timeoutSeconds?: number;
  /** Build the body for non-Responses wires; required when protocol is not responses. */
  transform?: (req: CodexResponsesRequest) => Record<string, unknown>;
  dispatcher?: Dispatcher;
}

const PATH_BY_WIRE: Record<string, string> = {
  responses: "/responses",
  "chat-completions": "/chat/completions",
  messages: "/messages",
};

/** Strip a trailing `/` so base + path concatenation stays predictable. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class RustRouterAdapter implements UpstreamAdapter {
  readonly tag = "opencode-rust";
  readonly logPath = "/v1/responses";
  readonly #options: RustRouterAdapterOptions;
  readonly #url: string;
  readonly #wire: keyof typeof PATH_BY_WIRE;
  /**
   * Stream parser for the selected protocol. Deliberately the same instances the
   * TypeScript path uses, so a Rust relay and a direct call cannot drift apart in how
   * they normalize events.
   */
  readonly #parser: UpstreamAdapter;
  readonly #streams = new WeakMap<Response, AbortController>();

  constructor(options: RustRouterAdapterOptions) {
    this.#options = options;
    this.#wire = options.protocol ?? "responses";
    const path = PATH_BY_WIRE[this.#wire];
    if (!path) throw new Error(`Unsupported Rust router protocol: ${String(this.#wire)}`);
    if (this.#wire !== "responses" && !options.transform) {
      throw new Error("Rust router adapter needs a transform for non-Responses protocols");
    }
    this.#url = `${trimBaseUrl(options.baseUrl)}${path}`;
    // The base URL here is never contacted: only parseStream is used on these instances.
    this.#parser = this.#wire === "messages"
      ? new AnthropicUpstream(options.apiKey ?? "", "http://127.0.0.1:1/v1", options.dispatcher)
      : this.#wire === "chat-completions"
        ? new OpenAIUpstream("opencode-rust", options.apiKey ?? "", "http://127.0.0.1:1/v1", options.dispatcher)
        : new ResponsesUpstream("opencode-rust", options.apiKey ?? "", "http://127.0.0.1:1/v1", options.dispatcher);
  }

  /** Request URL this adapter posts to (diagnostics/tests). */
  get requestUrl(): string {
    return this.#url;
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const timeoutMs = (this.#options.timeoutSeconds ?? 180) * 1000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const closeStream = new AbortController();
    const requestSignal = AbortSignal.any([signal, timeout, closeStream.signal]);

    const payload = this.#wire === "responses"
      ? { ...req, model: this.#options.modelId, stream: true }
      : { ...this.#options.transform!(req), model: this.#options.modelId, stream: true };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-ocx-upstream": this.#options.upstream,
      "x-ocx-protocol": this.#wire,
      "x-ocx-model": this.#options.modelId,
    };
    if (this.#options.sessionId) headers["x-ocx-session"] = this.#options.sessionId;
    if (this.#options.apiKey) headers.authorization = `Bearer ${this.#options.apiKey}`;

    let response: Awaited<ReturnType<typeof directFetch>>;
    try {
      response = await directFetch(this.#url, {
        method: "POST",
        dispatcher: this.#options.dispatcher ?? loopbackDispatcher,
        redirect: "manual",
        signal: requestSignal,
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      // Transport-level failures are reported in the repository's canonical error shape so
      // the existing classification / retry layer treats Rust like any other upstream.
      if (timeout.aborted) {
        throw new CodexApiError(504, JSON.stringify({ error: { code: "request_timeout", message: "Rust router request timed out" } }));
      }
      if (signal.aborted) {
        throw new CodexApiError(499, JSON.stringify({ error: { code: "cancelled", message: "Request cancelled" } }));
      }
      throw new CodexApiError(502, JSON.stringify({ error: { code: "upstream_unreachable", message: "Rust router is unreachable" } }));
    }

    if (response.ok && response.body) {
      const contentType = response.headers.get("content-type") ?? "";
      if (/^text\/event-stream/i.test(contentType) || !contentType) {
        const stream = new Response(response.body as ReadableStream<Uint8Array>, {
          headers: { "Content-Type": "text/event-stream" },
        });
        this.#streams.set(stream, closeStream);
        return stream;
      }
      return new Response(response.body as ReadableStream<Uint8Array>, {
        status: response.status,
        headers: { "Content-Type": contentType },
      });
    }

    // Error path: preserve the router's JSON body and retry hint for the classifier.
    const text = await response.text().catch(() => "");
    throw new CodexApiError(
      response.status >= 400 ? response.status : 502,
      text || JSON.stringify({ error: { message: `Rust router returned ${response.status}` } }),
      response.headers as unknown as Headers,
    );
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    try {
      yield* this.#parser.parseStream(response);
    } finally {
      const controller = this.#streams.get(response);
      this.#streams.delete(response);
      controller?.abort();
    }
  }
}

function failureFromBody(body: unknown): string | undefined {
  const root = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const error = root?.error && typeof root.error === "object" ? root.error as Record<string, unknown> : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (!code) return undefined;
  return code.replace(/^opencode_/, "").replace(/^ocx_/, "");
}

function messageFromBody(body: unknown): string | undefined {
  const root = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const error = root?.error && typeof root.error === "object" ? root.error as Record<string, unknown> : undefined;
  return typeof error?.message === "string" ? error.message : undefined;
}
