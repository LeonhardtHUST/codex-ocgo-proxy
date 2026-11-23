/**
 * OpenCode bridge for the chat-completions and Anthropic-messages inbound routes.
 *
 * Those routes already translate inbound → Codex and translate the upstream stream back
 * (`handleDirectRequest`). What they lacked was a credential: the OpenCode pool owns key
 * selection, so the bridge acquires a lease, builds the protocol-aware adapter, runs the
 * direct request, and releases the lease when the body settles.
 *
 * The lease is released exactly once, either when the stream completes, when the client
 * cancels, or when the body errors.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OpenCodeLease, OpenCodePool, OpenCodeSession } from "../auth/opencode-pool.js";
import type { AppConfig } from "../config-schema.js";
import type { CodexResponsesRequest } from "../proxy/codex-types.js";
import { OpenCodeUpstream } from "../proxy/opencode-sidecar-upstream.js";
import { X_OPENCODE_SESSION_HEADER } from "../proxy/opencode-headers.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { normalizeReasoningEffort } from "../translation/reasoning-effort.js";
import type { OpenCodeConfig } from "../opencode/config.js";
import { createOpenCodeUpstream, isOpenCodeServing } from "../opencode/dispatch.js";
import type { OpenCodeTier } from "../opencode/namespace.js";
import { stripOpenCodeNamespace } from "../opencode/namespace.js";
import { isRecord } from "../translation/shared-utils.js";
import { opencodeErrorResponse } from "./opencode-responses.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { HandleDirectRequestOptions } from "./shared/proxy-handler-types.js";

export interface OpenCodeBridge {
  /** Legacy OpenCode section (enabled switch + loopback fallback). */
  legacy: AppConfig["ocgo"];
  /** New OpenCode section; undefined on installations that never migrated. */
  opencode?: OpenCodeConfig;
  pool: Pick<OpenCodePool, "acquire" | "beginClientRequest">;
}

/** Session identity for pool affinity: header first, then the translated cache key. */
export function resolveOpenCodeSession(c: Context, cacheKey: string | undefined): OpenCodeSession | undefined {
  const id = c.req.header(X_OPENCODE_SESSION_HEADER)?.trim() || cacheKey?.trim() || "";
  if (!id || id.length > 256) return undefined;
  if (c.get("authRole") === "master") return { id, caller: { kind: "master" } };
  const clientKey: unknown = c.get("clientKey");
  if (isRecord(clientKey) && typeof clientKey.id === "string") {
    return { id, caller: { kind: "client_key", id: clientKey.id } };
  }
  return undefined;
}

/** Wrap a response body so the lease is released when it settles. */
export function withLeaseRelease(response: Response, lease: OpenCodeLease): Response {
  const body = response.body;
  if (!body) {
    lease.complete();
    lease.release();
    return response;
  }
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    if (ok) lease.complete();
    lease.release();
  };
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(true);
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish(false);
        controller.error(error);
      }
    },
    cancel(reason) {
      finish(false);
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}

export interface OpenCodeDirectOptions {
  c: Context;
  bridge: OpenCodeBridge;
  route: { resolvedModel: string; modelId?: string; tier?: string };
  proxyReq: HandleDirectRequestOptions["req"];
  codexRequest: CodexResponsesRequest;
  fmt: HandleDirectRequestOptions["fmt"];
}

/**
 * Serve one chat/messages request through the OpenCode provider family.
 * Returns a fully-formed response (including error responses) so callers can `return`.
 */
export async function handleOpenCodeDirect(options: OpenCodeDirectOptions): Promise<Response> {
  const { c, bridge, route } = options;
  if (!isOpenCodeServing({ legacyEnabled: bridge.legacy.enabled, opencode: bridge.opencode })) {
    return opencodeErrorResponse(c, 503, "ocgo_unavailable", "OpenCode is not available");
  }

  const bareId = route.modelId ?? stripOpenCodeNamespace(route.resolvedModel, { legacyOpenCode: true }) ?? "";
  if (!bareId) return opencodeErrorResponse(c, 400, "ocgo_invalid_model", "Invalid OpenCode model ID");

  const tier = route.tier as OpenCodeTier | undefined;
  const session = resolveOpenCodeSession(c, options.codexRequest.prompt_cache_key ?? undefined);
  const selection = bridge.pool.acquire(bareId, session);
  if (selection.kind === "busy") {
    return opencodeErrorResponse(c, 503, "ocgo_busy", "OpenCode credentials for this model are busy");
  }
  if (selection.kind === "backoff") {
    c.header("Retry-After", String(selection.retryAfterSeconds));
    return opencodeErrorResponse(c, 429, "ocgo_backoff", "OpenCode credentials for this model are temporarily unavailable");
  }
  if (selection.kind !== "selected") {
    return opencodeErrorResponse(c, 503, "ocgo_no_credential", "No OpenCode credential is available for this model");
  }

  const lease = selection.lease;
  let upstream: UpstreamAdapter;
  try {
    upstream = bridge.opencode
      ? createOpenCodeUpstream({
          config: bridge.opencode,
          modelId: bareId,
          tier,
          apiKey: lease.apiKey,
          ...(session ? { sessionId: session.id } : {}),
        })
      : new OpenCodeUpstream(bridge.legacy.base_url, lease.apiKey, bridge.legacy.timeout_seconds);
  } catch {
    lease.release();
    return opencodeErrorResponse(c, 502, "ocgo_request_failed", "OpenCode upstream could not be prepared");
  }

  // opencode accepts only low|medium|high|xhigh; normalise once here so every downstream
  // adapter (chat / messages / responses) sends a value the upstream accepts.
  const codexRequest: typeof options.codexRequest = options.codexRequest.reasoning
    ? {
        ...options.codexRequest,
        model: route.resolvedModel,
        reasoning: {
          ...options.codexRequest.reasoning,
          effort: normalizeReasoningEffort(options.codexRequest.reasoning.effort),
        },
      }
    : { ...options.codexRequest, model: route.resolvedModel };
  const directReq: HandleDirectRequestOptions["req"] = {
    ...options.proxyReq,
    model: route.resolvedModel,
    codexRequest,
  };

  try {
    const response = await handleDirectRequest({
      c,
      upstream,
      req: directReq,
      fmt: options.fmt,
    });
    if (options.codexRequest.stream !== true) {
      // A non-streaming response body was already aggregated inside handleDirectRequest, so
      // withLeaseRelease would wait for a settle that never comes and strand the lease.
      if (response.status < 400) lease.complete();
      lease.release();
      return response;
    }
    return withLeaseRelease(response, lease);
  } catch (error) {
    // Unknown transport failures carry no healthy signal for the pool; just free the key.
    lease.release();
    const status = (error as { status?: number }).status;
    return opencodeErrorResponse(
      c,
      (typeof status === "number" && status >= 400 ? status : 502) as ContentfulStatusCode,
      "ocgo_request_failed",
      "OpenCode request did not complete",
    );
  }
}
