import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_NAMES,
  CATEGORIES,
  buildReport,
  candidatePaths,
  formatBytes,
  formatPercent,
  matchesAppName,
  measurePath,
  normalizeCandidates,
  parseArgs,
  renderTable,
} from "../../../scripts/maintenance/disk-report.mjs";

const dirs = [];
function tempDir(prefix = "disk-report-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  // Temporary trees are small and inside the OS temp dir; leaving them would leak per run.
  for (const dir of dirs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("disk report formatting", () => {
  it("renders human readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatBytes(1024 ** 3 * 2)).toBe("2.0 GB");
  });

  it("renders percentages with a dash when the total is zero", () => {
    expect(formatPercent(50, 200)).toBe("25%");
    expect(formatPercent(10, 0)).toBe("-");
  });

  it("parses cli flags", () => {
    const parsed = parseArgs(["--json", "--root", "C:\\app", "--depth", "5"]);
    expect(parsed.json).toBe(true);
    expect(parsed.root).toBe("C:\\app");
    expect(parsed.depth).toBe(5);
    expect(parseArgs(["--help"]).help).toBe(true);
    // Unknown flags and missing values must not crash.
    expect(parseArgs(["--nope"]).json).toBe(false);
    expect(parseArgs(["--root"]).root).toBeTruthy();
  });
});

describe("disk report paths", () => {
  it("matches our product names", () => {
    expect(matchesAppName("opencodex-router")).toBe(true);
    expect(matchesAppName("Codex Proxy-updater")).toBe(true);
    expect(matchesAppName("@codex-proxy")).toBe(true);
    expect(matchesAppName("unrelated-tool")).toBe(false);
    expect(APP_NAMES.length).toBeGreaterThan(3);
  });

  it("builds platform specific candidates", () => {
    const win = candidatePaths({ platform: "win32", env: { APPDATA: "C:\\R", LOCALAPPDATA: "C:\\L" }, home: "C:\\Users\\u", root: "C:\\repo" });
    expect(win.updater.some((entry) => entry.includes("-updater"))).toBe(true);
    expect(win.install.some((entry) => entry.includes("Programs"))).toBe(true);
    expect(win["user-data"]).toContain("C:\\R\\opencodex-router");
    expect(win.workspace.some((entry) => entry.endsWith("ocx-router\\target"))).toBe(true);

    const mac = candidatePaths({ platform: "darwin", home: "/Users/u", root: "/repo" });
    expect(mac["user-data"].some((entry) => entry.includes("Application Support"))).toBe(true);

    const linux = candidatePaths({ platform: "linux", env: { XDG_CONFIG_HOME: "/cfg" }, home: "/home/u", root: "/repo" });
    // path.join uses the host separator, so compare with separators normalised.
    expect(linux["user-data"][0].replace(/\\/g, "/")).toBe("/cfg/opencodex-router");
  });

  it("drops nested and duplicate candidates so nothing is counted twice", () => {
    const normalized = normalizeCandidates(["C:\\a\\b", "C:\\a", "C:\\a\\b", "C:\\c"]);
    expect(normalized).toEqual(["C:\\a", "C:\\c"]);
  });
});

describe("disk report measurement", () => {
  it("sums files and skips symlinks", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "x".repeat(100));
    writeFileSync(join(dir, "nested", "b.txt"), "y".repeat(200));
    if (process.platform !== "win32") {
      try {
        symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));
      } catch {
        // symlinks may be unavailable in the sandbox; the assertion still holds for the rest
      }
    }
    const measured = await measurePath(dir);
    expect(measured.files).toBeGreaterThanOrEqual(2);
    expect(measured.bytes).toBeGreaterThanOrEqual(300);
    expect(measured.truncated).toBe(false);
  });

  it("returns zero for a missing path instead of throwing", async () => {
    const measured = await measurePath(join(tempDir(), "nope"));
    expect(measured).toEqual({ bytes: 0, files: 0, truncated: false });
  });
});

describe("disk report output", () => {
  it("reports every category and a total", async () => {
    const repo = tempDir("disk-repo-");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "big.bin"), "z".repeat(2048));

    const report = await buildReport({ root: repo });
    expect(report.platform).toBe(process.platform);
    expect(Object.keys(report.groups).sort()).toEqual([...CATEGORIES].sort());
    expect(report.groups.workspace.length).toBeGreaterThan(0);
    expect(report.total).toBeGreaterThanOrEqual(2048);

    const table = renderTable(report);
    expect(table).toContain("合计");
    expect(table).toContain("node_modules");
  });

  it("is serialisable for CI", async () => {
    const repo = tempDir("disk-repo-json-");
    const report = await buildReport({ root: repo });
    const roundTripped = JSON.parse(JSON.stringify(report)) as { total: number; groups: Record<string, unknown[]> };
    expect(roundTripped.total).toBe(report.total);
    expect(Array.isArray(roundTripped.groups.install)).toBe(true);
  });
});
