/**
 * CI-only helper: rewrite the unpacked app's config for the packaged-app smoke
 * test. The installer/AppImage are already built before this runs, so the
 * overrides never ship — they only keep the smoke process from starting
 * background network jobs while the isolated home keeps credentials out.
 *
 * Usage: node apply-ocgo-smoke-config.mjs <app.asar.unpacked/config dir>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: apply-ocgo-smoke-config.mjs <app.asar.unpacked/config dir>");
  process.exit(2);
}

const file = resolve(dir, "default.yaml");
if (!existsSync(file)) {
  console.error(`smoke config not found: ${file}`);
  process.exit(1);
}

const config = yaml.load(readFileSync(file, "utf8")) ?? {};
const section = (key) => {
  if (typeof config[key] !== "object" || config[key] === null) config[key] = {};
  return config[key];
};

// Disable catalog and pricing sync, keepalive, and usage snapshots for smoke.
// The fork build disables the app and fingerprint update checks separately.
section("model").official_catalog_sync = false;
section("pricing").auto_sync = false;
section("update").auto_update = false;
section("account_keepalive").enabled = false;
section("usage_stats").snapshot_interval_minutes = 0;

writeFileSync(file, yaml.dump(config, { lineWidth: -1 }));
console.log(`smoke config overrides applied to ${file}`);
