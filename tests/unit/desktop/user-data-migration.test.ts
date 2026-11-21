import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_USER_DATA_SCOPES,
  PRIMARY_USER_DATA_SCOPE,
  resolveUserDataDir,
  userDataBaseDir,
} from "../../../scripts/portable/user-data.mjs";

const BASE = "C:\\Users\\u\\AppData\\Roaming";
const PRIMARY = `${BASE}\\@opencodex-router\\electron`;
const LEGACY = `${BASE}\\@codex-proxy\\electron`;

/** Minimal virtual filesystem: a set of directories that "exist". */
function fakeFs(dirs, { failCopy = false } = {}) {
  const present = new Set(dirs);
  const copySync = vi.fn(() => { if (failCopy) throw new Error("EPERM"); });
  const existsSync = (path) => {
    // A directory "exists" when the exact path or anything below it was registered.
    if (present.has(path)) return true;
    for (const entry of present) if (entry.startsWith(`${path}\\`) || entry.startsWith(`${path}/`)) return true;
    return false;
  };
  return { existsSync, copySync };
}

describe("user data scope", () => {
  it("namespaces the new Electron scope and keeps the legacy ones", () => {
    expect(PRIMARY_USER_DATA_SCOPE).toEqual(["@opencodex-router", "electron"]);
    expect(LEGACY_USER_DATA_SCOPES).toContainEqual(["@codex-proxy", "electron"]);
  });

  it("resolves the platform base directory", () => {
    expect(userDataBaseDir({ platform: "win32", env: { APPDATA: "C:\\Roaming" }, home: "C:\\Users\\u" })).toBe("C:\\Roaming");
    expect(userDataBaseDir({ platform: "darwin", home: "/Users/u" })).toBe("/Users/u/Library/Application Support");
    expect(userDataBaseDir({ platform: "linux", home: "/home/u", env: {} })).toBe("/home/u/.config");
  });
});

describe("user data migration", () => {
  it("uses the new scope when it already holds data", () => {
    const fs = fakeFs([`${PRIMARY}\\data`]);
    const result = resolveUserDataDir({ baseDir: BASE, ...fs });
    expect(result).toMatchObject({ dir: PRIMARY, migrated: false });
    expect(fs.copySync).not.toHaveBeenCalled();
  });

  it("copies legacy data into the new scope exactly once", () => {
    const fs = fakeFs([`${LEGACY}\\data\\accounts.sqlite`]);
    const result = resolveUserDataDir({ baseDir: BASE, ...fs });
    expect(result).toMatchObject({ dir: PRIMARY, migrated: true, legacyDir: LEGACY });
    expect(fs.copySync).toHaveBeenCalledOnce();
    const [from, to, options] = fs.copySync.mock.calls[0];
    expect(from).toBe(LEGACY);
    expect(to).toBe(PRIMARY);
    // Never overwrite files the new scope may already have.
    expect(options).toMatchObject({ recursive: true, force: false });
  });

  it("starts fresh when neither scope has data", () => {
    const fs = fakeFs([]);
    const result = resolveUserDataDir({ baseDir: BASE, ...fs });
    expect(result).toMatchObject({ dir: PRIMARY, migrated: false });
    expect(fs.copySync).not.toHaveBeenCalled();
  });

  it("keeps working on the legacy directory when the copy fails", () => {
    const fs = fakeFs([`${LEGACY}\\data`], { failCopy: true });
    const result = resolveUserDataDir({ baseDir: BASE, ...fs });
    expect(result.dir).toBe(LEGACY);
    expect(result.migrated).toBe(false);
    expect(result.error).toContain("migration failed");
  });

  it("tries every legacy scope in order", () => {
    const fs = fakeFs([`${BASE}\\codex-proxy\\data`]);
    const result = resolveUserDataDir({ baseDir: BASE, ...fs });
    expect(result).toMatchObject({ dir: PRIMARY, migrated: true });
    expect(result.legacyDir).toBe(`${BASE}\\codex-proxy`);
  });
});
