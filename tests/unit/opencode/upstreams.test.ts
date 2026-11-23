import { describe, expect, it } from "vitest";
import type { OpenCodeModelEntry } from "@src/opencode/model.js";
import {
  buildRequestUrl,
  firstForwardableWire,
  isForwardableWire,
  isUpstreamEnabled,
  resolveUpstreamApiKey,
  resolveUpstreamRoot,
  upstreamCandidates,
  wireBaseUrl,
} from "@src/opencode/upstreams.js";
import { OpenCodeConfigSchema as SchemaForNormalize, normalizeOpenCodeEnabled } from "@src/opencode/config.js";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import {
  OpenCodeError,
  classifyOpenCodeFailure,
  extractErrorType,
  safeRetryAfter,
  toOpenCodeError,
} from "@src/opencode/errors.js";
import { resolveWireProtocol } from "@src/opencode/adapter.js";
import { ProtocolMatrix } from "@src/opencode/protocol-matrix.js";

const config = OpenCodeConfigSchema.parse({ enabled: true, upstreams: { zen_free: { enabled: true } } });

describe("opencode upstreams", () => {
  it("resolves the documented roots by default", () => {
    expect(resolveUpstreamRoot(config, "go")).toBe("https://opencode.ai/inference/go");
    expect(resolveUpstreamRoot(config, "zen")).toBe("https://opencode.ai/inference");
    expect(resolveUpstreamRoot(config, "zen-free")).toBe("https://opencode.ai/inference");
  });

  it("honours configured overrides and strips trailing slashes", () => {
    const custom = OpenCodeConfigSchema.parse({ upstreams: { go: { base_url: "https://example.test/go/" } } });
    expect(resolveUpstreamRoot(custom, "go")).toBe("https://example.test/go");
  });

  it("exposes static keys only for the upstream they belong to", () => {
    const withKeys = OpenCodeConfigSchema.parse({ upstreams: { go: { api_key: "go-key" }, zen: { api_key: "zen-key" } } });
    expect(resolveUpstreamApiKey(withKeys, "go")).toBe("go-key");
    expect(resolveUpstreamApiKey(withKeys, "zen")).toBe("zen-key");
    expect(resolveUpstreamApiKey(withKeys, "zen-free")).toBe("zen-key");
  });

  it("gates each upstream on its own switch, ignoring the retired global one", () => {
    expect(isUpstreamEnabled(config, "go")).toBe(true);
    expect(isUpstreamEnabled(config, "zen-free")).toBe(true);
    // No global gate any more: defaults keep go/zen on, zen-free stays opt-in.
    expect(isUpstreamEnabled(OpenCodeConfigSchema.parse({}), "go")).toBe(true);
    expect(isUpstreamEnabled(OpenCodeConfigSchema.parse({}), "zen-free")).toBe(false);
    expect(isUpstreamEnabled(OpenCodeConfigSchema.parse({ upstreams: { go: { enabled: false } } }), "go")).toBe(false);
    // A stale global false must not disable anything.
    expect(isUpstreamEnabled(OpenCodeConfigSchema.parse({ enabled: false }), "go")).toBe(true);
  });

  it("maps each wire to the documented base URL and request path", () => {
    const root = "https://opencode.ai/inference/go";
    expect(wireBaseUrl(root, "responses")).toBe(`${root}/openai/v1`);
    expect(wireBaseUrl(root, "chat-completions")).toBe(`${root}/openai/v1`);
    expect(wireBaseUrl(root, "messages")).toBe(`${root}/anthropic/v1`);
    expect(wireBaseUrl(root, "google")).toBe(`${root}/google/v1beta`);
    expect(wireBaseUrl(root, "systemone")).toBeUndefined();

    expect(buildRequestUrl(root, "chat-completions", "glm-5.3")).toBe(`${root}/openai/v1/chat/completions`);
    expect(buildRequestUrl(root, "responses", "gpt-6-sol")).toBe(`${root}/openai/v1/responses`);
    expect(buildRequestUrl(root, "messages", "claude-sonnet-5-5")).toBe(`${root}/anthropic/v1/messages`);
    expect(buildRequestUrl(root, "google", "gemini-4-argon")).toBe(`${root}/google/v1beta/models/gemini-4-argon:generateContent`);
  });

  it("only forwards chat-capable wires", () => {
    expect(isForwardableWire("responses")).toBe(true);
    expect(isForwardableWire("embeddings")).toBe(false);
    expect(firstForwardableWire(["systemone"])).toBeUndefined();
    expect(firstForwardableWire(["chat-completions"])).toBe("chat-completions");
  });

  it("orders upstream candidates paid before free", () => {
    expect(upstreamCandidates(undefined, ["zen-free", "go", "zen"])).toEqual(["go", "zen", "zen-free"]);
    expect(upstreamCandidates("zen-free", ["go", "zen", "zen-free"])).toEqual(["zen-free"]);
  });
});

describe("opencode errors", () => {
  it("reads both gateway envelopes", () => {
    expect(extractErrorType({ type: "error", error: { type: "AuthError" } })).toBe("AuthError");
    expect(extractErrorType({ error: { type: "authentication_error" } })).toBe("authentication_error");
    expect(extractErrorType({ error: { message: "Free usage limit reached" } })).toBe("FreeUsageLimitError");
    expect(extractErrorType({ error: { message: "Request is missing x-opencode-session" } })).toBe("MissingSessionID");
  });

  it("classifies the failures the retry layer cares about", () => {
    expect(classifyOpenCodeFailure(429, { error: { type: "FreeUsageLimitError" } })).toBe("free_limit");
    expect(classifyOpenCodeFailure(401, { type: "error", error: { type: "AuthError" } })).toBe("invalid_key");
    expect(classifyOpenCodeFailure(400, { error: { type: "MissingSessionID" } })).toBe("unsupported_capability");
    expect(classifyOpenCodeFailure(429, {})).toBe("rate_limited");
    expect(classifyOpenCodeFailure(403, {})).toBe("model_denied");
    expect(classifyOpenCodeFailure(503, {})).toBe("upstream_unavailable");
    expect(classifyOpenCodeFailure(400, { error: { message: "Model X is not supported for format openai" } })).toBe("unsupported_protocol");
  });

  it("clamps Retry-After into a sane window", () => {
    expect(safeRetryAfter("120")).toBe(120);
    expect(safeRetryAfter("0")).toBeUndefined();
    expect(safeRetryAfter("abc")).toBeUndefined();
    expect(safeRetryAfter("999999")).toBe(86_400);
    expect(safeRetryAfter(null)).toBeUndefined();
  });

  it("builds a typed upstream error", () => {
    const error = toOpenCodeError(429, { error: { type: "FreeUsageLimitError" } }, 71894);
    expect(error).toBeInstanceOf(OpenCodeError);
    expect(error.failure).toBe("free_limit");
    expect(error.code).toBe("opencode_free_limit");
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(71894);
  });
});

describe("wire selection", () => {
  const entry: OpenCodeModelEntry = {
    id: "minimax-m3",
    upstream: "go",
    protocols: ["messages"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: true,
    free: false,
    selectable: true,
    source: "catalog",
  };

  it("uses the native protocol when nothing overrides it", () => {
    expect(resolveWireProtocol(entry)).toBe("messages");
  });

  it("honours an explicit forwardable request", () => {
    expect(resolveWireProtocol(entry, { requested: "responses" })).toBe("responses");
    expect(resolveWireProtocol(entry, { requested: "embeddings" })).toBe("messages");
  });

  it("applies a live correction for the (upstream, model) pair", () => {
    const matrix = new ProtocolMatrix();
    matrix.recordCorrection("go", "minimax-m3", "responses");
    expect(resolveWireProtocol(entry, { matrix })).toBe("responses");
    expect(resolveWireProtocol({ ...entry, upstream: "zen" }, { matrix })).toBe("messages");
  });

  it("returns undefined for models this router cannot forward", () => {
    expect(resolveWireProtocol({ ...entry, protocols: ["systemone"] })).toBeUndefined();
    expect(resolveWireProtocol(undefined)).toBeUndefined();
  });
});

describe("normalizeOpenCodeEnabled", () => {
  it("flips a stale false and reports it once", () => {
    const raw: Record<string, unknown> = { opencode: { enabled: false } };
    expect(normalizeOpenCodeEnabled(raw)).toBe(true);
    expect((raw.opencode as Record<string, unknown>).enabled).toBe(true);
  });

  it("leaves true and absent sections alone", () => {
    const withTrue: Record<string, unknown> = { opencode: { enabled: true } };
    expect(normalizeOpenCodeEnabled(withTrue)).toBe(false);
    expect((withTrue.opencode as Record<string, unknown>).enabled).toBe(true);

    const absent: Record<string, unknown> = {};
    expect(normalizeOpenCodeEnabled(absent)).toBe(false);
    expect(absent.opencode).toBeUndefined();
  });

  it("survives a malformed section", () => {
    expect(normalizeOpenCodeEnabled({ opencode: "nope" })).toBe(false);
    expect(normalizeOpenCodeEnabled({ opencode: [] })).toBe(false);
  });

  it("defaults to enabled so the family needs no opt-in", () => {
    expect(SchemaForNormalize.parse({}).enabled).toBe(true);
  });
});
