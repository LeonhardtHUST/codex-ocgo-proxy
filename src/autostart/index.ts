/**
 * Autostart facade.
 *
 * Windows is the supported target. Other platforms report `supported: false` rather than
 * pretending (a silently failing autostart is worse than an honest "not implemented").
 *
 * Registration is user-initiated: nothing here writes to the registry or the task
 * scheduler unless an admin API call or the elevated helper asks it to.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { getRootDir } from "../paths.js";
import {
  AUTOSTART_ENTRY_NAME,
  type AutostartMode,
  type AutostartScope,
  type AutostartSettings,
  type AutostartStatus,
  type SchtasksLayout,
  buildStartCommand,
  locationFor,
  registryAddArgs,
  registryDeleteArgs,
  registryQueryArgs,
  requiresElevation,
  startupScriptContents,
  startupScriptPath,
  taskCreateArgs,
  taskDeleteArgs,
  taskQueryArgs,
} from "./windows.js";

const execFileAsync = promisify(execFile);

export type { AutostartMode, AutostartScope, AutostartSettings, AutostartStatus };

/** Command Windows should run. Overridable for portable / Electron distributions. */
export interface AutostartTarget {
  executablePath: string;
  args: string[];
  /** Extra arguments appended at logon, e.g. `--open-dashboard`. */
  extraArgs?: string[];
}

export interface AutostartDependencies {
  platform?: NodeJS.Platform;
  layout?: SchtasksLayout;
  target?: AutostartTarget;
  /** Injected executor: returns stdout, throws on non-zero exit. */
  run?: (file: string, args: string[]) => Promise<string>;
  fileExists?: (path: string) => boolean;
  writeFile?: (path: string, contents: string) => void;
  removeFile?: (path: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Tolerant default target: Electron binary when packaged, otherwise node + dist entry. */
export function defaultTarget(deps: AutostartDependencies = {}): AutostartTarget {
  const env = deps.env ?? process.env;
  const override = env.OPENCODEX_AUTOSTART_COMMAND?.trim();
  if (override) {
    const [executablePath, ...args] = override.split(" ");
    return { executablePath, args };
  }
  const execPath = process.execPath;
  // Running inside Electron: execPath is the app binary and takes no script argument.
  if (process.versions?.electron) return { executablePath: execPath, args: ["--hidden"] };
  return { executablePath: execPath, args: [`${getRootDir()}\\dist\\index.js`] };
}

function defaultLayout(deps: AutostartDependencies): SchtasksLayout {
  const env = deps.env ?? process.env;
  const appData = env.APPDATA ?? `${homedir()}\\AppData\\Roaming`;
  return {
    root: getRootDir(),
    startupDir: `${appData}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`,
    ...(env.USERNAME ? { userName: env.USERNAME } : {}),
  };
}

async function defaultRun(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true });
  return stdout;
}

function isAccessDenied(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? ""}`.toLowerCase();
  return text.includes("access is denied") || text.includes("拒绝访问") || text.includes("elevation");
}

function deps(overrides: AutostartDependencies) {
  const layout = overrides.layout ?? defaultLayout(overrides);
  return {
    platform: overrides.platform ?? process.platform,
    layout,
    target: overrides.target ?? defaultTarget(overrides),
    run: overrides.run ?? defaultRun,
    fileExists: overrides.fileExists ?? existsSync,
    writeFile: overrides.writeFile,
    removeFile: overrides.removeFile,
  };
}

/** Current registration state, without modifying anything. */
export async function getAutostartStatus(
  settings: AutostartSettings,
  overrides: AutostartDependencies = {},
): Promise<AutostartStatus> {
  const d = deps(overrides);
  const command = buildStartCommand(d.target.executablePath, d.target.args, d.target.extraArgs ?? []);
  const base: AutostartStatus = {
    platform: d.platform,
    supported: d.platform === "win32",
    mode: settings.mode,
    scope: settings.scope,
    runAsAdmin: settings.runAsAdmin,
    delaySeconds: settings.delaySeconds,
    registered: false,
    elevationRequired: requiresElevation(settings),
    command,
    location: locationFor(settings, d.layout),
  };
  if (d.platform !== "win32") return base;

  try {
    if (settings.mode === "registry") {
      await d.run("reg.exe", registryQueryArgs(settings.scope));
      return { ...base, registered: true };
    }
    if (settings.mode === "task") {
      await d.run("schtasks.exe", taskQueryArgs());
      return { ...base, registered: true };
    }
    return { ...base, registered: d.fileExists(startupScriptPath(d.layout.startupDir)) };
  } catch (error) {
    // A missing entry is the normal case; only report unexpected failures.
    if (isAccessDenied(error)) return { ...base, lastError: "access denied while reading the entry" };
    return base;
  }
}

export interface AutostartApplyResult {
  ok: boolean;
  status: AutostartStatus;
  /** True when the caller must run the elevated helper and try again. */
  elevationRequired?: boolean;
  error?: string;
}

/** Register (or refresh) the autostart entry. */
export async function enableAutostart(
  settings: AutostartSettings,
  overrides: AutostartDependencies = {},
): Promise<AutostartApplyResult> {
  const d = deps(overrides);
  const command = buildStartCommand(d.target.executablePath, d.target.args, d.target.extraArgs ?? []);
  const status = await getAutostartStatus(settings, overrides);
  if (!status.supported) return { ok: false, status, error: "autostart is only implemented for Windows" };

  try {
    if (settings.mode === "registry") {
      await d.run("reg.exe", registryAddArgs(settings.scope, command));
    } else if (settings.mode === "task") {
      await d.run("schtasks.exe", taskCreateArgs(d.layout, settings, command));
    } else {
      const path = startupScriptPath(d.layout.startupDir);
      const contents = startupScriptContents(command, settings.delaySeconds);
      if (d.writeFile) d.writeFile(path, contents);
      else {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, contents, "utf8");
      }
    }
  } catch (error) {
    if (isAccessDenied(error) || requiresElevation(settings)) {
      return {
        ok: false,
        status: await getAutostartStatus(settings, overrides),
        elevationRequired: true,
        error: (error as Error).message,
      };
    }
    return { ok: false, status, error: (error as Error).message };
  }
  return { ok: true, status: await getAutostartStatus(settings, overrides) };
}

/** Remove the autostart entry (idempotent: a missing entry is a success). */
export async function disableAutostart(
  settings: AutostartSettings,
  overrides: AutostartDependencies = {},
): Promise<AutostartApplyResult> {
  const d = deps(overrides);
  const status = await getAutostartStatus(settings, overrides);
  if (!status.supported) return { ok: false, status, error: "autostart is only implemented for Windows" };

  try {
    if (settings.mode === "registry") {
      await d.run("reg.exe", registryDeleteArgs(settings.scope));
    } else if (settings.mode === "task") {
      await d.run("schtasks.exe", taskDeleteArgs());
    } else {
      const path = startupScriptPath(d.layout.startupDir);
      if (d.removeFile) d.removeFile(path);
      else {
        const { rmSync } = await import("node:fs");
        rmSync(path, { force: true });
      }
    }
  } catch (error) {
    // Deleting an entry that is not there is the desired end state, not a failure.
    const text = `${(error as Error)?.message ?? ""}`.toLowerCase();
    const missing = text.includes("unable to find") || text.includes("找不到") || text.includes("does not exist") || text.includes("cannot find");
    if (missing) return { ok: true, status: await getAutostartStatus(settings, overrides) };
    if (isAccessDenied(error)) {
      return { ok: false, status, elevationRequired: true, error: (error as Error).message };
    }
    return { ok: false, status, error: (error as Error).message };
  }
  return { ok: true, status: await getAutostartStatus(settings, overrides) };
}

/** Windows command line that re-runs the helper elevated (one UAC prompt). */
export function buildElevatedHelperCommand(
  helperScript: string,
  settings: AutostartSettings,
  command: string,
  action: "apply" | "remove" = "apply",
): string[] {
  const helperArgs = [
    action === "apply" ? "--apply" : "--remove",
    `--mode=${settings.mode}`,
    `--scope=${settings.scope}`,
    ...(settings.runAsAdmin ? ["--run-as-admin"] : []),
    ...(action === "apply" ? [`--command=${command}`] : []),
  ];
  const escaped = helperArgs.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(",");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process -Verb RunAs -FilePath '${process.execPath}' -ArgumentList @('${helperScript}',${escaped}) -Wait`,
  ];
}

export { AUTOSTART_ENTRY_NAME };
