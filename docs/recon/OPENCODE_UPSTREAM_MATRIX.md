# OpenCode 上游能力矩阵（抓取核对版）

- 抓取时间：2026-11-21（Asia/Shanghai），全部数据来自当日实测。
- 方法：`web_fetch` 抓文档 + 无鉴权 GET/POST 实测（未使用任何真实 API key，未写入除本文件外的任何内容）。
- `web_search` 在本会话因余额 402 不可用，故所有结论均落为可回溯的 URL 或实测结果。
- 标注约定：`[文档]` = 官方文档原文；`[实测]` = 本次无凭据探测结果；`未验证` = 无证据，不猜。

| 来源 | URL | 结果 |
|---|---|---|
| 模型列表 API | https://opencode.ai/docs/console/api/models/ | 200，全文字段表 |
| 推理 API | https://opencode.ai/docs/console/api/inference/ | 200 |
| Console 模型表（端点总表） | https://opencode.ai/docs/console/models/ | 200，94 行模型→端点对照 |
| Go 订阅 | https://opencode.ai/docs/console/go/ | 200 |
| Harnesses（Base URLs） | https://opencode.ai/docs/console/harnesses/ | 200 |
| Claude Code / Codex harness | https://opencode.ai/docs/console/harnesses/claude-code/ 、 …/codex/ | 200 |
| API 鉴权/权限、客户端免费与缓存 | https://opencode.ai/docs/console/api/ 、 https://opencode.ai/docs/models/ | 200 |
| 疑似 zen 页 | https://opencode.ai/docs/zen/ | 未获取：重定向到 `/docs/console/models/`，无独立 zen 文档 |
| 公开模型列表 | https://opencode.ai/inference/v1/models | 200（无鉴权） |
| Go 模型列表 | https://opencode.ai/inference/go/v1/models | 200（无鉴权） |

---

## A. 三个逻辑上游

三者共用同一网关主机 `opencode.ai`，区别在**路径前缀 + 鉴权 + 客户端身份**，不是三个独立域名。

### A1. opencode-go（Go 订阅）

- Base URL：`https://opencode.ai/inference/go`　[文档 `harnesses#base-urls`](https://opencode.ai/docs/console/harnesses/)
- 鉴权：`Authorization: Bearer oc_sk_...`，且必须是**有 Go 订阅的工作区**签发的 key　[文档 `console/go#endpoints`](https://opencode.ai/docs/console/go/)
- 可用端点（同 payg 四族，路径加 `/go` 前缀）：`/go/openai/v1/responses`、`/go/openai/v1/chat/completions`、`/go/anthropic/v1/messages`、`/go/google/v1beta/models/<model>:generateContent`　[文档]
- 可用模型族：31 个（见 B2 表），含 GPT/Claude/Gemini/Grok/Qwen/Kimi/GLM/MiniMax/DeepSeek/MiMo/Hy/LongCat/Step/Muse/Beam/Iceman，Go 侧**独有 id**与 zen 不同名（如 `muse-spark-1.3-contributor`、`qwen4-max`、`mimo-v2.6-pro`）。
- **强制 header**：`x-opencode-session: ses_...`。缺失直接 `400 MissingSessionID`　[实测]：
  ```
  {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. ..."}}
  ```
  校验顺序在鉴权**之前**（无 key 且无 session → 400；补上 session → 401）。
- 限额：Go $10/月、Go Plus $40/月、Go Teams $20/人/月（2 人起）。5 小时窗口 = 月额度的 20%；周窗口 = 50%，周一 00:00 UTC 重置；月额度随付费周期重置。所有付费模型共享同一额度，换模型不另开额度　[文档 `console/go#usage-limits`]
- 已知限制：只覆盖订阅者本人与工作区 API key，其他成员用免费模型或余额；Service account 不被 Go Teams 覆盖；部分模型需在 Privacy 里放开 Region 或允许「训练数据的付费端点」　[文档 `console/go`]
- 免费模型也走 Go 路径，但**仍需 API key**　[实测]：`{"error":{"type":"authentication_error","message":"OpenCode Go requires an API key"}}`

### A2. opencode-zen PAYG（按量付费）

- Base URL：`https://opencode.ai/inference`　[文档 `harnesses#base-urls`]
- 鉴权：`Authorization: Bearer oc_sk_...`（personal key 或 service account key）。缺凭据实测 `401`　[实测]：
  ```
  {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}
  ```
- 可用端点：`/inference/openai/v1/responses`、`/inference/openai/v1/chat/completions`、`/inference/anthropic/v1/messages`、`/inference/google/v1beta/models/<model>:generateContent`；另有 `/inference/openai/v1/images/generations`、`/inference/xai/v1/images/generations`、`/inference/systemone/v1/systemone`　[文档 `console/api/inference#endpoints`、`console/models#endpoints`]
- 可用模型族：103 个条目（见 B1），含 12 个免费模型、3 个图像、4 个 decision、1 个 realtime、12 个 embedding。
- 关键语义：**每个模型有唯一原生接口，但每个文本模型都能从其余文本接口调用，由 Console 翻译**　[文档 `console/models#endpoints`]：「Each model is listed with its native API, but every text model also works through the other APIs, which Console translates.」
- 限额：按量付费，受 workspace/member budget 约束；无内置模型级限额　[文档 `budgets`]
- `x-opencode-session` **可选但强烈建议**（路由稳定性 + prompt cache 复用），payg 不强制　[文档 `harnesses#sessions`、实测：payg 无 session 返回正常 401 而非 400]

### A3. opencode-zen FREE（免费档）

- Base URL：与 A2 **完全相同** `https://opencode.ai/inference`；不是独立主机或前缀。
- 鉴权：免费模型**不要求 key**（实测无 key 未报 401，而是进入配额判定）　[实测]
- 访问限制（最关键）：免费档**只对 OpenCode 客户端开放**　[文档 `console/api/inference#authentication`]：「Free-tier chat models are only available from within OpenCode; other clients receive HTTP `403`, even with an API key.」
- 实测行为与文档取值不同　[实测]：无凭据 POST `big-pickle` / `deepseek-v4.1-flash-free`，返回 **429**（不是 403）：
  ```
  {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}
  ```
  带 `Retry-After: ~71894`（≈20 小时窗口），且附加 `x-opencode-session` + 自定义 User-Agent 后**仍是 429**。
- 结论：非 OpenCode 客户端拿不到免费额度；403/429 的差异取决于客户端身份判定（判定信号未验证，见 G）。

---

## A4. 各家 harness 的 Base URL 全表

| 场景 | Base URL | 说明 / 来源 |
|---|---|---|
| PAYG 网关根 | `https://opencode.ai/inference` | [文档](https://opencode.ai/docs/console/harnesses/) |
| Go 网关根 | `https://opencode.ai/inference/go` | 同上 |
| Responses | `<root>/openai/v1/responses` | 同上 |
| Chat Completions | `<root>/openai/v1/chat/completions` | 同上 |
| Messages | `<root>/anthropic/v1/messages` | 同上 |
| Gemini | `<root>/google/v1beta/models/<model>:generateContent` | 同上 |
| Claude Code | `ANTHROPIC_BASE_URL=https://opencode.ai/inference/anthropic`（Go：`/inference/go/anthropic`） | [文档](https://opencode.ai/docs/console/harnesses/claude-code/)；Claude Code 自行追加 `/v1/messages`；必须用 `ANTHROPIC_AUTH_TOKEN` 而非 `ANTHROPIC_API_KEY` |
| Codex | `base_url = "https://opencode.ai/inference/openai/v1"`（Go：`/inference/go/openai/v1`），`wire_api = "responses"`，`env_key = "OPENCODE_API_KEY"` | [文档](https://opencode.ai/docs/console/harnesses/codex/)；Codex 自行追加 `/responses` |
| 自定义 provider（connection） | `https://opencode.ai/inference/custom/<connection_id>` + 协议路径 | [文档](https://opencode.ai/docs/console/api/models/#model-api) |
| Console 管理面 | `https://opencode.ai/console/api/v1/models` | 需要 key，`Cache-Control: private, no-store` |

---

## B. 模型 → 原生接口对照表

### B1. zen（`/inference`），实测 103 条

`ctx` 单位 token；`effort` 来自 `capabilities.reasoning.effort`，`—` 表示该模型未声明档位。免费模型单列于 D 节。

| 模型 id | 原生接口 | ctx | effort |
|---|---|---|---|
| gpt-5 | responses | 400000 | minimal/low/medium/high |
| gpt-5-codex | responses | 400000 | low/medium/high |
| gpt-5-nano | responses | 400000 | minimal/low/medium/high |
| gpt-5.1 | responses | 400000 | none/low/medium/high |
| gpt-5.1-codex | responses | 400000 | low/medium/high |
| gpt-5.1-codex-max | responses | 400000 | low/medium/high/xhigh |
| gpt-5.1-codex-mini | responses | 400000 | low/medium/high |
| gpt-5.2 | responses | 400000 | none/low/medium/high/xhigh |
| gpt-5.2-codex | responses | 400000 | low/medium/high/xhigh |
| gpt-5.3-codex | responses | 400000 | none/low/medium/high/xhigh |
| gpt-5.3-codex-spark | responses | 128000 | low/medium/high/xhigh |
| gpt-5.4 | responses | 1050000 | none/low/medium/high/xhigh |
| gpt-5.4-mini | responses | 400000 | none/low/medium/high/xhigh |
| gpt-5.4-nano | responses | 400000 | none/low/medium/high/xhigh |
| gpt-5.4-pro | responses | 1050000 | medium/high/xhigh |
| gpt-5.5 | responses | 1050000 | none/low/medium/high/xhigh |
| gpt-5.5-pro | responses | 1050000 | medium/high/xhigh |
| gpt-5.6-luna | responses | 1050000 | none/low/medium/high/xhigh/max |
| gpt-5.6-sol | responses | 1050000 | none/low/medium/high/xhigh/max |
| gpt-5.6-terra | responses | 1050000 | none/low/medium/high/xhigh/max |
| gpt-6-astra | responses | 1050000 | low/medium/high/xhigh/max |
| gpt-6-sol | responses | 1050000 | none/low/medium/high/xhigh/max |
| gpt-6-luna | responses | 1050000 | none/low/medium/high/xhigh/max |
| gpt-6.1-sol | responses | 1050000 | low/medium/high/xhigh/max |
| gpt-6.2-sol | responses | 1050000 | low/medium/high/xhigh/max |
| gpt-6.2-astra | responses | 1050000 | low/medium/high/xhigh/max |
| grok-4.5 | responses | 500000 | low/medium/high |
| grok-4.6 | responses | 500000 | low/medium/high/xhigh |
| grok-4.7 | responses | 500000 | low/medium/high/xhigh |
| grok-build-0.1 | responses | 256000 | — |
| muse-spark-1.2 | responses | 1048576 | minimal/low/medium/high/xhigh |
| muse-spark-1.3 | responses | 1048576 | minimal/low/medium/high/xhigh |
| muse-wonder-1.0 | responses | 1048576 | minimal/low/medium/high/xhigh/max |
| muse-ember-1.0 | responses | 1048576 | minimal/low/medium/high/xhigh/max |
| glm-5.3 | chat-completions | 1000000 | low/high/max |
| glm-5.3-flash | chat-completions | 1000000 | low/high/max |
| kimi-k2.7-code | chat-completions | 262144 | — |
| kimi-k3 | chat-completions | 1048576 | low/high/max |
| minimax-m2.5 | chat-completions | 204800 | — |
| minimax-m2.7 | chat-completions | 204800 | — |
| minimax-m3 | chat-completions | 512000 | — |
| deepseek-v4.1-flash | chat-completions | 1000000 | low/high/max |
| deepseek-v4-pro | chat-completions | 1000000 | high/max |
| qwen3.8-max | chat-completions | 262144 | low/medium/xhigh |
| mistral-large-4 | chat-completions | 524288 | none/high |
| claude-fable-5 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-fable-5-1 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-fable-5-2 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-opus-4-5 | messages | 200000 | low/medium/high |
| claude-opus-4-6 | messages | 1000000 | low/medium/high/max |
| claude-opus-4-7 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-opus-4-8 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-opus-5 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-opus-5-5 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-sonnet-4-5 | messages | 1000000 | — |
| claude-sonnet-4-6 | messages | 1000000 | low/medium/high/max |
| claude-sonnet-5 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-sonnet-5-5 | messages | 1000000 | low/medium/high/xhigh/max |
| claude-haiku-4-5 | messages | 200000 | — |
| claude-haiku-5-5 | messages | 1000000 | low/medium/high/xhigh/max |
| qwen3.5-plus | messages | 262144 | — |
| qwen3.6-plus | messages | 262144 | — |
| qwen3.8-flash | messages | 1000000 | low/medium/xhigh |
| gemini-3.5-flash | google | 1048576 | minimal/low/medium/high |
| gemini-3.5-flash-lite | google | 1048576 | minimal/low/medium/high |
| gemini-3.6-flash | google | 1048576 | minimal/low/medium/high |
| gemini-3.7-flash | google | 1048576 | low/medium/high |
| gemini-3.8-flash | google | 1048576 | low/medium/high |
| gemini-4-argon | google | 1048576 | low/medium/high |
| gemini-4-carbon | google | 1048576 | low/medium/high |
| gemini-4-hydrogen | google | 1048576 | low/medium/high/xhigh |
| gemini-4-neon | google | 1048576 | low/medium/high/xhigh |
| jev-1.13 | systemone | 64000 | — |
| gemini-decision-1 | systemone | 262144 | — |
| gpt-6-luna-decision | systemone | 1050000 | — |
| gpt-image-2.5-sunburst | images | — | — |
| grok-imagine-image-2.0 | images | 64000 | — |
| gemini-nano-banana-2.1 | images + google | 131072 | minimal/medium/high |
| gpt-live-1 | live（type=realtime） | — | — |

免费档 12 个模型全部在 zen 目录里，接口与上下文见 D 节：除 `jev-1.13-free`（systemone）外**全部是 chat-completions**。

embeddings（12，全部走 `embeddings` 协议，非 chat，不进 `/models` 选择器）：`text-embedding-3-small`(8192)、`text-embedding-3-large`(8192)、`gemini-embedding-001`(2048)、`gemini-embedding-2`(8192)、`codestral-embed`(8192)、`mistral-embed`(8000)、`qwen3-embedding-8b`(32768)、`bge-m3`(8192)、`cohere-embed-v5-fast`(128000)、`cohere-embed-v5-pro`(128000)、`voyage-4`(32000)、`voyage-code-4`(32000)。

> 与文档端点表不一致的地方（以实测列表为准）：文档表缺 `tidepool-alpha-free`、`gemini-4-neon`、`gpt-live-1`、12 个 embedding；文档表有 `inkling-2-small-free`、`glm-5`/`glm-5.1`/`glm-5.2`、`kimi-k2.5`/`kimi-k2.6`，实测列表**已无**这些 id（`glm-5*`、`kimi-k2.5` 同列文档 Deprecated 表）。`minimax-m2.5`、`kimi-k2.5` 同时出现在 Deprecated 表和实测列表中。

### B2. Go（`/inference/go`），实测 31 条

`mu` = `go.monthly_usage`，单位美元（Go / Go Plus / Go Teams），`—` 表示免费不计额。

| 模型 id | 原生接口 | ctx | mu | zdr |
|---|---|---|---|---|
| deepseek-v4.1-flash | chat-completions | 1000000 | 100 / 200 / 105 | true |
| deepseek-v4-pro | chat-completions | 1000000 | 15 / 60 / 20 | true |
| glm-5.3 | chat-completions | 1000000 | 500 / 1000 / 505 | true |
| glm-5.3-flash | chat-completions | 1000000 | 60 / 180 / 65 | true |
| kimi-k2.7-code | chat-completions | 262144 | 60 / 180 / 65 | true |
| kimi-k3 | chat-completions | 1048576 | 15 / 60 / 20 | true |
| kimi-k3.1-pro | chat-completions | 1048576 | 15 / 60 / 20 | true |
| minimax-m3.1-flash | chat-completions | 1000000 | 20 / 80 / 25 | true |
| mimo-v2.6-flash | chat-completions | 1048576 | 60 / 120 / 65 | true |
| mimo-v2.6-pro | chat-completions | 1048576 | 15 / 60 / 20 | true |
| hy3 | chat-completions | 256000 | 60 / 240 / 65 | true |
| hy4 | chat-completions | 1048576 | 60 / 240 / 65 | true |
| hy4-preview | chat-completions | 1024000 | 30 / 120 / 35 | true |
| longcat-2.0 | chat-completions | 1000000 | 60 / 240 / 65 | true |
| step-5-preview | chat-completions | 1000000 | 15 / 60 / 20 | true |
| grok-4.7 | responses | 500000 | 15 / 60 / 20 | false |
| gpt-5.6-luna | responses | 1050000 | 15 / 60 / 20 | false |
| gpt-6-luna | responses | 1050000 | 15 / 60 / 20 | false |
| muse-spark-1.2-contributor | responses | 1048576 | 60 / 120 / 65 | false（train=true） |
| muse-spark-1.3-contributor | responses | 1048576 | 60 / 120 / 65 | false（train=true） |
| claude-haiku-5-5 | messages | 1000000 | 15 / 60 / 20 | false |
| minimax-m3 | messages | 1000000 | 60 / 180 / 65 | true |
| qwen3.8-max | messages | 1000000 | 15 / 60 / 20 | true |
| qwen3.8-flash | messages | 1000000 | 30 / 90 / 35 | true |
| qwen3.7-plus | messages | 1000000 | 60 / 180 / 65 | true |
| qwen4-max | messages | 1000000 | 15 / 60 / 20 | true |
| gemini-4-argon | google | 1048576 | 30 / 120 / 35 | false |
| beam-free | chat-completions | 1048576 | — | false（limited_regions） |
| iceman-contributor-free | chat-completions | 262144 | — | false（train=true） |
| longcat-2.5-free | chat-completions | 1000000 | — | true |
| hy4-flash-free | chat-completions | 1048576 | — | true |

> **同 id 跨上游换协议**：`minimax-m3`、`qwen3.8-max` 在 zen 上是 `chat-completions`，在 Go 上是 `messages`；`qwen3.8-flash` 两侧都是 `messages`。转发层不能按 id 缓存协议，必须按（上游，id）取。

---

## C. 模型元数据字段清单

Console 列表 `GET https://opencode.ai/console/api/v1/models` 与推理列表 `GET https://opencode.ai/inference/v1/models` 共用 models.dev v2 字段（[文档 fields](https://opencode.ai/docs/console/api/models/#fields)）。实测无鉴权 GET：`200`，`Content-Type: application/json`，`Cache-Control: no-store`，`131889` 字节，`object:"list"` + `data[103]`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `type` | string | 模型种类：`chat`（文档称目前只列 chat，实测另有 `decision`/`image`/`realtime`/`embedding`） |
| `id` | string | 请求里要发的模型 ID，也是 `models` 的键 |
| `object` | string | 常量 `model` |
| `created` / `owned_by` | number / string | OpenAI 列表形状字段 |
| `name` / `description` / `family` | string | 展示名、描述、族 |
| `canonical_id` | string | 规范 id，如 `anthropic/claude-sonnet-5-5`（Console 列表有） |
| `open_weights` | bool | 是否开放权重 |
| `knowledge` / `release_date` / `last_updated` | string | 知识截止、发布、更新 |
| `modalities.input[]` / `modalities.output[]` | string[] | 输入/输出模态，如 `text`、`image/png`、`application/pdf` |
| `capabilities.tools.supported` | bool | 是否支持工具调用 |
| `capabilities.reasoning.supported` | bool | 是否支持推理 |
| `capabilities.reasoning.effort[]` | string[] | 档位：`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`（按模型不同） |
| `capabilities.structured_output` / `temperature` / `system_updates` / `effort_updates` | bool | 结构化输出、温度、系统提示更新、运行中改 effort |
| `limit.context` | number | 上下文窗口 |
| `limit.input` | number | 单请求输入上限（模型设了才有） |
| `limit.output` | number | 响应输出上限 |
| `cost.text.input.price` | number | 输入价，USD / 1M token；`0` = 免费 |
| `cost.text.input.cache.read` / `.write` | number | 缓存读/写价；缺字段 = 该模型无缓存价 |
| `cost.text.output.price` | number | 输出价 |
| `cost.multipliers` | object | 部分模型按时段加价 |
| `api.<protocol>.base_url` | string | 该模型的 Console URL |
| `api.<protocol>.sdk.aisdk` / `.opencodeai` | string | AI SDK 包名 / OpenCode provider 模块 |
| `go.monthly_usage` | object | Go 各档月额度美元值 |
| `go.training` / `go.zdr` / `go.limited_regions` | bool | 是否训练、零留存、地区限制 |

`api` 的键就是协议名：`chat-completions` / `responses` / `messages` / `generate-content`；实测还出现 `interactions`（Gemini 系并列）、`images`、`systemone`、`live`、`embeddings`。

脱敏示例（结构真实，key 已替换）：

```json
{
  "id": "claude-sonnet-5-5",
  "object": "model",
  "created": 1795006281,
  "owned_by": "opencode",
  "name": "Claude Sonnet 5.5",
  "type": "chat",
  "family": "claude-sonnet",
  "open_weights": false,
  "knowledge": "2026-06",
  "release_date": "2026-09-28",
  "modalities": { "input": ["text", "image/jpeg", "image/png", "application/pdf"], "output": ["text"] },
  "capabilities": {
    "tools": { "supported": true },
    "reasoning": { "supported": true, "effort": ["low", "medium", "high", "xhigh", "max"] },
    "structured_output": true, "temperature": true, "system_updates": false, "effort_updates": false
  },
  "limit": { "context": 1000000, "output": 128000 },
  "cost": { "text": { "input": { "price": 2, "cache": { "read": 0.1, "write": 2.5 } }, "output": { "price": 10 } } },
  "api": {
    "messages": {
      "base_url": "https://opencode.ai/inference/anthropic/v1",
      "sdk": { "aisdk": "@ai-sdk/anthropic", "opencodeai": "@opencode/ai/providers/anthropic" }
    }
  }
}
```

错误码：`401` 无凭据/过期/吊销；`403` key 不能列模型（需 **Models › Read**）；越权请求 `403`　[文档 `console/api/models#errors`、`console/api#limitations`]。实测 `401` body 为 `{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}`。

---

## D. 免费模型清单与访问要求

zen `*-free` 共 12 个（全部 `cost.text.input.price == 0`）：`big-pickle`、`mimo-v2.6-flash-free`、`deepseek-v4.1-flash-free`、`longcat-2.5-free`、`iceman-free`、`beam-free`、`flint-40b-free`、`nemotron-3.5-super-vl-free`、`nemotron-3.5-lightning-free`、`hy4-flash-free`、`tidepool-alpha-free`、`jev-1.13-free`。除 `jev-1.13-free`（systemone）外全部是 **chat-completions**。

Go 免费 4 个：`beam-free`、`iceman-contributor-free`、`longcat-2.5-free`、`hy4-flash-free`。

访问要求：
1. 免费档只对 OpenCode 客户端开放，其他客户端 `403`　[文档 `console/api/inference#authentication`]。
2. 实测非 OpenCode 客户端、无 key：`429 FreeUsageLimitError` + `Retry-After ≈ 71894s`；加 `x-opencode-session`、改 UA 均不解锁　[实测]。**免费额度按来源判定，不是按 key。**
3. Go 路径下的免费模型仍需 API key（`401 OpenCode Go requires an API key`）　[实测]。
4. 隐藏免费模型：`OPENCODE_DISABLE_FREE_MODELS=1`（或 `true`）→ 从目录与默认值中消失，显式选择报 `Model unavailable`；定义是「`opencode` 或 `opencode-go` 下 input 价为 0 的模型」　[文档 `models#free-models`](https://opencode.ai/docs/models/)。
5. 免费模型不保证可用（限时提供），且部分有地区限制（`Beam Free` 排除中国大陆/香港/澳门等，`LongCat 2.5 Free` 托管在中国、100 请求/天）　[文档 `console/models#free-models`]。

---

## E. 缓存相关

原文摘录（英文原文 + 中文结论）：

1. 「Send a stable session ID with every request so Console can route a conversation consistently and reuse its prompt cache.」　[文档 `harnesses#sessions`] → **`x-opencode-session` 是缓存复用的前提**，Go 强制。
2. 「`opencode.tokens`: The tokens you were billed for. `input` excludes cache reads and writes; `output` includes `reasoning`.」　[文档 `console/api/inference#cost`] → 计费口径：`input` 不含缓存读写，缓存单独计。
3. 响应里的 usage 明细：`cache_read`、`cache_write_5m`、`cache_write_1h`　[文档 `console/api/inference#cost`] → **5 分钟与 1 小时两档缓存写入分别计数**，说明上游按 TTL 分档计价。
4. 「OpenCode places prompt-cache breakpoints automatically on routes that are known to need them, such as Anthropic.」　[文档 `models#prompt-caching`] → Anthropic 路由自动打 `cache_control: {"type":"ephemeral"}` 断点（工具定义、system、最新消息三处）。
5. 「OpenAI Chat and Responses: `"24h"` goes to `prompt_cache_retention`; other values go to `prompt_cache_options.ttl`.」　[文档 `models#cache-lifetime`] → 缓存 TTL 在 OpenAI 两族用不同字段表达。
6. 「`supportsPromptCacheKey`: Whether the endpoint accepts the `prompt_cache_key` body field.」　[文档 `models#compatibility`] → 转发层要按族决定是否发 `prompt_cache_key`。
7. 「`cacheFormat`: `anthropic` or `alibaba`」　[文档 `models#compatibility`] → 走 OpenAI 兼容代理的 Claude 需显式声明缓存标记语法。

补充：文档未给出 Console 网关侧的缓存 header（如命中率返回头）；`usage` 是唯一可观测入口。缓存读/写价在 `cost.text.input.cache` 里按模型给出，`GPT 5.5`/`5.4` 等少数模型无 cache 价字段（实测 `cache.write` 缺失）。

---

## F. 思考档位的表达方式

| 族 | 档位来源 | 文档依据 |
|---|---|---|
| 通用 | `capabilities.reasoning.effort[]` 决定可选变体名；`#variant` 选中，如 `openai/gpt-6.1-sol#high`；未知变体报模型解析错误 | [文档 `models#variants`](https://opencode.ai/docs/models/) |
| OpenAI Responses | `settings.reasoningEffort`；`supportsEffortUpdates=true`（GPT-6 起自动识别）时以 per-message 更新发送，**保留 prompt cache**，否则整请求生效 | [文档 `models#compatibility`] |
| OpenAI Chat | 无独立 effort 字段文档；靠 provider 包选项与 `reasoningField`（`reasoning`/`reasoning_content`/`reasoning_text`）承载返回的思考内容；`requireReasoning` 对 DeepSeek 默认 `true` | [文档 `models#reasoning`] |
| Anthropic Messages | `capabilities.reasoning.budget` 的 `min`/`max` 思维 token 预算；设了 `effort` 时 `budget` 被忽略；`supportsThinkingBlockBinding` 控制是否丢弃"上下文已变"的 thinking block（Claude 5.1+ 自动识别） | [文档 `models#variants`、`#compatibility`] |
| Gemini | 实测 catalog 直接给 `none`/`minimal`/`low`/`medium`/`high`/`xhigh`；缓存自动、无标记 | [实测 + 文档 `models#cache-lifetime`] |
| System One | 无思考档位（decision 模型，问 `noul`/`choice`/`score`） | [文档 `console/models#jev`] |

要点：**档位是模型级元数据，不是上游级常量** —— 同为 `chat-completions`，`deepseek-v4-pro` 只给 `high/max`，`glm-5.3` 给 `low/high/max`，`mistral-large-4` 只给 `none/high`。转发层应直接吃 `capabilities.reasoning.effort`，不要自建白名单。

---

## G. 未确认项（未验证，勿据此实现）

1. **免费档客户端身份判定信号**：文档称非 OpenCode 客户端 403，实测 429；到底是 User-Agent、header 还是 OAuth 会话决定，未验证。
2. **免费档在带合法 key 时的行为**：无 key 时被 429 拦住，带 OpenCode 账号 key 后是否放行（文档暗示仍限 OpenCode 客户端），未验证。
3. **`Retry-After ≈ 71894s` 的确切窗口语义**（是否 20 小时滚动窗），未验证。
4. **`x-opencode-session` 对 payg 的实际收益**（路由稳定性/缓存命中率提升幅度），无法在无 key 情况下量化。
5. **Go 的 `x-opencode-session` 强制是否覆盖全部四种协议**：仅实测 chat-completions 返回 400，`responses`/`messages`/`google` 路径未验证。
6. **`gpt-live-1`（type=realtime）与 `embeddings` 类的请求路径**：catalog 只给协议键，无文档端点，未验证。
7. **Gemini 模型的 `interactions` 协议键**：与 `generate-content` 并列出现，其路径与用途无文档，未验证。
8. **`tidepool-alpha-free` 状态**：出现在实测列表，但文档免费模型与定价表都没有它，有效期/地区未验证。
9. **`inkling-2-small-free` 状态**：文档定价表与免费说明有它，实测列表没有，是否已下线未验证。
10. **Go `monthly_usage` 的币种与精确含义**：文档只说"its monthly usage limit on each plan"，按美元理解，`console/go#limits` 页未抓取核对。
11. **`capabilities.reasoning.effort` 与真实可接受取值的偏差**：catalog 是声明值，个别模型（如 `nemotron-3.5-super-vl-free` 给 `none/minimal/low/medium/high/xhigh`）实际是否全支持未验证。
12. **`cost.multipliers` 的时段规则**：文档只说"raise the price at the times they name"，具体时段与倍率未取。
