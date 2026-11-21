/**
 * Cache header aggregation (req: unify cache-related headers so prompt caches hit).
 *
 * Upstream facts this module encodes:
 *   - `x-opencode-session` must be a stable per-conversation id, format
 *     `ses_` + 12 hex + 14 alphanumeric; Go rejects requests without it (400).
 *   - Prompt-cache reuse keys off that session id, so the identity must be stable
 *     across requests of one conversation and must not leak credentials.
 *   - Rotating the session identity is required when the credential or channel is
 *     no longer trustworthy (`FreeUsageLimitError`, auth failure), and harmful otherwise.
 *
 * Nothing here performs I/O; callers pass the request shape they own.
 */

import { createHash } from "node:crypto";

/** Everything the identity may be derived from, in priority order. */
export interface CacheSeed {
  /** Client-provided cache key, if any. */
  promptCacheKey?: string;
  /** Client conversation/session id (header or body), if any. */
  clientSessionId?: string;
  /** Resolved upstream model id. */
  model: string;
  /** Stable instructions/system prompt used as a content seed when no id exists. */
  instructions?: string;
  /** First user message text, used as the last content seed. */
  firstUserText?: string;
  /** Logical upstream, so the same conversation does not collide across upstreams. */
  upstream?: string;
}

const SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable per-conversation identity (hex, 32 chars). Contains no credential material. */
export function deriveCacheIdentity(seed: CacheSeed): string {
  const parts = [
    seed.promptCacheKey?.trim() ?? "",
    seed.clientSessionId?.trim() ?? "",
    seed.model,
    seed.upstream ?? "",
    seed.instructions ?? "",
    seed.firstUserText ?? "",
  ];
  return sha256Hex(parts.join("\u0000"));
}

/**
 * Build the `x-opencode-session` value. Deterministic function of the identity, so
 * the same conversation keeps the same value across requests and processes.
 */
export function buildOpenCodeSessionId(identity: string): string {
  const hex = sha256Hex(identity);
  const head = hex.slice(0, 12); // must be lowercase hex
  // 14 alphanumeric chars derived from a second slice of the same digest.
  const tail = hex.slice(12, 24);
  let out = "";
  for (let i = 0; i < 14; i++) {
    const byte = parseInt(tail.slice((i * 2) % 12, ((i * 2) % 12) + 2), 16);
    out += ALPHANUMERIC[byte % ALPHANUMERIC.length];
  }
  return `ses_${head}${out}`;
}

/** True when the value satisfies the upstream session id format. */
export function isValidSessionId(value: string): boolean {
  return SESSION_PATTERN.test(value);
}

/**
 * Stable project identity for `x-opencode-project` (16 lowercase hex chars).
 *
 * Derived from a configured seed, never from the conversation: the upstream uses this header
 * to group cache entries, so a per-conversation value would defeat cross-conversation reuse.
 */
export function buildProjectId(seed: string): string {
  return sha256Hex(seed).slice(0, 16);
}

/**
 * Failures that must invalidate the conversation identity: the credential or the
 * free channel is done for, and reusing the identity would bind fresh traffic to a
 * poisoned session. Ordinary errors keep the identity so prefix caches survive.
 */
const IDENTITY_RESET_FAILURES = new Set([
  "free_limit",
  "invalid_key",
  "auth_failed",
  "quota_group_exhausted",
]);

export function shouldRotateIdentity(failure: string | undefined): boolean {
  return failure !== undefined && IDENTITY_RESET_FAILURES.has(failure);
}

export type PromptCacheRetention = "24h" | "in_memory" | "off";

/** Map the configured retention to the wire value; "off" means "do not send the field". */
export function resolveCacheRetention(retention: PromptCacheRetention | undefined): string | undefined {
  switch (retention) {
    case "in_memory": return "in_memory";
    case "24h": return "24h";
    case "off":
    case undefined: return undefined;
    default: return undefined;
  }
}

/**
 * Providers whose prompt-cache marker syntax differs; sending Anthropic-style
 * `cache_control` to them is rejected or ignored, so breakpoints are skipped.
 */
export function shouldSkipCacheBreakpoints(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.startsWith("glm") || id.includes("zhipu") || id.includes("chatglm");
}

export interface CacheHintOptions {
  identity: string;
  /** Retention for Responses-protocol requests. */
  retention?: PromptCacheRetention;
  /** Whether the entry declares prompt-cache support. */
  supportsPromptCacheKey?: boolean;
}

/**
 * Apply cache hints to an OpenAI Responses-shaped body (mutates a shallow copy).
 * Returns the original body when hints are disabled so callers can pass through.
 */
export function applyResponsesCacheHints<T extends Record<string, unknown>>(body: T, options: CacheHintOptions): T {
  if (options.supportsPromptCacheKey === false) return body;
  const next: Record<string, unknown> = { ...body, prompt_cache_key: options.identity };
  const retention = resolveCacheRetention(options.retention);
  if (retention) next.prompt_cache_retention = retention;
  return next as T;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  cache_control?: { type: string; ttl?: string };
  [key: string]: unknown;
}

/**
 * Add Anthropic `cache_control` breakpoints to system / tools / latest user message.
 * Mutates a structural copy; returns the body unchanged when the model opts out.
 */
export function applyAnthropicCacheBreakpoints<T extends Record<string, unknown>>(body: T, modelId: string): T {
  if (shouldSkipCacheBreakpoints(modelId)) return body;

  const marker = { type: "ephemeral" };
  const next: Record<string, unknown> = { ...body };

  // system: array form gets a marker on the last block; string form is left alone
  // because converting it would change the request the client made.
  if (Array.isArray(next.system) && next.system.length > 0) {
    const blocks = [...(next.system as AnthropicContentBlock[])];
    const lastIndex = blocks.length - 1;
    blocks[lastIndex] = { ...blocks[lastIndex], cache_control: marker };
    next.system = blocks;
  }

  // tools: mark the last tool definition.
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    const tools = [...(next.tools as AnthropicContentBlock[])];
    const lastIndex = tools.length - 1;
    tools[lastIndex] = { ...tools[lastIndex], cache_control: marker };
    next.tools = tools;
  }

  // messages: mark the last content block of the newest user message.
  if (Array.isArray(next.messages) && next.messages.length > 0) {
    const messages = [...(next.messages as Array<Record<string, unknown>>)];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user") continue;
      const content = messages[i].content;
      if (Array.isArray(content) && content.length > 0) {
        const blocks = [...(content as AnthropicContentBlock[])];
        const lastIndex = blocks.length - 1;
        blocks[lastIndex] = { ...blocks[lastIndex], cache_control: marker };
        messages[i] = { ...messages[i], content: blocks };
      }
      break;
    }
    next.messages = messages;
  }

  return next as T;
}

export interface OpenCodeHeaderOptions {
  identity: string;
  /** `opencode/<version>`; defaults to a pinned client string. */
  clientVersion?: string;
  /** Project seed (already hashed by the caller when needed). */
  projectSeed?: string;
}

/** The header set every opencode upstream expects (Go enforces the session one). */
export function buildOpenCodeHeaders(options: OpenCodeHeaderOptions): Record<string, string> {
  const version = options.clientVersion ?? "1.0.0";
  const headers: Record<string, string> = {
    "x-opencode-client": "cli",
    "x-opencode-session": buildOpenCodeSessionId(options.identity),
    "User-Agent": `opencode/${version}`,
  };
  if (options.projectSeed) headers["x-opencode-project"] = buildProjectId(options.projectSeed);
  return headers;
}
