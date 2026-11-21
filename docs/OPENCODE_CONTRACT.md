# OpenCode 协议契约（防漂移基线）

用途：把「同一个请求，走 TypeScript adapter 还是走仓内 Rust 路由」的行为差异变成 CI 可见。
这是 `docs/BACKEND_RUST_EVALUATION.md` 路线 C 的落地物，也是将来若真做增量吸并时的验收基线。

命令：

```powershell
npm run test:contract
```

## 覆盖矩阵

黄金用例在 `tests/contract/fixtures/opencode-protocol-parity.json`，每条用例同时喂给两个实现：

| 用例 | 协议 | 上游端点 | 断言 |
|---|---|---|---|
| `responses-stream` | responses | `/openai/v1/responses` | 路径、`model` 直通、事件序列 |
| `chat-stream` | chat-completions | `/openai/v1/chat/completions` | 同上 |
| `messages-stream` | messages | `/anthropic/v1/messages` | 同上 |
| `free-limit-429` | responses | 同上 | 错误状态码一致、错误体保留 `opencode_free_limit` |
| `invalid-key-401` | chat-completions | 同上 | 同上 |
| `model-denied-403` | messages | 同上 | 同上 |

两个实现分别是：

- **TypeScript**：`OpenCodeAdapter` → 按协议委派 `ResponsesUpstream` / `OpenAIUpstream` / `AnthropicUpstream`；
- **Rust**：`native/ocx-router` 二进制 + `RustRouterAdapter`（与 TS 共用同一批流解析器，见下）。

## 三条不变式

1. **协议决定端点**：协议只能按 `(上游, 模型)` 从目录选，同一模型 id 在不同上游可以是不同协议，因此契约里 `expectedPath` 绑定的是「协议」而不是「模型」。
2. **模型 id 直通**：两个实现发给上游的 `model` 都必须是裸 id（不带 `opencode:` / `opencode-go:` 前缀）。
3. **错误口径一致**：直连路径抛 `CodexApiError`（仓库唯一的上游错误类型），状态码与上游一致，错误体原样保留供分类层读取。

## Rust 侧为何也要用 TS 的解析器

`RustRouterAdapter` 只负责把 Node 的决定转成 `x-ocx-*` 头并原样中继 SSE 字节；事件归一化仍由 TS 的
`parseStream` 完成。这样「Rust 改字节」「TS 改解析」两类改动都会在契约测试里立刻暴露，而不是靠人工比对。

## 更新方式

改行为时**先改 fixture 再改实现**：fixture 的 diff 就是这次行为变更的声明。禁止为了让测试通过而放宽断言
（例如把 `expectedPath` 改成 `expect.any(String)`）。

新增场景的门槛：必须能同时表达「请求侧」（路径 / 方法 / `model`）与「响应侧」（事件序列或错误状态）。

## 已知边界

- Rust 二进制未构建时，Rust 半套用例**报 skipped**，TypeScript 半套仍然执行——不会伪装成通过。
- 契约不覆盖：凭据选择、额度组、fallback 图遍历（这些留在 Node 侧，另有单测）；也不覆盖 header 注入的
  主机判定（`applyOpenCodeHeaders` 只对 `opencode.ai` 生效，有独立单测）。
