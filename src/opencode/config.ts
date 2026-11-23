import { z } from "zod";
import { opencodeResponsesUrl } from "../opencode-legacy-config.js";

/**
 * OpenCode 配置段（OpenCodeX-Router）。
 *
 * 三个逻辑上游共用主机 opencode.ai，差异在路径前缀、鉴权与客户端身份：
 *   go         https://opencode.ai/inference/go         （Go 订阅 key，强制 x-opencode-session）
 *   zen        https://opencode.ai/inference            （按量付费 key）
 *   zen_free   与 zen 同 base，只服务零价模型；pool_all_keys 开启后全部凭据参与轮换
 *
 * 旧的 `ocgo` 配置段仍可读入，由 `migrateLegacyOpenCodeSection` 映射到本段（见 src/config.ts）。
 */

const LOOPBACK_HINT = "必须是 http://127.0.0.1:<port>/v1 或 http://[::1]:<port>/v1 形式的数字回环地址";

/** 数字回环地址校验，复用 OpenCode 时期的规则，避免 DNS 与模糊 URL 形式。 */
export function isLoopbackApiBaseUrl(value: string): boolean {
  return opencodeResponsesUrl(value) !== undefined;
}

export const OpenCodeGoUpstreamSchema = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().min(1).default("https://opencode.ai/inference/go"),
  /** 未配置时由凭据池提供；配置后作为固定覆盖。 */
  api_key: z.string().optional(),
}).strict();

export const OpenCodeZenUpstreamSchema = z.object({
  enabled: z.boolean().default(true),
  base_url: z.string().min(1).default("https://opencode.ai/inference"),
  api_key: z.string().optional(),
}).strict();

export const OpenCodeZenFreeUpstreamSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * 开启后，全部 opencode 凭据（go + zen）进入免费模型轮换池，
   * 并按请求成功情况反馈权重与通道熔断。
   */
  pool_all_keys: z.boolean().default(false),
}).strict();

export const OpenCodeRustRoutingSchema = z.object({
  enabled: z.boolean().default(false),
  /** ocx-router 二进制路径；留空时按内置查找顺序探测。 */
  binary_path: z.string().optional(),
  /** 回环监听端口，Node 通过 http://127.0.0.1:<port> 调用。 */
  port: z.number().int().min(1).max(65535).default(8790),
  /** Rust 服务的 /v1 基址；缺省由 port 推导。 */
  base_url: z.string().refine((value) => isLoopbackApiBaseUrl(value), { message: `rust_routing.base_url ${LOOPBACK_HINT}` })
    .default("http://127.0.0.1:8790/v1"),
  startup_timeout_ms: z.number().int().min(500).max(60000).default(8000),
  /**
   * True when this section was migrated from the pre-rename `ocgo` block, whose
   * `base_url` pointed at the external ocgo2api-rs binary. Those installations keep the
   * legacy loopback adapter instead of the in-repo ocx-router.
   */
  legacy_sidecar: z.boolean().default(false),
}).strict().default({});

export const OpenCodeConfigSchema = z.object({
  /**
   * Deprecated and ignored: the family is always available, like `codex-official`.
   * What actually decides whether a request can be served is credentials + the per-upstream
   * switches below. Kept in the schema so old `data/local.yaml` files still parse;
   * `normalizeOpenCodeEnabled()` logs a warning and forces it to true.
   */
  enabled: z.boolean().default(true),
  upstreams: z.object({
    go: OpenCodeGoUpstreamSchema.default({}),
    zen: OpenCodeZenUpstreamSchema.default({}),
    zen_free: OpenCodeZenFreeUpstreamSchema.default({}),
  }).strict().default({}),
  /** 统一缓存 header 聚合：为同一对话派生稳定的上游 session / project 身份。 */
  cache_header_aggregation: z.boolean().default(true),
  /**
   * 项目级身份种子（`x-opencode-project`）。留空则不发该 header——上游的 project
   * 分组会影响跨会话缓存复用，用随机会话值冒充只会白白破坏命中率。
   */
  project_seed: z.string().trim().min(1).max(256).optional(),
  /** 接受 `ocgo:` 作为 `opencode:` 的别名（旧配置兼容）。 */
  legacy_prefix: z.boolean().default(true),
  http_timeout_seconds: z.number().int().min(1).max(600).default(180),
  rust_routing: OpenCodeRustRoutingSchema,
}).strict().default({});

export type OpenCodeConfig = z.infer<typeof OpenCodeConfigSchema>;
export type OpenCodeRustRoutingConfig = z.infer<typeof OpenCodeRustRoutingSchema>;

/**
 * 把旧 `ocgo` 配置段映射进 `opencode` 段（原地修改合并后的原始配置对象）。
 *
 * 语义：旧配置里的 base_url 指向同机 Rust sidecar，因此映射到 rust_routing，
 * 而不是 zen 的公网 base_url——两者含义不同，混用会把请求发到错误的上游。
 * 显式写了 `opencode` 段时以新段为准，不再覆盖。
 */
export function migrateLegacyOpenCodeSection(raw: Record<string, unknown>): void {
  const legacy = raw.ocgo;
  if (!raw.opencode && legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const source = legacy as Record<string, unknown>;
    const enabled = typeof source.enabled === "boolean" ? source.enabled : false;
    const mapped: Record<string, unknown> = {
      enabled,
      legacy_prefix: true,
    };
    if (typeof source.timeout_seconds === "number") mapped.http_timeout_seconds = source.timeout_seconds;
    const rust: Record<string, unknown> = { enabled, legacy_sidecar: true };
    if (typeof source.base_url === "string") rust.base_url = source.base_url;
    mapped.rust_routing = rust;
    raw.opencode = mapped;
    return;
  }
  // 新段存在但没写 enabled、旧段写了：尊重旧段的启用状态（迁移期只升不降）。
  if (raw.opencode && legacy && typeof raw.opencode === "object" && !Array.isArray(raw.opencode)) {
    const target = raw.opencode as Record<string, unknown>;
    const source = legacy as Record<string, unknown>;
    if (target.enabled === undefined && typeof source.enabled === "boolean") target.enabled = source.enabled;
  }
}

/**
 * Retire the `enabled` switch.
 *
 * It existed because the MVP needed an external `ocgo2api-rs` process on loopback: without
 * that binary the prefix had to be refused. Rust routing is now in-repo and degrades
 * explicitly, credentials live in the dashboard, and `codex-official` never had such a
 * switch — so the flag only produced "why is this off?" confusion. Old configs keep parsing;
 * an explicit `false` is reported once and ignored.
 */
export function normalizeOpenCodeEnabled(raw: Record<string, unknown>): boolean {
  const section = raw.opencode;
  if (!section || typeof section !== "object" || Array.isArray(section)) return false;
  const target = section as Record<string, unknown>;
  if (target.enabled !== false) return false;
  console.warn(
    "[Config] `opencode.enabled: false` is deprecated and ignored — the OpenCode family is " +
      "always available (like codex-official). Remove the key to silence this notice.",
  );
  target.enabled = true;
  return true;
}
