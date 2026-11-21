import { describe, expect, it } from "vitest";
import {
  applyAnthropicCacheBreakpoints,
  applyResponsesCacheHints,
  buildOpenCodeHeaders,
  buildOpenCodeSessionId,
  deriveCacheIdentity,
  isValidSessionId,
  resolveCacheRetention,
  shouldRotateIdentity,
  shouldSkipCacheBreakpoints,
} from "@src/opencode/cache-identity.js";

describe("cache identity", () => {
  it("derives a deterministic identity from the same conversation seed", () => {
    const seed = { promptCacheKey: "conv-1", model: "deepseek-v4.1-flash", upstream: "zen" };
    expect(deriveCacheIdentity(seed)).toBe(deriveCacheIdentity({ ...seed }));
    expect(deriveCacheIdentity(seed)).toHaveLength(64);
  });

  it("separates conversations by model and upstream", () => {
    const base = { promptCacheKey: "conv-1" };
    const a = deriveCacheIdentity({ ...base, model: "glm-5.3", upstream: "zen" });
    const b = deriveCacheIdentity({ ...base, model: "glm-5.3", upstream: "go" });
    const c = deriveCacheIdentity({ ...base, model: "kimi-k3", upstream: "zen" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("falls back to content seeds when the client sends no identifiers", () => {
    const identity = deriveCacheIdentity({
      model: "kimi-k3",
      instructions: "you are a helpful agent",
      firstUserText: "hello",
    });
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveCacheIdentity({ model: "kimi-k3", instructions: "you are a helpful agent", firstUserText: "hello" })).toBe(identity);
    expect(deriveCacheIdentity({ model: "kimi-k3", instructions: "you are a helpful agent", firstUserText: "bye" })).not.toBe(identity);
  });

  it("emits session ids in the format the gateway validates", () => {
    const session = buildOpenCodeSessionId(deriveCacheIdentity({ model: "glm-5.3", clientSessionId: "s1" }));
    expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(isValidSessionId(session)).toBe(true);
    expect(isValidSessionId("ses_X")).toBe(false);
    expect(isValidSessionId("ses_0123456789ab" + "A".repeat(13))).toBe(false);
  });

  it("keeps the session stable for the same identity", () => {
    const identity = deriveCacheIdentity({ promptCacheKey: "stable", model: "glm-5.3" });
    expect(buildOpenCodeSessionId(identity)).toBe(buildOpenCodeSessionId(identity));
  });

  it("rotates the identity only for credential or channel failures", () => {
    expect(shouldRotateIdentity("free_limit")).toBe(true);
    expect(shouldRotateIdentity("invalid_key")).toBe(true);
    expect(shouldRotateIdentity("auth_failed")).toBe(true);
    expect(shouldRotateIdentity("quota_group_exhausted")).toBe(true);
    expect(shouldRotateIdentity("rate_limited")).toBe(false);
    expect(shouldRotateIdentity("upstream_unavailable")).toBe(false);
    expect(shouldRotateIdentity(undefined)).toBe(false);
  });

  it("builds the opencode client header set", () => {
    const headers = buildOpenCodeHeaders({ identity: "abc", projectSeed: "D:/projects/demo" });
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-session"]).toMatch(/^ses_/);
    expect(headers["x-opencode-project"]).toHaveLength(16);
    expect(headers["User-Agent"]).toMatch(/^opencode\//);
  });

  it("maps cache retention modes without sending unknown values", () => {
    expect(resolveCacheRetention("24h")).toBe("24h");
    expect(resolveCacheRetention("in_memory")).toBe("in_memory");
    expect(resolveCacheRetention("off")).toBeUndefined();
    expect(resolveCacheRetention(undefined)).toBeUndefined();
  });

  it("injects responses cache hints only when the entry supports them", () => {
    const body = { model: "gpt-6-sol", input: "hi" };
    expect(applyResponsesCacheHints(body, { identity: "id", retention: "24h" })).toEqual({
      model: "gpt-6-sol",
      input: "hi",
      prompt_cache_key: "id",
      prompt_cache_retention: "24h",
    });
    expect(applyResponsesCacheHints(body, { identity: "id", supportsPromptCacheKey: false })).toBe(body);
  });

  it("adds anthropic breakpoints to tools and the newest user message", () => {
    const body = {
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "lookup" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "new" }] },
      ],
    };
    const next = applyAnthropicCacheBreakpoints(body, "claude-sonnet-5-5") as typeof body;
    expect(next.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(next.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(next.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(next.messages[0]?.content.at(-1)?.cache_control).toBeUndefined();
  });

  it("skips breakpoints for GLM / Zhipu models", () => {
    expect(shouldSkipCacheBreakpoints("glm-5.3")).toBe(true);
    expect(shouldSkipCacheBreakpoints("GLM-5.3-Flash")).toBe(true);
    expect(shouldSkipCacheBreakpoints("zhipu-glm")).toBe(true);
    expect(shouldSkipCacheBreakpoints("claude-sonnet-5-5")).toBe(false);

    const body = { model: "glm-5.3", tools: [{ name: "lookup" }] };
    expect(applyAnthropicCacheBreakpoints(body, "glm-5.3")).toBe(body);
  });
});
