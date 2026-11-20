export type OCGoFailureKind = "invalid_key" | "key_rate_limit" | "quota_group_exhausted" |
  "unknown_rate_limit" | "model_denied" | "policy_rejected" | "other";

/** Only explicit, structured signals can change pool state. Never infer scope from free text. */
export function classifyOCGoFailure(status: number, body: unknown): OCGoFailureKind {
  const error = body !== null && typeof body === "object" && "error" in body ? body.error : undefined;
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (status >= 400 && status < 500 && (code === "content_policy_violation" || code === "cyber_policy" || code === "session_blocked_by_cyber_policy")) return "policy_rejected";
  if (status === 401 && (code === "invalid_api_key" || code === "api_key_revoked")) return "invalid_key";
  if (status === 403 && code === "model_not_allowed") return "model_denied";
  // These scope-specific codes are the loopback contract, not claims about a live provider.
  if (status === 429 && code === "key_rate_limited") return "key_rate_limit";
  if ((status === 429 || status === 402) && code === "quota_group_exhausted") return "quota_group_exhausted";
  return status === 429 ? "unknown_rate_limit" : "other";
}

export class OCGoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly failure: OCGoFailureKind = "other",
  ) {
    super(message);
    this.name = "OCGoError";
  }
}

export function safeRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  let seconds: number;
  if (/^\d{1,8}$/.test(value)) {
    seconds = Number(value);
  } else if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    seconds = Math.ceil((Date.parse(value) - now) / 1000);
  } else {
    return undefined;
  }
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86_400) : undefined;
}
