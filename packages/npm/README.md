# OpenCodeX-Router

OpenAI 兼容的 Codex Responses API 网关，带 Web 面板、多账号密钥池与 Ollama 兼容桥接。这是完整应用包：面板、账号管理与 Ollama 桥接的行为与桌面版、Docker 版一致。

## 安装

要求 Node.js 22.13+（使用内置 `node:sqlite`）。

安装来源、镜像与离线包的获取方式见仓库 README 与 Releases 页面。包内入口脚本同时提供两个命令名：`opencodex-router`，以及上游兼容别名 `codex-proxy`。

```bash
opencodex-router              # 启动服务并打开面板
opencodex-router --mode=server   # 纯服务端
opencodex-router --mode=browser  # 强制使用系统浏览器
opencodex-router --help          # 全部参数
```

首次启动时面板默认在 `http://127.0.0.1:8080`（可用 `--port` 或 `PORT` 修改）。Windows 下面板使用系统浏览器；桌面版与 Lite 包附带 WebView2 宿主，npm 包不含。

运行数据（账号、配置、用量历史）保存在用户数据目录，更新包不会丢失；`CODEX_PROXY_DATA_DIR` 或 `--portable` 可改位置。平台相关的 TLS native addon 会按操作系统与架构自动安装，其他平台的二进制不会被下载。

## 链接

- 仓库：<https://github.com/LeonhardtHUST/codex-ocgo-proxy>
- 文档与截图：见仓库 README

## 许可证

非商业许可，全文见包内 `LICENCE`。
