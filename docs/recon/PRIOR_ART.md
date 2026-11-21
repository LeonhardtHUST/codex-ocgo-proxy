# PRIOR ART · OpenCode Go / Zen 代理与模型路由的既有实现

> 对应需求 req 13：确认 GitHub 上是否已有对应实现，可借鉴者记入 `CREDITS`，避免重复造轮子。
>
> **取证方式**：`web_search` 因 HTTP 402 不可用，本轮只用两条通道——`https://api.github.com/search/repositories`
> 与 `https://raw.githubusercontent.com/<owner>/<repo>/{main,master}/README.md`（另加少量 `raw` 文档）。所有结论来自
> README/官方文档原文，**未做源码级阅读**；凡是 README 没写的 header 名与字段名，本文标注为未验证。
>
> **取样时间**：2026-11-21。Star 数为当时值，会变。
>
> **本仓许可前提**：`LICENCE`（`D:\Projects\GitHub\codex-ocgo-proxy\LICENCE`）是自写的「非商业许可 v1.0」，不是 OSI 许可。
> 因此凡 GPL-3.0 / AGPL-3.0 项目，**代码一律不可并入**（GPL 第 7 条禁止附加限制，与本仓的非商业限制直接冲突；
> AGPL 另有网络服务条款）；MIT / Apache-2.0 项目的代码在保留版权与许可声明的前提下技术上可并入，但会把第三方许可叠加到
> 本仓之上，故本文件对**所有**项目一律只建议「借鉴思路与协议事实」，不复制代码。

---

## A. 项目清单

表中「对应点」只写与本仓 OCGo/Zen 需求直接相关的部分。许可证取自 GitHub API `license.spdx_id`；README 与 API 冲突时以 README 为准并注明。

| 仓库 | 语言/Star | License | 与本次需求的对应点 | 借鉴方式 |
|---|---|---|---|---|
| [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api) | Go · 1489 | GPL-3.0 | Zen / Zen Go / 匿名三路上游 + OAuth；`/v1/{models,chat/completions,responses,messages,systemone}`；模型目录聚合；key 池与轮换别名；会话亲和 | 仅思路（GPL） |
| [routatic/proxy](https://github.com/routatic/proxy) | Go · 981 | AGPL-3.0 | Anthropic-in → OpenAI/Responses/Gemini-out 的多上游路由；fallback 链；熔断；按场景选模型 | 仅思路（AGPL） |
| [6Kmfi6HP/opencode2api](https://github.com/6Kmfi6HP/opencode2api) | Go · 164 | 无许可（README：All rights reserved） | 按 key 前缀分档（`public`/`sk-`/`zen:`/`go:`）；**prompt cache 相关配置最完整**；models.dev 目录缓存 | 仅思路（无许可=不可用代码） |
| [12errh/zen-proxy](https://github.com/12errh/zen-proxy) | JS · 143 | MIT | 免 key 免费模型聚合；`models.json` 由 Action 每 6h 刷新；每调用方会话身份；有序 fallback 列表；Responses/Chat 双向翻译 | 可借鉴代码，建议仅思路 |
| [foxy1402/cline-proxy](https://github.com/foxy1402/cline-proxy) | Go · 9 | 无许可（API：NOASSERTION） | **Combos（别名模型组合）**；三方言入站 → chat-completions 出站；本地铸造 zen 会话 ID；每 key 固定出口；429 冷却与换 key 预算 | 仅思路 |
| [nennneko5787/opencode-zen-server](https://github.com/nennneko5787/opencode-zen-server) | Python · 2 | MIT | **模型目录零硬编码**：Zen `/v1/models` ∩ models.dev；`/v1/models` 字段别名兼容矩阵；路由自愈 | 可借鉴代码，建议仅思路 |
| [developingchet/zengate](https://github.com/developingchet/zengate) | JS · 11 | MIT | 不伪造客户端指纹，改为**驱动真实 `opencode serve`**，每请求一个短生命周期会话；Responses 存储与端点清单 | 仅思路（路线与本仓相斥） |
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | TS · 411 | MIT | 活目录 ∩ 免费元数据 + 离线缓存回退（~7 天 TTL）；宿主插件形态 | 仅思路 |
| [gumieri/nenya](https://github.com/gumieri/nenya) | Go · 38 | Apache-2.0 | 多上游 fallback 链 + 熔断 + **sticky 会话以保前缀缓存命中**；响应缓存；实时目录发现 | 可借鉴代码，建议仅思路 |
| [Michaelunkai/OpencodeGoProxy](https://github.com/Michaelunkai/OpencodeGoProxy) | C# · 0 | MIT | **加权评分选 key**（按配额窗口归一化，打满即停用）；Go 失败即时转 Zen；每次尝试换新会话；分档超时预算 | 仅思路 |
| [bigdata2211it-web/opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy) | JS · 132 | 无许可（API：NOASSERTION） | 免费额度（DeepSeek/MiniMax/Qwen）代理，OpenAI+Anthropic 兼容 | 仅思路 |
| [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy) | TS · 52 | MIT | Cloudflare Worker 形态，路由 Claude Desktop 到 Zen/Go | **README 未获取**（本轮未抓） |
| [LIMTCYT/opencode-go-proxy-for-trae](https://github.com/LIMTCYT/opencode-go-proxy-for-trae) | Python · 32 | MIT | `x-opencode-session` 报头补齐 + 模型名别名重写 | **README 未获取**（本轮未抓） |
| [dhaalves/opencode-swap](https://github.com/dhaalves/opencode-swap) | JS · 8 | MIT | opencode-go 多账号轮询 + 429 故障转移 | **README 未获取**（本轮未抓） |
| [humanfia/humanize](https://github.com/humanfia/humanize) | Python · — | Apache-2.0 | 用户指定的「图式配置编辑器」参考：声明式 flow + 运行期绑定 + schema 驱动的参数表单 | 可借鉴代码，建议仅思路 |

> 搜索面覆盖（均 `sort=stars`）：`opencode zen proxy` 共 116 项（取 30）、`opencode go api proxy` 37 项（30）、
> `opencode models api zen` 43 项（30）、`model fallback graph llm router` **仅 3 项**、`llm router fallback chain visual editor`
> **0 项**。最后两条说明：「模型回退图 + 可视化编辑器」在 GitHub 上没有现成可抄的对应物，见 §B.req12 与 §C。

---

## B. 按需求逐条对照

> **编号说明**：本仓 `docs/` 内没有 req 编号清单，以下主题编号沿用派单简报的排列（req 1/2/7/8/9/10/11/12）。
> 若主控的编号清单不同，按主题对齐即可，结论不变。

### req 1 / req 2 · 如何组织 go / zen / zen-free 三逻辑上游

| 项目 | 做法 |
|---|---|
| jasonxu114514 | 三路显式并列：`upstream.zen = https://opencode.ai/zen`（手填 Zen key）、`upstream.go = https://opencode.ai/zen/go`（手填 Go key，带 `/v1/usage` 配额端点）、`upstream.anonymous = https://opencode.ai/inference`（`anonymous: true` 才启用，对应免费/匿名通道）；另有 `zen_oauth` / `go_oauth` 两条 OAuth 通道与手填 key **互斥**——OAuth 已连时手填 key 不再是回退路径。选路靠 `prefer: go\|zen`。 |
| 6Kmfi6HP | 按 **key 前缀**分档：`public` → 免费档；`sk-` → 默认 Zen，模型只存在于 Go 目录时自动切 Go；`zen:<key>` → 强制 Zen 计量档；`go:<key>` → 优先 Go 订阅档；非法/占位 key 回落 public。 |
| 12errh / nennneko | 只做 zen 单路（含免费子集），不建模 go；nennneko 的免费集合是 **`cost.input == 0`** 的目录查询结果，不是另一条上游。 |
| foxy1402 | 单入口按 `model` 判路：免费 zen 模型名 → zen；付费 zen 模型 → 显式 400；其余 → Cline 账号池。 |
| routatic | 供应商是同级枚举（OpenCode Go / Zen / Bedrock / OpenRouter / Anthropic），**没有**「免费」这一档；免费只是 Zen 里的零价模型。 |

**我们的取舍**：本仓实施计划已经定了「供应商靠模型命名空间显式选（`ocgo:<model-id>`），不靠候选数量或添加顺序猜」，与
jasonxu114514 的 `prefer` 隐式偏好和 6Kmfi6HP 的 key 前缀隐式切档都不同。建议：**沿用我们自己的显式 `ocgo:` 命名空间**，
把三逻辑上游折成「一个供应商 + 三档凭据/通道」，即 `go`(订阅 key/OAuth)、`zen`(付费 key)、`free`(匿名或零价模型)，
档位选择落在请求的显式标记或配置默认值上，而不是从 key 形态反推。6Kmfi6HP 的前缀法值得记一笔作为交互备选（用户可在 UI 里
给每把 key 标 tier），但不宜作为唯一判据——它会让「同一把 key 换档」变成不可表达的状态。

差额提醒：jasonxu114514 的 `upstream.zen = /zen`、`upstream.go = /zen/go`、匿名 `/inference` 三个 base URL 是**可直接采信的
协议事实**（README 明写），与我们 Rust 后端 catalog 里的 `opencode-go/<model-id>` 映射可交叉核对。

### req 7 · 模型列表接口怎么维护

| 项目 | 静态表 / 上游拉取 | 字段 |
|---|---|---|
| jasonxu114514 | **聚合两源**：上游模型列表 + `https://models.opencode.ai/api.json` 能力/价格目录。`models.refresh_seconds = 300`，价格/弃用元数据 24h 刷新；失败保留旧数据；落盘为 `config.json.models.catalog.json` 与 `.dev.json` | `/v1/models` 暴露上下文/输出上限、价格、`native_protocol`（`chat\|responses\|anthropic\|systemone`）、`supported_endpoints`、reasoning 元数据；`models.free_only` 可按免费过滤 |
| 12errh | 仓内 `models.json` 由 **GitHub Action 每 6h** 从 OpenCode 公共目录刷新；运行时 `autoSync` 默认 1h 再发现，`/v1/models` 缓存 TTL 30s | 未在 README 展开字段 |
| foxy1402 | 两源自动同步（Cline 官方 feed 60s、zen 目录 10min）；**活列表为准，内置种子只覆盖冷启动/离线**；目录不可达则用种子，下次同步接上 | 未展开 |
| nennneko | 零硬编码：`GET https://opencode.ai/zen/v1/models`（唯一「此模型能不能用」权威）∩ `https://models.dev/api.json`（免费= `cost.input==0`，路由= `provider.npm`：`@ai-sdk/openai` → Responses，缺省 → chat，窗口= `limit.context/input/output` + `modalities`/`reasoning`）；`CATALOG_TTL=900`，双源皆挂时保留旧目录并每 15min 重试，**不挂在推理请求上**；第三源为 opencode 仓内 `models-dev/snapshot.txt` 镜像 | `/v1/models` 同时发多套别名：`context_window`、`context_length`、`max_context_length`、`max_input_tokens`、`max_tokens`、`max_output_tokens`、`modalities`、`reasoning`、`limit{context,input,output}` |
| FishBottle7 | 活目录 ∩ 免费元数据，回退离线缓存（~7 天 TTL）与校验过的静态表 | 未展开 |
| 6Kmfi6HP | models.dev 目录缓存放 `/data`；上下文来自 models.dev 的 `catalog.json`，`≥1M` 打 `[1m]` 后缀并设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW = ctx × 0.9` | 未展开 `/v1/models` 字段，但 codex 侧生成 `context_window`/`max_context_window`/`auto_compact_token_limit` |

**我们的取舍**：**不要自建静态模型表**。两条上游事实已经够用且被多项目重复验证：Zen 侧的 `/v1/models`（权威、能匿名读）与
`models.dev` / `models.opencode.ai` 的能力价格目录。建议按 nennneko 的分工照抄职责边界——「能不能用」只信上游列表，
「免费否/走哪个路由/窗口多大」信目录，目录挂了就服务旧快照；并采用它那套 `/v1/models` 字段别名矩阵，因为客户端读法确实不统一
（pi-web-ui 读 `context_window`/`max_tokens`，OpenRouter 风格客户端读 `context_length`/`max_context_length`）。

**必须自研的部分**：目录合并后的**本地优先级**（`ocgo:` 命名空间与 Codex/Custom 既有模型的别名冲突检测）。jasonxu114514 明写
「M0 先核对目录和别名冲突，若既有用户用相同命名空间则禁止静默接管」——这条我们照做，但实现得自己写。

### req 8 · zen-free 免费模型聚合

| 项目 | 判定口径 | 聚合与降级 |
|---|---|---|
| jasonxu114514 | 「模型 ID 里大小写不敏感地含 `free`」**或**「未弃用且输入输出价格均为 0」；明确说**资格不等于上游会接受** | 免费模型在启用匿名时先走匿名通道，再按 `prefer` 顺序走 keyed 档；`models.free_only` 同时过滤轮换组成员；`models.anonymous_backoff` 是**通道级熔断**（阈值 6、基数 1h、上限 24h） |
| nennneko | 只用 `cost.input == 0`，明确否掉名字判定：「`big-pickle` 看着付费但是免费；名字带 `-free` 但每百万 token 几百美元的应被拒」 | 免费集合只列 `/v1/models`；要付费模型返回说明原因的 404；实测 2026-10 起**匿名（`Bearer public`）对全部免费模型都 403**，只有 `/v1/models` 仍可匿名读 |
| 12errh | 无判定，直接吃「活着且免费」的目录 | `defaultModel` 空则自动挑第一个可用免费模型；`defaultZenKey` 在「身份免费额度耗尽」的 429 上**同一尝试改用自己的 key 重试一次**（共享池冷却不外溢） |
| foxy1402 | 按模型名白名单 + 目录，付费 zen 显式 400 | 无 key 时用匿名 `public` |

**我们的取舍**：免费判定取 **`cost.input == 0`（价格）优先，名字后缀只作兜底**，这与 nennneko 的实测结论一致，也解释了本仓
为什么会遇到「名字是 `-free` 却不可用」类问题。免费档要单独配**通道级熔断**（jasonxu114514 的 6 次 / 1h / 24h 参数可直接沿用），
否则免费档的 429 会污染付费 key 的健康分。**注意上游事实会变**：nennneko 记录 2026-10 起匿名已 403、12errh 记录 Zen 2.x 的
免费门禁换成 `429 FreeUsageLimitError`，说明「免 key 免费」这条路不可作为产品承诺。

### req 9 · 缓存命中优化（header 聚合 / session id / prompt cache）

这是**本轮唯一几乎没有现成实现可抄**的领域。逐项事实：

| 事实 | 出处 | 内容 |
|---|---|---|
| prompt-cache 保留指令 | [6Kmfi6HP/opencode2api](https://github.com/6Kmfi6HP/opencode2api) | `prompt_cache_retention`：`"24h"`（默认）/ `"in_memory"`（约 5 分钟）/ `"off"`，注入到上游 zen 网关请求 |
| Anthropic 风格断点 | 同上 | `cache_control_breakpoints`（默认开）给接受的模型加 `cache_control` 断点，`ttl: 1h`；**GLM/Zhipu 模型一律跳过** |
| 出口 IP 与缓存命中强相关 | 同上 | `socks5_sticky`：会话/账号固定同一出口代理，实测**固定出口 99.8% 命中，随机轮换约 0%** |
| base URL 也做亲和 | 同上 | `upstream_base_urls` 多值时，会话固定同一 (`baseURL`, `proxy`) 对，做「负载均衡 + 缓存亲和」 |
| sticky 会话以暖前缀缓存 | [gumieri/nenya](https://github.com/gumieri/nenya) | sticky 策略把会话（agent + system prompt + first user message）钉到一个 provider/model，保住 provider 侧前缀缓存 |
| 前缀开销与命中 | [developingchet/zengate](https://github.com/developingchet/zengate) | 默认 `compatible` profile 携带 OpenCode 系统提示与工具表（约 6–9k 输入 token，**大部分是缓存命中**），多 1–3s 延迟 |
| 会话身份 header 集合 | [nennneko5787/opencode-zen-server](https://github.com/nennneko5787/opencode-zen-server) | 反编译 `opencode.exe` 得到的完整 `x-opencode-*` 集：`x-opencode-client: cli`、`x-opencode-session: ses_…`、`x-opencode-request: req_…`，加 `User-Agent: opencode/<version>`；代理默认原样重放 |
| 更完整的 v2 线身份 | [12errh/zen-proxy](https://github.com/12errh/zen-proxy) | 追加 `x-opencode-project`（sha1）、`b3`/`traceparent`、亲和对；每调用方（源 IP + UA 家族）铸造并**30 分钟同步轮换** session+project 两半；客户端自带 `x-opencode-session` 则原样转发 |
| 会话 ID 的格式约束 | [foxy1402/cline-proxy](https://github.com/foxy1402/cline-proxy) | 免费档门禁是**格式校验** `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，故本地每调用铸造一个；同一调用重试才复用；换 key 或 403 强制刷新则重铸 |
| 会话 ID 有效期策略变迁 | jasonxu114514 | 换 key 时**不得**把旧上游续接 ID 带给新 key（与 `docs/OCGO_IMPLEMENTATION_PLAN.md` §2 的「响应已提交不换 key」同构）；它另有 `x-session-id` 显式亲和，缺省时以首条 system/user 内容为种子，身份限定在本地 API key + 进程生命周期内 |

**结论（对我们的取舍）**：
1. **没有项目做「缓存 header 聚合」这件事**。jasonxu114514 与 12errh 都是「重放/铸造上游官方身份头」，不是把客户端的缓存相关头做归一化再聚合。
   也就是说，若我们要做「多把 key / 多出口下仍稳定命中同一缓存」，需要自己设计：把 `(对话种子, 模型, 出口)` 三元组映射到一个稳定的
   上游会话身份，并在换 key 时判断**该不该保留**会话（换 key 保留会撞上游 per-key 缓存，不保留会丢前缀缓存）。
   现有项目里最接近的是 6Kmfi6HP 的「固定出口 + 固定 base URL」与 nenya 的 sticky，两者都只解决「同一身份不漂移」，没解决「身份不得不换时怎么办」。
2. `cache_control` 断点（`ttl: 1h`，跳过 GLM/Zhipu）与 `prompt_cache_retention`（`24h` / `in_memory` / `off`）是**可直接采信的协议事实**，
   建议做成配置项；这两个名字先按 README 原文使用，**落到我们代码前需以真实上游请求复核**（本轮未做源码/抓包验证）。
3. 出口粘滞（99.8% vs ~0% 那组数字）说明：**缓存收益首先是出口稳定性问题，不是 header 拼装问题**。我们的 key 池若做轮换，
   必须同时把出口绑定纳入调度键，否则轮换会系统性清零缓存收益。

### req 10 · 模型 fallback 关系怎么建模

| 形态 | 项目 | 具体 |
|---|---|---|
| **线性有序链** | 12errh | `fallbackModels`（缺省跟随目录）按顺序在 `429` / `5xx` / 不可用上依次重试；命中后靠 `zen_served_by` 与 `x-zen-served-by` / `x-zen-fallback` 响应头宣告 |
| **链 + 熔断** | routatic | Fallback Chains + Circuit Breaker（按模型健康跳过）+ Anthropic-first 故障转移（只在限流/故障时启用 OpenCode）+ 按场景（default / thinking / long-context / background / streaming）选模型 |
| **链 + 优先级** | nenya | 「model 在多 provider 存在时，全部加入该 agent 的 fallback chain」，round-robin 或 sequential，带熔断与 stream-head 故障转移 |
| **别名组合（不是链）** | foxy1402 | **Combos**：用户自建别名 ID → 同平台另一模型；别名出现在 `/v1/models` 里供 IDE 直选。README 明写「Strictly same-platform targets」，即**不做跨平台切换** |
| **服务级游标** | jasonxu114514 | 轮换别名 `sota` / `sweet`：整组共享一个「当前模型」，**成功则停留，失败则前进**；SOTA 组含 `deepseek-v4.1-flash`、`glm-5.3`、`grok-4.6`、`kimi-k3`、`qwen3.8-max`，Sweet 收其余合格 Go 模型；普通错误预算 = 3 个模型 × 每个最多 3 次尝试；额度/限流失败直接跳到下一个模型；响应里保留请求的别名，用 `X-Resolved-Model` 报真实模型；状态持久化在配置旁 |
| **加权评分 + 即时降级** | Michaelunkai | key 选择按上游上报的**配额窗口加权归一化**，任一窗口打到 100% 立即停用该 key；Go 侧失败（余额不足 / 地区策略 / 训练同意）**即时转 Zen** |
| **切换预算** | foxy1402 | 单次客户端请求最多冷却 `1 + retries`（默认 5）把 key——因为「换 key 不可逆，等待可逆」，避免一个超大请求几秒内走完整池 |

**我们的取舍**：本仓计划（§2）已经写了比这些项目更严的语义——「确认额度组耗尽才跳过同组全部 key」「429 含义未知不逐一试遍」
「响应已提交后不换 key 重放」。这些项目里**没有任何一个**做到了额度组感知：jasonxu114514 只到「Go key 可能共享额度，百分比不可相加」，
foxy1402 只到「单请求换 key 预算」。所以：

- **可以直接借鉴**：错误到动作的**分类表**（谁是可换 key 的、谁是不可换的）、退避参数形状（jasonxu114514：`retry.max_attempts=3`、
  `retry.timeout_seconds=300`、`failure_cooldown_seconds=15`、`free_tier_block_seconds=900`；Michaelunkai：TTFB 25s / 单次 90s /
  首字节总预算 240s）、`X-Resolved-Model` 这类「回执真实目标」的响应头。
- **不要照搬**：服务级游标（sota/sweet）会与我们的「同组 Key 不逐一试」冲突；Combos 的同平台限制与我们「不做跨供应商自动回退」其实一致，
  可以把它当作 OK 形态；线性链 + 熔断（routatic/nenya）与我们「显式供应商、MVP 不新增跨供应商回退」冲突，仅作后续阶段的候选。
- **必须自研**：把 fallback 建成**图而非链**。理由是需求里 fallback 关系要可视化编辑（req 12），而上述所有实现的关系都是隐式顺序表
  （数组顺序）或单层别名映射，没有「边带条件、组带权重」的模型。这一层没有可抄对象，见 §C。

### req 11 · 入站协议与上游协议映射

| 项目 | 入站 | 上游原生 | 转换要点 |
|---|---|---|---|
| jasonxu114514 | `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/systemone` | 每模型 `native_protocol` ∈ `chat\|responses\|anthropic\|systemone`，由目录与 `models.protocols` 覆盖 | 原生协议一致则原样透传并保留 provider 专有字段；跨协议只搬运有等价物的字段（例：Chat 的 `seed` / JSON 输出约束**不**翻成 Anthropic 选项）；Responses 的 reasoning/text/function-call item 在转 Chat 时合并为 assistant turn，未配对的 tool result 直接报错；明确不支持 embeddings / 文件上传 / 图像生成 / Responses 检索与取消 |
| 6Kmfi6HP | 同上三协议 | 统一 chat-completions + Responses wire | `model_alias` 映射；`reasoning_effort_map`；`force_disable_thinking`；`max_tokens_cap`（全局 + 每模型） |
| 12errh | chat / responses / messages（+ `messages/count_tokens`） | `https://opencode.ai/inference/openai/v1` | 「说 Responses 的语言就回 Responses，说 chat 就回 chat」；`responsesModels` 用通配模式（`gpt-5*`、`grok-*`、`muse-spark-*`）判定哪些模型走 `/v1/responses`；工具调用做「改名往返」，只保留自己客户端能执行的调用 |
| foxy1402 | 三方言 | 两条上游都是 chat-completions 服务 | chat 近乎透传；`/v1/responses` 与 `/v1/messages` 双向转换（含流式事件、工具调用、usage）；`tool_choice:"none"` 通过剥掉 tools 来强制执行；非流式响应在网关侧按 `stop` 截断 |
| nennneko | chat / responses / systemone | 三路由由目录 `provider.npm` 决定 | Chat → Responses 翻译：`system` → `instructions`、`tool_calls` → `function_call`、SSE `response.output_text.delta` → `chat.completion.chunk` delta；**路由猜错可自愈**：收到「Model X is not supported for format openai」就换另一条 OpenAI 兼容路由试一次并记住 |
| zengate | chat / responses（含 `GET/DELETE /v1/responses/{id}`，内存存 1h） | 真实 `opencode serve` 会话 | 因会话不能原生注册函数，function calling 用提示模拟；`/v1/embeddings` 返回 `404 unsupported_endpoint` |
| routatic | Anthropic Messages（Claude Code） | OpenAI / Anthropic / Responses / Gemini | 入站固定 Anthropic，出站按 provider 转；`tool_use`/`tool_result` ↔ OpenAI/Gemini function calling |

**我们的取舍**：本仓已定「先做 Responses 文本与工具 SSE」「只有 mock 合同验过的能力才宣称支持」。三个可采信的事实：
(1) **每模型原生协议是必要字段**（jasonxu114514 的 `native_protocol` + `supported_endpoints` 是最完整的数据形状），
(2) **路由猜错的成本可以做到「一个请求发两次」**（nennneko 的自愈记录法值得照抄，比硬编码更耐上游漂移），
(3) **不支持的能力要明示**（`embeddings` 404 / `systemone` 独立端点），这与我们「已识别的辅助请求返回明确 unsupported」一致。
注意：jasonxu114514 的「跨协议只搬有等价物的字段，其余报错」比「尽力猜」更安全，建议作为我们跨协议路径的原则。

### req 12 · 图形化配置编辑器（humanfia/humanize 参考）

先给结论：**humanize 不是一个「图编辑器」产品**，它没有节点/边/权重的数据模型，也没有画布式编辑界面。它的可借鉴点是
「**声明式定义 + 运行期绑定 + schema 驱动表单**」。抓取到的事实（README + `docs/weaver/writing-a-flow.md` + `docs/weaver/flow-settings.md`）：

| 方面 | 事实 |
|---|---|
| 基本单位 | 一个 flow 就是**一个 async Python 函数**，加 `@flow(agents=…, envs=…, params=…)`；名字取函数名，docstring 首行是列表里显示的说明 |
| 角色/节点 | `AgentCollection` 子类里一行一个角色（`builder: Agent`）；**函数体从不写 CLI 或模型名**，只写角色名 |
| 运行期绑定 | 运行者用 `-a ROLE=CLI/MODEL:EFFORT` 填角色（例：`-a builder=claude/claude-sonnet-5-5:high`）；能力不足的 CLI 会让整个 run 在第一次 turn 前被拒 |
| 参数/表单 | `FlowParams` 是 pydantic model，一字段一参数；**同一份 model 同时驱动三种入口**：CLI `-p key=value`、提示符处的表单、Web 新 epic 表单。字段的 `title` 是行名，`description` 是行旁说明，类型决定控件（`int` + `ge/le` 成数值范围，`Literal[...]` 成下拉，`bool` 成开关），`json_schema_extra`（示例里 `AFTER`）可声明「某字段只在某条件后出现」，`{"section": …}` 给表单分行分组 |
| 校验时机 | 命令行里没有对应字段的 key **直接拒绝而不是忽略**（拼写错误不会被吞）；所有校验在启动任何 agent 之前完成，试错零成本 |
| 预算 | `budget.cost` / `budget.duration` / `budget.output_tokens`；`hmz exec` 不给预算就拒绝跑；子 flow 的预算必须落在调用者剩余额度内 |
| 控制流 | 循环、条件、分支都写在 Python 里（`for _ in range(params.passes)`、`asyncio.gather` 并发、`output_schema=` 一个 pydantic model 换来「代码能分支的答案」）；`resumable=True` + `ctx.state` 支持断点续跑 |
| 可视化 | 文档站用 Vue 组件渲染 flow（`FlowScene` / `FlowWire` / `FlowGate` / `FlowLoop` / `FlowMeter` / `FlowTurn`），把声明画成「阶段—连线—闸门—回路—计量」的示意图；这是**文档级示意渲染**，不是可编辑画布 |

**对我们的取舍（req 12 的编辑器设计）**：

- **值得抄的三点**：① 表单由 schema 生成而不是手写表单（同一 schema 服务 CLI、表单、API 三处，改一处不漂移）；
  ② 条件字段可见性内建在 schema 里（`json_schema_extra`），不必为「先选供应商再填凭据」写特例代码——这正好对上本仓
  「先选供应商，再由该供应商选凭据」的需求；③ 校验前置、拼错即拒，比运行时静默回落安全。
- **不值得抄的**：humanize 用 Python 代码承载控制流，我们不可能让用户在 Web 里写 Python。我们要的是**数据化的图**（节点/边/条件/权重），
  humanize 的 flow 是代码，二者只在「声明式 + schema 校验」这一层同构。
- **必须自研**：见 §C 的「回退图数据模型」。另外 humanize 的 `FlowMeter` 说明「预算/用量作为节点属性展示」是可行交互，
  我们的编辑器同样应该每个节点带「未验证/已验证/已弃用」状态与最近一次探活结果，而不是只画拓扑。

---

## C. 不需要重复造轮子 vs 必须自研

### C.1 不需要重复造轮子（借鉴思路即可，别从零设计）

1. **三路上游的 base URL 与鉴权形态**：`https://opencode.ai/zen`（Zen key）、`https://opencode.ai/zen/go`（Go key + `/v1/usage` 配额）、
   `https://opencode.ai/inference`（匿名）。出处：jasonxu114514 README。协议事实，直接采信。
2. **模型目录的两源分工**：上游 `/v1/models` 定「能不能用」，`models.dev` / `models.opencode.ai` 定「免费否 / 走哪个路由 / 窗口多大」，
   目录不可达就服务旧快照、按自己的节奏重试而不挂在推理请求上。出处：nennneko、jasonxu114514、foxy1402 三家独立一致。
3. **`/v1/models` 字段别名矩阵**：`context_window` / `context_length` / `max_context_length` / `max_input_tokens` / `max_tokens` /
   `max_output_tokens` / `modalities` / `reasoning` / `limit{context,input,output}`。出处：nennneko（含每个别名面向哪类客户端）。
4. **免费判定口径**：`cost.input == 0` 优先，`-free` 名字只兜底；「名字带 free 但高价」必须被拒。出处：nennneko（含反例）、jasonxu114514。
5. **缓存相关协议事实**：`prompt_cache_retention`（`24h` / `in_memory` / `off`）、`cache_control` 断点 `ttl: 1h` 且跳过 GLM/Zhipu、
   出口粘滞与命中率强相关（99.8% vs ~0%）。出处：6Kmfi6HP。**落码前需抓一次真实请求复核。**
6. **会话身份 header 集合**：`x-opencode-client` / `x-opencode-session` / `x-opencode-request` / `x-opencode-project` + `User-Agent`，
   以及会话 ID 格式 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`。出处：nennneko（反编译）、12errh（v2 补齐）、foxy1402（格式）。
7. **错误 → 动作分类与参数形状**：可换 key / 不可换 key 的分界、退避与超时分档（3 次尝试 / 300s 总预算 / 15s 冷却 / 免费档 900s 封锁；
   TTFB 25s / 单次 90s / 首字节 240s）、单请求换 key 预算 `1 + retries`。出处：jasonxu114514、Michaelunkai、foxy1402。
8. **协议映射的字段级边界**：哪些字段没有等价物就不搬、不配对 tool result 直接报错、不支持的能力返回明示错误。出处：jasonxu114514、nennneko、zengate。
9. **配置表单的 schema 驱动模式**（若 req 12 要落地）：一份 schema → CLI / 表单 / API 三处渲染，条件字段可见性内建，拼错即拒。出处：humanize。

### C.2 必须自研（现有实现里没有对应物）

1. **回退图（graph）的数据模型**：节点 = 上游/模型/凭据档，边 = 带条件的转移（错误类别、额度组、已提交状态），组 = 带权重的候选集合。
   检索结果直接证明没有可抄对象：`model fallback graph llm router` 全库仅 3 条且无一相关，`llm router fallback chain visual editor` **0 条**；
   已抓项目的关系全是「数组顺序」或「单层别名映射」。
2. **额度组（quotaGroup）感知的调度**：本仓要「确认额度组耗尽才跳过同组全部 key」「429 含义未知不逐一试遍」。现有项目最多到
   「Go key 可能共享额度，百分比不可相加」（jasonxu114514），没有一个把组归属作为一级调度键。
3. **缓存身份在换 key 时的取舍**：现有做法只保证「同一身份不漂移」（固定出口 / sticky），没有回答「身份不得不换时，前缀缓存怎么办」。
   这是本仓要做缓存命中优化时唯一没有先例的设计点。
4. **`ocgo:` 命名空间的冲突检测与兼容规则**：需与本仓既有 Codex/Custom 模型目录合并，并禁止静默接管同名模型。
   jasonxu114514 只说「M0 先核对」，没给实现。
5. **可视化编辑器本身**：humanize 的可视化是文档示意图，不是可编辑画布；且它的控制流在 Python 里。画布、条件编辑、权重编辑、校验回写全部自研。
6. **非商业许可下的第三方边界管理**：需要一份「只借鉴了思路」的台账（即本文 D 段），以及一条纪律：不复制 GPL/AGPL/无许可项目的代码与注释。

---

## D. CREDITS 候选条目

只列**本轮确实抓取成功**（README/官方文档原文已读到）的项目。凡未抓到的不进此表。

```markdown
- [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api) — GPL-3.0
  Ideas only (no code copied). Three-upstream layout (Zen / Zen Go / anonymous base URLs), per-model
  `native_protocol` and `supported_endpoints` in `/v1/models`, and the error-budget/cooldown shapes
  informed this project's upstream model.

- [6Kmfi6HP/opencode2api](https://github.com/6Kmfi6HP/opencode2api) — No licence granted (all rights reserved)
  Ideas only (no code copied). Its `prompt_cache_retention` / `cache_control_breakpoints` / sticky-egress
  notes are the only public description of prompt-cache handling on the Zen gateway that we found.

- [nennneko5787/opencode-zen-server](https://github.com/nennneko5787/opencode-zen-server) — MIT
  Ideas only (no code copied). Split between "upstream model list decides usability" and "models.dev decides
  price/route/window"; the `/v1/models` field-alias matrix and the `cost.input == 0` free test.

- [12errh/zen-proxy](https://github.com/12errh/zen-proxy) — MIT
  Ideas only (no code copied). Ordered free-model fallback with `x-zen-served-by` / `x-zen-fallback` receipt
  headers, and per-caller OpenCode session identity minting.

- [foxy1402/cline-proxy](https://github.com/foxy1402/cline-proxy) — No licence (LICENSE absent; API reports NOASSERTION)
  Ideas only (no code copied). "Combos" (alias model IDs surfaced in `/v1/models`) as a same-platform fallback
  shape, plus the per-request key-switch budget that bounds pool walking.

- [gumieri/nenya](https://github.com/gumieri/nenya) — Apache-2.0
  Ideas only (no code copied). Sticky sessions pinned by (agent, system prompt, first user message) to keep
  provider-side prefix caches warm.

- [Michaelunkai/OpencodeGoProxy](https://github.com/Michaelunkai/OpencodeGoProxy) — MIT
  Ideas only (no code copied). Quota-window weighted key scoring with immediate bench at 100%, and Zen fallback
  triggered by Go-side classifiable failures.

- [humanfia/humanize](https://github.com/humanfia/humanize) — Apache-2.0
  Ideas only (no code copied). Schema-driven param forms (one pydantic model rendering CLI, prompt form and web
  form), condition-triggered field visibility, and fail-before-run validation.

- [developingchet/zengate](https://github.com/developingchet/zengate) — MIT
  Ideas only (no code copied). Explicit `unsupported_endpoint` responses and per-request session lifecycle are
  cited as design precedent for capability honesty.
```

> 上表之外，`cucoleadan/opencode-cowork-proxy`、`LIMTCYT/opencode-go-proxy-for-trae`、`dhaalves/opencode-swap`
> 仅在搜索列表中出现，本轮**未获取**其 README，暂不列入 CREDITS。

---

## 附：本轮取证清单与局限

**抓取成功**（均 `main` 分支，除注明外）：`jasonxu114514/opencode2api`、`routatic/proxy`、`12errh/zen-proxy`、
`foxy1402/cline-proxy`、`nennneko5787/opencode-zen-server`、`6Kmfi6HP/opencode2api`、`developingchet/zengate`、
`FishBottle7/opencode2dsh`（`master`）、`gumieri/nenya`、`Michaelunkai/OpencodeGoProxy`、`bigdata2211it-web/opencode-free-proxy`、
`humanfia/humanize`（README + `docs/weaver/writing-a-flow.md`、`docs/weaver/flow-settings.md`、`docs/features/flows.md`）。

**未能使用**：`web_search`（HTTP 402）；因此无法覆盖非 GitHub 来源（博客、Reddit、上游官方文档站），
若需要 OpenCode 官方对 Zen/Go 配额与缓存的表述，需另外授权抓 `opencode.ai/docs` 与 `models.dev`。

**未做**：源码级阅读、真实上游请求复核、issue/PR 讨论检索。凡本文给出 header 名、字段名、参数默认值的，均来自 README 原文；
其中 6Kmfi6HP 的 `prompt_cache_retention` / `cache_control_breakpoints` 两项**建议在实现前用一次真实请求确认**（该仓无许可证，
我们只取事实不取代码）。
