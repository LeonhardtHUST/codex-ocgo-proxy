/**
 * Reasoning-effort capability mapping.
 *
 * Codex models advertise efforts up to `max`/`ultra`, but other upstreams accept a
 * narrower set: opencode rejects anything above `xhigh` with a 400
 * (`invalid_enum_value ... Expected 'low' | 'medium' | 'high' | 'xhigh', received 'max'`).
 * Forwarding the caller's raw value therefore breaks the request instead of degrading it.
 *
 * The rule is "closest supported value", searching weaker values first (asking for less
 * reasoning is always safe) and only then stronger ones.
 */

/** What opencode accepts today (verified against a live 400 payload). */
export const OPENCODE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Ordered strongest → weakest, used to find the nearest supported neighbour. */
const DESCENDING_EFFORTS = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none"] as const;

/** Unknown labels degrade to the cheapest level, never to the most expensive one. */
const SAFE_FALLBACK = "low";

/**
 * Map `effort` onto `supported`, or return undefined when it cannot be mapped.
 * Unsupported levels degrade to the nearest weaker supported level, then the nearest stronger one.
 */
export function normalizeReasoningEffort(
  effort: string | null | undefined,
  supported: readonly string[] = OPENCODE_REASONING_EFFORTS,
): string | undefined {
  if (typeof effort !== "string") return undefined;
  const wanted = effort.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  if (supported.includes(wanted)) return wanted;

  const start = DESCENDING_EFFORTS.indexOf(wanted as (typeof DESCENDING_EFFORTS)[number]);
  if (start < 0) {
    // Unknown label: degrade to the cheapest supported level rather than guessing high.
    return supported.includes(SAFE_FALLBACK) ? SAFE_FALLBACK : supported[0];
  }
  for (let i = start + 1; i < DESCENDING_EFFORTS.length; i += 1) {
    const candidate = DESCENDING_EFFORTS[i];
    if (supported.includes(candidate)) return candidate;
  }
  for (let i = start - 1; i >= 0; i -= 1) {
    const candidate = DESCENDING_EFFORTS[i];
    if (supported.includes(candidate)) return candidate;
  }
  return undefined;
}
