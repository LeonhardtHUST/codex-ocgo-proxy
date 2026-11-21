import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  buildStartCommand,
  locationFor,
  quoteCommandArg,
  registryAddArgs,
  registryDeleteArgs,
  registryQueryArgs,
  requiresElevation,
  startupScriptContents,
  startupScriptPath,
  taskCreateArgs,
  type AutostartSettings,
} from "@src/autostart/windows.js";
import {
  buildElevatedHelperCommand,
  defaultTarget,
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
  type AutostartDependencies,
} from "@src/autostart/index.js";
import { createAutostartRoutes } from "@src/routes/admin/autostart.js";

const layout = { root: "D:\\app", startupDir: "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", userName: "u" };
const target = { executablePath: "C:\\Program Files\\OpenCodeX\\app.exe", args: [] as string[] };

const settings = (overrides: Partial<AutostartSettings> = {}): AutostartSettings => ({
  mode: "registry",
  scope: "user",
  runAsAdmin: false,
  delaySeconds: 0,
  ...overrides,
});

function deps(overrides: AutostartDependencies = {}): AutostartDependencies {
  return { platform: "win32", layout, target, ...overrides };
}

describe("autostart command builders", () => {
  it("quotes only when needed", () => {
    expect(quoteCommandArg("C:\\app.exe")).toBe("C:\\app.exe");
    expect(quoteCommandArg("C:\\Program Files\\app.exe")).toBe('"C:\\Program Files\\app.exe"');
  });

  it("builds the logon command line", () => {
    expect(buildStartCommand("C:\\Program Files\\a b\\app.exe", ["--hidden"], ["--port=8080"]))
      .toBe('"C:\\Program Files\\a b\\app.exe" --hidden --port=8080');
  });

  it("targets the per-user or machine Run key", () => {
    expect(registryAddArgs("user", "cmd")[1]).toBe("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(registryAddArgs("machine", "cmd")[1]).toBe("HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    expect(registryAddArgs("user", "cmd")).toContain("OpenCodeX-Router");
    expect(registryQueryArgs("user")[0]).toBe("query");
    expect(registryDeleteArgs("user")).toContain("/f");
  });

  it("only asks for RL HIGHEST when elevation at logon was requested", () => {
    const plain = taskCreateArgs(layout, settings({ mode: "task" }), "cmd");
    expect(plain).toContain("ONLOGON");
    expect(plain).not.toContain("/RL");

    const elevated = taskCreateArgs(layout, settings({ mode: "task", runAsAdmin: true }), "cmd");
    expect(elevated).toContain("/RL");
    expect(elevated).toContain("HIGHEST");
  });

  it("writes a startup wrapper with an optional delay", () => {
    expect(startupScriptPath(layout.startupDir)).toContain("OpenCodeX-Router.cmd");
    expect(startupScriptContents("C:\\app.exe", 0)).not.toContain("timeout");
    const delayed = startupScriptContents("C:\\app.exe", 30);
    expect(delayed).toContain("timeout /t 30");
    expect(delayed).toContain('start "" C:\\app.exe');
  });

  it("knows which selections need administrator rights", () => {
    expect(requiresElevation(settings())).toBe(false);
    expect(requiresElevation(settings({ scope: "machine" }))).toBe(true);
    expect(requiresElevation(settings({ mode: "task" }))).toBe(true);
    expect(requiresElevation(settings({ mode: "startup" }))).toBe(false);
  });

  it("reports where the entry would live", () => {
    expect(locationFor(settings(), layout)).toContain("HKCU");
    expect(locationFor(settings({ mode: "task" }), layout)).toContain("Task Scheduler");
    expect(locationFor(settings({ mode: "startup" }), layout)).toContain("Startup");
  });

  it("builds a single-prompt elevated helper invocation", () => {
    const args = buildElevatedHelperCommand("D:\\app\\scripts\\autostart-helper.mjs", settings({ mode: "task", runAsAdmin: true }), "C:\\app.exe");
    expect(args[0]).toBe("-NoProfile");
    expect(args.at(-1)).toContain("-Verb RunAs");
    expect(args.at(-1)).toContain("--run-as-admin");

    const removal = buildElevatedHelperCommand("D:\\app\\helper.mjs", settings(), "C:\\app.exe", "remove");
    expect(removal.at(-1)).toContain("'--remove'");
  });

  it("prefers the configured command override", () => {
    const target = defaultTarget({ env: { OPENCODEX_AUTOSTART_COMMAND: "C:\\app.exe --hidden" } });
    expect(target).toEqual({ executablePath: "C:\\app.exe", args: ["--hidden"] });
  });
});

describe("autostart facade", () => {
  const command = "C:\\Program Files\\OpenCodeX\\app.exe";

  it("reports unsupported on other platforms instead of pretending", async () => {
    const result = await getAutostartStatus(settings(), deps({ platform: "darwin" }));
    expect(result.supported).toBe(false);
    const applied = await enableAutostart(settings(), deps({ platform: "darwin" }));
    expect(applied.ok).toBe(false);
    expect(applied.error).toContain("Windows");
  });

  it("registers through the user Run key without elevation", async () => {
    const run = vi.fn(async () => "");
    const applied = await enableAutostart(settings(), deps({ run }));
    expect(applied.ok).toBe(true);
    // enable() re-reads status afterwards, so pick the write rather than the last call.
    const write = (run.mock.calls as unknown as Array<[string, string[]]>).find(([, args]) => args[0] === "add");
    expect(write?.[0]).toBe("reg.exe");
    // The value is stored quoted because the executable path contains a space.
    expect(write?.[1].join(" ")).toContain(`"${command}"`);
  });

  it("asks for elevation when the machine-wide key is denied", async () => {
    const run = vi.fn(async () => { throw new Error("ERROR: Access is denied."); });
    const applied = await enableAutostart(settings({ scope: "machine" }), deps({ run }));
    expect(applied.ok).toBe(false);
    expect(applied.elevationRequired).toBe(true);
    expect(applied.status.elevationRequired).toBe(true);
  });

  it("registers an ONLOGON task with RL HIGHEST", async () => {
    const run = vi.fn(async () => "");
    const applied = await enableAutostart(settings({ mode: "task", runAsAdmin: true }), deps({ run }));
    expect(applied.ok).toBe(true);
    const create = (run.mock.calls as unknown as Array<[string, string[]]>).find(([, args]) => args.includes("/Create"));
    expect(create?.[0]).toBe("schtasks.exe");
    expect(create?.[1]).toContain("/RL");
    expect(create?.[1]).toContain("HIGHEST");
  });

  it("writes and deletes the startup-folder wrapper without elevation", async () => {
    const writeFile = vi.fn();
    let exists = false;
    const applied = await enableAutostart(settings({ mode: "startup", delaySeconds: 15 }), deps({
      writeFile,
      fileExists: () => exists,
    }));
    expect(applied.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    const [path, contents] = writeFile.mock.calls[0] as unknown as [string, string];
    expect(path).toContain("OpenCodeX-Router.cmd");
    expect(contents).toContain("timeout /t 15");

    exists = true;
    const removeFile = vi.fn(() => { exists = false; });
    const removed = await disableAutostart(settings({ mode: "startup" }), deps({ removeFile, fileExists: () => exists }));
    expect(removed.ok).toBe(true);
    expect(removeFile).toHaveBeenCalledOnce();
  });

  it("treats removing a missing registry entry as success", async () => {
    const run = vi.fn(async (file: string, args: string[]) => {
      if (args[0] === "delete") throw new Error("ERROR: The system was unable to find the specified registry key or value.");
      return "";
    });
    const removed = await disableAutostart(settings(), deps({ run }));
    expect(removed.ok).toBe(true);
  });

  it("detects an existing registry entry", async () => {
    const run = vi.fn(async () => "    OpenCodeX-Router    REG_SZ    C:\\app.exe");
    const status = await getAutostartStatus(settings(), deps({ run }));
    expect(status.registered).toBe(true);
    expect(status.command).toContain("app.exe");
  });
});

describe("autostart admin routes", () => {
  function app(overrides: AutostartDependencies = {}) {
    const applied: Array<{ enabled: boolean }> = [];
    const instance = createAutostartRoutes({
      getSettings: () => settings(),
      getMasterKey: () => "master-key",
      deps: deps(overrides),
      spawnImpl: vi.fn(() => ({ unref: vi.fn() })) as never,
    });
    return { instance, applied };
  }

  const auth = { Authorization: "Bearer master-key" };

  it("requires auth", async () => {
    const { instance } = app();
    expect((await instance.request("/admin/autostart")).status).toBe(401);
  });

  it("reports status without touching the registry", async () => {
    const run = vi.fn(async () => { throw new Error("not found"); });
    const { instance } = app({ run });
    const response = await instance.request("/admin/autostart", { headers: auth });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: { registered: boolean; supported: boolean } };
    expect(body.status.supported).toBe(true);
    expect(body.status.registered).toBe(false);
  });

  it("rejects an invalid body", async () => {
    const { instance } = app();
    const response = await instance.request("/admin/autostart", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(response.status).toBe(400);
  });

  it("enables autostart through the user Run key", async () => {
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "query" && !querySeen) { querySeen = true; throw new Error("not found"); }
      return "";
    });
    let querySeen = false;
    const { instance } = app({ run });
    const response = await instance.request("/admin/autostart", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
  });

  it("answers 409 with an elevation hint when admin rights are needed", async () => {
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "add") throw new Error("ERROR: Access is denied.");
      throw new Error("not found");
    });
    const { instance } = app({ run });
    const response = await instance.request("/admin/autostart", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, mode: "task" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { elevationRequired: boolean; hint: string };
    expect(body.elevationRequired).toBe(true);
    expect(body.hint).toContain("/admin/autostart/elevate");
  });

  it("spawns the elevated helper on request", async () => {
    const { instance } = app();
    const response = await instance.request("/admin/autostart/elevate", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, started: true, action: "apply" });
  });
});

// Keep the Hono import meaningful for the type-only route helper above.
void (Hono as unknown);
