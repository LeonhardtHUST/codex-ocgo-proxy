/**
 * Error taxonomy for the OpenCode provider family.
 *
 * The gateway speaks two different error envelopes:
 *   zen : { "type": "error", "error": { "type": "AuthError" | "FreeUsageLimitError" | ... } }
 *   go  : { "error": { "type": "authentication_error" | "MissingSessionID" | ... } }
 * Both are normalized here so the retry / fallback layers see one vocabulary.
 */

export type OpenCodeFailure =
  | "invalid_key"
  | "auth_failed"
  | "model_denied"
  | "rate_limited"
  | "free_limit"
  | "quota_exhausted"
  | "upstream_unavailable"
  | "timeout"
  | "policy_rejected"
  | "unsupported_protocol"
  | "unsupported_capability"
  | "unknown";

export interface OpenCodeErrorInit {
  status: number;
  code: string;
  message: string;
  failure?: OpenCodeFailure;
  retryAfterSeconds?: number;
}

export class OpenCodeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly failure: OpenCodeFailure;
  readonly retryAfterSeconds?: number;

  constructor(init: OpenCodeErrorInit) {
    super(init.message);
    this.name = "OpenCodeError";
    this.status = init.status;
    this.code = init.code;
    this.failure = init.failure ?? "unknown";
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Pull the gateway's error type string out of either envelope. */
export function extractErrorType(body: unknown): string | undefined {
  const root = asRecord(body);
  const inner = asRecord(root?.error) ?? asRecord(root);
  const candidates = [inner?.type, inner?.code, root?.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  const message = inner?.message;
  if (typeof message === "string") {
    if (/free usage limit/i.test(message)) return "FreeUsageLimitError";
    if (/missing x-opencode-session/i.test(message)) return "MissingSessionID";
    if (/requires an api key|missing api key/i.test(message)) return "AuthError";
  }
  return undefined;
}

/** Map HTTP status + envelope to one failure class. */
export function classifyOpenCodeFailure(status: number, body?: unknown): OpenCodeFailure {
  const type = (extractErrorType(body) ?? "").toLowerCase();
  if (type.includes("freeusagelimit") || type.includes("free_usage_limit")) return "free_limit";
  if (type.includes("missingsessionid")) return "unsupported_capability";
  if (type.includes("autherror") || type.includes("authentication")) return "invalid_key";
  if (type.includes("permission") || type.includes("forbidden")) return "model_denied";
  if (type.includes("ratelimit") || type.includes("rate_limit")) return "rate_limited";
  if (type.includes("policy") || type.includes("content_filter")) return "policy_rejected";
  if (type.includes("quota")) return "quota_exhausted";

  if (status === 401) return "invalid_key";
  if (status === 402) return "quota_exhausted";
  if (status === 403) return "model_denied";
  if (status === 429) return "rate_limited";
  if (status === 400 && /not supported for format|unsupported_protocol|invalid_protocol/i.test(JSON.stringify(body ?? ""))) {
    return "unsupported_protocol";
  }
  if (status === 400) return "unsupported_capability";
  if (status >= 500) return "upstream_unavailable";
  return "unknown";
}

/** Clamp a Retry-After header into a sane range (1s .. 24h). */
export function safeRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(Math.max(Math.round(seconds), 1), 86_400);
}

/** Build the upstream-facing error for a failed request. */
export function toOpenCodeError(status: number, body: unknown, retryAfterSeconds?: number): OpenCodeError {
  const failure = classifyOpenCodeFailure(status, body);
  const type = extractErrorType(body) ?? `http_${status}`;
  return new OpenCodeError({
    status: status >= 400 ? status : 502,
    code: `opencode_${failure}`,
    message: `OpenCode upstream rejected the request (${type})`,
    failure,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}
