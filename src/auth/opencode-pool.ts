import type { OpenCodeCredential, OpenCodeKeyStore } from "./opencode-key-store.js";

import type { OpenCodeFailureKind } from "../proxy/opencode-sidecar-errors.js";
import { OpenCodeUsageCounter } from "./opencode-usage.js";

const DEFAULT_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 86_400;
const MAX_AFFINITIES = 4096;
const AFFINITY_TTL_MS = 30 * 60 * 1000;

type Caller = { kind: "master" } | { kind: "client_key"; id: string };
export interface OpenCodeSession {
  caller: Caller;
  id: string;
}

interface ActiveCredential {
  entry: OpenCodeCredential;
  generation: symbol;
  health: { invalid: boolean; cooldownUntil: number; deniedModels: Set<string> };
  usage: OpenCodeUsageCounter;
}

export interface OpenCodeLease {
  readonly credentialId: string;
  readonly apiKey: string;
  readonly quotaGroup: string | null;
  beginAttempt(): ReturnType<OpenCodeUsageCounter["begin"]>;
  /** Remember affinity only for a successfully completed response. */
  complete(): void;
  reportFailure(kind: OpenCodeFailureKind, retryAfterSeconds?: number): void;
  release(): void;
}

export type OpenCodeSelection =
  | { kind: "selected"; lease: OpenCodeLease }
  | { kind: "unavailable" | "busy" }
  | { kind: "backoff"; retryAfterSeconds: number };

/** A single instance per App. Acquisition is synchronous, including the slot increment. */
export class OpenCodePool {
  readonly #store: Pick<OpenCodeKeyStore, "readCredentials">;
  readonly #clock: () => number;
  #credentials = new Map<string, ActiveCredential>();
  readonly #inFlight = new Set<string>();
  readonly #leasedKeys = new Set<string>();
  readonly #affinity = new Map<string, { entryId: string; generation: symbol; expiresAt: number }>();
  #lastSelectedId?: string;
  readonly #clientRequests = new OpenCodeUsageCounter();
  #unknownUntil = 0;
  readonly #quotaUntil = new Map<string, number>();

  constructor(store: Pick<OpenCodeKeyStore, "readCredentials">, clock: () => number = Date.now) {
    this.#store = store;
    this.#clock = clock;
  }

  #refresh(): void {
    const next = new Map<string, ActiveCredential>();
    for (const entry of this.#store.readCredentials()) {
      const current = this.#credentials.get(entry.id);
      const sameKey = current && entry.apiKey === current.entry.apiKey;
      const generation = sameKey && entry.enabled === current.entry.enabled && entry.quotaGroup === current.entry.quotaGroup
        ? current.generation : Symbol();
      const health = sameKey ? current.health : { invalid: false, cooldownUntil: 0, deniedModels: new Set<string>() };
      for (const model of health.deniedModels) if (!entry.models.includes(model)) health.deniedModels.delete(model);
      next.set(entry.id, { entry, generation, health, usage: sameKey ? current.usage : new OpenCodeUsageCounter() });
    }
    this.#credentials = next;
    const now = this.#clock();
    for (const [group, until] of this.#quotaUntil) if (until <= now) this.#quotaUntil.delete(group);
    for (const [scope, value] of this.#affinity) {
      if (value.expiresAt <= now || next.get(value.entryId)?.generation !== value.generation) this.#affinity.delete(scope);
    }
  }

  beginClientRequest(): ReturnType<OpenCodeUsageCounter["begin"]> {
    return this.#clientRequests.begin();
  }

  snapshot() {
    this.#refresh();
    const { started, succeeded, failed, cancelled, inFlight } = this.#clientRequests.snapshot();
    return {
      clientRequests: { started, succeeded, failed, cancelled, inFlight },
      officialQuota: null,
      credentials: [...this.#credentials.values()].map(({ entry, health, usage }) => ({
        id: entry.id, name: entry.name, models: [...entry.models], enabled: entry.enabled,
        quotaGroup: entry.quotaGroup ?? null,
        invalid: health.invalid, deniedModels: [...health.deniedModels],
        busy: this.#inFlight.has(entry.id) || this.#leasedKeys.has(entry.apiKey),
        cooldownUntil: Math.max(this.#unknownUntil, health.cooldownUntil,
          entry.quotaGroup ? this.#quotaUntil.get(entry.quotaGroup) ?? 0 : Math.max(0, ...this.#quotaUntil.values())) || null,
        upstreamAttempts: usage.snapshot(),
      })),
    };
  }

  acquire(modelId: string, session?: OpenCodeSession, retry?: { previous: OpenCodeLease; requireIndependentGroup: boolean }, credentialId?: string): OpenCodeSelection {
    this.#refresh();
    const scope = session && session.id.length > 0 && session.id.length <= 256
      ? JSON.stringify(["opencode", session.caller.kind, session.caller.kind === "client_key" ? session.caller.id : null, session.id])
      : undefined;
    const entries = [...this.#credentials.values()];
    const now = this.#clock();
    const serves = ({ entry, health }: ActiveCredential) => (!credentialId || entry.id === credentialId) &&
      entry.enabled && entry.models.includes(modelId) &&
      !health.invalid && !health.deniedModels.has(modelId) &&
      (!retry || (entry.id !== retry.previous.credentialId && entry.apiKey !== retry.previous.apiKey &&
        (!retry.requireIndependentGroup || Boolean(retry.previous.quotaGroup && entry.quotaGroup &&
          entry.quotaGroup !== retry.previous.quotaGroup))));
    const unconfirmedUntil = Math.max(0, ...this.#quotaUntil.values());
    const backoffUntil = ({ entry, health }: ActiveCredential) => Math.max(
      this.#unknownUntil, health.cooldownUntil,
      entry.quotaGroup ? this.#quotaUntil.get(entry.quotaGroup) ?? 0 : unconfirmedUntil,
    );
    const available = (item: ActiveCredential) => serves(item) && backoffUntil(item) <= now &&
      !this.#inFlight.has(item.entry.id) && !this.#leasedKeys.has(item.entry.apiKey);
    const preferred = scope ? this.#affinity.get(scope) : undefined;
    let selected = preferred === undefined ? undefined : this.#credentials.get(preferred.entryId);
    if (!selected || !available(selected)) {
      const previous = entries.findIndex(({ entry }) => entry.id === this.#lastSelectedId);
      selected = undefined;
      for (let offset = 1; offset <= entries.length; offset++) {
        const candidate = entries[(previous + offset) % entries.length];
        if (available(candidate)) {
          selected = candidate;
          this.#lastSelectedId = candidate.entry.id;
          break;
        }
      }
    }
    if (!selected) {
      const candidates = entries.filter(serves);
      if (candidates.length === 0) return { kind: "unavailable" };
      const earliest = Math.min(...candidates.map(backoffUntil));
      return earliest > now ? { kind: "backoff", retryAfterSeconds: Math.ceil((earliest - now) / 1000) } : { kind: "busy" };
    }

    const { entry, generation } = selected;
    this.#inFlight.add(entry.id);
    this.#leasedKeys.add(entry.apiKey);
    let released = false;
    let failed = false;
    return { kind: "selected", lease: {
      credentialId: entry.id,
      apiKey: entry.apiKey,
      quotaGroup: entry.quotaGroup ?? null,
      beginAttempt: () => selected.usage.begin(),
      complete: () => {
        if (released || failed || !scope || this.#credentials.get(entry.id)?.generation !== generation) return;
        this.#affinity.delete(scope);
        this.#affinity.set(scope, { entryId: entry.id, generation, expiresAt: this.#clock() + AFFINITY_TTL_MS });
        if (this.#affinity.size > MAX_AFFINITIES) {
          const oldest = this.#affinity.keys().next();
          if (!oldest.done) this.#affinity.delete(oldest.value);
        }
      },
      reportFailure: (kind, retryAfterSeconds) => {
        if (released || failed) return;
        failed = true;
        const current = this.#credentials.get(entry.id);
        if (!current || current.generation !== generation) return;
        const delay = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)
          ? Math.max(1, Math.min(MAX_BACKOFF_SECONDS, retryAfterSeconds)) : DEFAULT_BACKOFF_SECONDS;
        const until = this.#clock() + delay * 1000;
        switch (kind) {
          case "invalid_key": current.health.invalid = true; break;
          case "model_denied": current.health.deniedModels.add(modelId); break;
          case "key_rate_limit": current.health.cooldownUntil = Math.max(current.health.cooldownUntil, until); break;
          case "quota_group_exhausted":
            if (entry.quotaGroup) {
              this.#quotaUntil.set(entry.quotaGroup, Math.max(this.#quotaUntil.get(entry.quotaGroup) ?? 0, until));
              break;
            }
            // No confirmed scope: a different credential may share the same quota.
            this.#unknownUntil = Math.max(this.#unknownUntil, until);
            break;
          case "unknown_rate_limit": this.#unknownUntil = Math.max(this.#unknownUntil, until); break;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight.delete(entry.id);
        this.#leasedKeys.delete(entry.apiKey);
      },
    } };
  }
}
