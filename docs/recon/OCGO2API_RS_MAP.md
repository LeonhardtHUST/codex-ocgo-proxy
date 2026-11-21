# ocgo2api-rs 地图（只读测绘）

参考实现：`d:\projects\github\ocgo2api-rs`（下称"参考仓"，路径写作 `src/xxx.rs:行`）。
目的：为本仓把请求路由搬到 Rust 时，判断哪些机制可照抄、哪些是本仓已有且更强、哪些是参考仓根本没做的。

一句话定位：参考仓是**逐请求凭据转发的单进程协议代理**（axum + reqwest），不是 Key 池调度器。它不做 Key 轮换、不做账号池、不判断模型免费与否；这些正是本仓 `src/auth/*`、`src/proxy/upstream-router.ts` 已经在做的事。

---

## 1. Cargo.toml / 构建形态

**结论**
- `name = "ocgo2api-rs"`，`edition = "2024"`，`rust-version = "1.85"`（`Cargo.toml:1-7`）。
- **没有 `[features]`、没有 `[lib]`、没有 `[[bin]]`**（整个文件 54 行，`Cargo.toml:1-54`）。因此是 Cargo 默认布局：`src/main.rs` 产出可执行文件 `ocgo2api-rs`，`src/lib.rs` 产出 `ocgo2api_rs` 库（`src/lib.rs:1-13` 共 12 个 pub 模块）。库之所以存在，是为了给 `tests/proxy.rs` 直接调用 `App`、`protocol`、`streaming`（`tests/proxy.rs:9-16`）。
- 依赖全是运行时服务端件：`axum 0.8`（`:12`）、`reqwest 0.12` 且 `default-features=false` + `rustls-tls/json/stream/gzip/brotli/deflate`（`:23`）、`tokio full`（`:28`）、`flate2/zstd`（`:17`/`:32`）、`hmac+sha2`（`:21`/`:26`）、`fs2` 文件锁（`:18`）。`tower` 只在 dev-dependencies（`:46-47`）。`windows-sys` 仅 Windows target 依赖（`:35-44`）。
- **不能当 cdylib / napi 复用**：没有任何 FFI 导出、没有 `napi`、`cdylib` cfg，入口是 `main()` 起 8 MiB 栈的 Tokio 运行时（`src/main.rs:8-21`），Windows 上还声明了 `windows_subsystem = "windows"`（`src/main.rs:1`，无控制台）。
- 它天然是**独立进程 sidecar**：自己 bind 端口（`src/server.rs:1296-1303`）、自带 `/health`+`/version`（`src/server.rs:671-676`）、自带进程管理（Task Scheduler / systemd，`src/service.rs:15-28`、`:167-188`、`:251-281`）、靠状态目录里的 `stop-request` 文件做 Windows 优雅停止（`src/server.rs:1322-1342`）。
- release 配置 `lto="thin"`、`debug=1`、`strip="none"`，为了崩溃可回溯（`Cargo.toml:49-54`）。

**借鉴**
- 本仓若要复用，只有两条路：**独立进程 sidecar + HTTP**（参考仓现成的形态，也是 `docs/OCGO_IMPLEMENTATION_PLAN.md:15` 已经写的「暂保留为同机协议后端」），或自己加 `[lib] crate-type=["cdylib"]` 走 napi。后者要重写入口与错误传播，参考仓没有可抄的先例。
- 抄它的 `lib.rs` 拆分方式（每个模块一个 pub 面，测试直接依赖 lib 而非跑二进制）比抄它的 `main.rs` 更有价值。

---

## 2. config.rs：配置全集与覆盖链

**结论**
- 顶层 `Config`（`src/config.rs:12-22`）：`version`、`server`、`upstream`、`identity`、`keys: Vec<Key>`、`models: Vec<catalog::Model>`、`state_dir`、`vision`、`monitor`。全结构 `deny_unknown_fields` + `serde(default)`（`:11`、`:25`、`:64`），拼错字段会直接报错而不是静默忽略。
- `[server]`（`:26-46`，默认值 `:47-62`）：`bind=127.0.0.1`、`port=8787`、`max_in_flight=1024`、`per_key_limit=None`、`timeout_sec=180`、`max_body_mb=20`、`max_response_mb=32`、`max_retries=2`、`retry_window_sec=180`、`keepalive_sec=15`。
- `[upstream]`（`:65-79`，默认 `:80-92`）：`go_base_url=https://opencode.ai/zen/go/v1`、`zen_base_url=https://opencode.ai/zen/v1`、`native_base_url=https://chatgpt.com/backend-api/codex/v1`、`api_key`（别名 `ocgokey`，`:71`）、`https_proxy`、`fallback_proxy`、`no_proxy`。
- `[identity]`（`:100-115`）：`user_agent`（默认由 `CARGO_PKG_VERSION` 拼，`:110`）、`session_mode ∈ {per_key, shared}`（`:93-99`，默认 per_key `:96-98`）、`shared_session_id`。
- `keys`（`:116-122`）：每项 `name` + `key_id`（**必须 64 位 SHA-256 hex**，`:398-401`）+ 可选 `session_id`；name/key_id 不允许重复（`:391-397`）。
- `[monitor]`（`:123-140`）：`enabled=false`、`interval_sec=60`、`output=metrics.csv`（相对 state_dir）。
- `[vision]`（`:141-156`）：`caption_model=opencode-go/mimo-v2.5`、`cache_entries=256`、`timeout_sec=30`。
- **环境变量覆盖在 `load()` 里手写枚举**（`:174-298`），不是 serde env：`OCGO2API_BIND`/`PORT`/`TIMEOUT_SEC`/`MAX_BODY_MB`/`MAX_IN_FLIGHT`/`MAX_RETRIES`/`RETRY_WINDOW_SEC`/`KEEPALIVE_SEC`（`:177`、`:231-257`）、三个 base url（`:180-200`）、`OCGO2API_API_KEY`（`:284-286`）、`OCGO2API_SESSION_MODE`/`SHARED_SESSION_ID`（`:258-267`）、`OCGO2API_HTTPS_PROXY`/`FALLBACK_PROXY`/`NO_PROXY`（`:272-280`）、`OCGO2API_STATE_DIR`（`:281-283`）、monitor 三项（`:287-296`）、caption model（`:205-212`）。每项都保留旧名（`OPENCODE_GO_PROXY_*`、`CHAT_COMPLETIONS_BASE_URL`）做兼容（`:176-213`）。
- 显式拒绝环境里的 `HTTPS_PROXY`：只认 `OCGO2API_HTTPS_PROXY`（`:268-274`），理由写在注释里——桌面代理客户端会 export 它，认了就等于「手动起一次进程 = 静默改道」。
- `validate()` 是硬闸门（`:299-414`）：`version==1`；**bind 必须回环**（`:309-312`，因为转发的是调用方凭据）；`max_in_flight ∈ 1..=65536`；`per_key_limit != 0`；`max_retries <= 10`；`retry_window_sec <= 900`；三个上游 URL 必须 http(s) 且**不带 userinfo/query/fragment**、http 只允许回环（`:335-360`）；代理 URL 可解析（`:361-366`）；`user_agent` 与 session header 必须是合法 header（`:380-390`）；`shared` 模式必须给 `shared_session_id`。
- 配置路径：Windows `%APPDATA%\ocgo2api-rs\config.toml`，其余 `$XDG_CONFIG_HOME`/`~/.config`（`:444-452`）。写盘是 `tempfile + sync_all + persist` 的原子替换，另有 `fs2` 进程锁（`:453-483`）。`config show` 把 `upstream.api_key` 输出成 `<redacted>`（`src/cli.rs:252`）。

**借鉴**
- `deny_unknown_fields` + 「校验在 load 之后、启动之前」这两条直接照抄：配置写错应该在启动时炸，不是第一个请求 500。
- 回环 bind 校验 + 上游 URL 禁 query/fragment 这条，与本仓「URL 由管理员配置且限定同机回环」是同一诉求（`docs/OCGO_IMPLEMENTATION_PLAN.md:15`），可直接做成启动断言。
- 别抄它的手写 env 枚举（60 行 if-let）。本仓用 zod/JSON schema 一套更省事；但**保留"命名空间 env 优先于全局 env"**这个判断（`:268-274`），这是很实际的运维教训。
- `state_dir`、`vision`、`monitor` 这三块对本仓 MVP 无用，抄了只会稀释配置面。

---

## 3. catalog.rs + data/：模型目录

**结论**
- 目录有**三层来源**：内置静态表（编译进二进制）→ 配置文件 `[[models]]` 覆盖 → 运行时发现文件。
  1. 内置表：`serde_json::from_str(include_str!("../data/models.json"))`（`src/catalog.rs:88-90`）。`data/models.json` 共 **108 条**：go 28（chat 16 / messages 8 / responses 4）、zen 80（chat 28 / gemini 6 / messages 18 / responses 28）；其中 16 条 `image:true`。
  2. `[[models]]` 合并：按 `(provider, id)` 先去重再 push，配置项整条替换内置项（`src/catalog.rs:91-94`）。
  3. 运行时发现：`state_dir/catalog/<sha256("provider|base|key_id")>.json`，按 key 隔离（`src/server.rs:273-284`），进 `App::models` 时按 60s TTL 缓存（`:35`、`:210-238`），每 key 一把异步锁防击穿（`:239-250`）。
- 字段只有 5 个（`src/catalog.rs:54-67`）：`id`、`provider ∈ {go, zen, native}`（`:6-12`）、`family ∈ {responses, chat, messages, gemini}`（`:29-36`）、`image: bool`（默认 false）、`context_window: u64`（默认 272000）。
- **没有的东西**（原任务假设它们存在，实测不存在）：没有 `free` / 定价字段、没有思考档位/推理强度字段、没有能力位图、没有 max_output_tokens、没有别名表。`src/catalog.rs` 全文 129 行，字段就是上面 5 个。
- `slug()`：native 用裸 id，其余 `provider/id`（`:80-86`）。`resolve()`：先认 `opencode-go/`、`zen/`、`native/` 前缀（`:97-106`），裸 id 按 **native → go → zen** 顺序命中（`:113-121`）。
- `render()` 给 `GET /models` 用：同时输出 `data` 和 `models` 两个键（兼容两种客户端），每条含 `id/slug/object/owned_by/display_name/context_window/input_modalities`（`:122-129`）。
- 发现时 family 是**猜**出来的：zen 按 id 前缀 `gemini-`→Gemini、`claude-`/`qwen`→Messages、`gpt-`/`grok-`→Responses、其余→Chat（`src/server.rs:440-450`）；go 的未知模型直接丢弃，必须在配置里显式认证协议（`:451`）。发现结果写回状态目录并清该 key 缓存（`:467-472`）。

**借鉴**
- Provider × Family 二维建模值得照抄：**provider 决定 base_url，family 决定 endpoint 路径与报文形状**，两个维度正交，本仓 adapter 层缺的正是这个显式二维表（`src/catalog.rs:20-27` + `:37-52`）。
- 前缀式 slug（`opencode-go/x`）与本仓计划的 `ocgo:<model-id>` 是同一思路，映射是一行字符串替换；裸 id 的解析优先级（native 先）必须显式固定并加回归，否则会静默改路。
- **不要抄 family 的 id 前缀猜测**（`src/server.rs:440-450`）。本仓已经有 `src/models/model-store.ts` 与官方目录，能力应由模型目录下发，而不是 Rust 端按名字猜；猜错的结果是「模型能选到但请求 400」。

---

## 4. protocol.rs：入站协议与转换

**结论**
- **入站只有 3 个生成入口**（`src/server.rs:735-746`）：`/responses` 与 `/responses/compact` → `Family::Responses`；`/chat/completions` → `Family::Chat`；`/messages` → `Family::Messages`。**没有 Gemini 入站**（Gemini 只是出站 family）。
- 转换方向固定：**Responses 是唯一的"万能入站"**，其余两个是直通。
  - `family == Responses`：原样透传，`build_owned` 直接返回入参（`src/protocol.rs:225-228`），`translate` 直接返回上游 JSON（`:431-434`）。这就是"零拷贝 passthrough"。
  - 其他 family：先 `to_chat()` 统一降到 Chat 中间表示（`:87-173`），再由 `chat_to_messages`（`:238-316`）或 `chat_to_gemini`（`:317-396`）落到目标协议。
- **family=chat 与 family=responses 的区别**（这是最容易搞混的一点）：
  - `chat` 的 endpoint 是 `chat/completions`，`responses` 是 `responses`，`messages` 是 `messages`，`gemini` 是 `models/{model}:streamGenerateContent?alt=sse` / `:generateContent`（`src/catalog.rs:37-52`）。
  - 语义上：`responses` 是**不转换**（报文形状一致才成立）；`chat` 是**必须转换**（Requests 入 → Chat 出 → 再转回 Responses 出）。
  - 直通面有协议守卫：`surface != Responses && surface != model.family` 直接 400 `incompatible_protocol`（`src/server.rs:807-813`）。即「拿去 `/chat/completions` 的模型必须是 chat family」。
- 请求侧细节：`previous_response_id` 非空直接报错，理由是要 Responses 上游才支持（`:88-91`）；`instructions` → system（`:93-95`）；`developer` role → `system`（`:103`）；`max_output_tokens` → `max_tokens`（`:153-155`）；流式自动补 `stream_options.include_usage`（`:169-171`）；`namespace` 工具被拍平成 `ns__name`（`:128-135`、`:80-86`）；工具名 >64 字符时替换成 `tool_<sha256 前48>`（`:182-189`）；`custom` / `web_search*` 工具转成带固定 schema 的 function（`:191-208`）。
- 响应侧：`usage()` 归一三家的 token 字段并抽 cached/reasoning（`:410-426`）；`translate()` 把 Chat/Messages/Gemini 结果拼成 Responses 对象，并按 `finish_reason=length` / `stop_reason=max_tokens` / `finishReason=MAX_TOKENS` 置 `status=incomplete`（`:495-501`）；`has_output()` 判断"有没有真内容"（`:516-525`）。
- 上下文压缩：`compaction`/`context_compaction` 项的 `encrypted_content` 用自有前缀 `kcr1:` + base64 存明文（`:110-115` 读、`src/server.rs:996-1002` 写）。

**借鉴**
- 「Responses 通用入站 + 其他直通」是本仓最该保留的形状：它把 N×M 的协议矩阵压成 1×M。
- `incompatible_protocol` 这个 400 必须抄：本仓现在最容易出的事故就是「模型选到了但协议不匹配」被当成上游 500。
- 转换函数应当**纯函数 + 无 I/O**（参考仓做到了：`protocol.rs` 全部是 `Value -> Value`），这是本仓把这坨逻辑从 TS 搬到 Rust 后唯一还能写快照测试的前提。
- `kcr1:` 这种自有历史封装**不要**抄：它是为了跨对话塞回上下文，与本仓 compact 语义没有关系，且把明文 token 写进了响应体。

---

## 5. server.rs：路由表、鉴权、转发、重试、SSE

文件 1508 行，是本仓要拆的主要参照物。

**5.1 路由表**
- 没有 axum 的显式 `.route()` 表：`Router::new().fallback(handle)`，所有路径进一个 `dispatch()`（`src/server.rs:647-649`）。`/v1` 前缀被剥掉后再匹配（`:665-670`），因此 `/v1/x` 与 `/x` 等价。
- 全部 endpoint：

| 方法 | 路径 | 行为 | 证据 |
|---|---|---|---|
| GET | `/health`、`/version` | 免鉴权，返回 `{status,version,implementation:"rust"}` | `:671-676` |
| GET | `/models` | 内置表+配置+本 key 发现目录，经 `catalog::render` | `:699-701` |
| GET | `/usage`、`/state`、`/metrics` | flush 计量后返回本 key 汇总 + `active` | `:702-705` |
| GET | `/quota` | 转 Go 上游 `/usage`，缓存 60s | `:706`、`:474-509` |
| GET | `/cache` | 本 key 缓存条数 | `:707-713` |
| POST | `/refresh-runtime` | 用本次 Bearer 刷 Go 目录 | `:728-734` |
| POST | `/responses`、`/responses/compact` | Responses 面 | `:736` |
| POST | `/chat/completions` | Chat 直通 | `:737` |
| POST | `/messages` | Messages 直通 | `:738` |
| — | 其他 | 404 `not_found`；GET 之外的动词 405 | `:714-719`、`:721-727` |

- 有 `Upgrade` 头直接 417 `unsupported_protocol`（`:690-696`）——明确不做 WebSocket。

**5.2 鉴权**
- `RequestContext::from_headers`（`src/auth.rs:29-67`）：若配置了 `upstream.api_key`，**调用方凭据完全被忽略**（缺失/非法/重复都不影响，`:34-39`）；否则取 `Authorization`，缺失 401、**重复 400**（`:41-45`）。Bearer 解析要求 `Bearer` scheme + 字符集白名单（`src/auth.rs:68-74`、`src/config.rs:435-440`）。
- `key_id = sha256(token)`（`src/auth.rs:149-151`），日志/计量只用它，绝不出 token。
- 会话头 `x-opencode-session`：`shared` 模式用配置值；`per_key` 模式优先用 `keys[].session_id`，否则 **HMAC(持久化 seed, token)**，于是同一 key 跨重启稳定、不同 key 不同（`src/auth.rs:78-105`，seed 落盘 `:160-178`）。

**5.3 三上游判定**
- 判定只看 `model.provider`，不猜 URL：`Provider::Go/Zen/Native` 分别取 `go_base_url` / `zen_base_url` / `native_base_url`（`src/catalog.rs:21-27`）。
- endpoint 再由 `model.family` 决定（`src/catalog.rs:37-52`），URL 拼法 `{base}/{endpoint}`（`src/server.rs:333-339`）。唯一特例：native + compact 用 `responses/compact`（`:882-886`）。
- `native` 额外带一组转发头（`src/server.rs:1447-1449` + `src/auth.rs:24`），其余上游不带。

**5.4 header 处理**

| 类别 | 内容 | 证据 |
|---|---|---|
| 自造（所有上游） | `authorization`（调用方或固定 key）、`user-agent`（配置值，不是客户端值）、`x-opencode-session`、`content-type: application/json`、`accept: text/event-stream`/`application/json` | `src/auth.rs:121-135` |
| 按 family 补 | `messages` 补 `x-api-key`（同 token）+ `anthropic-version: 2023-06-01`；`gemini` 补 `x-goog-api-key` | `src/auth.rs:136-145` |
| 透传给 native | 白名单：`user-agent`、`content-type`、`accept`、`openai-beta`、`chatgpt-account-id`、`originator`、`session_id`，以及所有 `x-*` **除了** `x-opencode-go-*`、`x-api-key`、`x-goog-api-key` | `src/auth.rs:49-65` |
| 响应回传 | hop-by-hop 全丢（`connection/keep-alive/proxy-*/te/trailer/transfer-encoding/upgrade/content-length/content-encoding/content-type` + `Connection` 里点名的），且不覆盖本地已设的头 | `src/server.rs:1192-1219` |
| 错误响应特殊放行 | 只保留 `retry-after`、`x-ratelimit-{limit,remaining,reset}-requests` | `src/server.rs:1180-1189` |
| 流式响应自造 | `content-type: text/event-stream`、`cache-control: no-cache`、`x-accel-buffering: no` | `src/server.rs:1138-1146` |

- **缓存相关的只有 `x-opencode-session`**：它就是提示词缓存亲和键，代码里没有任何 `cache_control`/`cache_creation` 之类的 Anthropic 缓存头处理。

**5.5 429 / 退避 / 重试 / key 轮换**
- 有两条**完全独立**的重试路径：
  1. **响应级**（上游给了响应但状态不好）：`429` 或 `5xx` 且 `retries < max_retries` 时重试；延迟取 `retry-after`（秒），没有就用 `1 << retries`，上限 30s（`src/server.rs:362-377`）。退避表按 `provider|base_url|key_id` 的 scope 记一个"最早可再试时间"，**同 key 的其他请求也会一起等**（`:192-199`、`:341-348`）。429/5xx 不消耗时间预算，只消耗 `max_retries`。
  2. **连接级**（报文没到）：按**时间预算** `retry_window_sec` 重试，不按次数；`should_retry = attempts < 256 && elapsed < window`（`:1416-1422`），退避 250ms 起指数到 4s + 0–250ms 抖动（`:1427-1431`）。这条路径最终失败返回 **504 `upstream_unreachable`**（`:388-390`）。
- 配了 `fallback_proxy` 时，直连"连不上"的那一次立刻改用备用客户端再试一遍，并记 `upstream.fallback` 诊断（`:353-359`）。
- **没有 key 轮换**：全文 grep `rotate|rotation|pool|next_key|key_pool` 只命中 `diagnostics.rs:198`（日志轮转）。每个请求用调用方给的那一个 Bearer，或配置里的唯一固定 key。多 key 在这个仓里只是"多个调用方各带各的 token"，配额、退避、目录缓存按 `key_id` 隔离而已（`src/server.rs:192-199`、`src/meter.rs:181-188`）。
- 空补全也算失败重试：非流式检测到没有内容时，在 `max_retries` 内重发，超限返回 502 `empty_completion`（`src/server.rs:966-988`）。
- 图片兜底：Responses 面 + 带图 + 上游 400/404/415/422 且非 native 时，先做 caption 替换再重发一次（`:900-914`）。

**5.6 SSE 转发与错误**
- 流式走 `stream_response`（`:1035-1150`），核心是 `committed` 标志：
  - 直通面（surface 或 family 是 Responses）：上游字节**原样转发**，但先缓冲进 `pending`（上限 2 MiB），直到 `converter.seen_output` 为真才 flush（`:1089-1096`）。这就是"提交前可重放、提交后绝不拼接"。
  - 非直通面：把上游事件逐条转成 Responses 事件再发（`:1097-1099`）。
  - 每秒 `keepalive_sec` 发一行 `: keepalive`（`:1068-1074`）。
  - 只有 `!committed` 且时间预算/总 deadline 都允许时才重连（`:1112-1121`）。
- 终止错误的分类（`stream_failure`，`:1379-1412`）：
  - 自己 deadline 到 → **504 `request_timeout`**，文案明说"是代理等的，不是上游坏了"（`:1384-1392`）。
  - 一个字节都没发出去 → **504 `upstream_unreachable`**，理由：告诉 agent "后端坏了"它会终止会话，而实际是链路（`:1393-1403`）。
  - 已发过内容但没收全 → **502 `upstream_error`**（`:1404-1410`）。
- 错误尾巴按协议落地：Chat 发 `data: {"error":{...}}`、Messages 发 `event: error`、Responses 发 `response.failed`（`:1129-1133`）。
- 非流式的上游错误统一在 `upstream_error` 处理：**5xx 一律改写成 502**，4xx 原样（`:1167-1173`），并带上 5.4 里那组限流头。

**5.7 /models 实现**
- 有，且是"三层合并 + 按 key 的发现缓存"：`catalog::render(&app.models(&context).await)`（`:699-701`）；`models()` 命中 60s 缓存，未命中则进 gate 后重建（`:210-228`）；发现文件不存在就只用内置表+配置（`:251-271`）。

**借鉴**
- 直接照抄的：**双重重试语义分离**（响应级按次数、连接级按时间）、**scope 级退避表**、**`committed` 提交语义**、**三态错误分类**、**5xx→502 / 4xx 原样**、**hop-by-hop 过滤**。这几条每一行都对应本仓现在 `src/proxy/error-classification.ts`、`src/routes/shared/proxy-retry-classifier.ts` 已经在补的坑。
- 必须改的：`fallback_proxy` 这种"第二个 client"是单机思维，本仓有多上游池，应做成候选切换而不是本机代理切换。
- 明确不适用：`upstream.api_key` 固定覆盖（`:284-286`、`src/auth.rs:34-39`）在多 key 模式下会**吃掉调用方的 key**，与本仓池化直接冲突——`docs/OCGO_IMPLEMENTATION_PLAN.md:15` 已明令多 Key 模式不得启用。

---

## 6. zen-free：参考仓没有这个机制

**结论（与任务假设相反，需修正上位计划）**
- 代码里**没有** zen 付费/免费的区分。全仓 grep `free` 只命中 `dns.rs:9`（"lookup is free"）与 `service.rs:30`（"dependency free"）两处注释，零业务命中。
- "免费"只体现为**数据里的 id 后缀**：`data/models.json` 有 10 条 zen 免费模型——`big-pickle`、`beam-free`、`flint-40b-free`、`mimo-v2.6-flash-free`、`nemotron-3.5-super-vl-free`、`nemotron-3.5-lightning-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`pulse-alpha-free`、`crouton-alpha-free`；**全部 `family=chat`、`image=false`、`context_window=272000`**。其中 `big-pickle` 连 `-free` 后缀都没有，说明命名本身也不是可靠判据。
- 因此也没有"免费池轮换"和"按模型的成功/失败判定"。最接近的东西只有两个，都不够用：
  - 免费与非免费共享同一 `Provider::Zen` base（`src/catalog.rs:16-19`、`src/config.rs:84`），路由上完全无差别；
  - 计量按 `provider|upstream|key_id` 折叠（`src/meter.rs:181-188`），**不按 model**，所以事后也算不出"某免费模型成功率"。

**借鉴**
- 免费/付费分组、免费池轮换、逐模型健康度，**本仓必须自建**，参考仓给不了实现，只能给"别把免费当特殊 provider"这个反面结论：免费模型是 zen 同一个上游、同一把 key、同一套额度，分组依据应该是本仓自己的 `quotaGroup`/策略表，不是 provider 字段。
- 建议把 `is_free` 作为模型目录的显式字段从本仓下发，而不是靠 id 匹配 `-free`（`big-pickle` 就是反例）。

---

## 7. auth / meter / monitor / streaming / service 的职责边界

**结论**

| 模块 | 职责 | 关键证据 |
|---|---|---|
| `auth.rs` | 逐请求凭据 → `RequestContext`（token、key_id、session_id、UA、deadline、取消令牌）；固定 key 覆盖；HMAC 会话 id；seed 持久化。**不做选择、不做轮换** | `src/auth.rs:14-26`、`:29-67`、`:78-105`、`:121-147`、`:160-178` |
| `meter.rs` | 用量记账：每请求一个 `Turn`（默认记为 499 未完成），`finish(status, usage)` 落 `usage-events.jsonl`，`Drop` 时补 `durationMs` 并写盘；单 `spawn_blocking` writer + 8192 通道；启动时回放历史 jsonl 折叠汇总；诊断事件写 `proxy.err.log`（5 MB 轮转） | `src/meter.rs:33-101`、`:102-120`、`:141-165`、`:167-174`、`:181-188` |
| `monitor.rs` | 可选性能采样：`serve` 另起一个子进程，按间隔写 CSV（`at,uptime_s,rss_mb,private_mb,cpu_total_s,cpu_pct,threads,handles,requests,failures,rps,active`），Windows 走 `GetProcessMemoryInfo`、Linux 读 `/proc/<pid>`；主进程退出子进程自停 | `src/monitor.rs:24`、`:30-88`、`:97`、`:241`、`:324` |
| `streaming.rs` | 两块：`Decoder` 是**字节级** SSE 解析（按 `\n` 切、`data:` 拼接、`[DONE]` 置位、UTF-8 跨包安全、2 MiB 缓冲上限）；`Converter` 把 Chat/Messages/Gemini 增量转成带 `sequence_number` 严格递增的 Responses 事件流，`complete()` 要求 `terminal && seen_output` 否则报"上游没有完整输出" | `src/streaming.rs:11-55`、`:63-109`、`:378-382`、`:111` |
| `service.rs` | 进程管理：Windows 走 `scripts/service.ps1`（Task Scheduler），Linux 写 systemd user unit；健康探测是**裸 socket** 的 `GET /health` 且必须含 `"rust"` 字样 | `src/service.rs:15-28`、`:31-53`、`:167-188`、`:251-281` |

**借鉴**
- `streaming.rs` 的 `Decoder`/`Converter` 分离是最值得整段搬的部分：字节层与协议层分开，UTF-8 跨包与 `[DONE]` 这类坑已经被测试钉住（见 §8）。`Converter::complete()` 的 `terminal && seen_output` 双条件是"截断流必须报错"的最小实现。
- `meter.rs` 的「先记 499 再 finish + `Drop` 兜底」很实用：任何提前返回都不会漏账。本仓若要 per-key per-model 记账，照这个骨架加 model 维度即可，成本很低。
- `monitor.rs` 与 `service.rs` **不要抄**：本仓的观测在 App 侧（`src/logs/metrics.ts`、`src/routes/admin/health.ts`），进程管理应由部署层负责。抄它等于把两份运维面同时维护。

---

## 8. tests/proxy.rs：已有契约覆盖

991 行，一个 mock 上游 + 一个 `Fixture`，全部是**端到端黑盒**（起真 axum server，真 reqwest 客户端）。这是本仓 Rust 路由最值得复用的资产。

**夹具**
- mock 上游按请求体关键字切行为：`redirect-test`→307 带 `location`、`fail-429`→429+`retry-after:0`、`empty-once`/`always-empty`→空补全、`tool-test`→工具调用、`hold-test`→卡住等 barrier、`truncate-test`→只发一半就断、`Describe this image precisely`→caption（`tests/proxy.rs:30-159`）。SSE 每帧按 17 字节切块，专门打 UTF-8 与分片边界（`:147-153`）。
- `Fixture::new` 起两个真服务（mock 上游 + 被测路由），配置把三个 base_url 都指向 mock，默认 `max_retries=0`（`:176-228`）。
- `events()` 把 SSE 正文解析成 `Vec<Value>`（`:245-255`）。

**测试与断言要点**

| 测试 | 覆盖行为 | 证据 |
|---|---|---|
| `identities_survive_restart_and_shared_overrides` | 不同 token → 不同 session；**重启后（重新 load seed）同 token 同 session**；`keys.session_id` 覆盖；`shared` 模式两 token 相等 | `:258-296` |
| `configured_key_overrides_every_caller_credential` | 配了固定 key 后：无凭据也 200、借来的 token 被覆盖、上游只见固定 key、记账 key_id 也是固定 key | `:298-346` |
| `config_failed_write_preserves_file` | 校验失败的 save 不碰原文件 | `:348-357` |
| `compression_is_bounded` | gzip 解压超限 → 413；zstd 正常解 | `:359-373` |
| `config_io_failure_preserves_existing_bytes`（仅 Windows） | 只读文件下 save 失败且字节不变 | `:374-392` |
| `fragmented_multiline_sse_and_tool_order` | 逐字节喂 SSE（含多行 `data:` 拼接）能拼出正确 JSON；`sequence_number` 从 0 严格递增；工具参数在 `complete()` 后落在 output[1] | `:394-416` |
| `auth_and_route_guards` | 无凭据 401；`Bearer ` / `Basic token` / `Bearer a,b` / `Bearer a b` 全 401；两个 Authorization 头 400；未知模型 400；`/messages` 打非 messages 模型 400；**且这些请求一个都没打到上游** | `:418-471` |
| `all_families_stream_and_nonstream` | 5 个模型 × {流式,非流式} 全 200；流式必有 `response.completed`；非流式文本与 usage 正确；上游头校验：`authorization` 原样、`user-agent` 是配置值不是客户端值、`x-opencode-session` 存在、messages 补 `x-api-key`+`anthropic-version`、gemini 补 `x-goog-api-key` | `:473-518` |
| `multi_key_cross_concurrency_and_accounting` | 40 并发 × 4 key × 2 模型，`shared` 模式下 session 头恒定；**每 key 记账 10 次**；`x-api-key` 必须等于 `authorization` 里的 token | `:520-572` |
| `namespaced_tools_and_compaction` | namespace 工具拍平后回填 `namespace`+`name`+`arguments`；`/responses/compact` 与 `compaction_trigger` 两条路都产出 `kcr1:` 与对应 item 类型 | `:574-603` |
| `caption_auxiliary_calls_are_scoped_and_coalesced` | 同一 key 4 并发同一张图 → 只打 **1 次** caption（按图片哈希合并）；两个 key 各 1 次且凭据不同；alpha 的记账是 5 次（4 生成 + 1 caption） | `:605-627` |
| `empty_retry_truncation_redirect_and_limits` | 空补全一次后重试成功（流式与非流式）；中途截断 → `response.failed` 且**没有** `response.completed`；上游 307 原样透给客户端（不跟随重定向）；`per_key_limit=1` 时同 key 第二个请求 503、另一 key 仍 200、客户端断开后许可释放 | `:629-700` |
| `authenticated_catalog_and_legacy_meter` | 发现目录按 key 隔离（a 刷到的 b 看不到）；Go 的未知模型被丢弃；`quota` 透传；历史 jsonl 坏行不影响折叠、缺 key_id 归 `legacy` | `:702-753` |
| `remote_close_and_partial_body_retry_before_commit` | 对端直接断开 / 响应体截断两种故障下，**提交前**重试成功；两次请求头完全一致；事件里 `retries=1`、`status=200`；`proxy.err.log` 有 `upstream.network_error` 且**不含 token**（脱敏断言） | `:756-838` |
| `tls_eof_is_bounded_and_reports_the_path_not_the_backend` | TLS 建连即断：返回 **504 `upstream_unreachable`**（不是 502）；重试次数由 `retry_window_sec` 决定（3..=6 次）；总耗时 < 15s；`/health` 仍 200；诊断条数等于尝试次数；日志不含 token | `:841-904` |
| `thousand_streams`（`#[ignore]`） | 1000 路并发流 + 期间 `/health` 200 且 < 2s；每 key 的 session 头可复算；记账总数等于发起数 | `:906-991` |

**未覆盖（写本仓验收时别误以为有先例）**
- mock 里定义了 `fail-429`（`tests/proxy.rs:62-69`）和 `always-empty`（`:70`），但**没有任何测试驱动它们**。也就是：429 + `retry-after` 的重试路径只有 `should_retry`/`retry_delay` 两个纯函数单测（`src/server.rs:1479-1498`）间接覆盖，"重试耗尽 → 502 `empty_completion`"则完全没有端到端覆盖。
- 没有 `per_key_limit` 与 `max_in_flight` 的竞争压测（只有一个 503 断言）。
- 没有 compact 与 native 上游的组合测试。

**借鉴**
- 这套夹具几乎可以整段移植：真 server + 关键字驱动的 mock + `events()` 解析 + "断言上游根本没被调用"这条（`:470`）。本仓现在的关键回归（供应商隔离、凭据只发选定 key、429 信号、提交后不换 key）都能用同一形状写。
- 移植时**先补 429 端到端**，这是参考仓自己的空白，也是本仓 `docs/OCGO_IMPLEMENTATION_PLAN.md:23` 明确要求的语义。

---

## 9. README：上游能力矩阵与"必须用什么接口"

**结论（能力矩阵，`README.md:100-111`）**

| 入站路径 | 行为 | 支持的出站 family |
|---|---|---|
| `/responses`、`/v1/responses` | 按模型转换 | responses（透传）/ chat / messages / gemini |
| `/chat/completions`、`/v1/chat/completions` | **只**对 chat family 直通 | chat |
| `/messages`、`/v1/messages` | **只**对 messages family 直通 | messages |
| `/responses/compact`、`/v1/responses/compact` | 上下文摘要 + `kcr1:` 历史封装 | 非 native 走 Chat 摘要；native 打 `responses/compact` |
| `/models` | 种子 + 配置 + 本 key 发现 | — |
| `/usage`、`/state`、`/metrics`、`/cache`、`/quota`、`/refresh-runtime` | 运维 | — |
| `/health`、`/version` | 免鉴权 | — |

- 由目录数据（§3）可以读出每个上游实际支持什么：**go 只有 chat/messages/responses，没有 gemini**；**zen 四类都有**（含 6 个 gemini）；**native 只有 responses**（`src/server.rs:439` 固定 `Provider::Native → Family::Responses`）。
- "必须使用什么接口"的三条硬结论：
  1. **Responses 是唯一通用入口**。要跨 go/zen/native 统一调用，客户端必须打 `/responses`；打 `/chat/completions` 只能命中 chat 模型（`README.md:102-104` + `src/server.rs:807-813`）。
  2. **tools / 图片 / 思考只在 Responses 面被完整支持**：流式工具参数增量、命名空间函数、custom 工具、图片 caption 与图片兜底、`compaction_trigger` 都写在 Responses 路径上（`README.md:124`、`src/server.rs:850-914`）。图片能力还要模型侧 `image:true` 才成立（`src/catalog.rs:60-61`）。
  3. **凭据随每笔请求转发**，除非配置了固定 key；`messages` 额外补 `x-api-key`、`gemini` 补 `x-goog-api-key`（`README.md:113-115`、`src/auth.rs:136-145`）。
- 其它被 README 钉死的约束：只监听回环（`README.md:96`、`:205`，容器里 `-p 8787:8787` 会被拒）；只认 `OCGO2API_HTTPS_PROXY`（`:86`）；连接级重试按时间预算、`max_retries` 只管 429/5xx（`:88`）；回环或 HTTPS 上游（`:96`）。

**借鉴**
- 这张表本身就该成为本仓 Rust 路由的**对外合同**：本仓 adapter 只需要实现「Responses 入站 → 选定 provider 的 family 出站」一条主干，其余两条直通面可以按需推迟。
- 「go 无 gemini、native 只有 responses」是硬事实，应当进本仓的模型目录，而不是靠 400 兜底。

---

## 10. 移植清单

**应保留**
1. Provider × Family 二维目录 + `provider/id` slug 前缀；provider 定 base_url、family 定 endpoint，两个维度正交。
2. Responses 作唯一通用入站口、其余直通；family=Responses 走零拷贝 passthrough，family=chat 必须转换。
3. 双重重试语义分离：响应级 429/5xx 按 `max_retries` 次数 + 读 `retry-after`，连接级按 `retry_window_sec` 时间预算；退避按 `provider|base|key` scope 记账。
4. 三态错误分类（504 `request_timeout` / 504 `upstream_unreachable` / 502 `upstream_error`）+ 上游 5xx 一律改写 502、4xx 原样透传 + 限定限流头回传。
5. SSE 的字节级 `Decoder` 与协议级 `Converter` 分离；`sequence_number` 严格递增；`terminal && seen_output` 双条件才算完整。
6. 提交语义：缓冲到 `committed` 之前可重放，之后只发协议内错误终止事件，绝不拼接两条响应。
7. 凭据卫生：`key_id=sha256(token)`、日志脱敏、错误响应不含 token、per-key HMAC 会话 id 跨重启稳定。

**应重构**
8. 把 1508 行单文件 `dispatch()` 拆成「路由表 + surface handler + 纯转换函数」三层；转换函数保持无 I/O，才写得进快照测试。
9. 丢掉「按 id 前缀猜 family」（`src/server.rs:440-450`）；本仓由模型目录显式下发 family/能力，Rust 端只做校验与拒绝。
10. 丢弃单机思维的单 key 语义：Rust 只接受 App 选定的 Bearer（禁用 `upstream.api_key`），池选择、轮换、额度组留在 App；Rust 只负责把 key 级信号（429/额度/无效）如实、可判别地回传。

**应放弃**
11. `upstream.api_key` 固定覆盖模式、`fallback_proxy` 第二客户端、`kcr1:` 自有历史封装、Gemini 出站、vision caption 兜底——均超出 MVP，且前两项与池化冲突。
12. `service.rs` / `monitor.rs` / `cli.rs` / `dns.rs` / `diagnostics.rs` 那一整套运维面（进程托管、CSV 采样、CLI 子命令、自建 DNS 缓存、panic 诊断）：本仓的观测与进程管理都在 App 与部署层，抄过来是双份维护。
