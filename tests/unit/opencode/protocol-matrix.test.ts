import { describe, expect, it } from "vitest";
import type { OpenCodeModelEntry } from "@src/opencode/model.js";
import {
  ProtocolMatrix,
  isUnsupportedProtocolError,
  nextProtocol,
  protocolCacheKey,
} from "@src/opencode/protocol-matrix.js";

function entry(overrides: Partial<OpenCodeModelEntry> = {}): OpenCodeModelEntry {
  return {
    id: "minimax-m3",
    upstream: "zen",
    protocols: ["chat-completions"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolCalling: true,
    free: false,
    selectable: true,
    source: "catalog",
    ...overrides,
  };
}

describe("protocol matrix", () => {
  it("defaults to the native protocol", () => {
    const matrix = new ProtocolMatrix();
    expect(matrix.resolve(entry())).toBe("chat-completions");
  });

  it("honours an explicitly requested protocol the entry supports", () => {
    const matrix = new ProtocolMatrix();
    const target = entry({ protocols: ["chat-completions", "messages"] });
    expect(matrix.resolve(target, "messages")).toBe("messages");
  });

  it("ignores a requested protocol the entry does not support", () => {
    const matrix = new ProtocolMatrix();
    expect(matrix.resolve(entry(), "responses")).toBe("chat-completions");
  });

  it("keys corrections by (upstream, model), not by model id alone", () => {
    const matrix = new ProtocolMatrix();
    matrix.recordCorrection("zen", "minimax-m3", "chat-completions");
    matrix.recordCorrection("go", "minimax-m3", "messages");

    expect(matrix.correctionFor("zen", "minimax-m3")?.wire).toBe("chat-completions");
    expect(matrix.correctionFor("go", "minimax-m3")?.wire).toBe("messages");
    expect(protocolCacheKey("go", "minimax-m3")).not.toBe(protocolCacheKey("zen", "minimax-m3"));

    expect(matrix.resolve(entry({ upstream: "go", protocols: ["messages"] }))).toBe("messages");
    expect(matrix.resolve(entry({ upstream: "zen" }))).toBe("chat-completions");
  });

  it("applies the correction to the matching pair only", () => {
    const matrix = new ProtocolMatrix();
    matrix.recordCorrection("zen", "qwen3.8-max", "messages");
    expect(matrix.resolve(entry({ id: "qwen3.8-max", upstream: "zen", protocols: ["chat-completions"] }))).toBe("messages");
    expect(matrix.resolve(entry({ id: "qwen3.8-max", upstream: "go", protocols: ["chat-completions"] }))).toBe("chat-completions");
  });

  it("expires corrections after the ttl", () => {
    let now = 1_000;
    const matrix = new ProtocolMatrix({ now: () => now, ttlMs: 500 });
    matrix.recordCorrection("zen", "glm-5.3", "messages");
    expect(matrix.correctionFor("zen", "glm-5.3")).toBeDefined();
    now += 501;
    expect(matrix.correctionFor("zen", "glm-5.3")).toBeUndefined();
    expect(matrix.size()).toBe(0);
  });

  it("clears corrections by pair, by upstream, or entirely", () => {
    const matrix = new ProtocolMatrix();
    matrix.recordCorrection("zen", "a", "messages");
    matrix.recordCorrection("zen", "b", "messages");
    matrix.recordCorrection("go", "a", "messages");
    matrix.clear("zen", "a");
    expect(matrix.size()).toBe(2);
    matrix.clear("zen");
    expect(matrix.size()).toBe(1);
    matrix.clear();
    expect(matrix.size()).toBe(0);
  });

  it("prefers responses, then messages, then chat when retrying a sibling", () => {
    const target = entry({ protocols: ["chat-completions", "messages", "responses"] });
    expect(nextProtocol(target, "chat-completions")).toBe("responses");
    expect(nextProtocol(target, "responses")).toBe("messages");
    expect(nextProtocol(entry(), "chat-completions")).toBeUndefined();
  });

  it("recognizes upstream protocol rejections without matching unrelated 400s", () => {
    expect(isUnsupportedProtocolError(400, '{"error":{"message":"Model X is not supported for format openai"}}')).toBe(true);
    expect(isUnsupportedProtocolError(400, '{"error":{"type":"unsupported_protocol"}}')).toBe(true);
    expect(isUnsupportedProtocolError(400, '{"error":{"message":"invalid_protocol"}}')).toBe(true);
    expect(isUnsupportedProtocolError(400, '{"error":{"message":"content policy violation"}}')).toBe(false);
    expect(isUnsupportedProtocolError(500, "not supported for format")).toBe(false);
  });
});
