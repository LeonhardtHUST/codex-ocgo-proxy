# BRANDING_MAP — 上游个人印记与改名清单

只读侦察产出。范围：`D:\Projects\GitHub\codex-ocgo-proxy`（已排除 `node_modules`、`dist`、`.git`；lock 文件单独说明）。
目标品牌名：**OpenCodeX-Router**（下文简称 OCR）。行号以当前 `dev` 工作区为准。

**总原则**：删除原作者的推广/募捐/个人叙事；保留许可证全文、上游血缘声明与社区贡献者致谢。改名只覆盖产品身份，不改协议语义（如 `CODEX_PROXY_*` 环境变量属于兼容面，见 §2.3）。

---

## 0. 结论速览

| 项 | 现状 | 影响面 |
|---|---|---|
| 个人推广印记 | 5 份 README + 2 张二维码图片 | 20 处，纯文档删除，零代码风险 |
| 上游身份（人名/组织） | `icebear0828` 出现在代码常量、CI 守卫、npm scope、GHCR 路径 | 高：改错会断更新源或让 CI 全绿空跑 |
| 上游仓库守卫 | 14 个 workflow 中 9 个含 `github.repository == 'icebear0828/codex-proxy'` | 高：在 fork 上这些 CI 全部不触发 |
| 上游血缘声明 | 仅 `OCGO_RELEASE.md` 有；README 完全没有 | 必须新增，否则违反 LICENCE 第 4 条精神 |
| 许可证 | `LICENCE` 非商业 1.0，中英双语，无个人署名 | 保留，可追加 fork 归属附录 |
| CREDITS 文件 | **不存在** | 需新建，承接贡献者致谢 |
| 个人邮箱 / 主页 | **未发现**（无 `mailto:`、无个人域名） | 无需处理 |

---

## 1. 原作者个人印记

### 1.1 X / Twitter 徽章

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| README.md:36 | `<a href="https://x.com/IceBearMiner">` + badge `Follow-@IceBearMiner` | **删除**整行 | P0 |
| README_EN.md:36 | 同上 | **删除** | P0 |
| README_HK.md:36 | 同上 | **删除** | P0 |
| README_JA.md:36 | 同上 | **删除** | P0 |
| README_TW.md:36 | 同上 | **删除** | P0 |

### 1.2 微信赞赏 / Telegram 二维码

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| README.md:38 | badge `赞赏-微信` 指向锚点 `#-赞赏--交流` | **删除** | P0 |
| README.md:45-47 | `<img src="./.github/assets/donate.png">` + `<sub>☕ 赞赏</sub>` | **删除**表格单元格 | P0 |
| README.md:49-50 | `<img src="./.github/assets/tgimage.png">` + `<sub>💬 Telegram</sub>` | **删除** | P0 |
| README.md:1232-1234 | 章节「☕ 赞赏 & 交流」，正文「请作者喝杯咖啡，或加入 Telegram 交流群」 | **删除整节** | P0 |
| README_EN.md:38 | badge `Donate-WeChat` 指向 `#-donate`（锚点与标题已不匹配，本身已坏） | **删除** | P0 |
| README_EN.md:974-989 | 章节 `☕ Donate & Community` + donate/tgimage 表 | **删除整节** | P0 |
| README_EN.md:980,984 | donate.png / tgimage.png | **删除** | P0 |
| README_HK.md:38,45-50 | 同中文版（讚賞） | **删除** | P0 |
| README_HK.md:582 | 章节「☕ 讚賞 & 交流」 | **删除整节** | P0 |
| README_JA.md:38,45-50 | 同（寄付） | **删除** | P0 |
| README_JA.md:1092-1094 | 章节「☕ 寄付 & コミュニティ」，正文提到 WeChat 群 | **删除整节** | P0 |
| README_TW.md:38,45-50 | 同 | **删除** | P0 |
| README_TW.md:582 | 章节「☕ 贊賞 & 交流」 | **删除整节** | P0 |
| .github/assets/donate.png | 微信赞赏码位图 | 移入 `docs/upstream/` 归档，或直接删除（建议删除并留 git 历史） | P1 |
| .github/assets/tgimage.png | Telegram 群二维码 | 同上 | P1 |

### 1.3 个人叙事 / 第一人称 / Star 曲线

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| README.md:1238 | 「Codex Proxy 最初只是一个个人自用项目……超乎预期的关注与支持」 | 改写为中性项目简介，或并入 CREDITS 的「由 icebear0828 创建」一句 | P1 |
| README.md:1246 | 第一人称「**正是你们的认可与喜爱，让我一直坚持维护**」 | **删除**或改为第三人称中性致谢 | P1 |
| README.md:1250 | `star-history.dera.page/svg?repos=icebear0828/codex-proxy` | **删除** Star History 整节（第三方图表指向他人仓库） | P1 |
| README_EN.md:993 | 同 1238 英文版「started as a personal project to scratch my own itch」 | 改写/并入 CREDITS | P1 |
| README_EN.md:1001 | 「what has kept **me** going」 | **删除**或改第三人称 | P1 |
| README_HK.md:588,596,600 | 同中文版三处 | 同上 | P1 |
| README_TW.md:588,596,600 | 同上 | 同上 | P1 |
| README_JA.md:1098,1106,1110 | 同（日本語版） | 同上 | P1 |

### 1.4 社区贡献者名单（**不是**个人印记，应保留）

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| README.md:1240-1242 / README_EN.md:995-997 / HK·TW:590-592 / JA:1100-1102 | 19 位 GitHub 贡献者 @handle 列表 | **保留**，迁移到新建 `CREDITS.md`，README 保留一句链接 | P2 |
| README.md:1244 等各语言对应行 | 感谢 Issues 提交者的段落 | 保留（去掉 `icebear0828/codex-proxy/issues` 外链，改为本仓 issues 或纯文字） | P2 |

### 1.5 未发现项

- 个人邮箱：全仓无 `mailto:`、无 `@qq.com` / `@gmail.com` 等。
- 个人主页 / 博客：无。
- Bilibili / 微博 / 小红书 / Discord：无。
- `.github/FUNDING.yml`：不存在（无 GitHub Sponsors 配置）。
- 结论：个人印记集中在 README 头部徽章区与文末「赞赏&交流 / Star History」两处。

---

## 2. 仓库 / 项目名标识

### 2.1 必须改（产品身份，缺一即品牌穿帮）

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| package.json:2 | `"name": "codex-proxy"` | → `opencodex-router` | P0 |
| package.json:3 | `"version": "2.1.26"` | 起始版本另定（建议 `3.0.0`） | P1 |
| package.json:4 | description 含 `Codex Desktop Responses API` | 协议描述保留，去掉产品名冲突 | P2 |
| packages/electron/package.json:2 | `"name": "@codex-proxy/electron"` | → `@opencodex-router/electron` | P0 |
| packages/electron/package.json:4 | description `Codex Proxy desktop app` | → `OpenCodeX-Router desktop app` | P0 |
| packages/electron/package.json:8 | `"author": "codex-proxy"` | → OCR 维护者名 | P1 |
| packages/electron/electron-builder.yml:1 | `appId: com.codex-proxy.app` | → `com.opencodex.router` | P0 |
| packages/electron/electron-builder.yml:2 | `productName: Codex Proxy` | → `OpenCodeX-Router` | P0 |
| packages/electron/electron-builder.yml:6-8 | `publish.owner: icebear0828` / `repo: codex-proxy` | 指向本仓 fork；或 `publish: null` | **P0 最高风险** |
| packages/electron/electron-builder.yml:10 | `artifactName: Codex-Proxy-${version}-...` | → `OpenCodeX-Router-${version}-...` | P0 |
| packages/electron/electron-builder.ocgo.yml:17 | `appId: com.ocgo.codexproxy.unofficial` | → `com.opencodex.router.unofficial` | P0 |
| packages/electron/electron-builder.ocgo.yml:18 | `productName: Codex Proxy OCGo (unofficial)` | → `OpenCodeX-Router (unofficial)` | P0 |
| packages/electron/electron-builder.ocgo.yml:20 | `executableName: codex-proxy-ocgo-unofficial` | → `opencodex-router-unofficial` | P0 |
| packages/electron/electron-builder.ocgo.yml:23 | `artifactName: Codex-Proxy-OCGo-unofficial-...` | 同步改名 | P0 |
| packages/electron/electron-builder.ocgo.yml:57-59 | `extraMetadata.name` / `productName` | 同步改名（决定用户数据目录） | P0 |
| packages/electron/electron/constants.ts:2 | `GITHUB_REPO = "icebear0828/codex-proxy"` | → 本仓 `owner/repo` | P0 |
| src/self-update.ts:83 | `GITHUB_REPO = "icebear0828/codex-proxy"` | → 本仓；OCGO build 已跳过查询，但源码模式仍用 | P0 |
| src/self-update.ts:84 | `GHCR_IMAGE = "icebear0828/codex-proxy"` | → 本仓镜像或置空（fork 不发 Docker） | P1 |
| src/routes/admin/update.ts:140 | npm 升级提示 `@icebear0828/codex-proxy@latest` | → OCR scope；fork 不发 npm 时应改为「手动下载 Release」 | P1 |
| packages/npm/package.json:2 | `"name": "@icebear0828/codex-proxy"` | → `@opencodex-router/cli`（或按发布通道定） | P1 |
| packages/npm/package.json:6-8 | `bin: {"codex-proxy": "bin/codex-proxy.mjs"}` | → `opencodex-router` | P1 |
| packages/npm/package.json:33,35,36 | repository / homepage / bugs 指向上游 | → 本仓 URL | P1 |
| packages/npm/README.md:1,12,17,20,37-39,43 | 标题与安装命令含 `@icebear0828` | 同步改名 | P2 |
| native/patch-loader.mjs:24 | `CODEX_NPM_SCOPE \|\| 'icebear0828'` | 默认值改 OCR scope | P1 |
| native/index.js:14 | 同上 | 同上 | P1 |
| scripts/npm/stage-npm-packages.mjs:68,109,121 | scope 默认值 `icebear0828` | 同上 | P1 |
| scripts/portable/win-launcher.c:13 | `RELEASES_URL = github.com/icebear0828/codex-proxy/releases/latest` | → 本仓 | P0 |
| scripts/portable/win-launcher.c:579 | MessageBox 标题 `Codex Proxy` | → OCR | P1 |
| scripts/portable/server.mjs:15 | `ELECTRON_USER_DATA_SCOPE = ["@codex-proxy","electron"]` | 跟随 electron 包名改 | **P1 数据迁移风险** |
| scripts/portable/build-portable.mjs:301 | 归档名 `codex-proxy-<ver>-no-node-lite-...zip` | 同步改名 | P1 |
| scripts/portable/build-portable.mjs:134-135,312,331-337 | `codex-proxy.exe` / `.sh` / `.cmd` / `name` | 同步改名 | P1 |
| Dockerfile.lite:46 | `COPY codex-proxy.sh ./` | 同步改名 | P1 |
| docker-compose.yml:2-3 | 服务名 `codex-proxy` + `image: ghcr.io/icebear0828/codex-proxy:latest` | → OCR 镜像；fork 不发镜像则改注释说明 | P0 |
| docker-compose.yml:45 | Watchtower 注释 `--interval 3600 codex-proxy` | 同步改名 | P2 |
| web/index.html:6 | `<title>Codex Proxy</title>` | → `OpenCodeX-Router` | P0 |
| web/index.html:12 | localStorage key `codex-proxy-theme` | → `ocr-theme`（记一条迁移或直接放弃旧偏好） | P2 |
| web/src/components/Header.tsx:82,83,90,91 | 品牌文字与 `alt="Codex Proxy"` | 改 OCR | P0 |
| web/src/components/Header.tsx:97 | Star 链接指向上游仓库 | → 本仓 | P0 |
| web/src/components/Sidebar.tsx:28,75 | 同上 | 改 OCR | P0 |
| web/src/components/Footer.tsx:20 | `Codex Proxy v{version}` | 改 OCR | P0 |
| web/src/components/UpdateModal.tsx:204,207 | npm 命令含 `@icebear0828` | 与 §2.1 update.ts 同步 | P1 |
| shared/i18n/translations.ts:154,831,1546,2259,2972 | footer `© 2026 Codex Proxy ...`（5 语言） | 改 OCR | P0 |
| DESIGN.md:3,314,318 | `name: Codex Proxy` / 设计系统标题与正文 | 改 OCR（设计系统文档，非运行面） | P2 |
| API_CN.md:1 / API.md:1 / API_HK.md:1 / API_JA.md:1 / API_TW.md:1 | `# Codex Proxy API ...` 标题 | 改 OCR | P1 |
| README*.md:3（5 份） | `<h1>Codex Proxy</h1>` 及副标题 | 改 OCR + 重写一句定位 | P0 |
| opencode.json:4,6 | provider id `codex-proxy` / name `Codex Proxy` | 改 OCR（示例配置，影响外部客户端模板） | P1 |
| package-lock.json:2,8 | 根 `name: codex-proxy` | 随 `npm install` 重生成，勿手改 | P1 |
| package-lock.json:112,7578 | `node_modules/@codex-proxy/electron` | 随 workspace 包名重生成 | P1 |
| package-lock.json:995,8074,8087 | `@icebear0828/codex-proxy` + `bin.codex-proxy` | 随 packages/npm 重生成 | P1 |
| .github/workflows：release.yml:26,478；docker-publish.yml:23,139,201；npm-publish.yml:41,98,185；bump-electron.yml:21；bump-electron-beta.yml:20；promote-dev-to-main.yml:27；sync-changelog-series.yml:17；sync-model-pricing.yml:18 | `if: github.repository == 'icebear0828/codex-proxy'` | 改为本仓 `LeonhardtHUST/codex-ocgo-proxy`（或新仓名），否则 fork 上全部 CI 静默不跑 | **P0 最高风险** |
| .github/scripts/sync-changelog-series.mjs:6 | `REPOSITORY_URL = "https://github.com/icebear0828/codex-proxy"` | 与上一条同批改 | P1 |
| release.yml:265,270 | 资产 glob `Codex-Proxy-*-linux*` / `-win*` | 随 artifactName 同步，否则发布脚本抓不到产物 | **P0** |
| lite-ci.yml:189,229,251,259,267,276 | `codex-proxy-lite-*` / `codex-proxy.sh` | 随 Lite 产物改名 | P2 |

### 2.2 可保留（上游血缘说明，删除会构成不当得利）

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| LICENCE:1,4,12,72 | 标题与主体使用 "Codex Proxy" 名称、`Copyright (c) 2026 Codex Proxy authors and contributors` | **保留原文不改**；在文末追加「本仓库为 Codex Proxy 的衍生版本，原许可条款完整适用于原始部分」附录 | **P0 不可删** |
| CHANGELOG.md:13,224,722,1144-1257 | 版本标题外链 `github.com/icebear0828/codex-proxy/releases` | **保留**为上游历史；文件顶部加一段「v2.1.26 及以前来自上游」说明 | P2 |
| CHANGELOG.md:147,157,186 等正文 | 叙述中出现 `@icebear0828/codex-proxy`、`ghcr.io/icebear0828/...` | 保留（历史记录的事实描述），不改写历史 | P2 |
| OCGO_RELEASE.md:3-4 | 明确写「上游 `icebear0828/codex-proxy`」「产物标注 unofficial」 | **保留并升级**为统一的上游声明（其他文档引用它） | P0 |
| tests/unit/routes/responses-*.test.ts:3、account-pool-team-dedup.test.ts:6 | 注释里引用上游 issue 编号 | 保留（溯源证据） | P3 |
| tests/unit/self-update*.test.ts、npm-package.test.ts、auto-updater.test.ts | 夹具中的上游仓库名与 scope | 随 §2.1 常量改动同步调整断言，不当作品牌债 | P2 |
| README*.md 贡献者 @handle 列表 | 社区贡献者 | 保留（迁 CREDITS） | P2 |

### 2.3 不动（兼容面 / 第三方 / 无品牌语义）

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| `CODEX_PROXY_*` 环境变量（\~50 处：Dockerfile:30、docker-compose.yml:37、README 配置表、src/config*.ts、scripts/portable/*） | 如 `CODEX_PROXY_HOST`、`CODEX_PROXY_DATA_DIR`、`CODEX_PROXY_DEBUG_DUMP` | **不动**。这是已发布的用户配置面，改名会静默破坏升级用户；如需品牌化，走「新名 + 旧名兼容」双读，列为独立票 | — |
| `codex-proxy` 作为 Codex CLI provider id（README:376-377,658,693,719,740 等示例） | 用户 config.toml 里的 `[model_providers.codex-proxy]` | **不动**（协议/客户端契约示例），或全量换成 OCR 但需同步 README 5 语言示例 | P3 |
| web/package-lock.json、native/package-lock.json 中全部 `github.com/sponsors/*` | 第三方包赞助链接 | **不动** | — |
| package-lock.json 中全部第三方 sponsor 链接（\~100 处） | 同上 | **不动** | — |
| .github/guides/screenshots/step-01..08.png | 界面截图 | 不改图；换品牌后如需重新截图列为独立任务 | P3 |
| Dockerfile:38,67 / Dockerfile.lite:42-43 / docker-entrypoint.sh | `codex-tls.*.node`、`CODEX_ARCH` | 不动（native addon 产物名，与品牌无关） | — |
| opencode.json:2 | `$schema` 指向 opencode.ai | 不动 | — |

---

## 3. 上游声明现状

| 项 | 现状 | 结论 |
|---|---|---|
| README 中的 upstream / fork 声明 | **完全没有**。5 份 README 全篇无「fork」「上游」「derived from」字样（grep `upstream/上游/fork/衍生` 仅命中业务语义的「上游响应头、上游模型」） | **必须新增**。建议在每份 README 头部 h1 下方加一行 fork 声明 + 链接 `CREDITS.md` |
| `OCGO_RELEASE.md:1-4` | 唯一有血缘声明处：「fork 的非官方发布通道……不构成上游项目或其维护者的背书」 | 保留，抽成可复用段落 |
| `.github/workflows/ocgo-release.yml:504` | Release notes 首行 `**Unofficial fork build — not affiliated with, endorsed by, or supported by the upstream project.**` | 保留，改名后同步文案 |
| LICENCE 条款 | 非商业 1.0，中文优先、英文对照。第 2 条允许非商业复制修改；第 3 条禁商用；**第 4 条要求分发时随附全文、保留著作权与许可声明、修改版须标明已修改且不得冒充官方版**；第 5 条声明与 OpenAI 无关联 | 改名与去个人化都合规，但**必须**保留 LICENCE 全文与「已修改」标注 |
| CREDITS / CREDITS.md / THIRD-PARTY-NOTICES | **均不存在**（`packages/npm/package.json:17` 的 `files` 里列了 `THIRD-PARTY-NOTICES.txt`，但仓库内无此文件 → **悬空引用，需补或删**） | 新建 `CREDITS.md` + 补 `THIRD-PARTY-NOTICES.txt` |
| README 致谢章节 | 存在：README.md:1236「🙏 贡献致谢」/ EN:991 / HK·TW:586 / JA:1096 | 保留章节，正文迁 CREDITS，去掉个人叙事 |
| CHANGELOG 对上游的引用方式 | 版本标题直接外链上游 releases（13、224、722……）；正文以「新增/修复」叙述，多处点名 `@icebear0828/codex-proxy` 与 `ghcr.io/icebear0828/...` | 不改写历史；在 CHANGELOG 顶部加一行来源说明 |
| LICENCE 引用的旧分支名 | `packages/npm/README.md:43` 链接 `/blob/dev/LICENCE` | 随仓库 URL 更新 |

---

## 4. 版本号与发布通道

`OCGO_RELEASE.md` 定义的 fork 发布线现状：

| 维度 | 现状值 | 改为 OCR 后需同步 |
|---|---|---|
| 通道标签 | `ocgo-v<semver>-beta.<n>`（`OCGO_RELEASE.md:9`、`ocgo-release.yml:26,78,85`） | tag 前缀与正则；建议 `ocr-v*`（若换前缀，`release.yml:478` 等 `v*` 过滤器仍不会误命中，安全性不变） |
| 打包配置 | `packages/electron/electron-builder.ocgo.yml`（整份 4 处身份字段） | 文件名 `electron-builder.ocr.yml` + 调用点 |
| 工作流 | `.github/workflows/ocgo-release.yml`（`name: OCGO Release (unofficial fork build)`） | 文件名 + `name` + 全文 `ocgo` 字面量 |
| appId | `com.ocgo.codexproxy.unofficial` | `com.opencodex.router.unofficial` |
| productName | `Codex Proxy OCGo (unofficial)` | `OpenCodeX-Router (unofficial)` |
| 可执行文件名 | `codex-proxy-ocgo-unofficial` | `opencodex-router-unofficial` |
| 打包内 `name` | `codex-proxy-ocgo-unofficial`（决定用户数据目录） | 同步改；**旧用户数据不会自动迁移，需在 release notes 写明** |
| 产物名 | `Codex-Proxy-OCGo-unofficial-<ver>-<os>-<arch>.<ext>` | `OpenCodeX-Router-unofficial-...` |
| docs 附件 | `ocgo-docs.zip`（LICENCE + OCGO_LOCAL.md + 两份示例配置） | `ocr-docs.zip`；对应脚本在 `ocgo-release.yml` publish job |
| smoke 附件 | `ocgo-win-smoke-log`、`ocgo-linux-smoke-log`、`ocgo-win-x64`、`ocgo-linux-x64` | 同步改名 |
| smoke 脚本 | `.github/scripts/electron-smoke.ps1 -Ocgo`、`packages/electron/electron/ocgo-smoke-linux.sh`、`apply-ocgo-smoke-config.mjs` | 文件名与 `-Ocgo` 开关 |
| 构建注入 | `OCGO_BUILD=1` → `__OCGO_BUILD__`（`build.mjs`、`main.ts:325`、`self-update.ts:80-82,517`） | 可保留（内部构建标志，用户不可见）；若追求彻底可改 `OCR_BUILD` |
| 输出目录 | `packages/electron/release-ocgo` | `release-ocr` |
| 隔离策略 | `publish: null` 强制无更新源，构建阶段断言无 `app-update.yml` | **保留**，这是 fork 与上游身份隔离的关键 |

**改名的连带约束**：`appId` / `productName` / `executableName` / `extraMetadata.name` 四者共同决定安装器入口、快捷方式、用户数据目录、electron-updater 缓存目录。四处必须同一批改，否则出现「新旧两套数据目录并存」。

---

## 5. i18n

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| shared/i18n/translations.ts:340 | `ocgoKeys: "OCGo"`（zh） | 改 OCR 对应文案（如 `OpenCodeX 后端`）；**key 名保留**（路由与组件引用 `ocgoKeys`，改名要同步 `navigation.ts`） | P1 |
| :1017 / :1732 / :2445 / :3158 | 同上 4 个语言（zh-TW / zh-HK / ja / en） | 同上，5 处同批 | P1 |
| :154 / :831 / :1546 / :2259 / :2972 | `footer: "© 2026 Codex Proxy ..."` | 改 OCR | P0 |
| web/src/navigation.ts:16 | `{ hash: "#/ocgo", label: "ocgoKeys" }` | 若要彻底去 ocgo：改 hash + key + 路由（`App.tsx:259`） | P1 |
| web/src/pages/OCGoKeysPage.tsx:113 | 硬编码 `<h1>OCGo</h1>`（未走 i18n） | 改 OCR；顺带抽成 i18n key | P1 |
| OCGoKeysPage.tsx:121,123,149 | 中英文内联 `label("...", "...")` 双语文案 | 改 OCR 措辞（功能文案，不必品牌化过深） | P2 |

**注意**：`ocgoKeys` 之外的 OCGo 大量代码标识（`src/auth/ocgo-*.ts`、`src/proxy/ocgo-*.ts`、`src/ocgo-config.ts`、`module ocgo` 命名空间）属于内部实现，不在品牌范围，建议**不动**（改动只会增加回归面）。

---

## 6. 面向用户的入口

| 文件:行号 | 现状 | 处置 | 优先级 |
|---|---|---|---|
| web/src/navigation.ts:16 | 侧栏 OCGo 入口 | 见 §5 | P1 |
| web/src/App.tsx:16,259-260 | 路由分支渲染 `OCGoKeysPage` | 跟随 hash 改名（若改） | P2 |
| web/src/components/Header.tsx:82-91 | 顶部品牌名与 logo alt | 改 OCR | P0 |
| web/src/components/Header.tsx:96-106 | 「Star on GitHub」按钮 → 上游仓库 | 改本仓 URL，或整体移除该按钮 | P0 |
| web/src/components/Sidebar.tsx:28,75 | 侧栏品牌名 | 改 OCR | P0 |
| web/src/components/Footer.tsx:20 | 页脚产品名 + 版本号 | 改 OCR | P0 |
| web/src/components/UpdateModal.tsx:204,207 | npm 升级命令含 `@icebear0828` | 与 §2.1 同步 | P1 |
| packages/electron/electron/main.ts:228 | 窗口标题 `title: "Codex Proxy"` | 改 OCR | P0 |
| packages/electron/electron/main.ts:325-329 | 托盘菜单「OCGo Releases (manual updates)」→ `github.com/LeonhardtHUST/codex-ocgo-proxy/releases` | **已是本仓**，仅需随新仓名/品牌名更新文案与 URL | P0 |
| packages/electron/electron/main.ts:275-278 | `setWindowOpenHandler` 外链统一走系统浏览器 | 不动 | — |
| scripts/portable/webview2-host.cpp:69 | 默认窗口标题 `Codex Proxy` | 改 OCR | P2 |

---

## 7. Git remote 与上游自动化

**remote 现状**

| remote | URL | 用途 |
|---|---|---|
| `origin` | `https://github.com/LeonhardtHUST/codex-ocgo-proxy.git` | 本 fork，push 目标 |
| `upstream` | `https://github.com/icebear0828/codex-proxy.git` | 上游，只读参考（**保留**，是血缘与同步来源） |

**上游自动化盘点**

- **不存在** upstream-sync / rebase-fork 类 workflow。14 个 workflow 全清单：`bump-electron.yml`、`bump-electron-beta.yml`、`ci-docker.yml`、`ci-quality.yml`、`docker-publish.yml`、`lite-ci.yml`、`native-ci-matrix.yml`、`native-musl-ci.yml`、`npm-publish.yml`、`ocgo-release.yml`、`promote-dev-to-main.yml`、`release.yml`、`sync-changelog-series.yml`、`sync-model-pricing.yml`。
- 其中 9 个带 `github.repository == 'icebear0828/codex-proxy'` 硬守卫（清单见 §2.1 末段）→ 在 fork 上这些 job **全部被跳过**，属于「CI 看着绿、其实没跑」。
- `ocgo-release.yml:56,203,324,451` 用 `github.repository == 'LeonhardtHUST/codex-ocgo-proxy'` 守卫 → fork 唯一真正生效的发布线。
- `.github/scripts/sync-changelog-series.mjs:6` 硬编码上游仓库 URL（供 `sync-changelog-series.yml` 用），是唯一直接抓取上游仓库元数据的脚本。
- `sync-model-pricing.yml` / `sync-model-pricing.mjs` 抓「上游 API 定价」（业务语义，非仓库），保留。
- `npm-publish.yml:284` 注释明确「runs on the upstream repo and … for fork runs skip publishing and upload tarballs」→ fork 设计上不发 npm，与 §2.1 的 npm 改名结论一致：**fork 侧可只改 scope 而不追求可发布**。

---

## 8. 执行清单（按文件分组）

### A. 删个人推广（8 项，零代码风险，可一次 PR）

1. `README.md` 删 36、38、45-50、1232-1234；改 1238、1246；删 1248-1250。
2. `README_EN.md` 删 36、38、974-989；改 993、1001。
3. `README_HK.md` 删 36、38、45-50、582；改 588、596；删 598-600。
4. `README_TW.md` 同上对应行。
5. `README_JA.md` 删 36、38、45-50、1092-1094；改 1098、1106；删 1108-1110。
6. 删 `.github/assets/donate.png`、`.github/assets/tgimage.png`。

### B. 新增上游声明与 CREDITS（3 个新文件）

7. 新建 `CREDITS.md`：上游项目名 + 原作者 icebear0828 + 上游仓库链接 + 非商业许可说明 + 19 位社区贡献者名单（从 README 迁移）。
8. 5 份 README 的 h1 下方加统一 fork 声明块（一两行，指向 `CREDITS.md` 与 `LICENCE`）。
9. 补 `THIRD-PARTY-NOTICES.txt`（`packages/npm/package.json:17` 已引用但文件缺失）。
10. `LICENCE` **原文不动**，文末追加「本发行版为衍生版本，已修改」附录（满足第 4 条）。

### C. 产品身份改名（代码面，建议同一 PR 原子提交）

11. `package.json`：name / version / description。
12. `packages/npm/package.json` + `packages/npm/README.md`：scope / bin / 三个 URL。
13. `packages/electron/package.json`：name / description / author。
14. `packages/electron/electron-builder.yml`：appId / productName / publish.owner+repo / artifactName。
15. `packages/electron/electron-builder.ocgo.yml`：4 处身份字段 + extraMetadata。
16. `packages/electron/electron/constants.ts`、`src/self-update.ts:83-84`、`src/routes/admin/update.ts:140`：仓库常量与 npm 提示。
17. `native/patch-loader.mjs:24`、`native/index.js:14`、`scripts/npm/stage-npm-packages.mjs:68,109,121`：scope 默认值。
18. `scripts/portable/win-launcher.c:13,579`、`server.mjs:15`、`build-portable.mjs:134-135,301,312,331-337`、`Dockerfile.lite:46`：Lite 产物与启动器名。
19. `docker-compose.yml:2-3,45`：服务名与镜像。
20. `web/index.html:6`（+ 可选 :12 localStorage key）、`web/src/components/{Header,Sidebar,Footer,UpdateModal}.tsx`、`DESIGN.md:3,314,318`。
21. `shared/i18n/translations.ts`：154 / 831 / 1546 / 2259 / 2972 footer；340 / 1017 / 1732 / 2445 / 3158 `ocgoKeys` 文案。
22. `API_CN.md:1`、`API.md:1`、`API_HK.md:1`、`API_JA.md:1`、`API_TW.md:1`、`opencode.json:4,6`。
23. `package-lock.json`：**不手改**，改完 package.json 后 `npm install` 重生成并核对 diff。

### D. CI 守卫与发布线（高风险，需单独 PR + 干跑）

24. 9 个 workflow 的 `github.repository` 守卫改为本仓（清单 §2.1 末段），逐条确认「改后应该跑」而不是「改后炸」。
25. `.github/scripts/sync-changelog-series.mjs:6` 仓库 URL。
26. `release.yml:265,270` 资产 glob 与 `artifactName` 同步（不改则发布 job 抓不到包）。
27. `electron-builder.ocgo.yml` / `ocgo-release.yml` / `OCGO_RELEASE.md` / `electron-smoke.ps1 -Ocgo` / `apply-ocgo-smoke-config.mjs` / `ocgo-smoke-linux.sh` / `release-ocgo` 目录：通道改名一批（建议保留 `OCGO_BUILD` 注入标志不动）。

### E. 明确不改

28. `CODEX_PROXY_*` 环境变量、`codex-tls` addon 名、`Codex CLI provider id` 示例、全部第三方 sponsor 链接、`.github/guides/screenshots/*`、OCGo 内部模块命名。

### F. 顺序建议

`A`（纯文档）→ `B`（声明与致谢，先把法律面补齐）→ `C`（代码身份，原子）→ `D`（CI，独立 PR + 一次 `ocgo-v*-beta` 干跑验证）。

`C` 与 `D` 之间必须插入一次**用户数据目录兼容性确认**：`extraMetadata.name` 与 `ELECTRON_USER_DATA_SCOPE` 任何一处改动都会让老用户「账号消失」，release notes 必须写明旧目录路径与迁移方式。

---

## 9. 落盘说明（提交前必读）

`.gitignore:9` 有 `docs/*`，仅 `!docs/MULTI_AGENT_WORKFLOW.md` 被放行。因此本文件当前是 **untracked / ignored 状态**，`git status` 看不到它。执行本清单前需二选一：

- 在 `.gitignore` 加 `!docs/recon/`（推荐，便于后续 recon 产出沉淀）；
- 或提交时 `git add -f docs/recon/BRANDING_MAP.md`。

同目录下的 `docs/OCGO_IMPLEMENTATION_PLAN.md`、`docs/OCGO_KICKOFF_PROMPT.md`、`docs/OCGO_PROGRESS.md` 同样处于 ignored 状态，仓库里只有 `docs/MULTI_AGENT_WORKFLOW.md` 是受版本控制的。
