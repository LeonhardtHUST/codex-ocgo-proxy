/**
 * OpenCode model namespace parsing — pure functions, no configuration access, no I/O.
 *
 * Prefixes (longest first, because `opencode-zen-free:` starts with `opencode-zen-`):
 *   opencode-zen-free:  → tier "zen-free"
 *   opencode-zen:       → tier "zen"
 *   opencode-go:        → tier "go"
 *   opencode:           → no tier; the catalog decides the logical upstream
 *   ocgo:               → legacy alias for `opencode:`, accepted only while the
 *                         legacy switch is on (see `OpenCodeConfig.legacy_prefix`)
 */

export const OPENCODE_PREFIX = "opencode:";
export const OPENCODE_GO_PREFIX = "opencode-go:";
export const OPENCODE_ZEN_PREFIX = "opencode-zen:";
export const OPENCODE_ZEN_FREE_PREFIX = "opencode-zen-free:";
/** Pre-rename prefix, kept for configuration compatibility. */
export const OPENCODE_LEGACY_PREFIX = "ocgo:";

export type OpenCodeTier = "go" | "zen" | "zen-free";
export type OpenCodeNamespace = "opencode" | "opencode-go" | "opencode-zen" | "opencode-zen-free";

export interface OpenCodeModelRef {
  /** Namespace that selected this model. */
  namespace: OpenCodeNamespace;
  /** Logical upstream forced by the namespace, when there is one. */
  tier?: OpenCodeTier;
  /** Bare upstream model id (never contains a namespace prefix). */
  modelId: string;
  /** Prefix that matched, kept so callers can echo the original form. */
  prefix: string;
  /** True when the legacy `ocgo:` prefix was used. */
  legacy: boolean;
}

export interface OpenCodeNamespaceOptions {
  /** Accept `ocgo:` as an alias of `opencode:`. Defaults to true so old configs keep working. */
  legacyOpenCode?: boolean;
}

const NAMESPACE_TIER: Record<OpenCodeNamespace, OpenCodeTier | undefined> = {
  opencode: undefined,
  "opencode-go": "go",
  "opencode-zen": "zen",
  "opencode-zen-free": "zen-free",
};

const PREFIX_TABLE: ReadonlyArray<{
  prefix: string;
  namespace: OpenCodeNamespace;
  legacy: boolean;
}> = [
  { prefix: OPENCODE_ZEN_FREE_PREFIX, namespace: "opencode-zen-free", legacy: false },
  { prefix: OPENCODE_ZEN_PREFIX, namespace: "opencode-zen", legacy: false },
  { prefix: OPENCODE_GO_PREFIX, namespace: "opencode-go", legacy: false },
  { prefix: OPENCODE_PREFIX, namespace: "opencode", legacy: false },
  { prefix: OPENCODE_LEGACY_PREFIX, namespace: "opencode", legacy: true },
];

/** Bare model id rule shared with the legacy OpenCode validator. */
export function isOpenCodeModelId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9._-]/.test(value);
}

/**
 * Split a namespaced model reference.
 * Returns null when the string carries no recognised prefix, and also when the
 * remainder is not a valid model id (callers must not silently strip bad input).
 */
export function parseOpenCodeModelRef(
  raw: string,
  options: OpenCodeNamespaceOptions = {},
): OpenCodeModelRef | null {
  const legacyOpenCode = options.legacyOpenCode ?? true;
  const value = raw.trim();
  for (const entry of PREFIX_TABLE) {
    if (entry.legacy && !legacyOpenCode) continue;
    if (!value.startsWith(entry.prefix)) continue;
    const modelId = value.slice(entry.prefix.length);
    if (!isOpenCodeModelId(modelId)) return null;
    const tier = NAMESPACE_TIER[entry.namespace];
    return {
      namespace: entry.namespace,
      ...(tier ? { tier } : {}),
      modelId,
      prefix: entry.prefix,
      legacy: entry.legacy,
    };
  }
  return null;
}

/** Whether the string belongs to the reserved opencode namespace. */
export function hasOpenCodeNamespace(
  raw: string,
  options: OpenCodeNamespaceOptions = {},
): boolean {
  const legacyOpenCode = options.legacyOpenCode ?? true;
  const value = raw.trim();
  return PREFIX_TABLE.some((entry) => (legacyOpenCode || !entry.legacy) && value.startsWith(entry.prefix));
}

/** Strip a namespace prefix, returning the bare model id or null. */
export function stripOpenCodeNamespace(
  raw: string,
  options: OpenCodeNamespaceOptions = {},
): string | null {
  return parseOpenCodeModelRef(raw, options)?.modelId ?? null;
}

/** Rebuild a namespaced reference. An unknown namespace falls back to `opencode:`. */
export function formatOpenCodeModelRef(ref: { namespace?: OpenCodeNamespace; modelId: string }): string {
  const prefix = ref.namespace === "opencode-go"
    ? OPENCODE_GO_PREFIX
    : ref.namespace === "opencode-zen"
      ? OPENCODE_ZEN_PREFIX
      : ref.namespace === "opencode-zen-free"
        ? OPENCODE_ZEN_FREE_PREFIX
        : OPENCODE_PREFIX;
  return `${prefix}${ref.modelId}`;
}

/** Provider id for a logical upstream tier. */
export function tierToProviderId(tier: OpenCodeTier | undefined): string {
  return tier === "go" ? "opencode-go" : tier === "zen" ? "opencode-zen" : tier === "zen-free" ? "opencode-zen-free" : "opencode-zen";
}

/** Logical upstream tier for a provider id, when the id belongs to opencode. */
export function providerIdToTier(providerId: string): OpenCodeTier | undefined {
  switch (providerId) {
    case "opencode-go": return "go";
    case "opencode-zen": return "zen";
    case "opencode-zen-free": return "zen-free";
    default: return undefined;
  }
}
