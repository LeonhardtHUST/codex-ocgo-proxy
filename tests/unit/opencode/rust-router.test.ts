import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeConfigSchema } from "@src/opencode/config.js";
import { RustRouterProcess, resolveRustRouterBinary } from "@src/opencode/rust-router.js";
import { RustRouterAdapter } from "@src/opencode/rust-adapter.js";

function rustConfig(overrides: Record<string, unknown> = {}) {
  return OpenCodeConfigSchema.parse({
    enabled: true,
    rust_routing: { enabled: true, port: 8791, base_url: "http://127.0.0.1:8791/v1", startup_timeout_ms: 1000, ...overrides },
  }).rust_routing;
}

class FakeChild extends EventEmitter {
  pid = 4242;
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
}

const healthyFetch = (() => Promise.resolve(new Response(JSON.stringify({ status: "ok", models: 0 }), {
  status: 200,
  headers: { "content-type": "application/json" },
}))) as unknown as typeof fetch;

describe("rust router lifecycle", () => {
  it("prefers an explicit binary path that exists and falls back to discovery otherwise", () => {
    // An existing explicit path wins; a bogus one falls back to the repo build (if any).
    expect(resolveRustRouterBinary(process.execPath)).toBe(process.execPath);
    const bogus = resolveRustRouterBinary("C:/definitely/not/here/ocx-router.exe");
    expect(bogus === undefined || bogus.endsWith("ocx-router.exe") || bogus.endsWith("ocx-router")).toBe(true);
  });

  it("stays disabled when the feature flag is off", async () => {
    const router = new RustRouterProcess({
      config: { ...rustConfig(), enabled: false },
      spawnImpl: vi.fn() as never,
    });
    await expect(router.start()).resolves.toBe(false);
    expect(router.state).toBe("disabled");
    expect(router.isReady).toBe(false);
  });

  it("degrades explicitly when the binary is missing", async () => {
    const router = new RustRouterProcess({
      config: rustConfig({ binary_path: "C:/definitely/not/here/ocx-router.exe" }),
      spawnImpl: vi.fn() as never,
      resolveBinary: () => undefined,
    });
    await expect(router.start()).resolves.toBe(false);
    expect(router.state).toBe("degraded");
    expect(router.status().lastError).toMatch(/binary not found/);
  });

  it("becomes ready once /health answers, then pushes the catalogue", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const router = new RustRouterProcess({
      config: rustConfig({ binary_path: process.execPath }),
      spawnImpl,
      fetchImpl,
    });
    await expect(router.start()).resolves.toBe(true);
    expect(router.state).toBe("ready");
    expect(router.isReady).toBe(true);
    expect(router.status().pid).toBe(4242);

    await expect(router.pushCatalog({ list: () => [{ id: "glm-5.3", upstream: "zen", protocols: ["chat-completions"], free: false }] } as never)).resolves.toBe(true);
    expect(router.status().catalogModels).toBe(1);

    await router.stop();
    expect(child.killed).toBe(true);
    expect(router.state).toBe("disabled");
  });

  it("degrades when the process exits on its own", async () => {
    const child = new FakeChild();
    const router = new RustRouterProcess({
      config: rustConfig({ binary_path: process.execPath }),
      spawnImpl: (() => child) as never,
      fetchImpl: healthyFetch,
    });
    await router.start();
    expect(router.state).toBe("ready");
    child.emit("exit", 1, null);
    expect(router.state).toBe("degraded");
    expect(router.status().lastError).toMatch(/exited/);
  });

  it("degrades when health never becomes ready", async () => {
    const child = new FakeChild();
    const router = new RustRouterProcess({
      config: rustConfig({ binary_path: process.execPath, startup_timeout_ms: 600 }),
      spawnImpl: (() => child) as never,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      pollIntervalMs: 50,
    });
    await expect(router.start()).resolves.toBe(false);
    expect(router.state).toBe("degraded");
    expect(router.status().lastError).toBeDefined();
  });
});

describe("rust router adapter", () => {
  it("defaults to the responses path", () => {
    const adapter = new RustRouterAdapter({
      baseUrl: "http://127.0.0.1:8790/v1/",
      upstream: "zen",
      modelId: "glm-5.3",
    });
    expect(adapter.requestUrl).toBe("http://127.0.0.1:8790/v1/responses");
    expect(adapter.tag).toBe("opencode-rust");
  });

  it("targets the chat and messages endpoints when a transform is supplied", () => {
    const transform = () => ({ messages: [] });
    expect(new RustRouterAdapter({ baseUrl: "http://127.0.0.1:8790/v1", upstream: "go", protocol: "chat-completions", modelId: "glm-5.3", transform }).requestUrl)
      .toBe("http://127.0.0.1:8790/v1/chat/completions");
    expect(new RustRouterAdapter({ baseUrl: "http://127.0.0.1:8790/v1", upstream: "go", protocol: "messages", modelId: "claude-sonnet-5-5", transform }).requestUrl)
      .toBe("http://127.0.0.1:8790/v1/messages");
  });

  it("refuses non-Responses protocols without a transform", () => {
    expect(() => new RustRouterAdapter({
      baseUrl: "http://127.0.0.1:8790/v1",
      upstream: "go",
      protocol: "chat-completions",
      modelId: "glm-5.3",
    })).toThrow(/transform/);
  });
});
