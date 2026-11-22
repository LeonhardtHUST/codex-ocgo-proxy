# OpenCode 上游与 Rust 路由（本机部署、验收与回滚）

OpenCode 家族（`go` / `zen` / `zen-free`）与 Codex 同级，默认关闭。App 负责选凭据、定协议、定上游；
Rust 路由只执行请求转发。Codex OAuth 与第三方 API Keys 仍在 Dashboard 的账号 / API Keys 页面管理，
OpenCode 凭据不参与 Codex 账号轮换。

## 两种运行形态

| 形态 | 说明 | 适用 |
|---|---|---|
| **仓内 Rust 路由（推荐）** | 二进制在 `native/ocx-router/`，由 App 拉起与回收，Node 经 `x-ocx-*` 头下发决策 | 全新部署 |
| 兼容：外部 sidecar | 仍指向外部 `ocgo2api-rs` 回环地址，`rust_routing.legacy_sidecar: true` | 已经装了外部服务的旧部署 |
| 纯 TypeScript | `rust_routing.enabled: false`，全部走 TS adapter | 不想装 Rust 工具链 / 排查问题 |

三种形态的协议选择、错误分类与事件归一化是同一套（契约测试锁定），差别只在请求执行层。

## 单实例：一个数据目录只有一个后端

CLI 与桌面版共用同一个 `data/`（两个 SQLite、调度器状态、若干缓存），所以**同一个数据目录只允许一个后端**。
后启动者直接失败，不会与已在运行的实例并行：

```text
[Init] This data directory is already served by a cli instance (pid 56100, port 18080).
[Init] Lock file: D:\...\data\instance.lock
[Init] Stop that instance first, or run this one against a different data directory.
```

- 退出码 **3**（锁冲突）与退出码 **1**（端口重试 10 次仍失败）是两回事，别混着查
- 桌面版遇到锁冲突会弹窗说明占用者然后退出，**不会**退到随机端口继续跑
- 锁文件记录 `pid` / `kind`（cli 或 desktop）/ `startedAt` / `host` / `port`
- 进程崩溃留下的锁按 **pid 存活探测**回收，不需要等超时，也不需要手工删文件
- 只有数据目录相同才会互斥：不同工作目录、不同安装位置各自独立

## 启用

1. 在 Dashboard 的 **OpenCode** 页面添加凭据并绑定模型。凭据只存本机，不进 Git。
2. 把 [配置样例](config/ocx.local.example.yaml) 的 `opencode` 段合并进 `data/local.yaml`，按需打开开关。
3. 重启 App。源码构建版用 `npm start`；打包版直接启动。
4. 自检：

```powershell
curl.exe -H "Authorization: Bearer $env:KEY" http://127.0.0.1:8080/admin/opencode/status
```

关注三个字段：

- `enabled`：OpenCode 家族是否启用；
- `rust_routing.router.state`：`running` / `degraded` / `stopped`，`degraded` 一定带 `lastError`；
- `providers`：每个 provider 的 `id` / `kind` / `enabled` / `priority`。

### Rust 路由配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `rust_routing.enabled` | `false` | 打开后 App 负责 spawn 与探活 |
| `rust_routing.binary_path` | 空 | 留空时按内置顺序探测 `native/ocx-router/target/release/ocx-router.exe` 等 |
| `rust_routing.port` | `8790` | 回环监听端口，Node 从这里调用 |
| `rust_routing.base_url` | `http://127.0.0.1:8790/v1` | 只接受回环地址，非回环会在配置校验阶段被拒 |
| `rust_routing.startup_timeout_ms` | `8000` | 超过即判启动失败 |
| `rust_routing.legacy_sidecar` | `false` | 旧部署保持指向外部 `ocgo2api-rs` |

**降级是显式的**：二进制缺失、启动失败或探活超时，状态置 `degraded` 并记录原因，请求自动回落
TypeScript adapter —— 不会静默成功，也不会把请求发到不存在的地方。

### 构建 Rust 路由

```powershell
# 本机 HUST 镜像对部分 crate 返回 404，用隔离 CARGO_HOME 直连 crates.io
$env:CARGO_HOME = "$env:TEMP\ocx-cargo-home"
Set-Location native/ocx-router
cargo build --release
```

细节与镜像报错原文见 [native/ocx-router/README.md](native/ocx-router/README.md)。

## 模型选择

客户端把模型名发给 App，认证用 App 客户端 Key（不能用上游 Key）：

```text
opencode:<model>              # 交给目录与协议矩阵决定上游
opencode-go:<model>           # 强制 go
opencode-zen:<model>          # 强制 zen
opencode-zen-free:<model>     # 强制免费档（配合聚合轮换）
```

`ocgo:` 是 `opencode:` 的兼容别名，由 `opencode.legacy_ocgo_prefix` 控制，默认开启。若已有模型、
别名或 Custom 供应商占用这些前缀，App 会拒绝启用；先迁移冲突名称，或保持关闭。

同一模型 id 在不同上游可能是**不同协议**（例如 `minimax-m3` 在 zen 是 chat completions、在 go 是
messages），协议缓存按（上游, 模型）二元组建立，不按模型 id 索引。

## 能力与限制

已打通三类入站：`POST /v1/responses`、`POST /v1/chat/completions`、`POST /v1/messages`。
`/v1/models` 与 `GET /v1/opencode/catalog` 提供上下文长度、输出上限、模态、能力、思考档位与定价。

以下入站对 OpenCode 模型仍**明确拒绝**（返回 `unsupported_endpoint`，不静默降级）：
Images、Embeddings、Gemini GenerateContent、Responses WebSocket、`/responses/compact`、`/responses/review`。

## 回退图

`GET/PUT /admin/opencode/fallback-graph` 与面板画布维护节点与条件边。节点目标可写
`opencode*:<model>` 或 `codex-fallback:<model>`；后者走 fallback 上游的 responses 线，未配置
fallback 上游时该跳返回 503 `codex_fallback_unconfigured`。遍历受 `maxHops` / `budgetMs` 约束，
响应一旦提交给客户端就不再跳转。

## 验证（不联系真实供应商）

```powershell
# 协议契约：TS 与 Rust 两条路径必须给出相同的路径、model 与事件序列
npm run test:contract

# Rust 回环集成（真二进制对本地 mock 上游；二进制未构建时显式 skipped）
npx vitest run tests/integration/opencode-rust-router.test.ts

# 路由与错误分类
npx vitest run tests/unit/opencode tests/unit/routes
```

跳过不等于通过：Rust 二进制没构建时集成测试会报 skipped，这时契约测试只覆盖 TypeScript 一侧。

## 停用或回滚

1. `opencode.rust_routing.enabled` 改回 `false` → 只用 TypeScript adapter，不再 spawn Rust。
2. `opencode.enabled` 改回 `false` → 取消前缀占用，恢复原有 Codex / Custom 路由规则；凭据不会被删除。
3. 关闭后不要把 `opencode:` / `ocgo:` 继续发给 App 并假定它仍属于 OpenCode 家族。
4. 回退 App 版本时，先停 App，再使用此前保留的构建与配置备份；不要覆盖 Codex / Custom 数据。
   `data/opencode-keys.json`（旧名 `data/ocgo-keys.json`）单独保存在受限目录，退出功能不必删除它。
