/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";

vi.mock("../../../shared/hooks/use-settings", () => ({
  useSettings: () => ({ apiKey: "master-key" }),
}));

import { AutostartSettings } from "./AutostartSettings";

const snapshot = {
  entry: "OpenCodeX-Router",
  settings: { mode: "registry", scope: "user", runAsAdmin: false, delaySeconds: 0 },
  status: {
    platform: "win32",
    supported: true,
    registered: false,
    mode: "registry",
    scope: "user",
    runAsAdmin: false,
    delaySeconds: 0,
    elevationRequired: false,
    command: "C:\\app\\app.exe",
    location: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  },
};

let calls: Array<{ url: string; method: string; body?: unknown }> = [];
let postStatus = 200;

beforeEach(() => {
  calls = [];
  postStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (init.method === "POST") {
      if (postStatus === 409) {
        return new Response(JSON.stringify({ ok: false, elevationRequired: true }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, status: snapshot.status }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutostartSettings", () => {
  it("loads the current state with the master key", async () => {
    render(<AutostartSettings />);
    await waitFor(() => expect(screen.getByText("Not registered.")).toBeTruthy());
    expect(calls[0]).toMatchObject({ url: "/admin/autostart", method: "GET" });
  });

  it("enables autostart with the selected mode and scope", async () => {
    render(<AutostartSettings />);
    await waitFor(() => expect(screen.getByText("Not registered.")).toBeTruthy());

    fireEvent.click(screen.getByText("Enable"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));

    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ enabled: true, mode: "registry", scope: "user" });
    await waitFor(() => expect(screen.getByText("Autostart registered.")).toBeTruthy());
  });

  it("offers the elevation retry when the server answers 409", async () => {
    postStatus = 409;
    render(<AutostartSettings />);
    await waitFor(() => expect(screen.getByText("Not registered.")).toBeTruthy());

    fireEvent.click(screen.getByText("Enable"));
    await waitFor(() => expect(screen.getByText("This mode needs administrator rights.")).toBeTruthy());
    expect(screen.getByText("Retry through Windows prompt")).toBeTruthy();
  });

  it("reports platforms other than Windows honestly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...snapshot,
      status: { ...snapshot.status, platform: "darwin", supported: false, command: "" },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<AutostartSettings />);
    await waitFor(() => expect(screen.getByText("Only implemented for Windows.")).toBeTruthy());
    expect(screen.queryByText("Enable")).toBeNull();
  });
});
