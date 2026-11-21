/**
 * Windows autostart primitives.
 *
 * Three registration modes, ordered by what they can do:
 *
 *   registry     HKCU\...\Run          — per user, no admin, starts as the logged-in user.
 *   startup      Startup folder        — per user, no admin, weakest (no delay control).
 *   task         Task Scheduler        — `ONLOGON` + `RL HIGHEST`; starts elevated *without*
 *                                        a UAC prompt at logon, but registering it needs admin.
 *
 * Everything here is a pure builder: it produces the exact command, registry value or
 * task arguments. Execution is injected so the builders can be tested without touching a
 * real registry, and so the elevated helper runs the same strings the server validated.
 */

export const AUTOSTART_ENTRY_NAME = "OpenCodeX-Router";

export type AutostartMode = "registry" | "task" | "startup";
export type AutostartScope = "user" | "machine";

export interface AutostartSettings {
  mode: AutostartMode;
  scope: AutostartScope;
  runAsAdmin: boolean;
  /** Delay before the app starts, where the mode supports it. */
  delaySeconds: number;
}

export interface AutostartStatus extends AutostartSettings {
  platform: NodeJS.Platform;
  supported: boolean;
  /** True when the entry is currently registered. */
  registered: boolean;
  /** True when registering the current selection needs an elevated helper. */
  elevationRequired: boolean;
  /** Command that would be registered. */
  command: string;
  /** Where the entry lives, for diagnostics. */
  location: string;
  lastError?: string;
}

/** Quote an argument for cmd.exe / Task Scheduler consumption. */
export function quoteCommandArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Build the command Windows will run at logon. */
export function buildStartCommand(executablePath: string, args: readonly string[], extraArgs: readonly string[] = []): string {
  return [executablePath, ...args, ...extraArgs].map(quoteCommandArg).join(" ");
}

/** Registry Run key path for the requested scope. */
export function registryKeyPath(scope: AutostartScope): string {
  return scope === "machine"
    ? "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    : "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

/** `reg.exe` arguments that create/replace the Run entry. */
export function registryAddArgs(scope: AutostartScope, command: string): string[] {
  return ["add", registryKeyPath(scope), "/v", AUTOSTART_ENTRY_NAME, "/t", "REG_SZ", "/d", command, "/f"];
}

/** `reg.exe` arguments that query the Run entry. */
export function registryQueryArgs(scope: AutostartScope): string[] {
  return ["query", registryKeyPath(scope), "/v", AUTOSTART_ENTRY_NAME];
}

/** `reg.exe` arguments that delete the Run entry. */
export function registryDeleteArgs(scope: AutostartScope): string[] {
  return ["delete", registryKeyPath(scope), "/v", AUTOSTART_ENTRY_NAME, "/f"];
}

export interface SchtasksLayout {
  root: string;
  startupDir: string;
  userName?: string;
}

/**
 * `schtasks.exe` arguments for an ONLOGON task.
 *
 * `RL HIGHEST` is what makes "start elevated without a UAC prompt at logon" possible; it is
 * also the reason creating the task needs elevation once.
 */
export function taskCreateArgs(layout: SchtasksLayout, settings: AutostartSettings, command: string): string[] {
  const args = [
    "/Create", "/F",
    "/TN", AUTOSTART_ENTRY_NAME,
    "/TR", command,
    "/SC", "ONLOGON",
  ];
  if (settings.runAsAdmin) args.push("/RL", "HIGHEST");
  if (layout.userName) args.push("/RU", layout.userName);
  return args;
}

export function taskDeleteArgs(): string[] {
  return ["/Delete", "/F", "/TN", AUTOSTART_ENTRY_NAME];
}

export function taskQueryArgs(): string[] {
  return ["/Query", "/TN", AUTOSTART_ENTRY_NAME];
}

/** Startup-folder shortcut target (a .cmd wrapper keeps it dependency-free). */
export function startupScriptPath(startupDir: string): string {
  return `${startupDir}\\${AUTOSTART_ENTRY_NAME}.cmd`;
}

/** Contents of the startup-folder wrapper, including the optional delay. */
export function startupScriptContents(command: string, delaySeconds: number): string {
  const delay = delaySeconds > 0 ? `timeout /t ${Math.min(delaySeconds, 600)} /nobreak >nul\r\n` : "";
  return `@echo off\r\nrem Managed by OpenCodeX-Router — deleting this file disables autostart.\r\n${delay}start "" ${command}\r\n`;
}

/** Whether registering this selection requires administrator rights. */
export function requiresElevation(settings: AutostartSettings): boolean {
  if (settings.mode === "task") return true;
  if (settings.mode === "registry") return settings.scope === "machine";
  return settings.scope === "machine";
}

/** Human-readable location for diagnostics. */
export function locationFor(settings: AutostartSettings, layout: SchtasksLayout): string {
  if (settings.mode === "task") return `Task Scheduler: ${AUTOSTART_ENTRY_NAME}`;
  if (settings.mode === "registry") return registryKeyPath(settings.scope);
  return startupScriptPath(layout.startupDir);
}
