/**
 * Normalized OpenCode model entry.
 *
 * The upstream catalog (https://opencode.ai/inference/v1/models and
 * /inference/go/v1/models) is the authority for "which models exist"; this shape is
 * the local normalization everything else (protocol matrix, /models, pools) reads.
 *
 * Fact that shapes this model: the same model id can speak a different wire protocol
 * on different upstreams (minimax-m3 is chat-completions on zen, messages on go).
 * Protocol lookup therefore always keys on the (upstream, id) pair, never on id alone.
 */

/** Logical upstream that serves an entry. */
export type OpenCodeUpstreamId = "go" | "zen" | "zen-free";

/** Wire protocols the OpenCode gateway exposes. */
export type OpenCodeWire =
  | "responses"
  | "chat-completions"
  | "messages"
  | "google"
  | "systemone"
  | "images"
  | "live"
  | "embeddings";

export interface OpenCodeCost {
  /** USD per 1M input tokens. */
  input?: number;
  cachedInput?: number;
  output?: number;
  cacheWrite?: number;
}

export interface OpenCodeGoMetadata {
  /** Monthly usage allowance per plan, USD: [go, go-plus, go-teams]. */
  monthlyUsage?: number[];
  zeroDataRetention?: boolean;
  training?: boolean;
  limitedRegions?: boolean;
}

export interface OpenCodeModelEntry {
  id: string;
  upstream: OpenCodeUpstreamId;
  /** Supported protocols; the first entry is the native one. */
  protocols: OpenCodeWire[];
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputModalities: string[];
  outputModalities: string[];
  toolCalling: boolean;
  /** Whether the upstream declares structured-output support; undefined when undeclared. */
  structuredOutput?: boolean;
  /** Reasoning effort tiers exactly as declared by the catalog. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  free: boolean;
  /** Whether the model may appear in /models as a selectable chat model. */
  selectable: boolean;
  cost?: OpenCodeCost;
  go?: OpenCodeGoMetadata;
  /** Provenance: "catalog" for live fetch, "seed" for the bundled snapshot. */
  source: "catalog" | "seed";
}

const CHAT_MODALITY = ["text"];

/** Usable as a chat model (the only kind /models advertises). */
export function isChatSelectable(entry: OpenCodeModelEntry): boolean {
  if (!entry.selectable) return false;
  return entry.protocols.some((wire) => wire === "responses" || wire === "chat-completions" || wire === "messages" || wire === "google");
}

/**
 * Free-tier detection. Price wins over the name suffix: `big-pickle` is free without
 * the suffix, and a `-free` name does not prove that the upstream serves it for free.
 */
export function isFreeModel(entry: Pick<OpenCodeModelEntry, "id" | "free" | "cost">): boolean {
  if (entry.free) return true;
  if (entry.cost?.input === 0 && entry.cost.output === 0) return true;
  return false;
}

/** Human-readable label for a protocol, used in admin output. */
export function protocolLabel(wire: OpenCodeWire): string {
  switch (wire) {
    case "chat-completions": return "Chat Completions";
    case "responses": return "Responses";
    case "messages": return "Anthropic Messages";
    case "google": return "Google generateContent";
    case "systemone": return "System One";
    case "images": return "Images";
    case "live": return "Realtime";
    case "embeddings": return "Embeddings";
  }
}

/** Default modalities for an entry that the upstream does not describe. */
export function defaultModalities(entry: Pick<OpenCodeModelEntry, "inputModalities" | "outputModalities">): {
  input: string[];
  output: string[];
} {
  return {
    input: entry.inputModalities.length > 0 ? entry.inputModalities : CHAT_MODALITY,
    output: entry.outputModalities.length > 0 ? entry.outputModalities : CHAT_MODALITY,
  };
}
