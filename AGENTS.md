## 多 Agent 工作流

- 仅在用户明确授权或任务明确要求时启用；完整规则见 `docs/MULTI_AGENT_WORKFLOW.md`。
- 默认在满足最低安全和验收要求的前提下，优先减少总 token、credits、费用与重复阅读。
- 开工前按语义难度、修改范围、可验证性、失败后果和上下文负担预分类。
- 使用预计可完成任务的最低成本执行体；高性能执行体只用于关键推理、弱机械验收或高后果节点。
- 简单任务不为使用多 Agent 增加调度成本；并行优先用于互不重叠的只读工作。
- 同一工作树和合同域保持单写者；Reviewer/Verifier 默认只读。
- 子 Agent 使用最小上下文、稳定公共前缀与增量证据，避免完整历史复制和重复读取。
- 多 Agent 授权不扩大网络、真实 API、外部写入、提交、发布或破坏性操作权限。
- 达到当前任务验收或停止条件后立即停止，不自动进入下一票据。

## 桌面版构建与打包（Windows）

完整流程、命令与排错顺序见 `docs/BUILD_AND_RELEASE.md`；这里只列必须遵守的硬规则。

- **启动验证前先清 `ELECTRON_RUN_AS_NODE`**：该变量存在时 `OpenCodeX-Router.exe` 会按纯 Node 运行，表现为"没有窗口、没有进程、退出码 0/9、无输出"。用 `ProcessStartInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')` 启动，再以进程数 + 8080 监听 + `GET /` 200 三项一起判定成功。
- **打包必须"先 prepack 后打包、最后 postpack"**（`npm run prepack` → `npx electron-builder ...` → `npm run postpack`），否则 `config/`、`public/`、`bin/`、`native/` 不会进入 `packages/electron/`。
- **路径过滤器先归一化分隔符再匹配**：Windows 上 `src.slice()` 给的是反斜杠转义，只用 `/target` 的正则永远不命中；`native/target` 曾因此被打进包，成品由 300 MB 膨胀到 1.1 GB。`native/ocx-router/.exe` 需要单独复制。
- **Windows 必须同时产出 setup 与 portable**：`win.target` 同时列 `nsis` 与 `portable`，并给 `nsis.artifactName` / `portable.artifactName` 分别命名，否则两者同名互相覆盖。CI 用 `electron-builder.ocx.yml`（输出 `release-ocx/`），本地用 `electron-builder.yml`（输出 `release/`）。
- **本地没有符号链接权限时**：`winCodeSign` 内含 macOS 符号链接，非管理员解包会失败（`Cannot create symbolic link`）。用 `--config.win.signAndEditExecutable=false` 跳过，或开启 Windows 开发者模式；CI 的 Windows runner 是管理员，可正常产出 nsis/portable。
- **首次打包需要下载 electron 与 nsis 工具包**：本机直连 GitHub 会超时，需设置 `HTTPS_PROXY=http://127.0.0.1:7897`。
- **改 `.github/workflows/**` 后先跑 `node scripts/check-workflows.cjs`**：YAML 缩进错误会让整个工作流失效，GitHub 只返回 0 秒失败且无日志，容易误判成「标签推送没触发」。
- **发布只走 `ocx-v*` 标签**，推送即触发 `.github/workflows/ocx-release.yml`（校验 → 构建 → 冒烟 → draft → 校验资产与 SHA256 → 转 prerelease），永不覆盖既有标签或上游仓库。

## Gemini / Antigravity Schema 与日志


- Gemini / Antigravity 的工具参数及结构化输出 schema 必须按 Gemini 支持的字段白名单清洗；清除 `prefixItems` 等不支持字段后，如果 schema 仍为 `type: array` 且缺少 `items`，需补宽松的 `{}` schema，避免 Gemini 的 `missing field` 校验错误。为此类变换补充嵌套 schema 回归测试。
- 持久化请求/错误诊断时，必须先脱敏并限制单条记录和文件大小；不要提交临时的原始 tools / request dump，也不要记录凭据。

## PR 合并策略

- 所有以 `dev` 或 `main` 为目标分支的 PR，必须使用 Squash merge 压缩合并。
- 禁止使用普通 merge commit 或 rebase merge 合入 `dev` / `main`。

## PR 合并后的自动同步

- PR 合并到 `dev` 后，默认自动同步主工作目录的本地 `dev`，无需再次询问用户；执行前确认当前分支为 `dev` 且工作区干净，然后运行 `git pull --ff-only origin dev`。
- 若主工作目录不在 `dev`、有未提交改动或无法快进，停止自动拉取并说明原因；不得擅自切换分支、stash、reset、覆盖改动或创建合并提交。不得改动其他任务的工作树。
- 同步成功后核对本地 `dev` 与 `origin/dev` 的提交是否一致，并在完成报告中说明同步结果。

## Keepalive safety

- Account keepalive is disabled by default. Enabling the scheduler or calling `POST /admin/keepalive-run` sends real requests to `/codex/usage`; unit tests must mock `CodexApi`, and real-account execution requires explicit user authorization.

## 提交规范

- **Angular convention**：`type(scope): 说明`，type 限定为 `build|ci|docs|feat|fix|perf|refactor|revert|style|test`。
- **提交信息必须包含汉字**：type 与 scope 用英文，说明部分用中文写清「改了什么、影响什么」。规则由 `commitlint.config.mjs` 强制（自定义 rule `commit-message-han`）。
- 手动校验：`npx commitlint --edit .git/COMMIT_EDITMSG`；提交时由 `.vite-hooks/commit-msg` 自动执行。
- **Node 依赖统一用 `vp` 管理**：`vp install`、`vp install -D <pkg>`、`vp run <script>`、`vp exec <cmd>`；不要直接用 npm/pnpm 增删依赖（`vp` 底层用 npm，`package-lock.json` 仍是唯一锁文件）。
- Git 钩子由 `vp hooks enable` 安装（`core.hooksPath=.vite-hooks/_`）。新克隆后先执行一次，否则提交时不会校验。
- **改动即提交**：完成一个可验证的改动批次后按主题立即提交，不要把大量改动长期留在工作区；提交前至少跑过 `npx tsc --noEmit` 与相关测试。

