import { describe, expect, it } from "vitest";
import {
  X_OPENCODE_SESSION_HEADER,
  applyOpenCodeHeaders,
  isOpenCodeUpstream,
} from "@src/proxy/opencode-headers.js";

describe("isOpenCodeUpstream", () => {
  it("recognizes opencode.ai and Console Go zen/go endpoints", () => {
    expect(isOpenCodeUpstream("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeUpstream("https://api.opencode.ai/zen/go")).toBe(true);
    expect(isOpenCodeUpstream("https://console.opencode.ai/v1")).toBe(true);
  });

  it("rejects non-OpenCode endpoints", () => {
    expect(isOpenCodeUpstream("https://api.openai.com/v1")).toBe(false);
    expect(isOpenCodeUpstream("https://provider.example.com/v1")).toBe(false);
    expect(isOpenCodeUpstream("https://opencode.evil.com/v1")).toBe(false);
    expect(isOpenCodeUpstream("")).toBe(false);
  });
});

describe("applyOpenCodeHeaders", () => {
  const baseUrl = "https://opencode.ai/zen/go/v1";
  const plainUrl = "https://api.openai.com/v1";

  it("forwards client session id and original User-Agent verbatim", () => {
    const headers: Record<string, string> = { "User-Agent": "proxy-default/1.0" };
    applyOpenCodeHeaders(headers, baseUrl, {
      clientUserAgent: "codex_cli_rs/0.41.0",
      opencodeSessionId: "session-abc",
    }, "fallback-session");
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBe("session-abc");
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.41.0");
  });

  it("falls back to the stable per-conversation id when the client sends none", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, baseUrl, {}, "stable-conversation-id");
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBe("stable-conversation-id");
  });

  it("does not overwrite the User-Agent when the client sends none", () => {
    const headers: Record<string, string> = { "User-Agent": "proxy-default/1.0" };
    applyOpenCodeHeaders(headers, baseUrl, {}, "stable-conversation-id");
    expect(headers["User-Agent"]).toBe("proxy-default/1.0");
  });

  it("is a no-op for non-OpenCode upstreams", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, plainUrl, {
      clientUserAgent: "codex_cli_rs/0.41.0",
      opencodeSessionId: "session-abc",
    }, "fallback-session");
    expect(headers).toEqual({});
  });
});

describe("applyOpenCodeHeaders identity injection", () => {
  const base = { userAgent: "" } as never;

  it("injects client and session for a recognised opencode host", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, "https://opencode.ai/zen/go/v1", { opencodeSessionId: "ses_abc" } as never, "ses_fallback");
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBe("ses_abc");
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBeUndefined();
  });

  it("stays out of the way for an unrelated host", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, "https://api.openai.com/v1", {} as never, "ses_fallback");
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBeUndefined();
    expect(headers["x-opencode-client"]).toBeUndefined();
  });

  it("injects on a custom base URL when the adapter marks the request", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(
      headers,
      "http://127.0.0.1:8080/v1",
      { opencodeUpstream: true, opencodeSessionId: "ses_marked" } as never,
      "ses_fallback",
    );
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBe("ses_marked");
    expect(headers["x-opencode-client"]).toBe("cli");
  });

  it("sends the project header only when a stable id is available", () => {
    const withProject: Record<string, string> = {};
    applyOpenCodeHeaders(withProject, "https://opencode.ai/v1", { opencodeUpstream: true, opencodeProjectId: "0123456789abcdef" } as never, "ses_x");
    expect(withProject["x-opencode-project"]).toBe("0123456789abcdef");

    const withoutProject: Record<string, string> = {};
    applyOpenCodeHeaders(withoutProject, "https://opencode.ai/v1", { opencodeUpstream: true } as never, "ses_x");
    expect(withoutProject["x-opencode-project"]).toBeUndefined();
  });

  it("preserves a caller supplied client identity", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, "https://opencode.ai/v1", { opencodeUpstream: true, opencodeClient: "kilo" } as never, "ses_x");
    expect(headers["x-opencode-client"]).toBe("kilo");
  });
});
