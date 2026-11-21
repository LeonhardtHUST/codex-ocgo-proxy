/**
 * Per-user data directory resolution + one-time migration.
 *
 * Electron derives `app.getPath("userData")` from the packaged package name, so renaming the
 * package silently moves every user's accounts, keys and logs to a new folder. This module
 * makes that move explicit: try the new scope, and if a legacy scope still holds data, copy it
 * once (never delete the original) before using the new one.
 *
 * Plain JavaScript on purpose: both the Electron shell (esbuild-inlined) and the portable
 * launcher (no build step) import this exact file, so they cannot drift.
 */

/** New scope segments under the per-user base directory. */
export const PRIMARY_USER_DATA_SCOPE = ["@opencodex-router", "electron"];

/** Older scopes that may still hold data on existing installations. */
export const LEGACY_USER_DATA_SCOPES = [
  ["@codex-proxy", "electron"],
  ["Codex Proxy"],
  ["codex-proxy"],
];

/** Per-user base directory for the current platform. */
export function userDataBaseDir({ platform, env = {}, home = "" }) {
  if (platform === "win32") return env.APPDATA?.trim() || `${home}\\AppData\\Roaming`;
  if (platform === "darwin") return `${home}/Library/Application Support`;
  return env.XDG_CONFIG_HOME?.trim() || `${home}/.config`;
}

function joinPath(...parts) {
  const separator = parts[0].includes("\\") && !parts[0].startsWith("/") ? "\\" : "/";
  return parts
    .filter((part) => part !== "")
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, "") : String(part).replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(separator);
}

/**
 * Resolve the data directory to use, migrating a legacy one when needed.
 *
 * Returns `{ dir, scope, migrated, legacyDir?, error? }`:
 *   - `migrated: true`  → data was copied from `legacyDir` into the new scope;
 *   - `error` set       → the copy failed and `dir` points at the legacy directory instead,
 *                         so the app keeps working with the old data rather than starting empty.
 */
export function resolveUserDataDir({
  baseDir,
  primaryScope = PRIMARY_USER_DATA_SCOPE,
  legacyScopes = LEGACY_USER_DATA_SCOPES,
  existsSync,
  copySync,
}) {
  const primary = joinPath(baseDir, ...primaryScope);
  const hasData = (dir) => {
    try {
      return Boolean(existsSync(joinPath(dir, "data")));
    } catch {
      return false;
    }
  };

  if (hasData(primary)) return { dir: primary, scope: primaryScope, migrated: false };

  for (const scope of legacyScopes) {
    const legacy = joinPath(baseDir, ...scope);
    if (legacy === primary || !hasData(legacy)) continue;
    try {
      // Never overwrite: `force: false` keeps any file the new scope already has.
      copySync(legacy, primary, { recursive: true, force: false, errorOnExist: false });
      return { dir: primary, scope: primaryScope, migrated: true, legacyDir: legacy };
    } catch (error) {
      return {
        dir: legacy,
        scope,
        migrated: false,
        legacyDir: legacy,
        error: `data migration failed, continuing on the legacy directory: ${error?.message ?? error}`,
      };
    }
  }

  return { dir: primary, scope: primaryScope, migrated: false };
}
