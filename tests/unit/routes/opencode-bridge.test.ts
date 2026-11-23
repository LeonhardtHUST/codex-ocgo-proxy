/** @vitest-environment node */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeLease, OpenCodeSelection } from "@src/auth/opencode-pool.js";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import { X_OPENCODE_SESSION_HEADER } from "@src/proxy/opencode-headers.js";
import {
  handleOpenCodeDirect,
  resolveOpenCodeSession,
  withLeaseRelease,
} from "@src/routes/opencode-bridge.js";

const directRequestMock = vi.fn();
vi.mock("@src/routes/shared/direct-request-handler.js", () => ({
  handleDirectRequest: (...args: unknown[]) => directRequestMock(...args),
}));

function fakeLease(): OpenCodeLease & { completed: number; released: number } {
  const lease = {
    credentialId: "c1",
    apiKey: "secret-key",
    quotaGroup: null,
    completed: 0,
    released: 0,
    beginAttempt: () => () => undefined,
    complete() { lease.completed += 1; },
    reportFailure() { /* not asserted here */ },
    release() { lease.released += 1; },
  };
  return lease;
}

function bridgeWith(selection: OpenCodeSelection, opencode = OpenCodeConfigSchema.parse({ enabled: true })) {
  return {
    legacy: { enabled: false, base_url: "http://127.0.0.1:8787/v1", timeout_seconds: 180 },
    opencode,
    pool: {
      acquire: () => selection,
      beginClientRequest: () => () => undefined,
    },
  };
}

const baseOptions = {
  route: { resolvedModel: "opencode:glm-5.3", modelId: "glm-5.3" },
  proxyReq: { codexRequest: { model: "glm-5.3" }, model: "glm-5.3", isStreaming: false } as never,
  codexRequest: { model: "opencode:glm-5.3" } as never,
  fmt: {} as never,
};

async function run(bridge: ReturnType<typeof bridgeWith>, headers: Record<string, string> = {}) {
  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    return handleOpenCodeDirect({ c, bridge: bridge as never, ...baseOptions });
  });
  return app.request("/v1/chat/completions", { method: "POST", headers });
}

beforeEach(() => {
  directRequestMock.mockReset();
  directRequestMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("opencode bridge: session identity", () => {
  it("prefers the opencode session header over the cache key", async () => {
    let seen: unknown;
    const app = new Hono();
    app.get("/probe", (c) => {
      c.set("authRole", "master");
      seen = resolveOpenCodeSession(c, "cache-key-value");
      return c.json({ ok: true });
    });
    await app.request("/probe", { headers: { [X_OPENCODE_SESSION_HEADER]: "header-session" } });
    expect(seen).toEqual({ id: "header-session", caller: { kind: "master" } });
  });

  it("falls back to the translated cache key and rejects oversized ids", async () => {
    const app = new Hono();
    let withKey: unknown;
    let oversized: unknown;
    app.get("/a", (c) => {
      c.set("authRole", "master");
      withKey = resolveOpenCodeSession(c, "cache-key-value");
      return c.json({});
    });
    app.get("/b", (c) => {
      c.set("authRole", "master");
      oversized = resolveOpenCodeSession(c, "x".repeat(300));
      return c.json({});
    });

    await app.request("/a");
    expect(withKey).toEqual({ id: "cache-key-value", caller: { kind: "master" } });
    await app.request("/b");
    expect(oversized).toBeUndefined();
  });

  it("returns undefined without an authenticated caller", async () => {
    const app = new Hono();
    let seen: unknown = "unset";
    app.get("/probe", (c) => { seen = resolveOpenCodeSession(c, "cache-key-value"); return c.json({}); });
    await app.request("/probe");
    expect(seen).toBeUndefined();
  });
});

describe("opencode bridge: lease release", () => {
  it("completes and releases once the body is fully read", async () => {
    const lease = fakeLease();
    const response = withLeaseRelease(new Response("hello"), lease);
    expect(await response.text()).toBe("hello");
    expect(lease.completed).toBe(1);
    expect(lease.released).toBe(1);
  });

  it("releases without completing when the client cancels", async () => {
    const lease = fakeLease();
    const response = withLeaseRelease(new Response("hello"), lease);
    await response.body!.cancel();
    expect(lease.completed).toBe(0);
    expect(lease.released).toBe(1);
  });

  it("releases immediately for a body-less response", () => {
    const lease = fakeLease();
    withLeaseRelease(new Response(null, { status: 204 }), lease);
    expect(lease.completed).toBe(1);
    expect(lease.released).toBe(1);
  });
});

describe("opencode bridge: dispatch", () => {
  it("rejects when the provider family is disabled", async () => {
    const bridge = bridgeWith({ kind: "selected", lease: fakeLease() }, OpenCodeConfigSchema.parse({ enabled: false }));
    const response = await run(bridge);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("ocgo_unavailable");
  });

  it("rejects a namespaced model with an invalid id", async () => {
    const bridge = bridgeWith({ kind: "selected", lease: fakeLease() });
    const app = new Hono();
    app.post("/x", (c) => handleOpenCodeDirect({
      c,
      bridge: bridge as never,
      route: { resolvedModel: "opencode:" },
      proxyReq: baseOptions.proxyReq,
      codexRequest: baseOptions.codexRequest,
      fmt: baseOptions.fmt,
    }));
    const invalid = await app.request("/x", { method: "POST" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe("ocgo_invalid_model");
    expect(directRequestMock).not.toHaveBeenCalled();
  });

  it("maps busy, backoff and unavailable selections to distinct errors", async () => {
    const busy = await run(bridgeWith({ kind: "busy" }));
    expect(busy.status).toBe(503);
    expect((await busy.json() as { error: { code: string } }).error.code).toBe("ocgo_busy");

    const backoff = await run(bridgeWith({ kind: "backoff", retryAfterSeconds: 42 }));
    expect(backoff.status).toBe(429);
    expect(backoff.headers.get("Retry-After")).toBe("42");

    const unavailable = await run(bridgeWith({ kind: "unavailable" }));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json() as { error: { code: string } }).error.code).toBe("ocgo_no_credential");
  });

  it("passes the selected key to the adapter and releases the lease after the body", async () => {
    const lease = fakeLease();
    const bridge = bridgeWith({ kind: "selected", lease });
    const response = await run(bridge);
    expect(response.status).toBe(200);
    await response.text();

    const call = directRequestMock.mock.calls.at(-1)?.[0] as { upstream: { tag: string }; req: { model: string; codexRequest: { model: string } } };
    expect(call.upstream.tag).toBeDefined();
    expect(call.req.model).toBe("opencode:glm-5.3");
    expect(call.req.codexRequest.model).toBe("opencode:glm-5.3");
    expect(lease.released).toBe(1);
    expect(lease.completed).toBe(1);
  });

  it("falls back to the legacy loopback upstream when only the old section is configured", async () => {
    const lease = fakeLease();
    const bridge = {
      legacy: { enabled: true, base_url: "http://127.0.0.1:8787/v1", timeout_seconds: 90 },
      opencode: undefined,
      pool: { acquire: () => ({ kind: "selected" as const, lease }), beginClientRequest: () => () => undefined },
    };
    const response = await run(bridge as never);
    expect(response.status).toBe(200);
    await response.text();
    const call = directRequestMock.mock.calls.at(-1)?.[0] as { upstream: { tag: string } };
    expect(call.upstream.tag).toBe("opencode-sidecar");
    expect(lease.released).toBe(1);
  });
});
