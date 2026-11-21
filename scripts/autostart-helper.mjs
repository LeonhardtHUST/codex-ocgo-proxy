/**
 * Elevated helper for autostart registration.
 *
 * Run through `Start-Process -Verb RunAs`, so it is a separate short-lived process that
 * only touches the Run key / Task Scheduler entry it was told to. It never reads the app
 * config and never starts the server.
 *
 * Usage:
 *   node scripts/autostart-helper.mjs --apply   --mode=task --scope=user --command="C:\...\app.exe"
 *   node scripts/autostart-helper.mjs --remove  --mode=task --scope=user
 */

import { execFileSync } from "node:child_process";

const ENTRY = "OpenCodeX-Router";

function parseArgs(argv) {
  const out = { apply: false, remove: false, mode: "registry", scope: "user", runAsAdmin: false, command: null };
  for (const arg of argv) {
    if (arg === "--apply") out.apply = true;
    else if (arg === "--remove") out.remove = true;
    else if (arg === "--run-as-admin") out.runAsAdmin = true;
    else if (arg.startsWith("--mode=")) out.mode = arg.slice(7);
    else if (arg.startsWith("--scope=")) out.scope = arg.slice(8);
    else if (arg.startsWith("--command=")) out.command = arg.slice(10);
  }
  return out;
}

function run(file, args) {
  execFileSync(file, args, { stdio: "inherit", windowsHide: true });
}

function registryKey(scope) {
  return scope === "machine"
    ? "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    : "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply && !options.remove) {
    console.error("usage: autostart-helper (--apply|--remove) [--mode=registry|task|startup] [--scope=user|machine] [--run-as-admin] [--command=<cmd>]");
    process.exit(2);
  }
  if (process.platform !== "win32") {
    console.error("autostart helper only supports Windows");
    process.exit(3);
  }

  try {
    if (options.mode === "task") {
      if (options.remove) {
        run("schtasks.exe", ["/Delete", "/F", "/TN", ENTRY]);
      } else {
        if (!options.command) throw new Error("--command is required when applying");
        const args = ["/Create", "/F", "/TN", ENTRY, "/TR", options.command, "/SC", "ONLOGON"];
        if (options.runAsAdmin) args.push("/RL", "HIGHEST");
        if (options.scope === "machine") args.push("/RU", "SYSTEM");
        run("schtasks.exe", args);
      }
    } else if (options.mode === "registry") {
      const key = registryKey(options.scope);
      if (options.remove) {
        run("reg.exe", ["delete", key, "/v", ENTRY, "/f"]);
      } else {
        if (!options.command) throw new Error("--command is required when applying");
        run("reg.exe", ["add", key, "/v", ENTRY, "/t", "REG_SZ", "/d", options.command, "/f"]);
      }
    } else {
      throw new Error(`unsupported mode for the helper: ${options.mode} (startup folder needs no elevation)`);
    }
  } catch (error) {
    console.error(`autostart-helper failed: ${error?.message ?? error}`);
    process.exit(1);
  }
  console.log(`autostart-helper: ${options.remove ? "removed" : "registered"} (${options.mode}/${options.scope})`);
}

main();
