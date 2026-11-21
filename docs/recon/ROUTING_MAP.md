# 供应商 / 路由 / 模型 架构测绘报告

范围：`src/proxy`、`src/models`、`src/config*`、`src/routes`（含 `shared`、`admin`）、`web/src/pages`。
目的：为「把 opencode 提升为一等公民 provider」提供精确事实。
约定：所有 `file:line` 均基于当前 HEAD 工作树；行号可能随改动漂移，定位以符号名为准。

---

## 1. 路由解析与「provider」的真实表征

### 1.1 结论

- `resolveMatch()` 只有 5 个 kind：`api-key` / `adapter` / `codex` / `ocgo` / `not-found`（`src/proxy/upstream-router.ts:24-29`）。没有 `custom`、`provider`、`codex-api` 这类 kind——`custom` 只是 api-key entry 的 `provider` 字段取值，`codex-api` 就是 `kind:"codex"`。
- 解析顺序（实现体 `:94-168`，注释 `:4-13`）：
  1. OCGo 前缀短路（`resolveMatch:81-88`）
  2. ApiKeyPool 精确模型命中（`:99-115`，LRU 取一，`pickLeastRecentlyUsed:214-222`）
  3. 显式 provider 前缀 `tag:model`（`:38-44` 拆分 → `:119-124`）
  4. 别名链（`:126-148`，含去后缀后的别名回退）
  5. `model_routing` 表（`:150-154`）
  6. 已知 Codex 模型形状（`:156-158` + `isKnownCodexModel:186-203`）
  7. 名称模式兜底 `claude*`→anthropic、`gemini*`→gemini（`:160-165`）
  8. `not-found`（`:167`）

- ⚠️ 与注释不一致：文件头 `:13` 写「Default (codex)」，但实现末尾返回 `not-found`。真正的「默认 codex」兜底在路由层：`src/routes/chat.ts:142-144`、`src/routes/responses.ts:163-166` 用 `isRequestableModel()` 兜底成 `{kind:"codex"}`。

### 1.2 「一个 provider」在代码里由什么表征（三种互不统一的表征）

| 表征 | 数据位置 | 由谁消费 |
|---|---|---|
| **A. adapter tag** | `Map<string, UpstreamAdapter>`，启动时按 `cfg.providers` 装配（`src/index.ts:180-204`） | 显式前缀 `tag:model`、`model_routing` 的值 |
| **B. `ApiKeyEntry.provider`** | 运行时 Key 池，持久化在 `data/api-keys.json`（`src/auth/api-key-pool.ts:43-66`、`:84-115`） | `UpstreamRouter` 的 api-key 分支、`createAdapterForEntry` 的 switch |
| **C. OCGo 命名空间** | 不是 adapter，也不是 key entry；`UpstreamRouter.ocgoEnabled` 布尔位（`upstream-router.ts:34,65-75`） | 路由层显式分派 `handleOCGoResponses` |

关键事实：
- provider 枚举定义在 `src/auth/api-key-catalog.ts:6-7`：`BuiltinProvider = anthropic|openai|gemini|openrouter`，`ApiKeyProvider = BuiltinProvider | antigravity | custom`。
- adapter 类选择由 `provider`（大类）+ `wire`（协议）两维决定：`src/proxy/adapter-factory.ts:42-62`，`custom` 的 wire 分派在 `:27-40`。
- **模型目录里没有 provider 字段**（见 §3.1）。模型到 provider 的唯一绑定就是 pool entry 的 `model`、`model_routing`、别名、显式前缀。
- `adapters` 的键就是 tag，`UpstreamAdapter.tag` 只是日志标识（`src/proxy/upstream-adapter.ts:30-32`），两者不校验一致（存在 `adapters.set(name, new OpenAIUpstream(name,...))` 的手工对齐，`index.ts:196-204`）。

### 1.3 新增「一等公民 provider」需要动的点（逐条）

必改（否则不可用）：

1. `src/auth/api-key-catalog.ts:6-7, 21-61, 64-66` —— 类型加成员、`PROVIDER_CATALOG` 加默认 baseUrl 与候选模型、`isBuiltinProvider` 加判断。
2. `src/proxy/adapter-factory.ts:42-62` —— `switch (entry.provider)` 加 case，返回一个 `UpstreamAdapter` 实现。
3. 新增 `src/proxy/<provider>-upstream.ts` —— 实现 `UpstreamAdapter`（`upstream-adapter.ts:30-58`：`tag` / `createResponse` / `parseStream`，可选 `forwardCodexJsonRequest`）。
4. `src/routes/api-keys.ts:27-28` —— `VALID_PROVIDERS` / `MODEL_PROVIDERS`；`:124-130` `isProviderWireAllowed` 加 wire 约束。
5. `src/auth/api-key-pool.ts:466-476` —— `normalizeWireForProvider` 加分支（否则落回 `"chat"`）；若引入新 wire，还要 `:40-41 API_KEY_WIRES` 与 `:454-460 isApiKeyWire`。

强建议（不清算会产生脏行为）：

6. `src/proxy/upstream-router.ts:101-103` —— 若该 provider 需要 `tag:model` 前缀进入 pool 查询（antigravity 就是靠这里特判），必须补同样的过滤。
7. `src/proxy/upstream-router.ts:65-75` —— 若新 provider 占用保留命名空间，`enableOCGoNamespace` 的冲突检查要一并覆盖。
8. `web/src/components/ApiKeyManager.tsx:10,16,150,196,301,379,545,550,768-769` —— provider 选择器与 wire 选择器；`shared/i18n/translations.ts` 补文案。
9. `src/auth/api-key-model-cache.ts` + `src/routes/api-keys.ts:239-258, 372-394` —— 若支持「拉取该 provider 模型列表」。

非必需（按形态选择）：

10. 若做成配置文件级 provider（而非运行时 Key）：`src/config-schema.ts:277-299` 的 `providers` 段 + `src/index.ts:181-204` 的 `adapters.set`。
11. `src/models/model-store.ts` 无需改——模型目录与 provider 解耦；要补模型元数据用 `model.custom_models`（`config-schema.ts:42-58`）或 `<provider>:model` 命名。

---

## 2. 配置结构

### 2.1 结论

- **仓库里没有 `config.yaml`**。基线是 `config/default.yaml`（git 跟踪），叠加层是 `data/local.yaml`（数据目录，缺失时自动写入 `server.proxy_api_key: pwd`）。
- 合并与校验只有一个入口：`src/config-loader.ts:137-172`（`loadYaml(default.yaml)` → `deepMerge(raw, local)`，数组整体替换 `:29-50`）→ `applyPersistedClientVersionState` → `src/config.ts:26-34` 的 `ConfigSchema.parse`（唯一 schema 校验点；热重载再 parse 一次 `:91-99`）。
- 环境变量覆盖发生在 schema 校验**之前**：`src/config-loader.ts:174-257`（JWT/PLATFORM/ARCH/PORT/CORS/HOST/OLLAMA/HTTPS_PROXY），且 local.yaml 显式赋值优先于 env。
- `reloadAllConfigs` 额外重载 `models.yaml` 并触发模型刷新（`src/config.ts:112-119`）。

### 2.2 yaml 里的结构（`src/config-schema.ts:69-353`）

顶层键：`api` / `client` / `model` / `auth` / `server` / `api_keys` / `logs` / `observability` / `usage_stats` / `session` / `tls` / `quota` / `update` / `pricing` / `ws_pool` / `ollama` / `official_agent` / `providers` / `ocgo` / `model_routing` / `policy_guard` / `account_keepalive`。

- `model`（`:84-124`）：`default`、`aliases`、`custom_models`、`default_reasoning_effort`、`service_tier_overrides`、`image_host_model`、`official_catalog_sync(_refresh_hours)` 等。
- `providers`（`:277-299`）：`openai` / `anthropic` / `gemini` 单例 + `custom` 为 `record<name,{api_key,base_url,models}>`。这是**配置文件级** provider，与运行时 `api_keys`（Key 池）并存。
- **没有 `accounts` / `apiKeys` / `fallback` 段**。这些全是数据目录里的独立状态：
  - 账号：`data/accounts.sqlite` + `data/accounts.json`（`src/auth/account-registry.ts`）
  - 运行时 Key：`data/api-keys.json`（`api-key-pool.ts:84-86`）
  - OCGo Key：`data/ocgo-keys.json`（`src/auth/ocgo-key-store.ts:39`）
  - fallback upstream：`data/fallback-upstream.json`（`src/auth/fallback-upstream.ts:39-41`）
  - 模型缓存：`data/models-cache.yaml`、`data/official-model-catalog.json`

### 2.3 ocgo 段如何接入

```ts
// src/config-schema.ts:300
ocgo: OCGoConfigSchema,
```

`OCGoConfigSchema` 在 `src/ocgo-config.ts:16-22`，`.strict()`：`enabled` / `base_url` / `timeout_seconds`。`base_url` 被 `.refine(ocgoResponsesUrl)` 限制为**字面 loopback**（`http://127.0.0.1:<port>/v1` 或 `http://[::1]:<port>/v1`），见 `:5-14`。同文件定义模型前缀 `ocgo:` 与合法性谓词（`:24-31`）。示例配置：`config/ocgo.local.example.yaml`。

**改造影响面**：新增 provider 若也要 yaml 段，必须同时改 `config-schema.ts`、`config/default.yaml`、`src/index.ts` 装配；若沿用 ocgo 的「数据目录 + admin API」形态，则完全不碰 yaml。

---

## 3. 模型目录：数据结构、解析、缓存

### 3.1 数据结构（`src/models/model-store.ts:44-122`）

单条 `CodexModelInfo` 关键字段：

- 身份：`id`、`displayName`、`description`、`isDefault`、`source`（`"static" | "backend" | "custom" | "runtime"`，`:121`）
- 推理档位：`supportedReasoningEfforts[{reasoningEffort,description}]`、`defaultReasoningEffort`
- 模态：`inputModalities`、`outputModalities`、`supportsPersonality`
- 上下文：`contextWindow`、`maxContextWindow`、`maxOutputTokens`、`autoCompactTokenLimit`、`truncationPolicyLimit/Mode`、`effectiveContextWindowPercent`
- 能力/呈现：`visibility`、`priority`、`supportedInApi`、`shellType`、`toolMode`、`webSearchToolType`、`supportsSearchTool`、`serviceTiers`、`defaultServiceTier`、`multiAgentVersion`…
- 迁移：`upgrade` / `upgradeInfo`

**没有的字段**：`provider`（归属）、`pricing`（定价）、`capabilities`（布尔能力表）、`aliases`（别名不在模型对象上）。

- 定价独立：`config/model-pricing.yaml`（`input_usd_per_million` / `cached_input_usd_per_million` / `output_usd_per_million` / `image_*`），运行时由 `src/auth/usage-pricing.ts` + `src/auth/pricing-sync.ts`（litellm URL，`config.pricing.table_urls`，`config-schema.ts:235-245`）维护。
- 别名独立：只来自 `model.aliases`（`model-store.ts:705-711`），链式解析上限 20 层（`:771-784`），另有内置别名 `gpt-6 → gpt-6-astra`（`:360-362`）。别名不会被当成模型暴露（文件头 `:9`）。

### 3.2 五个数据来源与合并

1. 静态内置：`KNOWN_OFFICIAL_MODELS`（`:223-358`）
2. `config/models.yaml`：当前为空目录（`models: []`、`aliases: {}`），**有意不内置回落**
3. 后端按 plan 抓取：`applyBackendModelsForPlan`（`:510-526`）→ `planModelSnapshots` → `rebuildCatalogFromPlanSnapshots`（`:741-751`）
4. 官方无凭据目录同步：`src/models/official-model-catalog.ts`，伪 plan `"official"`（`:370`），一旦有真实账号快照即退休（`:476-479`、`model-fetcher.ts:121-123`）
5. `model.custom_models`：`applyConfiguredCustomModels`（`:722-739`）+ `normalizeCustomModel`（`:938-980`）

`getModelCatalog()`（`:626-631`）= 实时 catalog + 静态内置补集；`getModelInfo()`（`:621-624`）再查内置别名。

### 3.3 模型名如何变成「可路由目标」

- `parseModelName`（`:598-612`）先剥 `-fast/-flex` 与 effort 后缀（`stripKnownModelSuffixes:376-402`，effort 集合 `:219`），返回 `{modelId, serviceTier, reasoningEffort}`。
- `resolveModelId`（`:560-571`）：别名链 → catalog 命中 → `codex` 哨兵取 `model.default` → 官方形状原样返回 → 否则回落默认。
- **模型名解析与 provider 解析是两件事**：`model-store` 只解析名字，`UpstreamRouter.resolveMatch` 才决定上游（§1）。
- 图片宿主模型的专门解析器：`src/models/routable-model-resolver.ts:43-51`（拒绝 `gpt-image-2`，未知模型返回 `null` 而非静默回落）。

### 3.4 缓存与刷新

- 磁盘缓存：`data/models-cache.yaml` 的 `planSnapshots`，`syncCache` 异步写（`model-store.ts:664-703`），启动时在 `loadStatic` 回灌（`:459-492`），`sanitizeCachedModel` 兼容旧格式（`:820-827`）。
- 定时刷新：`src/models/model-fetcher.ts` —— 启动后 1s 首次，失败 10s×最多 24 次，成功/放弃后进入 **6h ± 15% 抖动**周期（`:21-24, 156-191`）；按 plan 分别抓（`:81-126`）。
- 官方目录：6h TTL + 失败 60s 冷却，并发请求共享同一个 in-flight promise（`official-model-catalog.ts:22-26, 283-301`）。
- 手动刷新：`POST /admin/refresh-models`（`src/routes/models.ts:305-318`）。

**改造影响面**：把 opencode 模型接进目录，只需在 `official-model-catalog` 式来源或 `custom_models` 里产出 `CodexModelInfo`；`/v1/models` 会自动带出 `context_window`/`supported_reasoning_efforts`。**但 `source:"runtime"` 的池内模型只有 id**（`models.ts:124-137`），没有元数据——这是当前 ocgo/provider 模型信息贫瘠的根因。

---

## 4. `/v1/models` 与 `/models` 的返回结构

### 4.1 结论

- **`/models`（无 `v1` 前缀）根本没有注册**。实际存在的 7 条：`/v1/models`、`/v1/models/catalog`、`/v1/models/catalog/codex`、`/v1/models/:modelId`、`/v1/models/:modelId/info`、`/debug/models`、`/admin/refresh-models`（`src/routes/models.ts:187-318`）。
- `/v1/models` 有**双形态**（`models.ts:187-216`）：
  - 带 `?client_version=` → Codex 原生 `{ models: [ModelInfo] }`（`buildCodexCatalogModels:166-185` → `toCodexCatalogEntry`，`src/models/codex-catalog.ts:16-97`）
  - 否则 → OpenAI 列表信封 `{object:"list", data:[...]}`（`toOpenAIModel:43-112`）

### 4.2 OpenAI 形态已包含的元数据（`models.ts:51-109`）

`context_window`、`max_context_window`、`max_output_tokens`、`truncation_policy`、`auto_compact_token_limit`、`effective_context_window_percent`、`display_name`、`description`、`default_reasoning_effort`、`supported_reasoning_efforts[]`、`input_modalities`、`output_modalities`、`service_tiers`、`visibility`、`priority`、`supported_in_api`、`tool_mode`、`shell_type`、`upgrade`、`upgrade_info` 等。

- **context window：有**（`:51-52`）。**reasoning：有**（`:74-80`）。
- **capabilities：没有独立的 `capabilities` 数组**。最接近的是 `input_modalities` / `tool_mode` / `supports_search_tool` / `supported_in_api` / `model_specialty`。
- 数据来源：`getLiveCatalog()`（`models.ts:144-147`，从 `getModelStoreDebug()` 的 live id 反向过滤，剔除 `KNOWN_OFFICIAL_MODELS` 补集）+ `apiKeyPool.getActiveModels()` 注入的裸条目（`:202-206`、`:172-176`）。
- Client Key 的 `allowed_models` 会二次过滤（`:152-158, 179-182`）。

**改造影响面**：opencode 模型若要 `/v1/models` 显示上下文窗口与档位，必须让它们进入 catalog 并带 `CodexModelInfo`，仅靠 `getActiveModels()` 会得到空元数据。

---

## 5. 现有 fallback 机制

### 5.1 结论

存在**两层、都与「模型」无关**的 fallback：

| 层 | 触发 | 粒度 | 能力 |
|---|---|---|---|
| 账号 fallback | 上游错误分类命中后换同模型的另一个账号 | 账号级 | 同一模型、不同账号 |
| fallback upstream apikey | 所有账号不可用 / 重试耗尽 | 全局单例 | 换上游端点，仍是同一模型 |

**没有「模型 A 失败切模型 B」的能力**，也没有 provider 级 fallback：直连路径（api-key/adapter）内部只有同 adapter 的传输重试（`direct-request-handler.ts:28-33, 82-105`），`CHANGELOG.md:252` 明确记录「明确不做自动 fallback」。

### 5.2 账号 fallback 的触发条件（`src/routes/shared/proxy-error-handler.ts:72-314`）

按检查顺序：安全策略拒绝（`:97-119`，直接 400、不重试）→ 传输层 status 0（`:130-144`，一次性）→ 模型不支持（`:147-160`，一次性，**同模型换号**）→ 早期 server_error（`:167-179`）→ 429（`:184-200`）→ 402（`:203-209`）→ 503（`:213-223`）→ CF challenge（`:226-238`）→ 403 ban（`:241-247`）→ 401（`:250-258`）→ CF path-block 404（`:268-295`）→ 其余终止（`:304-313`）。

决策对象是 `ErrorAction`（`:41-54`），带 `releaseBeforeRetry` / `markModelRetried` / `markEarlyServerErrorRetried` / `markTransportRetried` / `useFormat429`。

执行链：`applyProxyErrorRetryTransition`（`proxy-error-retry-transition.ts:47-112`）→ `prepareProxyFallbackAccountRetry`（`proxy-fallback-account-retry.ts:40-95`，排除 `triedEntryIds`，`acquireAccount` 再取一个）→ 取不到则返回 `attemptFallback:true`（`proxy-error-retry-transition.ts:93-102`）。

### 5.3 fallback upstream apikey

- 单例、固定 Responses wire：`src/auth/fallback-upstream.ts:16-21`。
- 两处入口（`src/routes/shared/proxy-handler.ts:79-101` 无账号可租、`:110-135` 重试耗尽），都构造 `new ResponsesUpstream("fallback", ...)` 走直连。
- 服务层守卫：`accountPool.isAuthenticated() || fallback.isConfigured()`（`chat.ts:217-227`、`messages.ts:163-168`、`responses.ts:189`）。
- 指示灯：`src/auth/fallback-state.ts`（60s 窗口，`:21-36`），来自 `markFallbackUsed()`（`proxy-handler.ts:92,126`、`proxy-fallback-account-retry.ts:77`）。
- **配置入口不是 yaml**：`data/fallback-upstream.json` + admin API `GET/POST/PATCH/DELETE /auth/fallback-upstream`（`src/routes/accounts.ts:209-260`）。

**改造影响面**：要做「模型级 fallback」，需要新增一层路由重试（当前 `handleProxyRequest` 的失败分支只换账号，模型名在整个请求生命周期内是不变量：`req.codexRequest.model` 只在 service_tier 收窄时被改，`proxy-handler.ts:140-144, 249`）。最小切入点是 `proxy-error-retry-transition` 的 respond 分支。

---

## 6. 一次 chat/completions 的完整调用链与协议转换层

### 6.1 `/v1/responses`（Codex 原生，passthrough）

```
apiKeyAuth → parseBody → validateClientKeyModel → resolveMatch
 → [ocgo] handleOCGoResponses            (responses.ts:168-171)
 → [not-found] 404 model_not_found        (responses.ts:173-184)
 → checkAuth                              (responses.ts:186-190)
 → 组装 CodexResponsesRequest             (responses.ts:197-351)
 → ingress 日志                            (responses.ts:354-365)
 → [api-key|adapter] handleDirectRequest  (responses.ts:367-380)
 → [codex] handleProxyRequest             (responses.ts:382)
```
入口注册：`responses.ts:501-508`；格式适配 `PASSTHROUGH_FORMAT`（无转换）。

### 6.2 `/v1/chat/completions`（OpenAI）

```
ChatCompletionRequestSchema → validateClientKeyModel → resolveMatch
 → [ocgo] unsupportedOCGoEndpoint(400)    (chat.ts:146)
 → [not-found] 404                          (chat.ts:147-150)
 → translateToCodexRequest  (translation/openai-to-codex.ts)  (chat.ts:156)
 → fmt = makeOpenAIFormat(wantReasoning)     (chat.ts:169-170)
 → [api-key|adapter] handleDirectRequest     (chat.ts:195-213)
 → [codex] handleProxyRequest                (chat.ts:231/234)
```

### 6.3 `/v1/messages`（Anthropic）

```
AnthropicMessagesRequestSchema → validateClientKeyModel → resolveMatch
 → [ocgo] unsupportedOCGoEndpoint            (messages.ts:159)
 → 401 守卫                                  (messages.ts:163-168)
 → extractAnthropicClientConversationId      (messages.ts:170-173)
 → translateAnthropicToCodexRequest          (messages.ts:181, translation/anthropic-to-codex.ts)
 → fmt = makeAnthropicFormat(wantThinking)   (messages.ts:202)
 → [api-key|adapter] handleDirectRequest     (messages.ts:217-235)
 → [codex] handleProxyRequest                (messages.ts:237)
```

### 6.4 `handleProxyRequest` 内部顺序（`src/routes/shared/proxy-handler.ts:137-635`）

`set logForwarded` → service_tier 覆盖（`:140-144`）→ `getSessionAffinityMap` / requestId（`:146-151`）→ `buildProxySessionContext`（`:150`）→ `applyProxyRequestForwardingDefaults`（`:157-160`，**在此写入 `prompt_cache_key`**）→ 安全策略隔离预检（`:174-190`）→ `acquireAccount`（`:193`）→ 脏配额校验循环（`:198-248`，上限 5 次）→ 级联封号防御（`:262-276`）→ `buildCodexApi`（`:277-284`）→ 推理重放缓存查询（`:291-299`）→ 隐式续链生命周期（`:301-313`）→ 诊断日志（`:315-329`）→ 负载护栏 413（`:337-361`）→ `staggerIfNeeded`（`:366`）→ 主循环：`sendProxyUpstreamAttempt`（`:381-395`）→ 流式 `handleStreaming`（`:398-419`）/ 非流式 `handleNonStreaming`（`:421-448`）→ catch 中 `classifyRetryAction`（`:463-474`）后 6 个分支（`:477-632`）。

`sendProxyUpstreamAttempt`（`proxy-upstream-attempt.ts:51-104`）：debug dump → `withRetry(api.createResponse)` → egress 日志 → 限流头写回。

`CodexApi.createResponse`（`src/proxy/codex-api.ts:270-303`）：`useWebSocket` 时走 WS，失败且无 `previous_response_id` 才降级 HTTP SSE（`:291-299`）。

### 6.5 协议转换发生在哪一层（重要）

- **入站 → Codex**：在**路由层**完成（chat/messages 各调一个 translator）；`/v1/responses` 不做转换。
- **Codex → 上游原生**：在 **adapter** 内完成（如 `OpenAIUpstream.createResponse` 调 `translateCodexToOpenAIRequest`，`openai-upstream.ts:44-45`；`ResponsesUpstream` 直接透传形状）。
- **上游 SSE → 客户端协议**：在 `parseStream`（adapter 内，归一为 `CodexSSEEvent`）+ `FormatAdapter`（路由层，`fmt.collectTranslator` / `streamResponse`）两段完成。
- 因此**任何新 provider 只要能吃 `CodexResponsesRequest`，就自动获得全部 4 类入站协议**，无需改路由。

---

## 7. OpenCode（OCGo）现状

### 7.1 能力边界

支持（`src/routes/ocgo-responses.ts:39-194`）：
- 仅 `POST /v1/responses` 的生成端点；`/review`、`/compact`、`/alpha/search`、`/v1/chat/completions`、`/v1/messages`、`/v1/images/*` 全部显式拒绝（`unsupportedOCGoEndpoint`，`:35-37`；调用点 `responses.ts:169,408,466`、`chat.ts:146`、`messages.ts:136,159`、`images.ts:303`）。
- 要求 `authRole` 为 `master` 或 `client_key`（`:46-48`），否则 401 `ocgo_auth_required`。
- 模型 ID 必须是 `ocgo:<id>`，`id` 限 `[A-Za-z0-9._-]{1,128}`（`ocgo-config.ts:24-28`）。
- 只接受 `input` 为字符串或数组；拒绝 `previous_response_id`、`conversation`、`turnState`，以及 `compaction*` / `item_reference` / `input_image` / `input_file` 类目（`ocgo-responses.ts:51-57`、`ocgo-upstream.ts:36-64`）。
- 工具只允许 `type:"function"`（`ocgo-upstream.ts:90-93`）。
- 上游报文被重写为 `{model:"opencode-go/<id>", stream:true, store:false, ...}`（`ocgo-upstream.ts:94-105`），并**丢弃 Rust 侧全部响应 header**（`:131-138`）。

拒绝/限制：
- 无服务端续链（无 `previous_response_id`）、无多模态输入、无 hosted tools、无 WebSocket 传输（`responses-websocket.ts:300` 对 ocgo 直接报错）。
- 只有单一错误通道：`OCGoError` + 7 类 failure（`src/proxy/ocgo-errors.ts:1-15`，严格只认结构化 code，不猜自由文本）。
- 流保证：任何非法帧/`error`/`response.failed`/`incomplete` 一律折叠成 `ocgo_stream_failed`（`ocgo-upstream.ts:165-195`）。

### 7.2 Key 池与轮换策略（`src/auth/ocgo-pool.ts`）

- 单进程单实例（`:40-41`）；凭据来源 `OCGoKeyStore.readCredentials()`，每次 `acquire` 前 `#refresh()` 重建（`:58-75`），Key 变更即换代（`generation: Symbol()`，`:61-64`）。
- 选择顺序（`:99-138`）：**session 亲和命中 → 否则按 `#lastSelectedId` 环形轮转**；跳过 disabled / 不含该模型 / invalid / 已 deny 该模型 / 在 `#inFlight` 或 `#leasedKeys`（同 Key 串行，`:117-118`）/ 冷却中。
- 返回 `{kind:selected|unavailable|busy|backoff}`（`:35-38`）。
- 健康状态按 failure 分派（`:159-181`）：`invalid_key` → 永久 invalid；`model_denied` → 只禁该模型；`key_rate_limit` → 该 Key 冷却；`quota_group_exhausted` → 额度组冷却（无组则全局 `#unknownUntil`）；`unknown_rate_limit` → 全局冷却。`Retry-After` 夹在 1s–86400s（`:7-8, 164-165`）。
- 请求内重试（`ocgo-responses.ts:116-132`）：只对**获取到 HTTP 响应之前**的结构化拒绝重试一次；`quota_group_exhausted` 要求换到独立额度组；绝不复放 SSE。
- 上限：100 条凭据（`MAX_OCGO_CREDENTIALS`，`ocgo-key-store.ts:17`）、文件 `0600`/目录 `0700`（`:57-68`）、id 与 apiKey 均需唯一（`:27-32`）。

### 7.3 缓存 / 会话亲和现状

- OCGo **自己有一套 affinity**，与 `SessionAffinityMap` 无关：`#affinity` 键为 `["ocgo", caller.kind, clientKeyId|null, sessionId]`，TTL 30 分钟，容量 4096，FIFO 淘汰，只在**成功完成**后才写入（`ocgo-pool.ts:8-9, 47, 150-158`）。
- sessionId 来源：`x-opencode-session` 头优先，否则 `body.prompt_cache_key`（`ocgo-responses.ts:19-29`），长度上限 256。
- **不向上游传任何缓存键**：`OCGoUpstream.createResponse` 的 header 只有 `Authorization` / `Content-Type` / `Accept`（`ocgo-upstream.ts:119-124`），payload 也不含 `prompt_cache_key`（`:94-105`）。Rust 侧无法据此复用 prompt cache。
- 用量只能被动从 `response.completed` 的 `usage` 读，且不估算未知值（`src/auth/ocgo-usage.ts:9-18, 42-57`）。

### 7.4 管理面

- `src/routes/admin/ocgo.ts:28-146`：`GET/POST/PATCH/DELETE /admin/ocgo/keys`、`POST /admin/ocgo/keys/:id/verify`。鉴权 = master key 或 dashboard session，且写操作要求 `Sec-Fetch-Site` 同源（`:31-43`）；body 上限 32KB（`:44`）。
- `web/src/pages/OCGoKeysPage.tsx:28-168`：只做凭据 CRUD / 启停 / 验证 / 删除，无模型目录编辑、无额度组自动推断（替换 Key 会清空 `quotaGroup`，`:99-100, 135`）。
- 快照接口同时给出 `enabled`、客户端请求计数、每凭据的健康与 attempt 计数（`ocgo-pool.ts:81-97`）。

---

## 8. 上游 header 的统一注入点

### 8.1 结论：没有单一注入点，有 4 个「事实上的注入层」

| 层 | 文件 | 注入内容 |
|---|---|---|
| 通用 Codex 上下文头 | `src/proxy/codex-request-context.ts:36-53`（`applyCodexContextHeaders`）、`:55-72`（`buildCodexClientMetadata`） | `x-codex-turn-state`、`x-codex-turn-metadata`、`x-codex-beta-features`、`x-codex-parent-thread-id`、`Version`、`x-codex-installation-id`、`client_metadata.session_id`、`x-codex-window-id` |
| OAuth/账号路径 | `src/proxy/codex-api.ts:122-168`（身份派生）、`:331-332`、`:393-394`、`:426` | `session_id`、`x-codex-window-id`、`x-client-request-id`、body `prompt_cache_key`、`client_metadata` |
| 第三方 Responses 路径 | `src/proxy/codex-responses-upstream.ts:117-164` | `session_id`/`session-id`/`thread_id`/`thread-id`（同一值）、`x-client-request-id`、`x-codex-installation-id`、`x-codex-window-id`、`x-openai-internal-codex-residency`、body `prompt_cache_key`（`:177`） |
| 各 adapter 各自为政 | `openai-upstream.ts:47-59`、`responses-upstream.ts:117-129`、`antigravity-upstream.ts:45` | 只有 `Authorization`/`Content-Type`/`Accept` + `applyOpenCodeHeaders`；缓存键仅作为 opencode session 的回退种子 |

### 8.2 缓存相关键的真实做法

- 客户端不给键时，proxy **自己造一个稳定键**：`resolvePromptCacheIdentity`（`src/routes/shared/proxy-session-helpers.ts:62-83`）优先级 = `prompt_cache_key` → 客户端会话 id（chat 用 `req.user`、messages 用 `x-claude-code-session-id`/`metadata.user_id.session_id`、gemini 用自带 id）→ 内容派生键 → 随机 UUID。内容派生见 `stable-conversation-key.ts:69-78`（`sha256(model + instructions + 首条 user 文本)`）。
- 该键在 `applyProxyRequestForwardingDefaults` 被写回请求体（`proxy-request-preparation.ts:14-23`），因此**所有下游 adapter 都能读到 `req.prompt_cache_key`**。
- 账号路径会把键**再散列成账号级身份**：`cp_<sha256(kind,entryId,value)[:32]>`（`codex-api.ts:157-168`；`codex-responses-upstream.ts:87-97`），所以同一对话跨账号不会共享缓存键；opt-in 的 `codex_fingerprint_mode:"session"` 只收敛 `session_id`（`codex-api.ts:137-139, 146-155`）。
- 变体隔离：`variantHash = sha256(instructions + tools)` 只用于**本地** affinity / WS 池，不外发给上游（`src/routes/shared/variant-hash.ts`、`proxy-session-helpers.ts:85-96`）。
- `x-opencode-session` 是唯一「按上游域名条件注入」的 header：`applyOpenCodeHeaders`（`opencode-headers.ts:35-44`）先判 `isOpenCodeUpstream(baseUrl)`（`:17-27`：`opencode.ai` / `*.opencode.ai` / 路径含 `/zen/go`），命中才注入 UA + session。

**改造影响面**：给新 provider 加缓存头，正确落点是 adapter 的 `createResponse` 内（配合 `req.prompt_cache_key`）或 `codex-request-context.ts` 的共享函数；**不要**放到 `proxy-handler`，那里只管键的生成，且已有边界测试锁住（`tests/unit/routes/shared/proxy-request-preparation-boundary.test.ts:78`）。OCGo 当前完全绕过了这一层——这是「opencode 一等公民」最明显的空洞。

---

## 9. 新增 opencode 一等公民 provider 的最小改造清单

1. **表征统一**：在 `src/auth/api-key-catalog.ts:6-7` 增 `api_key` 式 provider（或复用 `custom`+`wire`），并在 `src/proxy/adapter-factory.ts:42-62` 映射到现有/adapter；**不要**再走 `UpstreamRouter` 的 `ocgoEnabled` 布尔特例（`upstream-router.ts:34,65-88`）——那是一等公民化的主要障碍。
2. **协议适配器**：把 `OCGoUpstream`（`src/proxy/ocgo-upstream.ts`）改造成符合 `UpstreamAdapter`（`upstream-adapter.ts:30-58`）的普通 adapter，允许模型 ID 直通、允许 `prompt_cache_key`、按 `isOpenCodeUpstream` 注入 `x-opencode-session`。
3. **缓存键**：在 adapter 内把 `req.prompt_cache_key`（已由 `proxy-request-preparation.ts:19` 写好）转发为上游可识别的键/头，取代当前 `ocgo-pool` 私有的 30 分钟 affinity（`ocgo-pool.ts:8-9, 150-158`）。
4. **路由放开**：删除 `chat.ts:146`、`messages.ts:136,159`、`responses.ts:169,408,466`、`images.ts:303` 的 `unsupportedOCGoEndpoint` 短路，让其自然落入 `handleDirectRequest` / `handleProxyRequest`。
5. **模型目录**：为 opencode 模型产出真实 `CodexModelInfo`（`contextWindow`、`supportedReasoningEfforts`、`inputModalities`），替换 `/v1/models` 里的裸 `source:"runtime"` 条目（`models.ts:124-137, 172-176`）。
6. **错误语义**：把 `OCGoError` 的 7 类 failure（`ocgo-errors.ts:1-15`）并入 `handleCodexApiError` 的分类链（`proxy-error-handler.ts:97-295`），否则账号 fallback 逻辑对新 provider 完全不生效。
7. **配置与鉴权**：`ocgo` 段（`ocgo-config.ts:16-22`）保持 loopback 约束；`data/ocgo-keys.json` 的凭据池可保留，但需支持 >1 模型粒度之外的 provider 语义。
8. **验证面**：同步 `tests/unit/proxy/adapter-factory.test.ts`、`tests/unit/proxy/upstream-router-apikeys.test.ts`、`tests/integration/ocgo-*`、`tests/unit/routes/ocgo-responses.test.ts`。
