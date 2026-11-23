import { describe, expect, it } from "vitest";
import type { OpenCodeCredential } from "@src/auth/opencode-key-store.js";
import { OpenCodePool, type OpenCodeSession } from "@src/auth/opencode-pool.js";

function fixture() {
  const credentials: OpenCodeCredential[] = [
    { id: "a", name: "First", apiKey: "fake-key-a", enabled: true, models: ["text", "other"] },
    { id: "b", name: "Second", apiKey: "fake-key-b", enabled: true, models: ["text"] },
    { id: "c", name: "Disabled", apiKey: "fake-key-c", enabled: false, models: ["text", "other"] },
  ];
  let now = 0;
  const pool = new OpenCodePool({ readCredentials: () => structuredClone(credentials) }, () => now);
  const take = (model: string, session?: OpenCodeSession) => {
    const result = pool.acquire(model, session);
    if (result.kind !== "selected") throw new Error(`Expected lease, got ${result.kind}`);
    return result.lease;
  };
  const finish = (model: string, session?: OpenCodeSession) => {
    const lease = take(model, session);
    lease.complete();
    lease.release();
    return lease.credentialId;
  };
  return { credentials, pool, take, finish, advance: (ms: number) => { now += ms; } };
}

const caller = (id: string): OpenCodeSession => ({ caller: { kind: "client_key", id }, id: "same-conversation" });

describe("OpenCode lease reclamation", () => {
  it("frees a stranded lease after the TTL instead of pinning the pool forever", () => {
    // Regression: a single-credential pool used to stay 503 ocgo_busy forever once one
    // lease was stranded (client disconnects after the response starts, before the stream
    // callback runs). Nothing released it, and no request was actually in flight.
    const { pool, advance } = fixture();
    const stranded = pool.acquire("other");
    expect(stranded.kind).toBe("selected");
    expect(pool.acquire("other")).toEqual({ kind: "busy" });

    advance(9 * 60 * 1000);
    expect(pool.acquire("other")).toEqual({ kind: "busy" });

    advance(2 * 60 * 1000); // past the 10-minute ceiling
    const recovered = pool.acquire("other");
    expect(recovered.kind).toBe("selected");
  });

  it("does not reclaim a lease that was released normally", () => {
    const { pool, take, advance } = fixture();
    const lease = take("text");
    lease.release();
    advance(60 * 1000);
    expect(pool.acquire("text").kind).toBe("selected");
  });
});

describe("OpenCode credential scheduling", () => {
  it("round-robins only model-eligible enabled credentials", () => {
    const { finish, pool } = fixture();
    expect([finish("text"), finish("text"), finish("text")]).toEqual(["a", "b", "a"]);
    expect(finish("other")).toBe("a");
    expect(pool.acquire("missing")).toEqual({ kind: "unavailable" });
  });

  it("holds one concurrent slot across models and ignores duplicate release", () => {
    const { pool, take } = fixture();
    const first = take("other");
    const second = take("text");
    expect(second.credentialId).toBe("b");
    expect(pool.acquire("other")).toEqual({ kind: "busy" });
    first.release();
    const next = take("other");
    first.release();
    expect(pool.acquire("other")).toEqual({ kind: "busy" });
    next.release();
    second.release();
    expect(take("text").credentialId).toBe("b");
  });

  it("scopes session affinity to the authenticated caller, and skips a busy preferred key", () => {
    const { finish, take } = fixture();
    const alice = caller("alice"), bob = caller("bob");
    const master: OpenCodeSession = { caller: { kind: "master" }, id: alice.id };
    expect(finish("text", alice)).toBe("a");
    expect(finish("text", bob)).toBe("b");
    expect(finish("text", alice)).toBe("a");
    expect(finish("text", master)).toBe("a");
    expect(finish("text", bob)).toBe("b");
    const busy = take("other");
    expect(finish("text", alice)).toBe("b");
    busy.release();
    expect(finish("text", alice)).toBe("b");
  });

  it("drops expired or replaced affinity and does not pin an incomplete attempt", () => {
    const { finish, take, credentials, advance } = fixture();
    const session = caller("alice");
    expect(finish("text", session)).toBe("a");
    advance(31 * 60 * 1000);
    expect(finish("text", session)).toBe("b");
    credentials[1].apiKey = "fake-replacement";
    const attempt = take("text", session);
    expect(attempt.credentialId).toBe("a");
    attempt.release();
    expect(finish("text", session)).toBe("b");
  });

  it("blocks all credentials of an exhausted group and does not treat unknown owners as independent", () => {
    const { take, pool, credentials, advance } = fixture();
    credentials[0].quotaGroup = "shared";
    credentials[1].quotaGroup = "shared";
    credentials.push({ ...credentials[1], id: "unknown", apiKey: "fake-unknown", quotaGroup: null });
    const attempt = take("text");
    attempt.reportFailure("quota_group_exhausted", 17);
    attempt.release();
    expect(pool.acquire("text")).toEqual({ kind: "backoff", retryAfterSeconds: 17 });
    credentials.push({ ...credentials[1], id: "independent", apiKey: "fake-independent", quotaGroup: "independent" });
    const other = take("text");
    expect(other.credentialId).toBe("independent");
    other.release();
    advance(17_000);
    expect(take("text").credentialId).toBe("a");
  });

  it("backs off the provider for an ambiguous 429, without trying other groups", () => {
    const { take, pool, credentials, advance } = fixture();
    credentials[1].quotaGroup = "other";
    const attempt = take("text");
    attempt.reportFailure("unknown_rate_limit");
    attempt.release();
    expect(pool.acquire("text")).toEqual({ kind: "backoff", retryAfterSeconds: 30 });
    advance(30_000);
    expect(take("text").credentialId).toBe("b");
  });

  it("scopes model denial, key cooldown and invalidation separately", () => {
    const { take, pool, credentials } = fixture();
    const attempt = take("text");
    attempt.reportFailure("model_denied");
    attempt.release();
    const modelOnly = take("other");
    expect(modelOnly.credentialId).toBe("a");
    modelOnly.reportFailure("invalid_key");
    modelOnly.release();
    expect(pool.acquire("other")).toEqual({ kind: "unavailable" });
    credentials[0].apiKey = "fake-replacement";
    const valid = take("other");
    valid.reportFailure("key_rate_limit", 12);
    valid.release();
    expect(pool.acquire("other")).toEqual({ kind: "backoff", retryAfterSeconds: 12 });
    expect(take("text").credentialId).toBe("b");
  });

  it("does not allocate a second lease if the same secret is re-added with a new ID", () => {
    const { take, pool, credentials } = fixture();
    const active = take("other");
    credentials[0].id = "new-id";
    expect(pool.acquire("other")).toEqual({ kind: "busy" });
    active.release();
    expect(take("other").credentialId).toBe("new-id");
  });
});
