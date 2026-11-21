/**
 * OpenCode upstream compatibility headers.
 *
 * Console Go (https://opencode.ai/zen/go) rejects requests that omit `x-opencode-session`,
 * and routes a dialogue efficiently only when it also receives the real client User-Agent.
 * Direct clients (Codex, Kilo Code) send both; through the proxy they are dropped or
 * overwritten, so adapters re-apply them here.
 *
 * Injection happens when either:
 *   - the base URL targets an opencode host (default behaviour), or
 *   - the request carries `opencodeUpstream: true`, which the OpenCode adapter always sets.
 *
 * The second case matters for custom/proxy base URLs: the adapter knows who it is talking to,
 * and a hostname heuristic would silently drop the identity headers there.
 */

import type { CodexResponsesRequest } from "./codex-types.js";

export const X_OPENCODE_SESSION_HEADER = "x-opencode-session";
export const X_OPENCODE_CLIENT_HEADER = "x-opencode-client";
export const X_OPENCODE_PROJECT_HEADER = "x-opencode-project";

/** Pinned client identity; the upstream uses it for routing and quota attribution. */
export const DEFAULT_OPENCODE_CLIENT = "cli";

/** True when the baseUrl targets an OpenCode / Console Go upstream. */
export function isOpenCodeUpstream(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "opencode.ai"
      || host.endsWith(".opencode.ai")
      || /\/zen\/go(?:\/|$)/.test(url.pathname);
  } catch {
    return /opencode\.ai|\/zen\/go(?:\/|$)/.test(baseUrl);
  }
}

type OpenCodeHeaderRequest = Pick<
  CodexResponsesRequest,
  "clientUserAgent" | "opencodeSessionId" | "opencodeUpstream" | "opencodeClient" | "opencodeProjectId"
>;

/**
 * Apply the compatibility headers. The client-provided User-Agent is forwarded verbatim
 * (when present); the session header prefers the client's own id and falls back to a stable
 * per-conversation id so each dialogue keeps routing to the same backend.
 */
export function applyOpenCodeHeaders(
  headers: Record<string, string>,
  baseUrl: string,
  request: OpenCodeHeaderRequest,
  fallbackSessionId: string,
  options: { force?: boolean } = {},
): void {
  const forced = options.force ?? request.opencodeUpstream === true;
  if (!forced && !isOpenCodeUpstream(baseUrl)) return;
  if (request.clientUserAgent) headers["User-Agent"] = request.clientUserAgent;
  headers[X_OPENCODE_SESSION_HEADER] = request.opencodeSessionId ?? fallbackSessionId;
  headers[X_OPENCODE_CLIENT_HEADER] = request.opencodeClient ?? DEFAULT_OPENCODE_CLIENT;
  if (request.opencodeProjectId) headers[X_OPENCODE_PROJECT_HEADER] = request.opencodeProjectId;
}
