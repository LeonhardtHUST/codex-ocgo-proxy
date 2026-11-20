import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OCGoLease, OCGoPool, OCGoSession } from "../auth/ocgo-pool.js";
import { readOCGoTokens, type OCGoOutcome, type OCGoTokens } from "../auth/ocgo-usage.js";
import { X_OPENCODE_SESSION_HEADER } from "../proxy/opencode-headers.js";
import type { AppConfig } from "../config-schema.js";
import type { CodexResponsesRequest } from "../proxy/codex-types.js";
import { hasUnsupportedOCGoInput, OCGoError, OCGoUpstream } from "../proxy/ocgo-upstream.js";
import { isRecord } from "../translation/shared-utils.js";
import { collectPassthrough, extractResponseUsage } from "./responses-passthrough.js";
import { recordClientKeyUsage } from "./shared/proxy-handler-utils.js";

export interface OCGoResponsesOptions {
  config: AppConfig["ocgo"];
  pool: Pick<OCGoPool, "acquire" | "beginClientRequest">;
}

function localSession(c: Context, body: Record<string, unknown>): OCGoSession | undefined {
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

export function ocgoErrorResponse(c: Context, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ type: "error", error: { type: status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error", code, message } }, status);
}

export function unsupportedOCGoEndpoint(c: Context): Response {
  return ocgoErrorResponse(c, 400, "ocgo_unsupported_endpoint", "OCGo supports the Responses generation endpoint only");
}

export async function handleOCGoResponses(
  c: Context,
  body: Record<string, unknown>,
  route: { resolvedModel: string; modelId?: string },
  options?: OCGoResponsesOptions,
): Promise<Response> {
  // Do not expose a paid upstream when the app is running in no-auth mode.
  if (c.get("authRole") !== "master" && c.get("authRole") !== "client_key") {
    return ocgoErrorResponse(c, 401, "ocgo_auth_required", "OCGo requires a configured App access key");
  }
  const modelId = route.modelId;
  if (!modelId) return ocgoErrorResponse(c, 400, "ocgo_invalid_model", "Invalid OCGo model ID");
  if (body.previous_response_id != null || body.conversation != null || body.turnState != null ||
      (Array.isArray(body.input) && hasUnsupportedOCGoInput(body.input))) {
    return ocgoErrorResponse(c, 400, "ocgo_unsupported_request", "OCGo supports text and function tools without server-side continuation");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return ocgoErrorResponse(c, 400, "ocgo_invalid_input", "OCGo input must be text or an array of input items");
  }
  if (!options?.config.enabled) return ocgoErrorResponse(c, 503, "ocgo_unavailable", "OCGo is not available");

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
  const deadline = AbortSignal.timeout(options.config.timeout_seconds * 1000);
  const clientSignal = AbortSignal.any([c.req.raw.signal, abort.signal]);
  const signal = AbortSignal.any([clientSignal, deadline]);
  let lease: OCGoLease | undefined;
  let streaming = false;
  const finishRequest = options.pool.beginClientRequest();
  let finishAttempt: ((outcome: OCGoOutcome, usage?: OCGoTokens) => void) | undefined;
  let succeeded = false;
  const finish = () => {
    const terminal = succeeded ? "succeeded" : clientSignal.aborted ? "cancelled" : "failed";
    finishAttempt?.(terminal);
    finishRequest(terminal);
  };
  try {
    if (signal.aborted) return ocgoErrorResponse(c, 499 as ContentfulStatusCode, "ocgo_cancelled", "OCGo request cancelled");
    const session = localSession(c, body);
    const selection = options.pool.acquire(modelId, session);
    if (selection.kind === "busy") return ocgoErrorResponse(c, 503, "ocgo_busy", "OCGo credentials for this model are busy");
    if (selection.kind === "backoff") {
      c.header("Retry-After", String(selection.retryAfterSeconds));
      return ocgoErrorResponse(c, 429, "ocgo_backoff", "OCGo credentials for this model are temporarily unavailable");
    }
    if (selection.kind !== "selected") return ocgoErrorResponse(c, 503, "ocgo_no_credential", "No OCGo credential is available for this model");
    lease = selection.lease;
    const send = async (attempt: OCGoLease) => {
      const upstream = new OCGoUpstream(options.config.base_url, attempt.apiKey, options.config.timeout_seconds);
      try {
        finishAttempt = undefined;
        const response = await upstream.createResponse(request, signal, () => { finishAttempt = attempt.beginAttempt(); });
        return { upstream, response };
      } catch (error) {
        finishAttempt?.(clientSignal.aborted ? "cancelled" : "failed");
        if (error instanceof OCGoError && !signal.aborted) attempt.reportFailure(error.failure, error.retryAfterSeconds);
        throw error;
      }
    };
    // Retry only a structured rejection before a successful HTTP response. Never replay SSE,
    // requests that depend on upstream continuity, or ambiguous transport/rate-limit failures.
    let result;
    try {
      result = await send(lease);
    } catch (error) {
      if (signal.aborted || !(error instanceof OCGoError)) throw error;
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
      finishAttempt?.("succeeded", readOCGoTokens(result.response));
      activeLease.complete();
      recordClientKeyUsage(c, route.resolvedModel, result.usage);
      return c.json(result.response);
    }
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    const streamed = stream(c, async (writer) => {
      writer.onAbort(() => abort.abort());
      try {
        for await (const event of upstream.parseStream(response)) {
          if (clientSignal.aborted) break;
          if (deadline.aborted) {
            await writer.write('event: error\ndata: {"type":"error","error":{"code":"ocgo_timeout","message":"OCGo request timed out"}}\n\n');
            break;
          }
          if (event.event === "response.completed") {
            activeLease.complete();
            const data = event.data;
            succeeded = true;
            finishAttempt?.("succeeded", readOCGoTokens(isRecord(data) ? data.response : undefined));
            const usage = isRecord(data) && isRecord(data.response) ? data.response.usage : undefined;
            recordClientKeyUsage(c, route.resolvedModel, isRecord(usage) ? extractResponseUsage(usage) : undefined);
          }
          await writer.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      } catch {
        if (!signal.aborted) {
          const error = { type: "error", error: { code: "ocgo_stream_failed", message: "OCGo stream did not complete" } };
          await writer.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
        }
      } finally {
        finish();
        abort.abort();
        activeLease.release();
      }
    });
    streaming = true;
    return streamed;
  } catch (error) {
    if (clientSignal.aborted) return ocgoErrorResponse(c, 499 as ContentfulStatusCode, "ocgo_cancelled", "OCGo request cancelled");
    if (deadline.aborted) return ocgoErrorResponse(c, 504, "ocgo_timeout", "OCGo request timed out");
    if (error instanceof OCGoError) {
      if (error.retryAfterSeconds !== undefined) c.header("Retry-After", String(error.retryAfterSeconds));
      return ocgoErrorResponse(c, error.status as ContentfulStatusCode, error.code, error.message);
    }
    return ocgoErrorResponse(c, 502, "ocgo_request_failed", "OCGo request did not complete");
  } finally {
    if (!streaming) {
      finish();
      abort.abort();
      lease?.release();
    }
  }
}
