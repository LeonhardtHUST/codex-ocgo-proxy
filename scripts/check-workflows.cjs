/**
 * Validate every GitHub Actions workflow file parses as YAML.
 *
 * Why this exists: an indentation slip inside a `run: |` block silently invalidates
 * the whole workflow file. GitHub then fails the run in ~0 s with no logs at all
 * ("startup_failure"), which is easy to misread as "the trigger never fired".
 *
 * Usage: node scripts/check-workflows.cjs
 */

const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { load } = require("js-yaml");

const dir = join(process.cwd(), ".github", "workflows");
let failures = 0;

for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  try {
    const doc = load(readFileSync(join(dir, name), "utf8"));
    if (!doc || typeof doc !== "object") throw new Error("parsed to a non-object");
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} workflow file(s) failed to parse — GitHub would reject them with startup_failure.`);
  process.exit(1);
}
console.log("\nall workflow files parse");
