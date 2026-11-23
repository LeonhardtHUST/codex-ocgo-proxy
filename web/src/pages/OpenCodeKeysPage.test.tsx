/** @vitest-environment jsdom */
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenCodeKeysPage } from "./OpenCodeKeysPage";

const token = { total: null, unknown: 0 };
const entry = {
  id: "fake-id-1", name: "Test Go Key", models: ["mock-model"], enabled: true, quotaGroup: "verified",
  invalid: false, deniedModels: [], busy: false, cooldownUntil: null,
  upstreamAttempts: { started: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: token, outputTokens: token, cachedTokens: token },
};
let root: HTMLElement;
beforeEach(() => { root = document.createElement("div"); document.body.append(root); });
afterEach(() => { render(null, root); root.remove(); vi.unstubAllGlobals(); });

async function waitForText(text: string) {
  await vi.waitFor(() => expect(root.textContent).toContain(text));
}

function button(text: string) {
  return [...root.querySelectorAll("button")].find((item) => item.textContent === text);
}

function click(text: string) {
  const item = button(text);
  expect(item?.disabled).toBe(false);
  item!.click();
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

it("loads and mutates only the OpenCode admin endpoint, never prefilling the Key", async () => {
  let entries = [entry];
  const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "DELETE") entries = [];
    return Response.json({ enabled: true, credentials: entries, clientRequests: { started: 0, succeeded: 0, failed: 0, cancelled: 0 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => { render(<OpenCodeKeysPage masterApiKey="fake-app-master" />, root); });
  await waitForText("Official quota: unknown");
  expect(root.textContent).toContain("opencode:mock-model");
  await act(async () => { click("Edit / replace"); });
  const form = root.querySelector("form")!;
  const password = form.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(password.value).toBe("");
  password.value = "fake-replacement-key";
  await act(async () => { submit(form); });
  expect(password.value).toBe("");
  const patch = fetchMock.mock.calls.find(([, init]) => init.method === "PATCH")!;
  expect(patch[0]).toBe("/admin/opencode/keys/fake-id-1");
  expect(JSON.parse(String(patch[1].body))).toEqual({ name: entry.name, models: entry.models, apiKey: "fake-replacement-key" });
  expect(new Headers(patch[1].headers).get("Authorization")).toBe("Bearer fake-app-master");
  expect(root.textContent).not.toContain("fake-replacement-key");
  await vi.waitFor(() => expect(root.querySelector("form")).toBeNull());
  await vi.waitFor(() => expect(button("Verify")?.disabled).toBe(false));
  await act(async () => { click("Verify"); });
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/verify"))).toBe(false);
  await act(async () => { click("Confirm"); });
  expect(fetchMock.mock.calls.find(([url]) => url.endsWith("/verify"))?.[1].body).toBe('{"model":"mock-model"}');
  await waitForText("Verification completed.");
  await vi.waitFor(() => expect(button("Remove")?.disabled).toBe(false));
  await act(async () => { click("Remove"); });
  await act(async () => { click("Confirm"); });
  await waitForText("No OpenCode credentials added.");
});

it("adds a Key and toggles the stored enabled state without resending the secret", async () => {
  let entries: (typeof entry)[] = [];
  const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "POST") entries = [entry];
    if (init.method === "PATCH") entries = [{ ...entry, enabled: false }];
    return Response.json({ enabled: true, credentials: entries });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => { render(<OpenCodeKeysPage />, root); });
  await waitForText("No OpenCode credentials added.");
  await act(async () => { click("Add Go Key"); });
  const form = root.querySelector("form")!;
  form.querySelector<HTMLInputElement>('input[name="name"]')!.value = entry.name;
  form.querySelector<HTMLInputElement>('input[name="models"]')!.value = "mock-model, mock-model";
  form.querySelector<HTMLInputElement>('input[name="apiKey"]')!.value = "fake-new-key";
  await act(async () => { submit(form); });
  expect(fetchMock.mock.calls.find(([, init]) => init.method === "POST")?.[1].body)
    .toBe(JSON.stringify({ name: entry.name, models: entry.models, apiKey: "fake-new-key", quotaGroup: null }));
  await vi.waitFor(() => expect(button("Disable")?.disabled).toBe(false));
  await act(async () => { click("Disable"); });
  expect(fetchMock.mock.calls.find(([, init]) => init.method === "PATCH")?.[1].body).toBe('{"enabled":false}');
  await vi.waitFor(() => expect(button("Enable")?.disabled).toBe(false));
});

it("ignores a stale enabled:false from the backend", async () => {
  // The enable switch is retired; a backend that still reports false must not resurrect
  // the old "not enabled" banner or block outbound verification.
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ enabled: false, credentials: [entry] })));
  await act(async () => { render(<OpenCodeKeysPage />, root); });
  await waitForText("Edit / replace");
  expect(document.body.textContent ?? "").not.toContain("is disabled");
  expect(button("Verify")?.disabled).toBe(false);
  expect(button("Edit / replace")?.disabled).toBe(false);
});
