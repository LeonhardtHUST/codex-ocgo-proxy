# OCX Release (fork-only, unofficial)

本文件描述 `LeonhardtHUST/codex-ocgo-proxy` fork 的非官方发布通道。它与上游
`icebear0828/codex-proxy` 的发布链路完全独立，产物标注 unofficial，不构成上游
项目或其维护者的背书。

- 工作流：`.github/workflows/ocx-release.yml`
- 打包配置：`packages/electron/electron-builder.ocx.yml`
- 通道标签：`ocx-v<semver>-beta.<n>`（例：`ocx-v2.1.26-beta.1`）
- 产物：Windows x64 NSIS 安装包、Linux x64 AppImage，均为未签名 prerelease
- 附带：`LICENCE`、`ocx-docs.zip`（`LICENCE` + `OCX_LOCAL.md` + 一份配置样例）、
  `SHA256SUMS.txt`

## 明确不产出

- 没有 macOS 包
- 没有 Lite 便携 zip
- 没有 npm 包（GitHub Packages 与 npmjs 都不发）
- 没有 Docker 镜像
- 不写 upstream 仓库、不推送除 `ocx-v*` 之外的任何 ref

## 前置条件

工作流只在本仓库运行（job 内校验 `github.repository`），需要：

1. fork 的 Actions 已启用；
2. `Settings → Actions → General → Workflow permissions` 允许读写，供最后的
   publish job 使用 `GITHUB_TOKEN`（其余 job 只有 `contents: read`）；
3. 待发布提交已合并进 `origin/dev`。工作流在 validate job 用 GitHub compare
   API 校验 tag 解引用后的提交（annotated tag 先 peel 到 commit，不信任
   `GITHUB_SHA`）已包含在 `dev` 历史中，未合并的提交会被拒绝；
4. 打包所需文件已在提交里：`LICENCE`、`OCX_LOCAL.md`、
   `config/ocx.local.example.yaml`。工作区里
   未提交的文件不会进入 CI 构建；缺少任一文件，tag 运行会在 validate 阶段失败。

## 发布步骤

1. 在已合并到 `dev` 的提交上创建附注标签并推送（tag 形状必须匹配
   `ocx-v<semver>-beta.<n>`）：

   ```sh
   git tag -a ocx-v2.1.26-beta.1 -m "OCGO unofficial build 2.1.26-beta.1" <sha-on-dev>
   git push origin ocx-v2.1.26-beta.1
   ```

   标签前缀是 `ocx-v`，不会命中继承工作流的 `v*` 过滤器，因此不会触发
   `Release Electron App`、`Publish npm packages`、`Publish Docker Image`。

2. 工作流执行顺序：

   | 阶段 | 内容 | 权限 |
   | --- | --- | --- |
   | validate | tag 正则与 git 对象校验（HEAD 必须等于 tag peel 后的 commit）、提交可从 `origin/dev` 到达、同名 release 不存在、打包所需文档存在；`npm ci` 锁文件安装；校验 `node:sqlite`（Node 22）可用；package/update 边界测试（含 `self-update.test.ts`）；OCGo 单测 + app 重启集成测试；Web OCGo 页面测试 | `contents: read` |
   | build-windows | 从 tag 提交构建 win32-x64 native addon、Electron 主/服务端 bundle、NSIS 安装包；断言无 `app-update.yml`、`LICENCE` 已嵌入；仅在 unpacked 树应用 smoke 配置覆盖并用隔离 HOME/APPDATA 启动 smoke（`electron-smoke.ps1`） | `contents: read` |
   | build-linux | 同上（linux-x64 gnu addon、AppImage、先校验文件名命中 smoke glob、在 unpacked 树应用 smoke 配置覆盖后用隔离 HOME/XDG 启动 `ocgo-smoke-linux.sh`、xvfb/libfuse2） | `contents: read` |
   | publish | 校验构建产物、打包 docs bundle、生成并本地校验 `SHA256SUMS.txt`、确认同名 release 不存在、创建 **draft**、上传资产、比对资产清单、**重新下载远端资产并校验 checksum**、翻成 prerelease | `contents: write`（仅此 job） |

3. 发布结果：`ocx-v...` 的 prerelease，资产为 `*.exe`、`*.AppImage`、`LICENCE`、
   `ocx-docs.zip`、`SHA256SUMS.txt`。draft 阶段任何校验失败都不会公开半成品；tag
   本身在推送时即公开，这是正常现象。

## 校验

```sh
# tag 提交确实在 dev 历史里
git fetch origin dev --tags
git merge-base --is-ancestor "$(git rev-list -n1 ocx-v2.1.26-beta.1)" origin/dev && echo ok

# 资产完整性与发布状态（含 draft 阶段重下远端资产校验）
gh release view ocx-v2.1.26-beta.1 --repo LeonhardtHUST/codex-ocgo-proxy \
  --json isDraft,isPrerelease,assets
gh release download ocx-v2.1.26-beta.1 --repo LeonhardtHUST/codex-ocgo-proxy --dir /tmp/ocgo-assets
cd /tmp/ocgo-assets && sha256sum -c SHA256SUMS.txt
```

## 身份与更新隔离

- `appId`：`com.opencodex.router.unofficial`
- `productName`：`OpenCodeX-Router (unofficial)`
- 可执行文件名：`opencodex-router-unofficial`
- 打包内 `name`：`opencodex-router-unofficial`（用户数据目录与 electron-updater
  缓存目录据此隔离；updater 实际不会初始化，也不会创建缓存目录）
- 打包配置显式设置 `publish: null`，禁止自动发现发布源；工作流在
  build 阶段断言该文件不存在。`OCX_BUILD=1` 使 `packages/electron/electron/build.mjs`
  在两个 bundle 中注入 `__OCX_BUILD__`，`main.ts` 与 `src/self-update.ts` 据此跳过
  更新器初始化/查询，缺 feed 时不会回退到上游仓库。

## 打包应用 smoke 的隔离

smoke 只针对 unpacked 树（安装包/AppImage 已在此前构建完成，配置覆盖不会进入产物）：

- HOME / USERPROFILE / APPDATA / LOCALAPPDATA（Windows）与 HOME / XDG_*（Linux）
  指向 runner 临时目录，运行数据与凭据与主机隔离，且数据目录为空、没有账号；
- `packages/electron/electron/apply-ocgo-smoke-config.mjs` 把 unpacked 配置改成
  `model.official_catalog_sync=false`、`pricing.auto_sync=false`、
  `update.auto_update=false`、`account_keepalive.enabled=false`、
  `usage_stats.snapshot_interval_minutes=0`，避免后台目录/定价/更新/keepalive 任务；
- Fork 构建也关闭 Codex 指纹的自动检测与应用，smoke 不读取上游 appcast。

## 回滚

工作流从不删除或覆盖任何 release/tag。需要撤回时由维护者手动执行：

```sh
gh release delete ocx-v2.1.26-beta.1 --repo LeonhardtHUST/codex-ocgo-proxy --yes
git push origin :refs/tags/ocx-v2.1.26-beta.1
```

重发同一版本必须先删除旧 tag/release；重跑不会 `--clobber`，已存在的 release 会被
validate/publish 直接拒绝。

## 已知限制

- 安装包未签名：Windows SmartScreen 与 Linux 桌面环境都会提示未知发布者；
- 只有 Windows/Linux x64，没有 arm64、macOS、Lite、npm、Docker；
- release notes 由工作流静态生成，不经过上游的 LLM notes 服务；
- PR 与手动 dispatch 只跑构建/测试，不会发布；发布条件固定为 `ocx-v*` tag push；
- 同一工作流重复推送同名 tag 会被拒绝，需要先按“回滚”删除旧对象。

## 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| validate: `not reachable from origin/dev` | tag 打在未合并的分支提交上 | 先把提交合入 dev，再在 dev 提交上重新打 tag |
| validate/publish: `release ... already exists` | 同名 release 已存在 | 按“回滚”删除后重发，不要改 tag 名绕过 |
| build: `resources/app-update.yml` 存在 | 误用了 `electron-builder.yml` | 确认命令使用 `--config electron-builder.ocx.yml` |
| publish: 资产清单 diff 失败 | 上传缺件或多余文件 | 检查 build 日志与 `dist/`，修复后删除 draft/tag 重发 |
| smoke 失败但构建成功 | 打包产物无法启动或健康检查超时 | 看失败时上传的 `ocgo-*-smoke-log` artifact |
