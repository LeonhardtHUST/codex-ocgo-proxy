import { describe, expect, it } from "vitest";
import {
  formatOpenCodeModelRef,
  hasOpenCodeNamespace,
  isOpenCodeModelId,
  parseOpenCodeModelRef,
  providerIdToTier,
  stripOpenCodeNamespace,
  tierToProviderId,
} from "@src/opencode/namespace.js";

describe("opencode namespace parsing", () => {
  it("parses the bare namespace and leaves the tier to the catalog", () => {
    expect(parseOpenCodeModelRef("opencode:deepseek-v4.1-flash")).toEqual({
      namespace: "opencode",
      modelId: "deepseek-v4.1-flash",
      prefix: "opencode:",
      legacy: false,
    });
  });

  it.each([
    ["opencode-go:glm-5.3", "opencode-go", "go", "glm-5.3"],
    ["opencode-zen:kimi-k3", "opencode-zen", "zen", "kimi-k3"],
    ["opencode-zen-free:big-pickle", "opencode-zen-free", "zen-free", "big-pickle"],
  ])("parses tier prefix %s", (raw, namespace, tier, modelId) => {
    expect(parseOpenCodeModelRef(raw)).toMatchObject({ namespace, tier, modelId, legacy: false });
  });

  it("prefers the longest prefix so zen-free never degrades to zen", () => {
    const ref = parseOpenCodeModelRef("opencode-zen-free:jev-1.13-free");
    expect(ref?.namespace).toBe("opencode-zen-free");
    expect(ref?.modelId).toBe("jev-1.13-free");
  });

  it("accepts the legacy ocgo prefix only while the switch is on", () => {
    expect(parseOpenCodeModelRef("ocgo:kimi-k2.5")).toMatchObject({
      namespace: "opencode",
      modelId: "kimi-k2.5",
      legacy: true,
    });
    expect(parseOpenCodeModelRef("ocgo:kimi-k2.5", { legacyOcgo: false })).toBeNull();
    expect(parseOpenCodeModelRef("opencode:kimi-k2.5", { legacyOcgo: false })).not.toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseOpenCodeModelRef("  opencode:gpt-6-sol  ")).toMatchObject({ modelId: "gpt-6-sol" });
  });

  it.each([
    "opencode:",
    "opencode:zen/wrong",
    "opencode:with space",
    `opencode:${"a".repeat(129)}`,
    "gpt-6-sol",
    "opencode",
    "",
  ])("rejects %s", (raw) => {
    expect(parseOpenCodeModelRef(raw)).toBeNull();
  });

  it("validates bare model ids with the shared rule", () => {
    expect(isOpenCodeModelId("deepseek-v4.1-flash")).toBe(true);
    expect(isOpenCodeModelId("")).toBe(false);
    expect(isOpenCodeModelId("a/b")).toBe(false);
    expect(isOpenCodeModelId("a".repeat(129))).toBe(false);
  });

  it("detects namespace membership without validating the id", () => {
    expect(hasOpenCodeNamespace("opencode:")).toBe(true);
    expect(hasOpenCodeNamespace("opencode:zen/wrong")).toBe(true);
    expect(hasOpenCodeNamespace("ocgo:model")).toBe(true);
    expect(hasOpenCodeNamespace("ocgo:model", { legacyOcgo: false })).toBe(false);
    expect(hasOpenCodeNamespace("gpt-6-sol")).toBe(false);
  });

  it("strips the prefix and reports invalid ids as null", () => {
    expect(stripOpenCodeNamespace("opencode-go:glm-5.3")).toBe("glm-5.3");
    expect(stripOpenCodeNamespace("opencode:")).toBeNull();
    expect(stripOpenCodeNamespace("claude-sonnet-5-5")).toBeNull();
  });

  it("round-trips through the formatter", () => {
    expect(formatOpenCodeModelRef({ namespace: "opencode-go", modelId: "glm-5.3" })).toBe("opencode-go:glm-5.3");
    expect(formatOpenCodeModelRef({ namespace: "opencode-zen-free", modelId: "big-pickle" })).toBe("opencode-zen-free:big-pickle");
    expect(formatOpenCodeModelRef({ modelId: "deepseek-v4.1-flash" })).toBe("opencode:deepseek-v4.1-flash");
  });

  it("maps tiers to provider ids and back", () => {
    expect(tierToProviderId("go")).toBe("opencode-go");
    expect(tierToProviderId("zen")).toBe("opencode-zen");
    expect(tierToProviderId("zen-free")).toBe("opencode-zen-free");
    expect(tierToProviderId(undefined)).toBe("opencode-zen");
    expect(providerIdToTier("opencode-zen-free")).toBe("zen-free");
    expect(providerIdToTier("codex-official")).toBeUndefined();
  });
});
