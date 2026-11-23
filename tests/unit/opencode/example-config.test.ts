/**
 * The published config sample must stay valid against the real schema.
 *
 * `config/ocx.local.example.yaml` ships inside the release docs bundle and is the only
 * copy-pasteable example users get; a stale field name here turns into a hard config-load
 * failure on their machine, which is exactly the kind of drift this test prevents.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { OpenCodeConfigSchema, isLoopbackApiBaseUrl } from "@src/opencode/config.js";

const sample = load(readFileSync(resolve("config", "ocx.local.example.yaml"), "utf8")) as { opencode?: unknown };

describe("config/ocx.local.example.yaml", () => {
  it("parses against the OpenCode config schema", () => {
    expect(sample.opencode, "样例缺少 opencode 段").toBeTruthy();
    const parsed = OpenCodeConfigSchema.safeParse(sample.opencode);
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  it("demonstrates the documented defaults", () => {
    const config = OpenCodeConfigSchema.parse(sample.opencode);
    expect(config.enabled).toBe(true);
    expect(config.legacy_prefix).toBe(true);
    expect(config.cache_header_aggregation).toBe(true);
    expect(config.rust_routing.enabled).toBe(true);
    // A non-loopback rust_routing base_url would be rejected at runtime; the sample must not
    // teach users a value that cannot work.
    expect(isLoopbackApiBaseUrl(config.rust_routing.base_url)).toBe(true);
    expect(config.upstreams.go.base_url).toBe("https://opencode.ai/inference/go");
    expect(config.upstreams.zen.base_url).toBe("https://opencode.ai/inference");
  });
});
