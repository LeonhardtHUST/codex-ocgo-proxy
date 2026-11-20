export type OCGoOutcome = "succeeded" | "failed" | "cancelled";
const fields = ["inputTokens", "outputTokens", "cachedTokens"] as const;
type TokenField = typeof fields[number];
export type OCGoTokens = Partial<Record<TokenField, number>>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function readOCGoTokens(response: unknown): OCGoTokens {
  const usage = record(record(response)?.usage);
  const pairs = [usage?.input_tokens, usage?.output_tokens, record(usage?.input_tokens_details)?.cached_tokens];
  const result: OCGoTokens = {};
  fields.forEach((field, i) => {
    const value = pairs[i];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[field] = value;
  });
  return result;
}

/** Process-local aggregate. No request payload, caller identity or credential is stored. */
export class OCGoUsageCounter {
  readonly #totals = { started: 0, succeeded: 0, failed: 0, cancelled: 0 };
  readonly #tokens = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  readonly #reported = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  begin(): (outcome: OCGoOutcome, usage?: OCGoTokens) => void {
    this.#totals.started++;
    let done = false;
    return (outcome, usage) => {
      if (done) return;
      done = true;
      this.#totals[outcome]++;
      for (const field of fields) {
        const count = usage?.[field];
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
        this.#tokens[field] = Math.min(Number.MAX_SAFE_INTEGER, this.#tokens[field] + count);
        this.#reported[field]++;
      }
    };
  }

  snapshot() {
    const terminal = this.#totals.succeeded + this.#totals.failed + this.#totals.cancelled;
    const tokens = (field: TokenField) => ({
      // Totals reflect reported values only; unknown entries are never estimated.
      total: this.#reported[field] ? this.#tokens[field] : null,
      reported: this.#reported[field],
      unknown: terminal - this.#reported[field],
    });
    return {
      ...this.#totals,
      inFlight: this.#totals.started - terminal,
      inputTokens: tokens("inputTokens"),
      outputTokens: tokens("outputTokens"),
      cachedTokens: tokens("cachedTokens"),
    };
  }
}
