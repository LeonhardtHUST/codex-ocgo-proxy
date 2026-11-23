/**
 * The inbound chat schema must accept every effort level Codex clients send.
 *
 * Regression: it used to enumerate only low|medium|high|xhigh, so `reasoning_effort: "max"`
 * was rejected by zod in ~5 ms — before any upstream capability mapping could degrade it.
 * The visible symptom was a 400 whose body looked exactly like an upstream validation error,
 * which made it look like the remote model rejected the value.
 *
 * Downstream clipping (src/translation/reasoning-effort.ts) is what protects each upstream;
 * the entry schema's job is only to reject values that are not effort levels at all.
 */

import { describe, expect, it } from "vitest";
import { ChatCompletionRequestSchema } from "@src/types/openai.js";

const request = (reasoning_effort?: string) => ({
  model: "opencode-go:deepseek-v4.1-flash",
  messages: [{ role: "user", content: "hi" }],
  ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
});

describe("ChatCompletionRequestSchema reasoning_effort", () => {
  it("accepts every level a Codex client may send", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      const parsed = ChatCompletionRequestSchema.safeParse(request(effort));
      expect(parsed.success, `expected ${effort} to be accepted`).toBe(true);
    }
  });

  it("still rejects values that are not effort levels", () => {
    for (const effort of ["bogus", "HIGHEST", "x-high", ""]) {
      const parsed = ChatCompletionRequestSchema.safeParse(request(effort));
      expect(parsed.success, `expected ${JSON.stringify(effort)} to be rejected`).toBe(false);
    }
  });

  it("keeps reasoning_effort optional", () => {
    expect(ChatCompletionRequestSchema.safeParse(request()).success).toBe(true);
  });
});
