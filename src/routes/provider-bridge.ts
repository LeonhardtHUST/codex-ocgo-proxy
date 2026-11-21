/**
 * Provider bridge for `kind: "provider"` routes.
 *
 * Today this covers `codex-fallback`: the upstream that used to be reachable only when every
 * Codex account was exhausted. It keeps that same base URL + key pair, but is now selectable
 * explicitly with `codex-fallback:<model>` and carries its own priority in the registry.
 */

import type { Context } from "hono";
import type { FallbackUpstreamStore } from "../auth/fallback-upstream.js";
import { markFallbackUsed } from "../auth/fallback-state.js";
import { ResponsesUpstream } from "../proxy/responses-upstream.js";
import { CODEX_FALLBACK_PROVIDER_ID } from "../opencode/providers.js";
import { handleDirectRequest } from "./shared/direct-request-handler.js";
import type { HandleDirectRequestOptions } from "./shared/proxy-handler-types.js";

export interface ProviderBridgeOptions {
  c: Context;
  route: { providerId: string; resolvedModel: string; modelId?: string };
  proxyReq: HandleDirectRequestOptions["req"];
  fmt: HandleDirectRequestOptions["fmt"];
  fallbackUpstream?: FallbackUpstreamStore;
}

/** JSON error in the same shape the proxy uses elsewhere. */
function errorResponse(c: Context, status: number, code: string, message: string): Response {
  c.status(status as never);
  return c.json({ error: { message, type: "invalid_request_error", param: "model", code } });
}

export async function handleProviderRoute(options: ProviderBridgeOptions): Promise<Response> {
  const { c, route, proxyReq, fmt, fallbackUpstream } = options;

  if (route.providerId !== CODEX_FALLBACK_PROVIDER_ID) {
    return errorResponse(c, 400, "provider_not_implemented", `Provider "${route.providerId}" cannot be selected directly yet`);
  }

  const fallback = fallbackUpstream?.get();
  if (!fallback) {
    return errorResponse(
      c,
      503,
      "codex_fallback_unconfigured",
      "The codex-fallback provider is selected but no fallback upstream is configured",
    );
  }

  const model = route.modelId ?? route.resolvedModel;
  const req: HandleDirectRequestOptions["req"] = {
    ...proxyReq,
    model,
    codexRequest: { ...proxyReq.codexRequest, model },
  };

  markFallbackUsed();
  return handleDirectRequest({
    c,
    upstream: new ResponsesUpstream("fallback", fallback.apiKey, fallback.baseUrl),
    req,
    fmt,
    account: "fallback-upstream",
  });
}
