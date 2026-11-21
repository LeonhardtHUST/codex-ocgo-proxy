# 自启（Windows）

默认关闭。服务端**从不**自行注册自启；只有三种情况会写系统状态：配置里 `autostart.enabled: true`
（启动时补齐）、管理 API 显式调用、或用户点「提权」触发的一次性 helper。

## 三种模式

| 模式 | 位置 | 需要管理员 | 登录时是否提权启动 | 说明 |
|---|---|---|---|---|
| `registry`（默认） | `HKCU\...\CurrentVersion\Run`（`scope: machine` 时为 `HKLM`） | `user` 否 / `machine` 是 | 否 | 最轻，随登录用户权限启动 |
| `startup` | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\OpenCodeX-Router.cmd` | 否 | 否 | 支持 `delay_seconds`（写进 wrapper 的 `timeout`） |
| `task` | 任务计划程序 `OpenCodeX-Router`，`ONLOGON` | **是**（注册一次） | 仅 `run_as_admin: true` | 用 `RL HIGHEST` 实现「登录即以管理员身份启动，且不再弹 UAC」 |

选择建议：

- 只是要开机就在 → `registry`。
- 后端需要绑定 1024 以下端口、或要动系统级目录 → `task` + `run_as_admin: true`（一次性 UAC）。
- 需要「延迟 30 秒再起，避免和桌面加载抢资源」→ `startup` + `delay_seconds`。

## 配置

```yaml
autostart:
  enabled: true          # 启动时补齐条目；不会删除已有条目
  mode: registry         # registry | startup | task
  scope: user            # user | machine
  run_as_admin: false    # 仅 task 模式生效：注册 RL HIGHEST
  delay_seconds: 0       # 仅 startup 模式生效
```

**为什么 `enabled: false` 不会删除条目**：配置是「启动时补一条」，不是「以配置为准全量覆盖」。
删除必须显式调用 API，避免一次误编辑把用户的开机启动悄悄取消。

## 管理 API

```text
GET  /admin/autostart            现状：是否已注册、条目位置、实际会执行的命令、是否需要提权
POST /admin/autostart            {enabled, mode?, scope?, runAsAdmin?, delaySeconds?}
POST /admin/autostart/elevate    {enabled}  —— 弹一次 UAC，由 helper 完成注册或删除
```

鉴权：`Authorization: Bearer <master key>` 或 dashboard 会话；写操作还要求同源（`Sec-Fetch-Site`）。

提权失败时 `POST /admin/autostart` 返回 **409** 且带 `elevationRequired: true` 与提示，不会静默失败：

```json
{ "ok": false, "elevationRequired": true, "hint": "POST /admin/autostart/elevate to retry through one UAC prompt, ..." }
```

`POST /admin/autostart/elevate` 的实质是：

```powershell
Start-Process -Verb RunAs -FilePath node -ArgumentList @('scripts\autostart-helper.mjs','--apply','--mode=task','--scope=user', ...) -Wait
```

helper（`scripts/autostart-helper.mjs`）是独立短生命周期进程，只做它被要求的那一次注册/删除，
不读应用配置、不启动服务端。它拒绝 `startup` 模式——写启动文件夹本来就不需要提权。

## 目标程序

默认目标在 `src/autostart/index.ts` 的 `defaultTarget()`：

- Electron 打包版：`process.execPath` + `--hidden`（托盘常驻）；
- 源码/Node 版：`process.execPath` + `<root>\dist\index.js`；
- 需要覆盖时设环境变量 `OPENCODEX_AUTOSTART_COMMAND="C:\path\app.exe --hidden"`（便携包、自定义启动器走这条）。

## 回滚

```powershell
# 通过 API（推荐，会走同样的鉴权与提权路径）
curl -X POST http://127.0.0.1:8080/admin/autostart -H "Authorization: Bearer $env:KEY" `
  -H "Content-Type: application/json" -d '{"enabled":false}'

# 手工兜底
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v OpenCodeX-Router /f
schtasks /Delete /F /TN OpenCodeX-Router
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\OpenCodeX-Router.cmd"
```

删除不存在的条目按成功处理（幂等），不会因为「本来就没装」而报错。

## 非 Windows

`GET /admin/autostart` 返回 `supported: false`，注册接口直接返回错误。macOS/Linux 的自启
（launchd / systemd user unit）尚未实现——按现状显式报「不支持」，不做假装成功的处理。

## 测试

`tests/unit/autostart/autostart.test.ts` 覆盖：命令与注册表/任务参数构造、三种模式的注册与删除、
`RL HIGHEST` 只在要求时出现、启动文件夹 wrapper 的延迟、缺失条目删除的幂等、非 Windows 的显式不支持、
API 的鉴权/400/409 提权分支/`elevate` 调用。全部用注入的 executor，不触碰真实注册表。
