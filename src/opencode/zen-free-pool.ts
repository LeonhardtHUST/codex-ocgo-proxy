/**
 * zen-free aggregated rotation pool.
 *
 * Free-tier models on the OpenCode gateway answer `429 FreeUsageLimitError` and the
 * limit is decided by the caller's origin, not by the key — so a per-key health model
 * is the wrong shape here. Two layers instead:
 *
 *   - per key: availability for free models only (structural failures cool that key
 *     down for free traffic; paid traffic is untouched because this pool never owns it);
 *   - per channel: a circuit breaker for `free_limit`, with exponential backoff, that
 *     is shared by every key and can only be cleared explicitly.
 *
 * Rotation is success-weighted: `score = success / (attempts + 1)`, ties broken by
 * least-recently used. A key is never handed out twice concurrently.
 *
 * See docs/OPENCODEX_ROUTER_DESIGN.md §6.
 */

/** Minimal credential shape; matches src/auth/ocgo-key-store.ts. */
export interface ZenFreeCredential {
  id: string;
  enabled: boolean;
  apiKey: string;
  models: string[];
  quotaGroup?: string | null;
}

export interface ZenFreeCredentialSource {
  readCredentials(): readonly ZenFreeCredential[];
}

export type ZenFreeFailure = string;

export interface ZenFreePoolOptions {
  /** When true every enabled credential may serve free models. */
  poolAllKeys: boolean;
  /** Clock injection for tests. */
  now?: () => number;
  /** Consecutive channel-level free-limit hits before the breaker opens. */
  breakerThreshold?: number;
  /** Base backoff for the breaker (doubles per consecutive open). */
  breakerBaseMs?: number;
  /** Upper bound for the breaker backoff. */
  breakerMaxMs?: number;
  /** Default cooldown for structural per-key failures. */
  keyCooldownMs?: number;
}

export type ZenFreeAcquireResult =
  | { kind: "selected"; key: ZenFreeCredential }
  | { kind: "busy" }
  | { kind: "channel_blocked"; retryAfterSeconds: number }
  | { kind: "unavailable" };

interface KeyState {
  attempts: number;
  successes: number;
  consecutiveFailures: number;
  lastUsedAt: number;
  cooldownUntil: number;
  /** Models this key may no longer serve on the free channel. */
  blockedModels: Set<string>;
}

export interface ZenFreeKeySnapshot {
  id: string;
  score: number;
  attempts: number;
  successes: number;
  inFlight: boolean;
  cooldownSeconds: number;
  blockedModels: string[];
}

export interface ZenFreePoolSnapshot {
  poolAllKeys: boolean;
  channel: {
    open: boolean;
    retryAfterSeconds: number;
    consecutiveHits: number;
  };
  keys: ZenFreeKeySnapshot[];
}

export class ZenFreePool {
  readonly #source: ZenFreeCredentialSource;
  readonly #options: Required<Omit<ZenFreePoolOptions, "now">> & { now: () => number };
  readonly #state = new Map<string, KeyState>();
  readonly #inFlight = new Set<string>();
  #channelOpenUntil = 0;
  #channelConsecutiveHits = 0;
  #channelOpenedTimes = 0;

  constructor(source: ZenFreeCredentialSource, options: ZenFreePoolOptions) {
    this.#source = source;
    this.#options = {
      poolAllKeys: options.poolAllKeys,
      now: options.now ?? (() => Date.now()),
      breakerThreshold: options.breakerThreshold ?? 6,
      breakerBaseMs: options.breakerBaseMs ?? 60 * 60 * 1000,
      breakerMaxMs: options.breakerMaxMs ?? 24 * 60 * 60 * 1000,
      keyCooldownMs: options.keyCooldownMs ?? 5 * 60 * 1000,
    };
  }

  /** Whether the pool currently owns `modelId` on the free channel. */
  serves(modelId: string, credential: ZenFreeCredential): boolean {
    if (this.#options.poolAllKeys) return true;
    return credential.models.includes(modelId);
  }

  /**
   * Pick a credential for one free-model attempt.
   * `busy` means every eligible key is already serving a request.
   */
  acquire(modelId: string): ZenFreeAcquireResult {
    const now = this.#options.now();
    if (this.#channelOpenUntil > now) {
      return { kind: "channel_blocked", retryAfterSeconds: Math.ceil((this.#channelOpenUntil - now) / 1000) };
    }

    const eligible = this.#source.readCredentials().filter((credential) => {
      if (!credential.enabled) return false;
      if (!this.serves(modelId, credential)) return false;
      const state = this.#stateFor(credential.id);
      // "*" means the upstream denied every free model for this credential.
      if (state.blockedModels.has(modelId) || state.blockedModels.has("*")) return false;
      if (state.cooldownUntil > now) return false;
      if (this.#inFlight.has(credential.id)) return false;
      return true;
    });

    if (eligible.length === 0) {
      const hasAny = this.#source.readCredentials().some((credential) => credential.enabled && this.serves(modelId, credential));
      return hasAny ? { kind: "busy" } : { kind: "unavailable" };
    }

    const chosen = eligible
      .map((credential) => ({ credential, state: this.#stateFor(credential.id) }))
      .sort((a, b) => {
        const scoreDiff = this.#score(b.state) - this.#score(a.state);
        if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
        return a.state.lastUsedAt - b.state.lastUsedAt;
      })[0];

    this.#inFlight.add(chosen.credential.id);
    chosen.state.lastUsedAt = now;
    chosen.state.attempts += 1;
    return { kind: "selected", key: chosen.credential };
  }

  /** Return a credential to the pool after the request settled. */
  release(keyId: string): void {
    this.#inFlight.delete(keyId);
  }

  /** Success feedback: raises the key's score and clears its consecutive failures. */
  recordSuccess(keyId: string): void {
    const state = this.#stateFor(keyId);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.lastUsedAt = this.#options.now();
  }

  /**
   * Failure feedback. `free_limit` opens the shared breaker; structural failures
   * (invalid key / model denied / rate limited) only affect this key on free traffic.
   * A success does not clear an open breaker — only `resetBreaker` does.
   */
  recordFailure(keyId: string, failure: ZenFreeFailure, retryAfterSeconds?: number): void {
    const now = this.#options.now();
    const state = this.#stateFor(keyId);
    state.consecutiveFailures += 1;

    if (failure === "free_limit") {
      this.#channelConsecutiveHits += 1;
      if (this.#channelConsecutiveHits >= this.#options.breakerThreshold) {
        this.#openBreaker(now);
      } else {
        // Short optimism window: retry after the upstream's own hint when present.
        state.cooldownUntil = now + (retryAfterSeconds ?? 30) * 1000;
      }
      return;
    }

    switch (failure) {
      case "invalid_key":
        state.blockedModels.clear();
        state.cooldownUntil = now + this.#options.breakerMaxMs;
        break;
      case "model_denied":
        state.blockedModels.add("*");
        break;
      case "rate_limited":
      case "quota_group_exhausted":
        state.cooldownUntil = now + (retryAfterSeconds ?? this.#options.keyCooldownMs / 1000) * 1000;
        break;
      default:
        // Unknown failures cool the key down briefly; three in a row doubles it.
        state.cooldownUntil = now + Math.min(
          this.#options.keyCooldownMs * 2 ** Math.max(0, state.consecutiveFailures - 3),
          this.#options.breakerMaxMs,
        );
    }
  }

  /** Clear the channel breaker and every per-key free-channel penalty. */
  reset(): void {
    this.#state.clear();
    this.#inFlight.clear();
    this.#channelOpenUntil = 0;
    this.#channelConsecutiveHits = 0;
    this.#channelOpenedTimes = 0;
  }

  /** Clear only the channel breaker, keeping per-key state. */
  resetBreaker(): void {
    this.#channelOpenUntil = 0;
    this.#channelConsecutiveHits = 0;
    this.#channelOpenedTimes = 0;
  }

  snapshot(): ZenFreePoolSnapshot {
    const now = this.#options.now();
    const credentials = this.#source.readCredentials();
    return {
      poolAllKeys: this.#options.poolAllKeys,
      channel: {
        open: this.#channelOpenUntil > now,
        retryAfterSeconds: this.#channelOpenUntil > now ? Math.ceil((this.#channelOpenUntil - now) / 1000) : 0,
        consecutiveHits: this.#channelConsecutiveHits,
      },
      keys: credentials.map((credential) => {
        const state = this.#stateFor(credential.id);
        return {
          id: credential.id,
          score: Number(this.#score(state).toFixed(4)),
          attempts: state.attempts,
          successes: state.successes,
          inFlight: this.#inFlight.has(credential.id),
          cooldownSeconds: state.cooldownUntil > now ? Math.ceil((state.cooldownUntil - now) / 1000) : 0,
          blockedModels: [...state.blockedModels],
        };
      }),
    };
  }

  #openBreaker(now: number): void {
    this.#channelOpenedTimes += 1;
    const backoff = Math.min(
      this.#options.breakerBaseMs * 2 ** (this.#channelOpenedTimes - 1),
      this.#options.breakerMaxMs,
    );
    this.#channelOpenUntil = now + backoff;
    this.#channelConsecutiveHits = 0;
  }

  #score(state: KeyState): number {
    return state.successes / (state.attempts + 1);
  }

  #stateFor(id: string): KeyState {
    let state = this.#state.get(id);
    if (!state) {
      state = { attempts: 0, successes: 0, consecutiveFailures: 0, lastUsedAt: 0, cooldownUntil: 0, blockedModels: new Set<string>() };
      this.#state.set(id, state);
    }
    return state;
  }
}
