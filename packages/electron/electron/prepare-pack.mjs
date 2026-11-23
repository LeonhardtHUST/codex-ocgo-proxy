/**
 * Copy root-level runtime resources into packages/electron/ before
 * electron-builder runs, so all paths resolve relative to projectDir.
 *
 * Usage:
 *   node electron/prepare-pack.mjs          # copy
 *   node electron/prepare-pack.mjs --clean  # remove copies
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PKG = resolve(import.meta.dirname, "..");

const DIRS = ["config", "public", "bin"];
const isClean = process.argv.includes("--clean");

for (const dir of DIRS) {
  const src = resolve(ROOT, dir);
  const dest = resolve(PKG, dir);

  if (isClean) {
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true });
      console.log(`[prepare-pack] removed ${dir}/`);
    }
  } else {
    if (!existsSync(src)) {
      console.warn(`[prepare-pack] skipping ${dir}/ (not found at ${src})`);
      continue;
    }
    // Clean destination first to avoid stale files from previous builds
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true });
    }
    cpSync(src, dest, { recursive: true });
    console.log(`[prepare-pack] copied ${dir}/ → packages/electron/${dir}/`);
  }
}

// Native addon — copy only runtime files (index.js, index.d.ts, *.node, package.json),
// skip Rust source, build artifacts (target/), and node_modules.
const nativeSrc = resolve(ROOT, "native");
const nativeDest = resolve(PKG, "native");

if (isClean) {
  if (existsSync(nativeDest)) {
    rmSync(nativeDest, { recursive: true });
    console.log("[prepare-pack] removed native/");
  }
} else if (!existsSync(nativeSrc)) {
  console.warn(`[prepare-pack] skipping native/ (not found at ${nativeSrc})`);
} else {
  cpSync(nativeSrc, nativeDest, {
    recursive: true,
    force: true,
    filter: (src) => {
      // Normalize separators first: on Windows `src` uses "\" and a forward-slash-only
      // regex silently matches nothing, which used to copy native/target (~800 MB) into
      // the app package.
      const rel = src.slice(nativeSrc.length).replace(/\\/g, "/");
      // Skip Rust source, build artifacts, and node_modules
      if (/\/(target|node_modules|src)(\/|$)/.test(rel)) return false;
      if (/\/(Cargo\.(toml|lock)|build\.rs|\.cargo)/.test(rel)) return false;
      return true;
    },
  });
  console.log("[prepare-pack] copied native/ (runtime only) → packages/electron/native/");

  // The Rust router lives under target/release (excluded above). Ship just the binary so
  // `rust_routing.enabled: true` works without dragging the whole cargo target dir along.
  const routerBin = resolve(nativeSrc, "ocx-router", "target", "release", "ocx-router.exe");
  if (existsSync(routerBin)) {
    const routerDest = resolve(nativeDest, "ocx-router");
    mkdirSync(routerDest, { recursive: true });
    copyFileSync(routerBin, resolve(routerDest, "ocx-router.exe"));
    console.log(`[prepare-pack] copied ocx-router.exe (${(statSync(routerBin).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    console.warn("[prepare-pack] ocx-router.exe not built — Rust routing will degrade to the TypeScript adapter");
  }
}
