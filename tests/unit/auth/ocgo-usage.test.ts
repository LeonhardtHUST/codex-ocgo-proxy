import { expect, it } from "vitest";
import { OCGoUsageCounter, readOCGoTokens } from "@src/auth/ocgo-usage.js";

it("counts reported zero and cached tokens separately without inventing missing counts", () => {
  const usage = new OCGoUsageCounter();
  usage.begin()("succeeded", readOCGoTokens({ usage: { input_tokens: 12, output_tokens: 0, input_tokens_details: { cached_tokens: 4 } } }));
  usage.begin()("succeeded", readOCGoTokens({ usage: { output_tokens: -1, input_tokens: "7" } }));
  expect(usage.snapshot()).toMatchObject({
    started: 2, succeeded: 2, inFlight: 0,
    inputTokens: { total: 12, reported: 1, unknown: 1 },
    outputTokens: { total: 0, reported: 1, unknown: 1 },
    cachedTokens: { total: 4, reported: 1, unknown: 1 },
  });
});

it("settles an attempt only once and does not count in-flight samples as unknown", () => {
  const usage = new OCGoUsageCounter();
  const settle = usage.begin();
  expect(usage.snapshot()).toMatchObject({ inFlight: 1, inputTokens: { total: null, unknown: 0 } });
  settle("cancelled");
  settle("succeeded", { inputTokens: 5 });
  expect(usage.snapshot()).toMatchObject({ cancelled: 1, succeeded: 0, inFlight: 0, inputTokens: { total: null, unknown: 1 } });
});
