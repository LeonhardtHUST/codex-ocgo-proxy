# UI 外壳选型评估：Tauri 重构 / Electron 瘦身 / CLI 控制面

日期：2026-11-21　范围：桌面外壳与发行形态，不含代理路由逻辑

**结论先行**

1. **不建议全量 Tauri 重写**。本仓后端是 Node（Hono + better-sqlite3 + `native/codex-tls` addon），
   Tauri 不带 Node 运行时，所以要么拖一个 Node sidecar，要么把后端整体重写成 Rust。
   前者体积收益接近零，后者等价于重写产品。
2. **1 GiB 的账不在前端**。应用自身 JS/资源只有个位数 MB（实测 `src+web+shared` 源码 2.7 MB、
   `config` 0.1 MB），占地方的是 Chromium 运行时、解包副本与更新器缓存。
   先把账算清，再决定花不花那 30 人日。
3. **真正高性价比的两件事**：发行形态瘦身（1–2 人日）与 CLI 控制面（5–8 人日）。
   Tauri 应排在「后端 Rust 化」之后，那时它才是自然选择。

---

## 1. 现状事实

### 1.1 应用载荷（实测，本机工作树）

| 项 | 体积 | 说明 |
|---|---:|---|
| `src` + `web/src` + `shared`（TS 源码） | 2.7 MB | 编译后进 `public/assets`，产物量级 1–3 MB |
| `config/` | 0.1 MB | 模型目录、定价、指纹样本 |
| `native/*.node` | < 0.1 MB（未构建） | `codex-tls` 原生 addon，构建后约 2–6 MB |
| `node_modules`（开发依赖） | 364.6 MB | **不进发行包**，仅本地开发 |
| `.git` | 12.7 MB | — |

结论：应用逻辑不是体积问题。

### 1.2 桌面外壳实际承担的功能（`packages/electron/electron/main.ts`，12 KB）

`BrowserWindow` 主窗口、`Tray` 托盘（菜单 + 点击唤起）、`requestSingleInstanceLock` 单实例、
`Menu` 应用菜单、`shell.openExternal` 外链、`dialog.showErrorBox` 错误框、
`electron-updater` 自动更新（`auto-updater.ts` 5.5 KB）、关闭窗口转后台常驻（`window-all-closed` 空实现）。
**没有**原生文件对话框业务、没有深度 IPC 业务逻辑、没有原生菜单栏编辑能力。

也就是说：这是一个**薄壳**，把壳换掉的收益上限就是「一个浏览器运行时」。

### 1.3 仓库里已经存在的轻量发行形态

`scripts/portable/` 是一套独立的「No-Node Lite Browser/Server distribution」：

- `win-launcher.c`（27 KB）：原生启动器 + 托盘 +「Open Dashboard / Quit」，`auto` 模式下优先 WebView2，
  失败回落默认浏览器；
- `webview2-host.cpp`（4.7 KB）：WebView2 宿主窗口；
- `server.mjs`（19 KB）+ `build-portable.mjs`（14.8 KB）：起后端、选端口、复用 Electron 的用户数据目录；
- `codex-proxy.sh` / `.cmd`：POSIX 与脚本兜底。

**唯一硬依赖：系统 Node.js ≥ 20。** 这是「1 GiB → 几十 MB」只差一步的地方。

### 1.4 现有发布与更新通道

`electron-builder.yml`：NSIS / dmg+zip / AppImage，`asarUnpack` 含 `bin/` 与 `native/`，
`publish` 指向 GitHub Releases，更新由 `electron-updater` 完成。
portable 发行物**没有更新器**（手动换包）。

### 1.5 1 GiB 的可能构成（待实测确认）

| 组成 | 典型值 | 是否可删 |
|---|---:|---|
| Electron 解包安装目录（Win） | 250–320 MB | 换壳可消 |
| electron-updater 缓存（旧版本，通常留 1–2 份） | 150–300 MB | **可删，与换壳无关** |
| `%LOCALAPPDATA%` 下 Chromium 缓存 / GPU cache | 50–150 MB | 可清 |
| 用户数据（`data/`：sqlite、日志、模型缓存） | 10–100 MB | 不该删 |
| 同时存在便携 zip 与解压副本 | 80–120 MB | 可删 |

**任何 UI 重构决定之前，先跑 §2 的测量脚本**。若大头是更新器缓存与重复副本，
换 Tauri 只能省下第一行那 300 MB 里的一部分，性价比会进一步下降。

---

## 2. 先花 30 分钟把账算清

仓库自带只读报告脚本（已实现，随仓发布）：

```powershell
node scripts/maintenance/disk-report.mjs          # 人类可读表格
node scripts/maintenance/disk-report.mjs --json   # 机器可读（CI / 归档用）
node scripts/maintenance/disk-report.mjs --root D:\Projects\GitHub\codex-ocgo-proxy
```

它把占用分成五类，正好对应五种不同处置：

| 分类 | 含义 | 处置 |
|---|---|---|
| `install` | 安装目录、便携解压副本 | 换发行形态才能消掉 |
| `updater` | electron-updater 下载缓存（旧版本包） | **可安全删除**，与换壳无关 |
| `browser` | Chromium / WebView2 profile 与 GPU 缓存 | 可再生，可删 |
| `user-data` | 账号、Key、日志、模型缓存 | 不该删，属于产品数据 |
| `workspace` | 仓库构建产物（`node_modules`、`target/`、`.git`…） | 只影响开发机 |

脚本不跟随符号链接（避免重复计算与死循环），单目录超过 20 万条目会标记 `[扫描截断]`，**从不删除任何文件**。

### 本机实测（2026-11-21，源码部署）

```text
安装目录 / 便携解压副本     0 B
更新器缓存（旧版本）        0 B
Chromium / WebView2 缓存    0 B
用户数据                   10.8 MB   C:\Users\Leon\AppData\Roaming\@codex-proxy
仓库构建产物              723 MB
                            365 MB  node_modules
                            345 MB  native/ocx-router/target   ← Rust release 构建产物
                             12.7 MB .git
合计                      734 MB
```

两个结论直接影响后续动作：

1. **这台机器上没有 Electron 安装、没有更新器缓存**——「~1 GiB」不可能来自本机源码部署形态，
   需要在你实际安装过 Electron 版的环境中再跑一次这个脚本才能定位。
2. **Rust 构建目录（345 MB）已超过 `.git` 二十多倍**，是开发机上除 `node_modules` 外的最大单块；
   它不进发行包，但会占开发机磁盘，`cargo clean` 可回收。

---

## 3. 三条路线对比

### 路线 A：全量 Tauri（前端复用，后端 Node sidecar）

| 维度 | 评估 |
|---|---|
| 前端改动 | preact + vite 产物可原样装入 Tauri `distDir`，**UI 代码零重写** |
| 后端 | Node 必须随包：SEA/单文件约 85–110 MB（压缩 30–45 MB），或要求系统 Node |
| 安装体积 | Tauri 壳 5–10 MB + Node sidecar 50–80 MB ≈ **55–90 MB** |
| 内存 | 壳 40–70 MB + Node 60–100 MB |
| 启动 | 0.8–1.5 s |
| 三平台 | Windows 需 WebView2 Runtime（Win11 自带，Win10 视版本）；Linux 需 `webkit2gtk-4.1`；macOS 用系统 WKWebView |
| 更新 | Tauri updater 需要签名密钥 + 静态 `latest.json`，与现有 `electron-updater` 通道**不兼容，要重建** |
| 原生 addon | `better-sqlite3` 与 `codex-tls` 仍要在 sidecar 侧加载，路径/ABI 处理与现在同等复杂度 |
| 工作量 | **25–35 人日**（可选功能 8 项 + 三平台打包 + 更新器 + 回归） |

**关键判断：与「portable + 自带 Node」相比，体积差 0–10 MB，内存差 20–40 MB，启动差 0.3–0.7 s。**
换壳换不掉 Node，这是本项目的结构性约束。

### 路线 B：精简 Electron + 已有 portable 升格（推荐）

| 动作 | 人日 | 效果 |
|---|---:|---|
| 更新器缓存治理（保留 N 版、清理残留、`--clean-cache`） | 0.5 | 省 100–300 MB/用户 |
| 主线发行改为 portable（带 Node sidecar） | 1 | 安装体积 300 MB →90–110 MB（带 Node）或 5–8 MB（依赖系统 Node） |
| Electron 包降级为「可选完整版」 | 0.5 | 保留托盘/更新等完整能力 |
| 托盘常驻改用现有 `win-launcher.c` | 0（已实现） | 功能对齐 |

**合计 2 人日，覆盖 80% 的体积/内存收益。**

### 路线 C：Tauri 全 Rust 后端（远期，非本次）

把 Hono 路由、账号池、SQLite、TLS 指纹、协议转换全部 Rust 化。这是另一个项目：
**120–200 人日**，且会与正在进行的 `native/ocx-router`（只做路由层）产生架构重叠。
届时时序会变成「Rust 后端 + Tauri 壳」，单二进制 20–30 MB，才是 Tauri 的真正价值区间。

### 对比总表

| 指标 | 现状 Electron | A: Tauri+Node | B: portable+Node | B′: portable 依赖系统 Node | C: Tauri+Rust |
|---|---:|---:|---:|---:|---:|
| 安装体积（解包） | 250–320 MB | 100–120 MB | 90–110 MB | 5–8 MB | 25–35 MB |
| 用户首次下载 | 90–120 MB | 45–60 MB | 35–50 MB | 5–8 MB | 15–25 MB |
| 常驻内存 | 120–200 MB | 100–170 MB | 100–170 MB | 80–140 MB | 60–100 MB |
| 冷启动 | 1.5–3 s | 0.8–1.5 s | 0.8–1.5 s | 0.8–1.5 s | 0.5–1.2 s |
| 开发投入 | 0 | 25–35 人日 | 2 人日 | 1–2 人日 | 120–200 人日 |
| 更新通道 | 已工作 | 重建 | 手动/复用 | 手动 | 重建 |
| 平台一致性 | 单一 Chromium | 三种 WebView | 单一 Chromium | 单一 Chromium | 三种 WebView |
| 回归风险 | — | 高 | 低 | 低 | 极高 |

---

## 4. 收支比

以「每 1 人日投入换取的用户价值」计：

| 方案 | 投入 | 换来 | 收支比 |
|---|---|---|---|
| 更新器缓存治理 | 0.5 人日 | 100–300 MB/用户、零回归 | **极高** |
| portable 升格为主线 | 1.5 人日 | 200–300 MB/用户、内存 -40%、启动 -50% | **高** |
| CLI 控制面 | 5–8 人日 | 无头部署、脚本化巡检、CI 集成、故障排查提速 | **高**（与 UI 无关，独立成立） |
| Tauri + Node sidecar | 25–35 人日 | 相对 B 再省 0–10 MB、0.3–0.7 s | **低** |
| Tauri + Rust 后端 | 120–200 人日 | 单二进制 25–35 MB | **当前阶段不可回收** |

换算：Tauri 相对 B 的额外收益约 10 MB / 0.5 s，按 30 人日摊，等于**每 1 人日换 0.3 MB**；
而缓存治理是**每 0.5 人日换 100–300 MB**，相差三个数量级。

被牺牲的隐性成本也要计入：
- 三种 WebView 引擎并存 → CSS/JS 行为分歧，问题复现与测试矩阵变三倍；
- Tauri updater 的签名密钥管理与静态托管是新增运维面；
- Linux `webkit2gtk-4.1` 依赖会把「AppImage 一把梭」变成「先装系统库」；
- 现有 `electron-updater` 通道、`ocgo-release.yml` 发行流水线需要重写，这部分不在 25 人日之外。

---

## 5. CLI 控制面（独立收益，建议先做）

现状：`packages/npm/bin/codex-proxy.mjs` 只是**启动器**（spawn 后端），没有控制能力；
服务端 `src/routes/admin/` 已有 12 个路由模块（settings、accounts、client-keys、logs、health、
usage-stats、policy-guard、keepalive、ocgo、ollama、connection、update），**CLI 需要的接口基本齐全**。

设计要点：CLI 只做 HTTP 客户端（回环 + master key），**不复制业务逻辑**，`serve` 复用现有启动器。

```text
opencodex-router <command> [--json] [--server URL] [--key K]

serve                          启动后端（--daemon / --foreground）
status                         版本、健康、provider 状态、目录 stale、协议修正数
providers list|priority <id> <n>
models list|show <id>|refresh
keys list|add|rm|test           opencode 凭据（go/zen/zen-free）
accounts list|login|rm          codex 账号
fallback-graph get|set <file>|validate
zen-free status|reset
logs tail|export
doctor                         配置校验、端口占用、目录权限、上游连通性
update check|apply
```

约定：
- 退出码：`0` 成功 / `1` 通用错误 / `2` 配置错误 / `3` 上游不可达 / `4` 认证失败；
- 输出：TTY 走表格，`--json` 或非 TTY 走 NDJSON；
- 密钥不落日志，`--key` 支持从 `OPENCODEX_ROUTER_KEY` 读取；
- shell 补全（bash/zsh/pwsh）随包发布。

工作量：6–8 人日（含 15–20 个子命令、集成测试、补全脚本）。价值：Docker/无头部署不再需要浏览器，
运维与自助排查从「开面板点」变成一行命令，也为将来的 CI 自检（`doctor --json`）铺路。

---

## 6. 建议路线图

| 阶段 | 内容 | 人日 | 验收 |
|---|---|---:|---|
| P0 | 按 §2 测量 1 GiB 真实构成，出结论文档 | 0.2 | 三个数字：安装/更新缓存/用户数据 |
| P1 | 更新器缓存治理 + 残留清理命令 | 0.5 | 老用户 `--clean-cache` 后体积下降可测 |
| P2 | portable（含 Node sidecar）升格为默认发行，Electron 降级为可选完整版 | 1.5 | 三平台产物 < 120 MB，功能对齐清单逐项勾 |
| P3 | CLI 控制面（`packages/cli`，`opencodex-router` 命令） | 6–8 | `doctor --json` 在 CI 可跑；退出码有测试 |
| P4 | （可选）后端 Rust 化完成后再评估 Tauri | — | 单二进制 < 35 MB 才立项 |

P0–P2 合计约 2.2 人日即可拿掉大部分体积；P3 与本轮正在做的 `/admin/opencode/*` 接口同源，
建议在 W6/W7 完成后立刻做，接口还在手上。

---

## 7. 风险与前提

1. **不要把「体积」当成 UI 框架问题**。本项目 1 GiB 若主要来自更新器缓存与重复副本，换任何壳都不解决。
2. **Tauri 的体积优势依赖「后端不是 Node」**。本项目后端是 Node，这一点在 Rust 化之前不可绕过。
3. **portable 依赖系统 Node** 是当前折中方案的唯一软肋；带 sidecar 可消，代价 +45–60 MB。
4. **更新通道重建**是 Tauri 方案中最容易被低估的一块（签名、托管、灰度、回滚）。
5. **原生 addon**（`better-sqlite3`、`codex-tls`）在任何方案里都必须随包并匹配 ABI，
   SEA 方案需要把它们放在 asar/externals 之外，这与现有 `asarUnpack` 做法同构，风险可控。
