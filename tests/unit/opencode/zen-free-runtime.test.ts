import { describe, expect, it, vi } from "vitest";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import { ZenFreePool } from "@src/opencode/zen-free-pool.js";
import { createKeySelector, createZenFreePool, freeModelPredicate } from "@src/opencode/zen-free-runtime.js";

const FREE = "big-pickle";
const PAID = "glm-5.3";

function credentials() {
  return [
    { id: "k1", enabled: true, apiKey: "secret-1", models: [FREE, PAID], quotaGroup: null },
    { id: "k2", enabled: true, apiKey: "secret-2", models: [FREE], quotaGroup: null },
  ];
}

function enabledConfig(poolAllKeys = true) {
  return OpenCodeConfigSchema.parse({
    enabled: true,
    upstreams: { zen_free: { enabled: true, pool_all_keys: poolAllKeys } },
  });
}

describe("zen-free pool construction", () => {
  it("stays off unless the family, the upstream and the pooling switch are all on", () => {
    expect(createZenFreePool({ readCredentials: credentials }, OpenCodeConfigSchema.parse({}))).toBeNull();
    expect(createZenFreePool({ readCredentials: credentials }, enabledConfig(false))).toBeNull();

    const off = OpenCodeConfigSchema.parse({ enabled: true, upstreams: { zen_free: { enabled: false, pool_all_keys: true } } });
    expect(createZenFreePool({ readCredentials: credentials }, off)).toBeNull();

    expect(createZenFreePool({ readCredentials: credentials }, enabledConfig(true))).toBeInstanceOf(ZenFreePool);
  });
});

describe("free model predicate", () => {
  it("uses the catalogue and treats unknown models as paid", () => {
    const predicate = freeModelPredicate({
      findAny: (id: string) => (id === FREE ? { free: true } : id === PAID ? { free: false } : undefined),
    } as never);
    expect(predicate(FREE)).toBe(true);
    expect(predicate(PAID)).toBe(false);
    expect(predicate("not-in-catalog")).toBe(false);
  });
});

describe("key selector", () => {
  function basePool() {
    const lease = {
      credentialId: "base",
      apiKey: "base-key",
      quotaGroup: null,
      beginAttempt: () => () => undefined,
      complete: vi.fn(),
      reportFailure: vi.fn(),
      release: vi.fn(),
    };
    return {
      lease,
      pool: {
        acquire: vi.fn(() => ({ kind: "selected" as const, lease })),
        beginClientRequest: vi.fn(() => () => undefined),
        snapshot: vi.fn(() => ({ enabled: true, credentials: [] })),
      },
    };
  }

  it("delegates paid models to the original pool", () => {
    const { pool } = basePool();
    const selector = createKeySelector({ pool, zenFree: new ZenFreePool({ readCredentials: credentials }, { poolAllKeys: true }), isFreeModel: (id) => id === FREE });
    const selection = selector.acquire(PAID);
    expect(pool.acquire).toHaveBeenCalledWith(PAID, undefined, undefined);
    expect(selection.kind).toBe("selected");
  });

  it("delegates everything when the free pool is off", () => {
    const { pool } = basePool();
    const selector = createKeySelector({ pool, zenFree: null, isFreeModel: () => true });
    selector.acquire(FREE);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
  });

  it("serves free models from the aggregated pool", () => {
    const { pool } = basePool();
    const zenFree = new ZenFreePool({ readCredentials: credentials }, { poolAllKeys: true });
    const selector = createKeySelector({ pool, zenFree, isFreeModel: (id) => id === FREE });

    const selection = selector.acquire(FREE);
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") throw new Error("expected a lease");
    expect(["secret-1", "secret-2"]).toContain(selection.lease.apiKey);

    selection.lease.complete();
    selection.lease.release();
    const snapshot = zenFree.snapshot();
    expect(snapshot.keys.some((key) => key.successes === 1)).toBe(true);
    expect(snapshot.keys.every((key) => !key.inFlight)).toBe(true);
  });

  it("maps a blocked free channel to a backoff selection", () => {
    const zenFree = new ZenFreePool({ readCredentials: credentials }, { poolAllKeys: true, breakerThreshold: 1 });
    zenFree.recordFailure("k1", "free_limit", 1); // opens the channel breaker

    const { pool } = basePool();
    const selector = createKeySelector({ pool, zenFree, isFreeModel: () => true });
    const selection = selector.acquire(FREE);
    expect(selection.kind).toBe("backoff");
    expect((selection as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("passes busy and unavailable results through", () => {
    const zenFree = new ZenFreePool({
      readCredentials: () => [{ id: "only", enabled: true, apiKey: "s", models: [FREE], quotaGroup: null }],
    }, {});
    const { pool } = basePool();
    const selector = createKeySelector({ pool, zenFree, isFreeModel: () => true });

    expect(selector.acquire(FREE).kind).toBe("selected");
    expect(selector.acquire(FREE).kind).toBe("busy");

    const empty = createKeySelector({
      pool,
      zenFree: new ZenFreePool({ readCredentials: () => [] }, { poolAllKeys: true }),
      isFreeModel: () => true,
    });
    expect(empty.acquire(FREE).kind).toBe("unavailable");
  });

  it("reports failures from the lease into the free pool", () => {
    const zenFree = new ZenFreePool({ readCredentials: credentials }, { poolAllKeys: true });
    const { pool } = basePool();
    const selector = createKeySelector({ pool, zenFree, isFreeModel: () => true });
    const selection = selector.acquire(FREE);
    if (selection.kind !== "selected") throw new Error("expected a lease");

    selection.lease.reportFailure("model_denied");
    selection.lease.release();
    expect(zenFree.snapshot().keys.some((key) => key.blockedModels.includes("*"))).toBe(true);
  });
});
