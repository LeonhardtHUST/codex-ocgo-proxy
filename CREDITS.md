# CREDITS

本文件记录 OpenCodeX-Router 的来源、借鉴对象与第三方组件。许可证全文见 [LICENCE](./LICENCE)。

## 1. 上游血缘

OpenCodeX-Router 是在 **Codex Proxy** 基础上独立演进的衍生分支（fork），当前作为独立项目维护，
不再跟随上游主仓的功能节奏、命名与发布通道。

- 上游项目：Codex Proxy（`github.com/icebear0828/codex-proxy`）
- 上游许可证：非商业许可 1.0（见 [LICENCE](./LICENCE) 原文，本仓未修改其条款）
- 衍生关系：本仓保留上游的许可与著作权声明；产品名、包名、配置段、模型命名空间已按本仓命名重构，
  与上游不再兼容。若需回退，请使用上游仓库自身发布的版本。

按 LICENCE 第 4 条要求：分发本软件或其修改版本时须随附许可全文、保留原始声明，并标明已作修改。
本仓即为「已修改版本」，修改范围见 [CHANGELOG](./CHANGELOG.md) 与 git 历史。

## 2. Rust 请求路由的参考实现

- **ocgo2api-rs**（内部参考实现，随本仓 `native/ocx-router` 重新组织）

  Rust 侧「Provider × Family 二维目录、Responses 通用入站 + 其余直通、响应级/连接级双重重试分离、
  5xx→502 与 4xx 原样、SSE 字节层 Decoder 与协议层 Converter 分离、`committed` 提交语义」这些设计
  来自该实现。移植时的保留/重构/放弃判断记录在 `docs/recon/OCGO2API_RS_MAP.md`。
  该实现无 zen-free 池与 key 轮换机制，这两部分为本仓自研。

## 3. 协议事实与设计借鉴（Ideas only, no code copied）

以下项目仅用于核对 OpenCode 网关的协议事实与交互模式，**未复制任何代码、注释或数据文件**。
原因见 §5。读者若需实现细节，请直接阅读原项目。

- [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api) — GPL-3.0
  三路上游布局（Zen / Zen Go / 匿名 base URL）、`/v1/models` 中每模型的 `native_protocol` 与
  `supported_endpoints`、错误预算与冷却参数形状。

- [6Kmfi6HP/opencode2api](https://github.com/6Kmfi6HP/opencode2api) — 未授予许可（All rights reserved）
  `prompt_cache_retention`、Anthropic 风格 `cache_control` 断点（跳过 GLM/Zhipu）、出口粘滞与缓存命中率的
  关系描述。这是目前唯一公开描述 Zen 网关 prompt cache 行为的资料。

- [nennneko5787/opencode-zen-server](https://github.com/nennneko5787/opencode-zen-server) — MIT
  「上游模型列表决定能不能用、能力目录决定价格/路由/窗口」的双源分工；`/v1/models` 字段别名矩阵；
  以 `cost.input == 0` 判定免费模型。

- [12errh/zen-proxy](https://github.com/12errh/zen-proxy) — MIT
  有序免费模型回退与 `x-zen-served-by` / `x-zen-fallback` 回执头；按调用方铸造 OpenCode 会话身份。

- [foxy1402/cline-proxy](https://github.com/foxy1402/cline-proxy) — 无许可文件（API 报 NOASSERTION）
  「Combos」形式的同平台别名额；单请求换 key 预算（`1 + retries`）；会话 ID 格式约束
  `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`。

- [gumieri/nenya](https://github.com/gumieri/nenya) — Apache-2.0
  以（agent、system prompt、首条 user 消息）钉住会话的 sticky 策略，用于保住 provider 侧前缀缓存。

- [Michaelunkai/OpencodeGoProxy](https://github.com/Michaelunkai/OpencodeGoProxy) — MIT
  按配额窗口加权的 key 评分与打满即停用；Go 侧可分类失败即时转 Zen。

- [routatic/proxy](https://github.com/routatic/proxy) — AGPL-3.0
  多上游 fallback 链与熔断的形态对照（本仓未采用线性链模型，见 §4）。

- [developingchet/zengate](https://github.com/developingchet/zengate) — MIT
  显式 `unsupported_endpoint` 与每请求会话生命周期，作为「能力诚实」的设计先例。

- [humanfia/humanize](https://github.com/humanfia/humanize) — Apache-2.0
  一份 schema 同时驱动 CLI、提示表单与 Web 表单的 schema-driven 参数表单；条件字段可见性内建；
  提交前校验、拼错即拒。本仓 fallback 图编辑器的表单部分借鉴这一模式。

未列入：仅在搜索结果中出现、本轮未获取到 README 的项目（`cucoleadan/opencode-cowork-proxy`、
`LIMTCYT/opencode-go-proxy-for-trae`、`dhaalves/opencode-swap`）。

## 4. 本仓自研部分（无先例可循）

- 模型 fallback 关系的**图数据模型**（带条件与权重的边、分组、hop/预算上限）与可视化编辑器。
  公开实现全部是数组顺序或单层别名映射。
- **额度组感知**的凭据调度（确认额度组耗尽才跳过同组全部 key）。
- **缓存身份在换 key 时的取舍**：普通故障保留会话身份，`FreeUsageLimitError` / 认证失败则重算。
- **zen-free 聚合池**：全部 opencode 凭据共同参与免费模型轮换，并按成功情况反馈权重、按通道熔断。
- 模型目录合并后的**本地命名空间优先级与冲突检测**（与既有 Codex/Custom 模型、别名合并）。

## 5. 许可证边界

本仓 LICENCE 为非商业许可。

- GPL-3.0 / AGPL-3.0 项目的**代码不可并入**本仓（与本许可的附加限制冲突）。
- 无许可证项目（All rights reserved / 无 LICENSE 文件）**代码不可使用**。
- 因此 §3 全部条目按「仅借鉴思路与协议事实」处理；即便对方为 MIT/Apache-2.0，本仓也不复制其代码，
  以免引入额外的许可义务。

## 6. 第三方依赖与素材

运行时与构建期依赖的许可信息以各包自带声明为准（`node_modules/*/LICENSE`、`native/Cargo.lock` 对应 crate）。
若发行包需要单独的第三方声明汇总，见 `THIRD-PARTY-NOTICES.txt`。

素材：本仓不包含上游项目的赞赏码、社群二维码、个人社交账号徽章或 Star 历史图表。
