import { describe, expect, it } from "vitest";
import { normalizeReasoningEffort, OPENCODE_REASONING_EFFORTS } from "@src/translation/reasoning-effort.js";

describe("normalizeReasoningEffort", () => {
  it("degrades levels opencode does not accept to the nearest weaker one", () => {
    // The live 400 was: Expected 'low' | 'medium' | 'high' | 'xhigh', received 'max'.
    expect(normalizeReasoningEffort("max")).toBe("xhigh");
    expect(normalizeReasoningEffort("ultra")).toBe("xhigh");
    expect(normalizeReasoningEffort("minimal")).toBe("low");
    expect(normalizeReasoningEffort("none")).toBe("low");
  });

  it("keeps values the upstream already accepts", () => {
    for (const effort of OPENCODE_REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(effort)).toBe(effort);
    }
  });

  it("is case and whitespace insensitive", () => {
    expect(normalizeReasoningEffort("  HIGH ")).toBe("high");
    expect(normalizeReasoningEffort("Max")).toBe("xhigh");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeReasoningEffort(null)).toBeUndefined();
    expect(normalizeReasoningEffort("")).toBeUndefined();
    expect(normalizeReasoningEffort("   ")).toBeUndefined();
  });

  it("honours an explicit supported list", () => {
    expect(normalizeReasoningEffort("max", ["low", "medium"])).toBe("medium");
    expect(normalizeReasoningEffort("xhigh", ["low", "medium"])).toBe("medium");
    expect(normalizeReasoningEffort("medium", ["low", "medium"])).toBe("medium");
  });

  it("falls back to the cheapest supported level for unknown labels", () => {
    expect(normalizeReasoningEffort("banana")).toBe("low");
    expect(normalizeReasoningEffort("banana", ["low", "medium"])).toBe("low");
  });
});
