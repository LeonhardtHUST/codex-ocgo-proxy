/**
 * OpenCode upstream adapter.
 *
 * Reuses the repository's existing protocol adapters instead of re-implementing
 * conversion: Responses is a passthrough, Chat Completions and Anthropic Messages
 * already translate from the Codex request shape, and all three already apply the
 * `x-opencode-session` header for opencode.ai base URLs. What is new here is that
 * the wire protocol is chosen per (upstream, model) instead of per provider.
 */

import type { Dispatcher } from "undici";
import type { CodexResponsesRequest, CodexSSEEvent } from "../proxy/codex-types.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { OpenAIUpstream } from "../proxy/openai-upstream.js";
import { ResponsesUpstream } from "../proxy/responses-upstream.js";
import { AnthropicUpstream } from "../proxy/anthropic-upstream.js";
import { GeminiUpstream } from "../proxy/gemini-upstream.js";
import { buildOpenCodeSessionId, buildProjectId, deriveCacheIdentity, type PromptCacheRetention } from "./cache-identity.js";
import { DEFAULT_OPENCODE_CLIENT } from "../proxy/opencode-headers.js";
import { OpenCodeError } from "./errors.js";
import type { OpenCodeModelEntry, OpenCodeUpstreamId, OpenCodeWire } from "./model.js";
import type { ProtocolMatrix } from "./protocol-matrix.js";
import { firstForwardableWire, isForwardableWire, wireBaseUrl } from "./upstreams.js";

export interface OpenCodeAdapterOptions {
  upstream: OpenCodeUpstreamId;
  apiKey: string;
  /** Root base URL, e.g. https://opencode.ai/inference/go */
  root: string;
  /** Catalog entry for the requested model, when already resolved. */
  entry?: OpenCodeModelEntry;
  /** Force a wire protocol instead of deriving it from the entry. */
  wire?: OpenCodeWire;
  /** Live correction store shared across requests. */
  matrix?: ProtocolMatrix;
  cache?: {
    aggregation: boolean;
    retention?: PromptCacheRetention;
    /** Stable project identity for `x-opencode-project`; omitted means the header is not sent. */
    projectSeed?: string;
  };
  dispatcher?: Dispatcher;
  /** Log identifier; defaults to `opencode:<upstream>`. */
  tag?: string;
}

/** Resolve the wire protocol for one request without any I/O. */
export function resolveWireProtocol(
  entry: OpenCodeModelEntry | undefined,
  options: { requested?: OpenCodeWire; matrix?: ProtocolMatrix } = {},
): OpenCodeWire | undefined {
  if (options.requested && isForwardableWire(options.requested)) return options.requested;
  if (!entry) return undefined;
  const corrected = options.matrix?.correctionFor(entry.upstream, entry.id)?.wire;
  if (corrected && isForwardableWire(corrected)) return corrected;
  return firstForwardableWire(entry.protocols);
}

export class OpenCodeAdapter implements UpstreamAdapter {
  readonly tag: string;
  readonly logPath: string;
  readonly #options: OpenCodeAdapterOptions;
  /** Which delegate produced a given response, so parseStream uses the same one. */
  readonly #delegates = new WeakMap<Response, { adapter: UpstreamAdapter; wire: OpenCodeWire }>();
  #lastWire: OpenCodeWire = "chat-completions";

  constructor(options: OpenCodeAdapterOptions) {
    this.#options = options;
    this.tag = options.tag ?? `opencode-${options.upstream}`;
    this.logPath = `opencode:${options.upstream}`;
  }

  /** Protocol this adapter last used (diagnostics / tests). */
  get lastWire(): OpenCodeWire {
    return this.#lastWire;
  }

  /** Protocol that would be used for a model id, without sending anything. */
  wireFor(_modelId: string): OpenCodeWire | undefined {
    return resolveWireProtocol(this.#options.entry, {
      requested: this.#options.wire,
      matrix: this.#options.matrix,
    });
  }

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const wire = resolveWireProtocol(this.#options.entry, {
      requested: this.#options.wire,
      matrix: this.#options.matrix,
    });
    if (!wire) {
      throw new OpenCodeError({
        status: 400,
        code: "opencode_unsupported_capability",
        message: "This model does not expose a chat protocol the router can forward",
        failure: "unsupported_capability",
      });
    }
    const base = wireBaseUrl(this.#options.root, wire);
    if (!base) {
      throw new OpenCodeError({
        status: 400,
        code: "opencode_unsupported_capability",
        message: `Protocol "${wire}" has no forwardable endpoint`,
        failure: "unsupported_capability",
      });
    }

    const delegate = this.#createDelegate(wire, base);
    const prepared = this.#applyCacheIdentity(req);
    this.#lastWire = wire;
    const response = await delegate.createResponse(prepared, signal);
    this.#delegates.set(response, { adapter: delegate, wire });
    return response;
  }

  async *parseStream(response: Response): AsyncGenerator<CodexSSEEvent> {
    const bound = this.#delegates.get(response);
    const adapter = bound?.adapter ?? this.#createDelegate(this.#lastWire, wireBaseUrl(this.#options.root, this.#lastWire) ?? this.#options.root);
    yield* adapter.parseStream(response);
  }

  #createDelegate(wire: OpenCodeWire, baseUrl: string): UpstreamAdapter {
    const { apiKey, dispatcher, tag } = this.#options;
    switch (wire) {
      case "responses":
        return new ResponsesUpstream(tag ?? "opencode", apiKey, baseUrl, dispatcher);
      case "messages":
        return new AnthropicUpstream(apiKey, baseUrl, dispatcher);
      case "google":
        return new GeminiUpstream(apiKey, baseUrl, dispatcher);
      case "chat-completions":
      default:
        return new OpenAIUpstream(tag ?? "opencode", apiKey, baseUrl, dispatcher);
    }
  }

  /**
   * Give every request of one conversation the same upstream session identity so the
   * gateway can reuse its prompt cache. Disabled, the client's own id wins.
   */
  #applyCacheIdentity(req: CodexResponsesRequest): CodexResponsesRequest {
    const cache = this.#options.cache;
    // The adapter by construction talks to an opencode upstream, so header injection must not
    // depend on a hostname match (custom base URLs would silently lose the identity headers).
    const marked: CodexResponsesRequest = {
      ...req,
      opencodeUpstream: true,
      ...(req.opencodeClient ? {} : { opencodeClient: DEFAULT_OPENCODE_CLIENT }),
    };
    if (!cache?.aggregation) {
      return cache?.projectSeed
        ? { ...marked, opencodeProjectId: buildProjectId(cache.projectSeed) }
        : marked;
    }
    const identity = deriveCacheIdentity({
      promptCacheKey: req.prompt_cache_key,
      clientSessionId: req.opencodeSessionId ?? undefined,
      model: req.model,
      upstream: this.#options.upstream,
      instructions: req.instructions ?? undefined,
    });
    return {
      ...marked,
      opencodeSessionId: buildOpenCodeSessionId(identity),
      ...(cache.projectSeed ? { opencodeProjectId: buildProjectId(cache.projectSeed) } : {}),
    };
  }
}
