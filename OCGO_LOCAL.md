# OCGo 同机部署与回滚

OCGo 默认关闭。App 管理 Go Key 并负责选 Key；同机的 `ocgo2api-rs` 只转换协议。Codex OAuth 和第三方 API Keys 仍分别在 Dashboard 的账号与 API Keys 页面管理。OCGo 不使用 Codex 账号或 Custom Key 作为备用。

## 启用

1. 准备本 App 的本地构建（已备齐依赖时，在仓库根运行 `npm run build`）和一个通过下方回环验证的 Rust 二进制。保留当前 App 版本及配置的本地备份；凭据文件不进 Git 或普通导出。手工启动两者，不需要安装系统服务。
2. 将 [Rust 配置样例](config/ocgo2api.example.toml)复制到独立的本地目录。保留数字回环监听，`max_retries = 0`、`retry_window_sec = 0` 和 `session_mode = "per_key"`。不要设置 `upstream.api_key`（含 `ocgokey`）、`OCGO2API_API_KEY`，也不要设置 fallback proxy。检查启动环境中没有 `OCGO2API_*` 或兼容变量覆盖端口、上游地址、状态目录、固定凭据或重试配置。用明确的配置路径启动：

   ```powershell
   & $rustExe --config $rustConfig serve
   ```

   `$rustExe`、`$rustConfig` 应是已确认的本机绝对路径。`http://127.0.0.1:8787/health` 只检查进程，不检查 Key 或余额。不要暴露 Rust 的端口和管理端点。回环只限制可达范围，不能认证本机其他进程；只在信任同机进程的环境中部署。
3. 将 [App 配置样例](config/ocgo.local.example.yaml)的 `ocgo` 段合并到 App 的 `data/local.yaml`，把 `enabled` 改成 `true`，保留原来的其他配置。`base_url` 必须是数字回环地址，以 `/v1` 结尾。配置独立、非默认的 App 主访问 Key。启动或重启 App（源码构建版 `npm start`）。如果已有模型、别名或 Custom 供应商占用 `ocgo:`，App 会拒绝启用；先迁移冲突名称，或继续保持关闭。
4. 在 Dashboard 的 **OCGo** 页面新增 Go Key 和模型绑定。表单填 Go 目录中的裸模型 ID；客户端向 App 发送 `ocgo:<model-id>`，认证用 App 客户端 Key，不能用 Go Key。只有确认额度确实共享时才给多个条目填同一个额度组；不确定就留空。启停、替换和删除只影响本地。验证按钮会用单个选定 Key 发出一次短生成请求，可能计费；它不会查官方余额。

仅支持 HTTP `POST /v1/responses`（或 `/responses`）的文本与函数工具；支持 SSE 或收集为 JSON。Compact、Review、Search、Chat、Messages、Gemini、Images、Embeddings、WebSocket 和基于旧响应 ID 的续接不支持 OCGo。内容未知的 429 触发保守退避，不逐把试 Key。Dashboard 显示进程内本地用量，重启清零；官方额度显示未知。

## 回环验收（不联系真实供应商）

不要用上述 Rust 样例的默认上游进行验收。以下测试仅用假 Key，自己创建短生命周期的 Rust 进程，明确将 Go、Zen 和 Native 全部指向回环 mock。不要用系统服务或已有数据目录代替它。

```powershell
$env:OCGO_TEST_RUST_BINARY = 'C:\path\to\ocgo2api-rs.exe'
npm exec --offline -- vitest run tests/integration/ocgo-rust-loopback.test.ts tests/integration/ocgo-app-restart.test.ts tests/unit/routes/ocgo-admin.test.ts tests/unit/routes/ocgo-responses.test.ts
Remove-Item Env:OCGO_TEST_RUST_BINARY
```

若锁定依赖尚未在本地安装且不在缓存中，该命令会失败；不要把跳过测试当成通过。另在 `web` 目录运行 `npm exec --offline -- vitest run src/pages/OCGoKeysPage.test.tsx` 验证表单。使用隔离测试数据时保持 Codex keepalive 关闭，不登录真实账号或运行 `test:real`。

## 停用或回滚

1. 在 App 的本地配置中将 `ocgo.enabled` 改回 `false`，然后重启 App。这样取消 OCGo 对 `ocgo:` 前缀的占用，恢复原有 Codex/Custom 路由规则，不会删除凭据。本地管理入口仍可查看；生成与手动验证不会调用 Rust。不要将 `ocgo:` 继续发给关闭后的 App 并假定它仍属于 OCGo。
2. 停止本次手工启动的 Rust 实例。使用独立状态目录时，可在该状态目录创建空的 `stop-request` 文件，等待它退出。以样例为例：`New-Item -ItemType File -Path (Join-Path (Split-Path $rustConfig) 'ocgo-state/stop-request') -Force`。确认已退出后再释放端口；不要停止其他实例或调用系统服务管理命令。
3. 若还需回退 App 版本，停止 App 后使用此前保留的 App 构建及配置备份；不要覆盖 Codex、Custom 数据。`data/ocgo-keys.json` 单独保存在受限目录；退出功能不必删除它。
