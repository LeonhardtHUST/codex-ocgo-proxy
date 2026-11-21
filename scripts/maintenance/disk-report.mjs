#!/usr/bin/env node
/**
 * Disk footprint report — read-only.
 *
 * Answers "where did ~1 GiB go" before anyone changes the distribution form. Groups the
 * footprint into the categories that drive different decisions:
 *
 *   install      app binaries (Electron install dirs, portable extracted copies)
 *   updater      electron-updater download cache (old versions, deleted safely)
 *   browser      Chromium / WebView2 profile + GPU caches (regenerated on demand)
 *   user-data    accounts, keys, logs, model cache (must never be deleted blindly)
 *   workspace    repo-local build output, only meaningful in a source checkout
 *
 * Usage:
 *   node scripts/maintenance/disk-report.mjs            # human table
 *   node scripts/maintenance/disk-report.mjs --json     # machine readable
 *   node scripts/maintenance/disk-report.mjs --root D:\Projects\GitHub\codex-ocgo-proxy
 *
 * Nothing here deletes or moves files.
 */

import { readdir, lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

/** App/product names that may appear in install and cache paths. */
export const APP_NAMES = ["opencodex-router", "OpenCodeX-Router", "@opencodex-router", "codex-proxy", "Codex Proxy", "@codex-proxy"];

/** Categories, in report order. */
export const CATEGORIES = ["install", "updater", "browser", "user-data", "workspace"];

export const CATEGORY_LABELS = {
  install: "安装目录 / 便携解压副本",
  updater: "更新器缓存（旧版本）",
  browser: "Chromium / WebView2 缓存",
  "user-data": "用户数据（账号、Key、日志）",
  workspace: "仓库构建产物",
};

export function parseArgs(argv) {
  const options = { json: false, root: REPO_ROOT, depth: 3 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = resolve(argv[++index] ?? options.root);
    else if (arg === "--depth") options.depth = Number(argv[++index] ?? options.depth) || options.depth;
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatPercent(part, total) {
  if (!total) return "-";
  return `${((part / total) * 100).toFixed(0)}%`;
}

/** Whether a path name looks like one of ours. */
export function matchesAppName(name) {
  const lowered = name.toLowerCase();
  return APP_NAMES.some((candidate) => lowered.includes(candidate.toLowerCase()));
}

/**
 * Sum the size of a tree without following symlinks/junctions (they would double count or
 * loop). Missing paths yield 0 rather than throwing.
 */
export async function measurePath(target, { maxEntries = 200_000 } = {}) {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let info;
    try {
      info = await lstat(current);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) {
      files++;
      bytes += info.size;
      entries++;
    } else if (info.isDirectory()) {
      entries++;
      let children;
      try {
        children = await readdir(current);
      } catch {
        continue;
      }
      for (const child of children) stack.push(join(current, child));
    }
    if (entries > maxEntries) break;
  }
  return { bytes, files, truncated: entries > maxEntries };
}

/** Candidate paths per category for the current platform. */
export function candidatePaths({ platform, env = process.env, home = homedir(), root = REPO_ROOT } = {}) {
  const groups = { install: [], updater: [], browser: [], "user-data": [], workspace: [] };

  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    for (const name of APP_NAMES) {
      groups["user-data"].push(join(appData, name));
      groups.browser.push(join(localAppData, name));
      groups.install.push(join(localAppData, "Programs", name));
      groups.updater.push(join(localAppData, `${name}-updater`));
    }
  } else if (platform === "darwin") {
    for (const name of APP_NAMES) {
      groups["user-data"].push(join(home, "Library", "Application Support", name));
      groups.browser.push(join(home, "Library", "Caches", name));
      groups.install.push(join(home, "Applications", `${name}.app`));
      groups.updater.push(join(home, "Library", "Caches", `${name}-updater`));
    }
  } else {
    const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    const cache = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
    for (const name of APP_NAMES) {
      groups["user-data"].push(join(config, name));
      groups.browser.push(join(cache, name));
      groups.install.push(join(home, "Applications", name));
      groups.updater.push(join(cache, `${name}-updater`));
    }
  }

  groups.workspace.push(
    ...["dist", "dist-electron", "public", "release", "portable-release", "node_modules", "data", ".git"]
      .map((entry) => join(root, entry)),
    join(root, "native", "target"),
    join(root, "native", "ocx-router", "target"),
  );

  return groups;
}

/** De-duplicate and drop nested paths so nothing is counted twice. */
export function normalizeCandidates(paths) {
  const unique = [...new Set(paths.map((entry) => resolve(entry)))].sort();
  return unique.filter((entry, index) => {
    const previous = unique[index - 1];
    return !previous || !(entry === previous || entry.startsWith(`${previous}${process.platform === "win32" ? "\\" : "/"}`));
  });
}

/** Scan bounded roots for directories whose name matches one of ours (portable copies). */
export async function findPortableCopies({ roots = [], depth = 2 } = {}) {
  const found = [];
  const walk = async (current, remaining) => {
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const next = join(current, child.name);
      if (matchesAppName(child.name)) {
        found.push(next);
        continue;
      }
      if (remaining > 1) await walk(next, remaining - 1);
    }
  };
  for (const root of roots) await walk(root, depth);
  return found;
}

export async function buildReport(options = {}) {
  const platform = process.platform;
  const groups = candidatePaths({ platform, root: options.root ?? REPO_ROOT });
  const report = { generatedAt: new Date().toISOString(), platform, total: 0, groups: {} };

  for (const category of CATEGORIES) {
    const entries = [];
    for (const candidate of normalizeCandidates(groups[category] ?? [])) {
      let present = false;
      try {
        present = (await stat(candidate)).isDirectory();
      } catch {
        present = false;
      }
      if (!present) continue;
      const { bytes, files, truncated } = await measurePath(candidate);
      if (bytes === 0) continue;
      entries.push({ path: candidate, bytes, files, ...(truncated ? { truncated } : {}) });
      report.total += bytes;
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    report.groups[category] = entries;
  }

  if (options.findCopies) {
    const roots = platform === "win32"
      ? [join(homedir(), "Downloads"), join(homedir(), "Desktop")]
      : [join(homedir(), "Downloads"), join(homedir(), "Desktop")];
    const copies = await findPortableCopies({ roots, depth: options.depth ?? 2 });
    const entries = [];
    for (const copy of normalizeCandidates(copies)) {
      const { bytes, files } = await measurePath(copy);
      if (bytes > 0) entries.push({ path: copy, bytes, files });
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    if (entries.length > 0) {
      report.groups.install.push(...entries.map((entry) => ({ ...entry, portable: true })));
      report.total += entries.reduce((sum, entry) => sum + entry.bytes, 0);
    }
  }

  return report;
}

export function renderTable(report) {
  const lines = [];
  lines.push(`磁盘占用报告  ${report.platform}  ${report.generatedAt}`);
  lines.push("");
  for (const category of CATEGORIES) {
    const entries = report.groups[category] ?? [];
    const subtotal = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    lines.push(`${CATEGORY_LABELS[category]}  ${formatBytes(subtotal)}  (${formatPercent(subtotal, report.total)})`);
    if (entries.length === 0) {
      lines.push("  —");
      continue;
    }
    for (const entry of entries.slice(0, 12)) {
      lines.push(`  ${formatBytes(entry.bytes).padStart(9)}  ${entry.truncated ? "[扫描截断] " : ""}${entry.path}`);
    }
    if (entries.length > 12) lines.push(`  … 另有 ${entries.length - 12} 项`);
    lines.push("");
  }
  lines.push(`合计  ${formatBytes(report.total)}`);
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: node scripts/maintenance/disk-report.mjs [--json] [--root <repo>] [--depth <n>]");
    return;
  }
  const report = await buildReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderTable(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
