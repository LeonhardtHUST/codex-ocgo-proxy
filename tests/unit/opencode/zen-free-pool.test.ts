import { beforeEach, describe, expect, it } from "vitest";
import { ZenFreePool, type ZenFreeCredential } from "@src/opencode/zen-free-pool.js";

const FREE_MODEL = "big-pickle";

function credential(overrides: Partial<ZenFreeCredential> = {}): ZenFreeCredential {
  return {
    id: "key-1",
    enabled: true,
    apiKey: "secret-1",
    models: [FREE_MODEL],
    quotaGroup: null,
    ...overrides,
  };
}

function poolWith(credentials: ZenFreeCredential[], options: Partial<ConstructorParameters<typeof ZenFreePool>[1]> = {}) {
  let now = 1_000_000;
  const source = { readCredentials: () => credentials };
  const pool = new ZenFreePool(source, {
    poolAllKeys: false,
    now: () => now,
    ...options,
  });
  return {
    pool,
    advance(ms: number) { now += ms; },
    setClock(ms: number) { now = ms; },
    now: () => now,
  };
}

describe("zen-free pool", () => {
  let credentials: ZenFreeCredential[];

  beforeEach(() => {
    credentials = [
      credential({ id: "key-1", models: [FREE_MODEL] }),
      credential({ id: "key-2", models: [FREE_MODEL] }),
      credential({ id: "key-3", models: ["other-model"] }),
    ];
  });

  it("only uses credentials bound to the model when pooling is off", () => {
    const { pool } = poolWith(credentials);
    const first = pool.acquire(FREE_MODEL);
    expect(first.kind).toBe("selected");
    pool.release((first as { key: ZenFreeCredential }).key.id);

    // key-3 never appears because it does not list the free model
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const result = pool.acquire(FREE_MODEL);
      if (result.kind === "selected") {
        seen.add(result.key.id);
        pool.release(result.key.id);
      }
    }
    expect(seen).not.toContain("key-3");
  });

  it("lets every key serve free models when pool_all_keys is on", () => {
    const { pool } = poolWith(credentials, { poolAllKeys: true });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const result = pool.acquire(FREE_MODEL);
      if (result.kind === "selected") {
        seen.add(result.key.id);
        pool.release(result.key.id);
      }
    }
    expect(seen).toContain("key-3");
  });

  it("reports busy instead of double-assigning an in-flight key", () => {
    const { pool } = poolWith([credential({ id: "only" })]);
    expect(pool.acquire(FREE_MODEL).kind).toBe("selected");
    expect(pool.acquire(FREE_MODEL).kind).toBe("busy");
    pool.release("only");
    expect(pool.acquire(FREE_MODEL).kind).toBe("selected");
  });

  it("reports unavailable when no credential can serve the model", () => {
    const { pool } = poolWith(credentials);
    expect(pool.acquire("paid-only-model").kind).toBe("unavailable");
  });

  it("prefers the key with the better success score", () => {
    const { pool } = poolWith([
      credential({ id: "good" }),
      credential({ id: "bad" }),
    ]);
    // good: 1 success / 1 attempt -> 0.5 ; bad: 2 attempts, 0 successes -> 0
    pool.recordSuccess("good");
    pool.recordFailure("bad", "rate_limited", 1);
    pool.release("bad");
    const result = pool.acquire(FREE_MODEL);
    expect(result.kind).toBe("selected");
    expect((result as { key: ZenFreeCredential }).key.id).toBe("good");
  });

  it("breaks ties with least-recently-used", () => {
    const { pool, advance } = poolWith([
      credential({ id: "key-1" }),
      credential({ id: "key-2" }),
    ]);
    const first = pool.acquire(FREE_MODEL);
    expect((first as { key: ZenFreeCredential }).key.id).toBe("key-1");
    pool.release("key-1");
    advance(1000);
    const second = pool.acquire(FREE_MODEL);
    expect((second as { key: ZenFreeCredential }).key.id).toBe("key-2");
  });

  it("cools a key down for structural failures without touching other keys", () => {
    const { pool, advance } = poolWith([
      credential({ id: "key-1" }),
      credential({ id: "key-2" }),
    ]);
    pool.recordFailure("key-1", "rate_limited", 60);
    expect(pool.acquire(FREE_MODEL).kind).toBe("selected");
    advance(61_000);
    const snapshot = pool.snapshot();
    expect(snapshot.keys.find((key) => key.id === "key-1")?.cooldownSeconds).toBe(0);
    expect(snapshot.keys.find((key) => key.id === "key-2")).toBeDefined();
  });

  it("blocks a model for one key after model_denied", () => {
    const { pool } = poolWith([
      credential({ id: "key-1" }),
      credential({ id: "key-2" }),
    ]);
    pool.recordFailure("key-1", "model_denied");
    const result = pool.acquire(FREE_MODEL);
    expect((result as { key: ZenFreeCredential }).key.id).toBe("key-2");
    expect(pool.snapshot().keys.find((key) => key.id === "key-1")?.blockedModels).toContain("*");
  });

  it("opens the channel breaker after repeated free-limit failures", () => {
    const { pool } = poolWith([credential({ id: "only" })], { breakerThreshold: 3, breakerBaseMs: 60_000 });
    for (let i = 0; i < 2; i++) pool.recordFailure("only", "free_limit", 1);
    expect(pool.snapshot().channel.open).toBe(false);

    pool.recordFailure("only", "free_limit", 1);
    const snapshot = pool.snapshot();
    expect(snapshot.channel.open).toBe(true);
    expect(snapshot.channel.retryAfterSeconds).toBeGreaterThan(0);

    const blocked = pool.acquire(FREE_MODEL);
    expect(blocked.kind).toBe("channel_blocked");
    expect((blocked as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("backs the breaker off exponentially and caps at 24h", () => {
    const { pool, advance, now } = poolWith([credential()], { breakerThreshold: 1, breakerBaseMs: 60_000, breakerMaxMs: 24 * 60 * 60 * 1000 });

    pool.recordFailure("key-1", "free_limit", 1);
    const first = pool.snapshot().channel.retryAfterSeconds;
    expect(first).toBe(60);

    advance(61_000);
    expect(pool.snapshot().channel.open).toBe(false);

    for (let round = 0; round < 12; round++) {
      pool.resetBreaker();
      pool.recordFailure("key-1", "free_limit", 1);
      advance(25 * 60 * 60 * 1000);
    }
    pool.resetBreaker();
    pool.recordFailure("key-1", "free_limit", 1);
    expect(pool.snapshot().channel.retryAfterSeconds).toBeLessThanOrEqual(24 * 60 * 60);
    expect(now()).toBeGreaterThan(0);
  });

  it("keeps the breaker open until it is explicitly reset", () => {
    const { pool } = poolWith([credential()], { breakerThreshold: 1 });
    pool.recordFailure("key-1", "free_limit", 1);
    expect(pool.snapshot().channel.open).toBe(true);

    pool.recordSuccess("key-1");
    expect(pool.snapshot().channel.open).toBe(true);

    pool.resetBreaker();
    expect(pool.snapshot().channel.open).toBe(false);
  });

  it("isolates free-channel state from paid traffic", () => {
    const { pool } = poolWith([credential()], { breakerThreshold: 1 });
    pool.recordFailure("key-1", "free_limit", 1);
    // The breaker only gates the free channel; snapshot never reports paid health.
    expect(pool.snapshot().channel.open).toBe(true);
    expect(Object.keys(pool.snapshot())).toEqual(["poolAllKeys", "channel", "keys"]);
  });

  it("resets everything on reset()", () => {
    const { pool } = poolWith([credential()], { breakerThreshold: 1 });
    pool.recordFailure("key-1", "free_limit", 1);
    pool.reset();
    const snapshot = pool.snapshot();
    expect(snapshot.channel.open).toBe(false);
    expect(snapshot.keys[0].attempts).toBe(0);
  });
});
