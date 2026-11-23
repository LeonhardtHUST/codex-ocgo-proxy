import { Agent, fetch as directFetch } from "undici";
import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";
import { parseSSEStream, sseSnippet } from "./codex-sse.js";
import { normalizeReasoningEffort } from "../translation/reasoning-effort.js";
import type { UpstreamAdapter } from "./upstream-adapter.js";
import { isOpenCodeKey, isOpenCodeModelId, opencodeResponsesUrl, stripOpenCodeModelPrefix } from "../opencode-legacy-config.js";

import { classifyOpenCodeFailure, OpenCodeError, safeRetryAfter } from "./opencode-sidecar-errors.js";
export { OpenCodeError } from "./opencode-sidecar-errors.js";

// Don't use global fetch, the global dispatcher, or the Custom proxy resolver.
const loopbackDispatcher = new Agent();
/** Read only small JSON diagnostics and never retain the raw bytes. */
async function readErrorBody(response: Awaited<ReturnType<typeof directFetch>>): Promise<unknown> {
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return JSON.parse(text + decoder.decode()) as unknown;
      bytes += next.value.byteLength;
      if (bytes > 8192) return undefined;
      text += decoder.decode(next.value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const unsupportedInputTypes = new Set(["compaction", "compaction_trigger", "context_compaction", "item_reference", "input_image", "input_file"]);

/** Server/Rust session continuation and multimodal fallbacks are outside the MVP. */
export function hasUnsupportedOpenCodeInput(input: readonly unknown[]): boolean {
  // Rust's image detector scans all JSON values and keys, not just content parts.
  // Keep this iterative so deeply nested client input can't overflow the stack.
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === "input_image") return true;
    if (Array.isArray(value)) {
      for (const part of value) pending.push(part);
    } else if (value && typeof value === "object") {
      for (const [key, part] of Object.entries(value)) {
        if (key === "input_image") return true;
        pending.push(part);
      }
    }
  }
  return input.some((item) => {
    const entry = asRecord(item);
    if (!entry) return false;
    if (typeof entry.type === "string" && unsupportedInputTypes.has(entry.type)) return true;
    return Array.isArray(entry.content) && entry.content.some((part) => {
      const type = asRecord(part)?.type;
      return typeof type === "string" && unsupportedInputTypes.has(type);
    });
  });
}

/** One request, one selected credential, no retries. Only the App may select another key. */
export class OpenCodeUpstream implements UpstreamAdapter {
  readonly tag = "opencode-sidecar";
  readonly logPath = "/v1/responses";
  readonly #url: string;
  readonly #key: string;
  readonly #timeoutMs: number;
  readonly #streams = new WeakMap<Response, AbortController>();

  constructor(baseUrl: string, key: string, timeoutSeconds: number) {
    const url = opencodeResponsesUrl(baseUrl);
    if (!url) throw new Error("Invalid OpenCode loopback URL");
    if (!isOpenCodeKey(key)) throw new Error("Invalid OpenCode credential");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
      throw new Error("Invalid OpenCode timeout");
    }
    this.#url = url;
    this.#key = key;
    this.#timeoutMs = timeoutSeconds * 1000;
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal, onDispatch?: () => void): Promise<Response> {
    const id = stripOpenCodeModelPrefix(req.model) ?? "";
    if (!isOpenCodeModelId(id)) throw new OpenCodeError(400, "ocgo_invalid_model", "Invalid OpenCode model ID");
    if (req.previous_response_id !== undefined || hasUnsupportedOpenCodeInput(req.input) ||
        req.tools?.some((tool) => asRecord(tool)?.type !== "function")) {
      throw new OpenCodeError(400, "ocgo_unsupported_request", "OpenCode supports text and function tools without server-side continuation");
    }
    const payload = {
      model: `opencode-go/${id}`,
      stream: true,
      store: false,
      input: req.input,
      instructions: req.instructions ?? undefined,
      tools: req.tools,
      tool_choice: req.tool_choice,
      parallel_tool_calls: req.parallel_tool_calls,
      text: req.text,
      // opencode rejects efforts above `xhigh`; degrade instead of forwarding a 400 trigger.
      reasoning: req.reasoning
        ? { ...req.reasoning, effort: normalizeReasoningEffort(req.reasoning.effort) }
        : undefined,
    };
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const closeStream = new AbortController();
    const requestSignal = AbortSignal.any([signal, timeout, closeStream.signal]);
    let response: Awaited<ReturnType<typeof directFetch>>;
    try {
      const body = JSON.stringify(payload);
      requestSignal.throwIfAborted();
      onDispatch?.();
      response = await directFetch(this.#url, {
        method: "POST",
        dispatcher: loopbackDispatcher,
        redirect: "manual",
        signal: requestSignal,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch {
      if (timeout.aborted) throw new OpenCodeError(504, "ocgo_timeout", "OpenCode request timed out");
      if (signal.aborted) throw new OpenCodeError(499, "ocgo_cancelled", "OpenCode request cancelled");
      throw new OpenCodeError(502, "ocgo_unreachable", "Cannot reach the local OpenCode backend");
    }
    if (response.ok && /^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") && response.body) {
      // Don't expose Rust's headers. The body stays linked to the same abort/timeout signal.
      const stream = new Response(response.body as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": "text/event-stream" },
      });
      this.#streams.set(stream, closeStream);
      return stream;
    }

    // Do not turn a slow error body into a timeout that hides a 429.
    const status = response.status;
    const retryAfter = status === 429 || status === 402 ? safeRetryAfter(response.headers.get("retry-after")) : undefined;
    let errorBody: unknown;
    if (status >= 400 && status < 500) {
      const readDeadline = setTimeout(() => closeStream.abort(), 300);
      readDeadline.unref();
      try { errorBody = await readErrorBody(response); } finally { clearTimeout(readDeadline); }
    }
    closeStream.abort();
    const failure = classifyOpenCodeFailure(status, errorBody);
    switch (failure) {
      case "invalid_key": throw new OpenCodeError(status, "ocgo_invalid_key", "OpenCode credential was rejected", undefined, failure);
      case "model_denied": throw new OpenCodeError(status, "ocgo_model_denied", "OpenCode credential cannot access the model", undefined, failure);
      case "policy_rejected": throw new OpenCodeError(status, "ocgo_policy_rejected", "OpenCode rejected the request under its content policy", undefined, failure);
      case "quota_group_exhausted": throw new OpenCodeError(status, "ocgo_quota_exhausted", "OpenCode reported shared quota exhaustion", retryAfter, failure);
      case "key_rate_limit":
      case "unknown_rate_limit": throw new OpenCodeError(status, "ocgo_rate_limited", "OpenCode backend returned a rate limit", retryAfter, failure);
    }
    if (status >= 400 && status < 500) {
      throw new OpenCodeError(status, "ocgo_rejected", "OpenCode backend rejected the request");
    }
    throw new OpenCodeError(502, "ocgo_bad_response", "Invalid response from the local OpenCode backend");
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    const failed = (detail?: string): CodexSSEEvent => ({
      event: "error",
      data: {
        type: "error",
        error: {
          code: "ocgo_stream_failed",
          message: detail ? `OpenCode stream did not complete: ${detail}` : "OpenCode stream did not complete",
        },
      },
    });
    // Frames that are not JSON objects are skipped rather than fatal: keepalive text, a
    // proxy's HTML error page or a truncated frame must not kill an otherwise healthy
    // dialogue, and forwarding them would break the client's SSE JSON parsing.
    let skippedFrames = 0;
    let firstSkipped: string | undefined;
    try {
      for await (const frame of parseSSEStream(response)) {
        const data = asRecord(frame.data);
        if (!data) {
          skippedFrames += 1;
          if (firstSkipped === undefined) {
            const raw = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
            firstSkipped = sseSnippet(raw).replaceAll(this.#key, "[redacted]");
          }
          continue;
        }
        const type = frame.event || (typeof data?.type === "string" ? data.type : "");
        if (data.type !== type || !/^[a-z][a-z_.]{0,95}$/.test(type) || type.includes(this.#key) ||
            type === "error" || type === "response.failed" || type === "response.incomplete") {
          yield failed(`unexpected event "${type}"`);
          return;
        }
        // Defensive suppression if an upstream unexpectedly echoes the credential in a JSON event.
        const serialized = JSON.stringify(data, (key, value: unknown) =>
          key.includes(this.#key) ? undefined : typeof value === "string" ? value.replaceAll(this.#key, "[redacted]") : value);
        yield { event: type, data: JSON.parse(serialized) as unknown };
        if (type === "response.completed") return;
      }
      yield failed(
        skippedFrames > 0
          ? `stream ended after skipping ${skippedFrames} non-JSON frame(s), first: ${firstSkipped}`
          : undefined,
      );
    } catch {
      yield failed();
    } finally {
      // The shared parser can leave its decoding pipe locked after an early return.
      // Abort the underlying request instead of relying on body.cancel().
      const closeStream = this.#streams.get(response);
      this.#streams.delete(response);
      closeStream?.abort();
    }
  }
}
