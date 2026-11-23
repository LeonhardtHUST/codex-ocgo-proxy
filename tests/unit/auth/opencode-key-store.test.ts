/**
 * Credential store: file naming and the one-time move off the pre-rename file name.
 *
 * The store used to live at `data/ocgo-keys.json`. Renaming the product must not silently
 * orphan someone's keys, so the first construction with the default path moves the old file
 * into place. Explicit paths never migrate (tests and tooling pass their own file).
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => ({ value: "" }));
vi.mock("@src/paths.js", () => ({ getDataDir: () => dataDir.value }));

import { OpenCodeKeyStore } from "@src/auth/opencode-key-store.js";

const CREDENTIAL = {
  version: 1,
  credentials: [
    {
      id: "3f1a6a52-0d7a-4d3e-9d1a-2b3c4d5e6f70",
      name: "Legacy fixture",
      apiKey: "fake-legacy-go-key",
      models: ["kimi-k2.5"],
      enabled: true,
    },
  ],
};

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-key-store-"));
  dataDir.value = dir;
  return dir;
}

describe("OpenCodeKeyStore file migration", () => {
  it("moves the pre-rename ocgo-keys.json to opencode-keys.json once", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "ocgo-keys.json"), JSON.stringify(CREDENTIAL));

    const store = new OpenCodeKeyStore();
    expect(store.readCredentials()).toMatchObject([{ name: "Legacy fixture", apiKey: "fake-legacy-go-key" }]);

    expect(existsSync(join(dir, "opencode-keys.json"))).toBe(true);
    expect(existsSync(join(dir, "ocgo-keys.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "opencode-keys.json"), "utf8"))).toMatchObject(CREDENTIAL);
  });

  it("keeps using an existing opencode-keys.json and ignores the old name", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "opencode-keys.json"), JSON.stringify(CREDENTIAL));
    writeFileSync(join(dir, "ocgo-keys.json"), JSON.stringify({ version: 1, credentials: [] }));

    const store = new OpenCodeKeyStore();
    expect(store.readCredentials()).toHaveLength(1);
    // The stale file is left untouched rather than clobbering the live one.
    expect(existsSync(join(dir, "ocgo-keys.json"))).toBe(true);
  });

  it("does not migrate when an explicit file is passed", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "ocgo-keys.json"), JSON.stringify(CREDENTIAL));
    const explicit = join(dir, "custom-store.json");

    const store = new OpenCodeKeyStore(explicit);
    expect(store.readCredentials()).toEqual([]);
    expect(existsSync(join(dir, "opencode-keys.json"))).toBe(false);
  });
});
