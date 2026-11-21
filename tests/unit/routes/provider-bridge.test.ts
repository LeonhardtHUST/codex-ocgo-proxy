/** @vitest-environment node */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleProviderRoute } from "@src/routes/provider-bridge.js";

const directRequestMock = vi.fn();
vi.mock("@src/routes/shared/direct-request-handler.js", () => ({
  handleDirectRequest: (...args: unknown[]) => directRequestMock(...args),
}));

const proxyReq = {
  codexRequest: { model: "codex-fallback:gpt-5.1", input: [] },
  model: "gpt-5.1",
  isStreaming: false,
} as never;

function app(store: { get: () => { baseUrl: string; apiKey: string } | null } | undefined) {
  const instance = new Hono();
  instance.post("/v1/responses", (c) => handleProviderRoute({
    c,
    route: { providerId: "codex-fallback", resolvedModel: "codex-fallback:gpt-5.1", modelId: "gpt-5.1" },
    proxyReq,
    fmt: {} as never,
    fallbackUpstream: store as never,
  }));
  return instance;
}

beforeEach(() => {
  directRequestMock.mockReset();
  directRequestMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

describe("provider bridge: codex-fallback", () => {
  it("refuses when no fallback upstream is configured", async () => {
    const response = await app({ get: () => null }).request("/v1/responses", { method: "POST" });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("codex_fallback_unconfigured");
    expect(directRequestMock).not.toHaveBeenCalled();
  });

  it("refuses when the store is missing entirely", async () => {
    const response = await app(undefined).request("/v1/responses", { method: "POST" });
    expect(response.status).toBe(503);
    expect(directRequestMock).not.toHaveBeenCalled();
  });

  it("forwards through the Responses wire with the bare model id", async () => {
    const response = await app({ get: () => ({ baseUrl: "https://fallback.test/v1", apiKey: "fake-key" }) })
      .request("/v1/responses", { method: "POST" });
    expect(response.status).toBe(200);

    const call = directRequestMock.mock.calls.at(-1)?.[0] as { upstream: { tag: string }; req: { model: string; codexRequest: { model: string } } };
    expect(call.upstream.tag).toBe("fallback");
    // The namespace must be stripped before the upstream sees the request.
    expect(call.req.model).toBe("gpt-5.1");
    expect(call.req.codexRequest.model).toBe("gpt-5.1");
  });

  it("rejects a provider that cannot be selected yet", async () => {
    const instance = new Hono();
    instance.post("/v1/responses", (c) => handleProviderRoute({
      c,
      route: { providerId: "opencode-go", resolvedModel: "opencode-go:glm-5.3", modelId: "glm-5.3" },
      proxyReq,
      fmt: {} as never,
    }));
    const response = await instance.request("/v1/responses", { method: "POST" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("provider_not_implemented");
  });
});
