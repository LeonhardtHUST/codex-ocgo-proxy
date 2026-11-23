import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OpenCodeLease, OpenCodePool, OpenCodeSession } from "../auth/opencode-pool.js";
import { readOpenCodeTokens, type OpenCodeOutcome, type OpenCodeTokens } from "../auth/opencode-usage.js";
import { X_OPENCODE_SESSION_HEADER } from "../proxy/opencode-headers.js";
import type { AppConfig } from "../config-schema.js";
import type { CodexResponsesRequest } from "../proxy/codex-types.js";
import { hasUnsupportedOpenCodeInput, OpenCodeError, OpenCodeUpstream } from "../proxy/opencode-sidecar-upstream.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type { OpenCodeConfig } from "../opencode/config.js";
import type { OpenCodeTier } from "../opencode/namespace.js";
import { createOpenCodeUpstream, isOpenCodeServing, resolveTimeoutSeconds } from "../opencode/dispatch.js";
import { isRecord } from "../translation/shared-utils.js";
import { collectPassthrough, extractResponseUsage } from "./responses-passthrough.js";
import { recordClientKeyUsage } from "./shared/proxy-handler-utils.js";

export interface OpenCodeResponsesOptions {
  config: AppConfig["ocgo"];
  pool: Pick<OpenCodePool, "acquire" | "beginClientRequest">;
  /**
   * OpenCode provider family. When present, requests are forwarded straight to
   * opencode.ai on the protocol the catalog declares; when absent, the legacy
   * loopback OpenCode sidecar is used unchanged.
   */
  opencode?: OpenCodeConfig;
  /** Test seam: build the adapter for one attempt. */
  createUpstream?: (args: { modelId: string; apiKey: string; tier?: OpenCodeTier }) => UpstreamAdapter;
}

function localSession(c: Context, body: Record<string, unknown>): OpenCodeSession | undefined {
  const id = c.req.header(X_OPENCODE_SESSION_HEADER)?.trim() ||
    (typeof body.prompt_cache_key === "string" ? body.prompt_cache_key.trim() : "");
  if (!id || id.length > 256) return undefined;
  if (c.get("authRole") === "master") return { id, caller: { kind: "master" } };
  const clientKey: unknown = c.get("clientKey");
  if (isRecord(clientKey) && typeof clientKey.id === "string") {
    return { id, caller: { kind: "client_key", id: clientKey.id } };
  }
  return undefined;
}

export function opencodeErrorResponse(c: Context, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ type: "error", error: { type: status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error", code, message } }, status);
}

export function unsupportedOpenCodeEndpoint(c: Context): Response {
  return opencodeErrorResponse(c, 400, "ocgo_unsupported_endpoint", "OpenCode supports the Responses generation endpoint only");
}

export async function handleOpenCodeResponses(
  c: Context,
  body: Record<string, unknown>,
  route: { resolvedModel: string; modelId?: string; tier?: string },
  options?: OpenCodeResponsesOptions,
): Promise<Response> {
  // Do not expose a paid upstream when the app is running in no-auth mode.
  if (c.get("authRole") !== "master" && c.get("authRole") !== "client_key") {
    return opencodeErrorResponse(c, 401, "ocgo_auth_required", "OpenCode requires a configured App access key");
  }
  const modelId = route.modelId;
  if (!modelId) return opencodeErrorResponse(c, 400, "ocgo_invalid_model", "Invalid OpenCode model ID");
  if (body.previous_response_id != null || body.conversation != null || body.turnState != null ||
      (Array.isArray(body.input) && hasUnsupportedOpenCodeInput(body.input))) {
    return opencodeErrorResponse(c, 400, "ocgo_unsupported_request", "OpenCode supports text and function tools without server-side continuation");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return opencodeErrorResponse(c, 400, "ocgo_invalid_input", "OpenCode input must be text or an array of input items");
  }
  if (!options || !isOpenCodeServing({ legacyEnabled: options.config.enabled, opencode: options.opencode })) {
    return opencodeErrorResponse(c, 503, "ocgo_unavailable", "OpenCode is not available");
  }
  const tier = route.tier as OpenCodeTier | undefined;
  const timeoutSeconds = resolveTimeoutSeconds({
    opencode: options.opencode,
    legacyTimeoutSeconds: options.config.timeout_seconds,
  });

  const request: CodexResponsesRequest = {
    model: route.resolvedModel,
    input: typeof body.input === "string"
      ? [{ role: "user", content: [{ type: "input_text", text: body.input }] }]
      : body.input as CodexResponsesRequest["input"],
    stream: true,
    store: false,
  };
  if (typeof body.instructions === "string") request.instructions = body.instructions;
  if (Array.isArray(body.tools)) request.tools = body.tools;
  if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.tool_choice === "string") request.tool_choice = body.tool_choice;
  else if (isRecord(body.tool_choice) && typeof body.tool_choice.type === "string") {
    request.tool_choice = {
      type: body.tool_choice.type,
      ...(typeof body.tool_choice.name === "string" ? { name: body.tool_choice.name } : {}),
    };
  }

  const abort = new AbortController();
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  const clientSignal = AbortSignal.any([c.req.raw.signal, abort.signal]);
  const signal = AbortSignal.any([clientSignal, deadline]);
  let lease: OpenCodeLease | undefined;
  let streaming = false;
  const finishRequest = options.pool.beginClientRequest();
  let finishAttempt: ((outcome: OpenCodeOutcome, usage?: OpenCodeTokens) => void) | undefined;
  let succeeded = false;
  const finish = () => {
    const terminal = succeeded ? "succeeded" : clientSignal.aborted ? "cancelled" : "failed";
    finishAttempt?.(terminal);
    finishRequest(terminal);
  };
  try {
    if (signal.aborted) return opencodeErrorResponse(c, 499 as ContentfulStatusCode, "ocgo_cancelled", "OpenCode request cancelled");
    const session = localSession(c, body);
    const selection = options.pool.acquire(modelId, session);
    if (selection.kind === "busy") return opencodeErrorResponse(c, 503, "ocgo_busy", "OpenCode credentials for this model are busy");
    if (selection.kind === "backoff") {
      c.header("Retry-After", String(selection.retryAfterSeconds));
      return opencodeErrorResponse(c, 429, "ocgo_backoff", "OpenCode credentials for this model are temporarily unavailable");
    }
    if (selection.kind !== "selected") return opencodeErrorResponse(c, 503, "ocgo_no_credential", "No OpenCode credential is available for this model");
    lease = selection.lease;
    const send = async (attempt: OpenCodeLease) => {
      const upstream = options.createUpstream
        ? options.createUpstream({ modelId, apiKey: attempt.apiKey, ...(tier ? { tier } : {}) })
        : options.opencode
          ? createOpenCodeUpstream({ config: options.opencode, modelId, tier, apiKey: attempt.apiKey })
          : new OpenCodeUpstream(options.config.base_url, attempt.apiKey, timeoutSeconds);
      try {
        finishAttempt = undefined;
        const response = await upstream.createResponse(request, signal, () => { finishAttempt = attempt.beginAttempt(); });
        return { upstream, response };
      } catch (error) {
        finishAttempt?.(clientSignal.aborted ? "cancelled" : "failed");
        if (error instanceof OpenCodeError && !signal.aborted) attempt.reportFailure(error.failure, error.retryAfterSeconds);
        throw error;
      }
    };
    // Retry only a structured rejection before a successful HTTP response. Never replay SSE,
    // requests that depend on upstream continuity, or ambiguous transport/rate-limit failures.
    let result;
    try {
      result = await send(lease);
    } catch (error) {
      if (signal.aborted || !(error instanceof OpenCodeError)) throw error;
      const { failure } = error;
      const requireIndependentGroup = failure === "quota_group_exhausted";
      if (requireIndependentGroup ? !lease.quotaGroup : !["invalid_key", "model_denied", "key_rate_limit"].includes(failure)) throw error;
      const previous = lease;
      previous.release();
      const replacement = options.pool.acquire(modelId, session, { previous, requireIndependentGroup });
      if (replacement.kind !== "selected") throw error;
      lease = replacement.lease;
      result = await send(lease);
    }
    const { upstream, response } = result;
    const activeLease = lease;
    if (body.stream !== true) {
      const result = await collectPassthrough(upstream, response, route.resolvedModel);
      signal.throwIfAborted();
      succeeded = true;
      finishAttempt?.("succeeded", readOpenCodeTokens(result.response));
      activeLease.complete();
      recordClientKeyUsage(c, route.resolvedModel, result.usage);
      return c.json(result.response);
    }
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    const streamed = stream(c, async (writer) => {
      // Mark streaming only once the callback actually runs: if the client disappears
      // before that, the outer finally must still release the lease.
      streaming = true;
      writer.onAbort(() => abort.abort());
      try {
        for await (const event of upstream.parseStream(response)) {
          if (clientSignal.aborted) break;
          if (deadline.aborted) {
            await writer.write('event: error\ndata: {"type":"error","error":{"code":"ocgo_timeout","message":"OpenCode request timed out"}}\n\n');
            break;
          }
          if (event.event === "response.completed") {
            activeLease.complete();
            const data = event.data;
            succeeded = true;
            finishAttempt?.("succeeded", readOpenCodeTokens(isRecord(data) ? data.response : undefined));
            const usage = isRecord(data) && isRecord(data.response) ? data.response.usage : undefined;
            recordClientKeyUsage(c, route.resolvedModel, isRecord(usage) ? extractResponseUsage(usage) : undefined);
          }
          await writer.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      } catch {
        if (!signal.aborted) {
          const error = { type: "error", error: { code: "ocgo_stream_failed", message: "OpenCode stream did not complete" } };
          await writer.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
        }
      } finally {
        finish();
        abort.abort();
        activeLease.release();
      }
    });
    return streamed;
  } catch (error) {
    if (clientSignal.aborted) return opencodeErrorResponse(c, 499 as ContentfulStatusCode, "ocgo_cancelled", "OpenCode request cancelled");
    if (deadline.aborted) return opencodeErrorResponse(c, 504, "ocgo_timeout", "OpenCode request timed out");
    if (error instanceof OpenCodeError) {
      if (error.retryAfterSeconds !== undefined) c.header("Retry-After", String(error.retryAfterSeconds));
      return opencodeErrorResponse(c, error.status as ContentfulStatusCode, error.code, error.message);
    }
    return opencodeErrorResponse(c, 502, "ocgo_request_failed", "OpenCode request did not complete");
  } finally {
    if (!streaming) {
      finish();
      abort.abort();
      lease?.release();
    }
  }
}
