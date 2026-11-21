# OpenCodeX-Router 架构契约

状态：草案 v1（2026-11-21）
适用范围：本仓全部后续开发。与本文冲突的实现视为缺陷；修改本文需要同步改受影响测试。

配套侦察事实（实现前必读，本文引用其结论）：

- `docs/recon/ROUTING_MAP.md` —— 本仓 provider / 路由 / 模型 / fallback / header 注入的真实结构
- `docs/recon/OPENCODE_UPSTREAM_MATRIX.md` —— 三个逻辑上游的端点、鉴权、字段、缓存与思考档位实测
- `docs/recon/OCGO2API_RS_MAP.md` —— 参考 Rust 实现的保留 / 重构 / 放弃清单
- `docs/recon/PRIOR_ART.md` —— GitHub 既有实现对照与 CREDITS 依据
- `docs/recon/BRANDING_MAP.md` —— 个人印记与改名清单

---

## 0. 目标与不变量

目标：把 opencode 系上游提升为与 codex official 同级的 provider 家族，并把请求路由下沉到本仓 Rust 服务。

不变量（任何改动都不得破坏）：

1. **响应只提交一次**。上游已提交（首个语义事件已下发）后不得换 key、换模型、换上游重放。
2. **凭据不出进程**。日志、错误、诊断、快照、Web 响应一律不含明文 key；session 身份由内容派生，不携带 key。
3. **能力诚实**。未通过 mock 合同测试的能力，不得在 `/models` 或文档中宣称支持。
4. **兼容面不动**。`CODEX_PROXY_*` 环境变量、`codex-tls` addon 名、客户端 `[model_providers.codex-proxy]` 示例保持不变。
5. **不静默接管**。新命名空间与既有模型/别名冲突时拒绝启用并报明确错误，绝不覆盖用户已有配置。

---

## 1. 命名与迁移

| 项 | 旧 | 新 | 处理 |
|---|---|---|---|
| 项目名 | Codex Proxy / codex-ocgo-proxy | **OpenCodeX-Router** | README、UI、package.json `name` |
| npm 包 | `codex-proxy` | `opencodex-router`（未被占用，2026-11-21 校验 404） | `packages/npm`、`packages/electron` |
| 模型命名空间 | `ocgo:<id>` | `opencode:<id>` | 保留 `ocgo:`→`opencode:` 兼容别名，`opencode.legacy_ocgo_prefix`（默认 `true`）控制 |
| 逻辑上游命名 | 无 | `opencode-go` / `opencode-zen` / `opencode-zen-free` | 目录与 `/models` 的 `owned_by` |
| 发布 tag | `ocgo-v*` | `ocx-v*` | `.github/workflows/ocgo-release.yml`（改名见 WBS） |
| 配置段 | `ocgo:` | `opencode:` | 保留 `ocgo:` 段读入并映射，写入只写 `opencode:` |

已知同名冲突（需在 README 声明，不影响内部落地）：
`github.com/Cerion9/opencodex-router`（0★，PowerShell 技能脚本，内容无关）、
npm `@bitkyc08/opencodex`（另一产品的 scoped 包）。我们不占用上述二者。

**命名不改的部分**（改名无收益、只增回归面）：`src/**/ocgo-*.ts` 内部文件名、`data/ocgo-keys.json` 存储名、
`OCX_BUILD` / `__OCX_BUILD__` 构建标志（已改名）、i18n key 名 `ocgoKeys`（只改文案）。

---

## 2. Provider 模型（req 2 / req 9）

### 2.1 一等公民清单

| provider id | kind | 凭据 | 说明 |
|---|---|---|---|
| `codex-official` | oauth | ChatGPT 账号池 | 现状不变 |
| `codex-fallback` | apikey | 单条可配置端点 | 由 `data/fallback-upstream.json` 升级为可显式路由、可入 fallback 图的一等公民 |
| `opencode-go` | opencode | Go 订阅 key | `https://opencode.ai/inference/go`，强制 `x-opencode-session` |
| `opencode-zen` | opencode | PAYG key | `https://opencode.ai/inference` |
| `opencode-zen-free` | opencode | 无 key / 池内任意 key | 同 zen base，仅零价模型 |
| `custom/<name>` | apikey | 用户 key | 现状不变 |

### 2.2 统一表征

引入单一描述符，路由层只认它，删除 `UpstreamRouter.ocgoEnabled` 布尔特例：

```ts
interface ProviderDescriptor {
  id: string;                       // "opencode-go" | "codex-official" | "codex-fallback" | "custom/foo"
  kind: "codex-oauth" | "opencode" | "apikey";
  enabled: boolean;
  priority: number;                 // 同模型多 provider 可用时的默认顺序，用户可覆盖
  endpoints: Partial<Record<Wire, string>>;   // responses | chat | messages | google
  capabilities: ProviderCapabilities;         // tools / images / reasoning / streaming / promptCacheKey
  modelSource: "catalog" | "pool" | "static";
}
```

`resolveMatch()` 返回的 kind 收敛为 `provider`（带 descriptor.id）与 `not-found`；
`api-key` / `adapter` / `ocgo` 三个旧 kind 作为内部实现细节保留一版，迁移完成后删除。

迁移期实现状态（2026-11-21，W2 已落地）：`opencode*:` 前缀当前仍解析为 `kind: "ocgo"`，
以便复用既有路由分派（`handleOCGoResponses`）而不改动 `src/routes/**`；`codex-fallback:<model>`
已走 `kind: "provider"`。W8 完成后所有 provider 统一为 `kind: "provider"`，`ocgo` kind 删除。

### 2.3 codex-fallback 提升（req 9）

`codex-fallback` 从「账号池耗尽时才用的隐藏出口」变为：

- 出现在 `/models`（`owned_by: "codex-fallback"`），可被 `codex-fallback:<model>` 显式选中；
- 可配置 `priority`，与 `codex-official` 同权参与同模型多 provider 排序；
- 可出现在 fallback 图的节点与边上（见 §7）；
- 保留原有语义：**只有**在账号池不可用 / 重试耗尽时才作为兜底自动启用，除非用户显式指定或图中有边指向它。

---

## 3. 三逻辑上游与端点矩阵（req 1 / req 8 / req 11）

三者共用主机 `opencode.ai`，差异在路径前缀、鉴权、客户端身份。**协议选择必须按 `(upstream, model)` 二元组**，
因为同一 model id 跨上游会换协议（实测：`minimax-m3`、`qwen3.8-max` 在 zen 是 chat-completions，在 Go 是 messages）。

| 逻辑上游 | base | 鉴权 | 强制头 | 可用协议 |
|---|---|---|---|---|
| `opencode-go` | `https://opencode.ai/inference/go` | `Bearer oc_sk_*`（须 Go 订阅工作区签发） | `x-opencode-session`（缺失即 400 `MissingSessionID`） | openai responses / openai chat / anthropic messages / google |
| `opencode-zen` | `https://opencode.ai/inference` | `Bearer oc_sk_*` | `x-opencode-session` 建议 | 同上 + images / systemone |
| `opencode-zen-free` | 同 zen | 无 key 或池内 key | 同上 | 实测以 chat-completions 为主（`jev-1.13-free` 走 systemone） |

协议 → 路径：

```
responses  -> {base}/openai/v1/responses
chat       -> {base}/openai/v1/chat/completions
messages   -> {base}/anthropic/v1/messages
google     -> {base}/google/v1beta/models/{model}:generateContent
```

转发策略（req 8）：

1. **原生协议优先**：目录给出 `api.<protocol>.base_url`，命中即直发该协议，零转换。
2. **跨协议走翻译**：仅当目标协议缺失时，用「有等价物的字段才搬」原则转换；无等价物的字段丢弃并记录诊断，不猜。
3. **协议兜底自愈**：收到 `Model X is not supported for format ...` 时换兄弟协议重试一次并缓存该修正（进程内 TTL 1h）。
4. **免费档不承诺可用**：`FreeUsageLimitError`（HTTP 429）按通道级熔断处理，绝不当成单 key 故障。

---

## 4. `/models` 契约（req 7）

### 4.1 数据来源与生命周期

| 来源 | 用途 | 刷新 |
|---|---|---|
| `GET https://opencode.ai/inference/v1/models` | 权威「能不能用」清单（可匿名读） | 启动一次 + 6h ± 15% 抖动 |
| `GET https://opencode.ai/inference/go/v1/models` | Go 侧模型与 `go.monthly_usage` | 同上 |
| 本地种子快照（仓库内 `config/opencode-models.seed.json`） | 冷启动 / 上游不可达 | 随版本发布 |

目录不可达时**服务旧快照**并在 `/admin/opencode/status` 暴露 `stale: true`；绝不把目录刷新挂在推理请求路径上。

### 4.2 字段契约

`/v1/models` 的每个 opencode 模型必须给出（缺一即视为缺陷）：

```
id, owned_by(逻辑上游), display_name, context_window, max_output_tokens,
input_modalities, output_modalities, capabilities{tools, reasoning, structured_output},
supported_reasoning_efforts[], default_reasoning_effort,
native_protocol, supported_protocols[], free(bool), pricing{input, cached_input, output},
go{monthly_usage, zdr, training, limited_regions}
```

同时输出字段别名，兼容读法不统一的客户端：
`context_length`、`max_context_length`、`max_input_tokens`、`max_tokens`、`limit{context,input,output}`、`reasoning`。

`free` 判定：`cost.text.input.price == 0` 优先，`-free` 后缀仅作兜底。

新增 `GET /v1/opencode/catalog` 返回完整矩阵（含 `native_protocol`、`api.*` 原始键），供高级客户端与 UI 使用。

### 4.3 与既有目录合并

opencode 模型以 `codexModelInfo` 形态进入 catalog（`source: "opencode"`），替换当前 `/v1/models` 里的裸 `runtime` 条目。
命名冲突检测在 `enableOpenCodeNamespace()` 中完成：与既有模型、别名、Custom 供应商重名即拒绝启用。

---

## 5. 缓存 header 聚合（req 10）

开关：`opencode.cache_header_aggregation`（默认 `true`）。

### 5.1 聚合身份

```
sessionSeed   = 客户端 prompt_cache_key | 客户端会话 id | sha256(model + instructions + 首条 user 文本)
cacheIdentity = sha256(sessionSeed + nativeModel + logicalUpstream)[:24]
sessionHeader = "ses_" + cacheIdentity[0:12](hex) + cacheIdentity[12:26](base32 风格 alnum)
```

- 格式必须匹配 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`（上游免费档门禁按格式校验）。
- 同一对话跨请求稳定；**换 key 不换 identity**（见 5.3）。

### 5.2 注入内容

| 位置 | 内容 | 条件 |
|---|---|---|
| header | `x-opencode-session` | 全部 opencode 上游（go 强制，缺则 400） |
| header | `x-opencode-client: cli`、`User-Agent: opencode/<ver>` | 全部 opencode 上游 |
| header | `x-opencode-project: sha1(项目种子)[:16]` | 全部 opencode 上游 |
| body | `prompt_cache_key` = cacheIdentity | responses / chat 协议且目录声明支持 |
| body | `prompt_cache_retention: "24h" \| "in_memory" \| "off"` | responses 协议，配置可调，默认 `24h` |
| body | `cache_control: {type:"ephemeral", ttl:"1h"}` 断点（system / tools / 最新 user） | messages 协议；GLM / Zhipu 系跳过 |

### 5.3 换 key 语义（唯一没有先例的设计点）

- 普通故障换 key：**保留** cacheIdentity（上游按 session 计入缓存，换 key 不清前缀）。
- `FreeUsageLimitError` / `invalid_key` 换 key：**重算** cacheIdentity（避免把新身份绑到已污染会话）。
- 出口代理必须与 cacheIdentity 绑定（sticky egress）：同一 session 固定同一出口，否则缓存命中系统性归零。

---

## 6. zen-free 聚合轮换（req 11）

开关：`opencode.zen_free.pool_all_keys`（默认 `false`）。

- 开启后，**全部 opencode 凭据**（go + zen + 零价专用 key）进入 free 模型轮换池。
- 选择：`score = success/(attempts+1)`，按 score 降序、同分按 LRU；同一 key 串行（in-flight 不并发）。
- 失败处理：单 key 结构化为 `invalid` / `model_denied` / `rate_limited` 时只影响该 key 对 free 模型的可用性；
  通道级 `FreeUsageLimitError` 触发**通道熔断**（阈值 6 次 / 基数 1h / 上限 24h，指数退避），不污染付费 key 健康分。
- 成功则记录 `lastSuccessAt`，权重加回；连续失败 3 次降权，成功后恢复。
- 受众隔离：free 通道的熔断状态与付费通道状态分开存储（`free` 命名空间）。

---

## 7. Fallback 图（req 12）

### 7.1 数据模型

```jsonc
{
  "version": 1,
  "entrypoints": { "opencode:deepseek-v4.1-flash": "n1" },   // 请求模型 → 起始节点
  "nodes": [
    { "id": "n1", "target": "opencode:deepseek-v4.1-flash", "label": "主用", "enabled": true },
    { "id": "n2", "target": "opencode-go:glm-5.3", "label": "Go 兜底", "enabled": true },
    { "id": "n3", "target": "codex-fallback:gpt-5.1", "label": "应急", "enabled": true }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "on": ["rate_limited", "quota_exhausted", "model_denied"], "weight": 10 },
    { "from": "n1", "to": "n3", "on": ["upstream_unavailable", "auth_failed"], "weight": 5 },
    { "from": "n2", "to": "n3", "on": ["*"], "weight": 1 }
  ],
  "limits": { "maxHops": 3, "budgetMs": 240000, "perHopAttempts": 2 }
}
```

- `on` 取值枚举固定，来自统一错误分类（`rate_limited` / `quota_exhausted` / `model_denied` / `auth_failed` /
  `upstream_unavailable` / `policy_rejected` / `timeout` / `*`）。
- 出边按 `weight` 降序；同 weight 按 `to` 字典序，保证确定性（测试依赖）。
- 语义约束：只在**响应未提交**时跳转；`maxHops` / `budgetMs` 超限即返回原始错误。

### 7.2 持久化与编辑

- 存储：`data/opencode-fallback-graph.json`（原子写、schema 校验、版本号）。
- 迁移期限制：节点 `target` 目前只支持 opencode 命名空间（`opencode:` / `opencode-go:` / `opencode-zen:` /
  `opencode-zen-free:`）。指向 `codex-fallback:` 或其他 provider 的节点会被 dispatch 原样忽略（保留当前路由），
  跨 provider 跳转要等 provider 统一分派完成后才开放。
- 管理 API：`GET/PUT /admin/opencode/fallback-graph`、`POST /admin/opencode/fallback-graph/validate`。
- Web 编辑器（`web/src/pages/FallbackGraphPage.tsx`）：
  - 画布：节点拖拽、从节点边缘拖出连线建边；边选中后编辑条件与权重。
  - 左侧 schema 驱动表单（沿用 humanize 的思路：一份 JSON Schema 渲染表单，条件字段可见性内建，非法值提交前拒绝）。
  - 每个节点显示状态徽章：`未验证 / 已验证 / 已弃用`、最近探活结果、所属 provider。
  - 保存前跑 `validate`（环检测、孤立节点、指向不存在模型、hop 上限超限），错误定位到具体节点/边。

---

## 8. Rust 请求路由（req 6）

### 8.1 形态

参考实现无 `[lib]` / cdylib、起 8 MiB 栈 Tokio 运行时，**只能以独立进程复用**。因此：

- 新增 crate：`native/ocx-router/`（独立 binary `ocx-router`），Node 通过回环 HTTP 调用。
- 进程生命周期由 Node 管理：`opencode.rust_routing = { enabled, binary_path, port, startup_timeout_ms }`；
  spawn → `/health` 就绪探测 → 请求代理 → 退出时优雅停止（`stop-request` 文件或 SIGTERM）。
- 二进制缺失或启动失败：**显式降级**到 TS adapter，并在 `/admin/opencode/status` 标记 `router: "ts-fallback"` 且写 error log。不允许静默。

### 8.2 Rust 服务职责面

| 端点 | 说明 |
|---|---|
| `POST /v1/responses` | 入站 Codex/OpenAI Responses；按 `(upstream, model)` 选原生协议 |
| `POST /v1/chat/completions` | OpenAI Chat 入站 |
| `POST /v1/messages` | Anthropic Messages 入站 |
| `GET /v1/models` | 由 Node 下发目录快照（Rust 不自建目录） |
| `GET /health` | 进程就绪 + 目录版本 |

职责边界：**Rust 只做协议选择、转换、SSE、header 注入、错误分类、单请求内重试**；
凭据选择、额度组、轮换、fallback 图遍历留在 Node（App）侧，Rust 只接受本次请求选定的一个 Bearer。

### 8.3 从参考实现继承与放弃

- 继承：Provider×Family 二维目录、Responses 通用入站 + 其余直通、响应级/连接级双重重试分离、
  5xx→502 / 4xx 原样、SSE 字节层 Decoder 与协议层 Converter 分离、`committed` 提交语义、`key_id=sha256(token)`。
- 重构：1508 行单 `dispatch()` 拆成「路由表 + surface handler + 纯转换函数」；协议由目录下发，不再按 `id` 前缀猜。
- 放弃：`upstream.api_key` 固定覆盖、`fallback_proxy`、自有历史封装、`service.rs`/`monitor.rs`/`dns.rs`/`diagnostics.rs` 运维面。

### 8.4 验收

- 回环合同测试（镜像 `tests/proxy.rs` 的夹具）：三协议 × 流式/非流式 × 429/5xx/超时。
- 一致性测试：同一请求分别经 TS adapter 与 Rust 服务，归一后的 `CodexSSEEvent` 序列一致。

---

## 9. 工作分解与验收

| ID | 任务 | 主要落点 | 依赖 |
|---|---|---|---|
| W1 | 命名与品牌（README/CREDITS/包名/CI 守卫） | `README*.md`、`CREDITS.md`、`.github/workflows/*`、`packages/*` | — |
| W2 | provider 统一表征 + `opencode:` 命名空间 + 兼容别名 | `src/opencode/`、`src/proxy/upstream-router.ts`、`src/config-schema.ts` | — |
| W3 | 三逻辑上游 adapter + 协议矩阵 + 缓存 header 聚合 | `src/opencode/upstream/*`、`src/opencode/cache-identity.ts` | W2 |
| W4 | 模型目录与 `/models` 契约 | `src/opencode/catalog.ts`、`src/routes/models.ts` | W2 |
| W5 | zen-free 池 + 通道熔断 | `src/opencode/pool/*` | W3 |
| W6 | fallback 图（数据模型 + API + 运行时 + 编辑器） | `src/opencode/fallback-graph/*`、`web/src/pages/FallbackGraphPage.tsx` | W3 |
| W7 | Rust 路由服务 + Node 生命周期 | `native/ocx-router/`、`src/opencode/rust-router.ts` | W3 |
| W8 | 错误分类合并 + 删除 unsupported 短路 + 回归测试 | `src/routes/chat.ts`、`messages.ts`、`responses.ts`、`src/proxy/error-classification.ts` | W3 |

统一验收：`npm run typecheck` 通过；`vitest run tests/unit tests/integration` 全绿；新增能力均有 mock 合同测试；
文档同步 `README`、`docs/`、`CHANGELOG`。任一任务未过验收不得标记完成。

---

## 10. 风险与未确认项

1. **免费档门禁信号未验证**（UA / header / OAuth 会话三者谁决定），zen-free 只能做到「有 key 池 + 熔断」，不得宣称稳定可用。
2. **`Retry-After ≈ 71894s` 的窗口语义未验证**，熔断基数参数（6 次 / 1h / 24h）是借鉴值，需按真实 429 校准。
3. **`prompt_cache_retention` / `cache_control` 的字段名来自第三方 README**，落码前用一次真实请求复核。
4. **Rust 与 TS 双实现的一致性**是长期维护成本，必须靠 §8.4 的对照测试锁住，否则会漂移。
5. **LICENCE 为非商业许可**，与 GPL/AGPL/无许可项目只能借鉴思路，不得复制代码；CREDITS 记录该边界。
