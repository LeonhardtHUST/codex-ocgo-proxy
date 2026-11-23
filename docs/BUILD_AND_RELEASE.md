# 构建与发布（Windows 桌面版）

本文件记录**实际验证过**的构建/打包事实，避免重复踩坑。所有命令在
`D:\Projects\GitHub\codex-ocgo-proxy` 下执行（PowerShell）。

## 1. 三份产物分别是什么

| 目标 | 产物 | 用途 | 需要外部工具 |
| --- | --- | --- | --- |
| `portable` | `OpenCodeX-Router-<ver>-win-x64-portable.exe`（约 78 MB，单文件） | 双击即用，不安装 | NSIS 工具包（自动下载） |
| `nsis` | `OpenCodeX-Router-<ver>-win-x64-setup.exe` | 常规安装、开始菜单、卸载 | NSIS 工具包（自动下载） |
| `zip` | `*-win-x64.zip` + `win-unpacked/` | 免安装绿色版、CI 冒烟测试对象 | 无（不需要下载） |

`win-unpacked/` 是三者共同的中间产物；**它自己就是可用的绿色版**，目录保持完整时
`win-unpacked/OpenCodeX-Router.exe` 可以直接双击。

三者的 `artifactName` 必须分开写，否则 portable 与 nsis 会生成同名文件互相覆盖：

```yaml
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]

nsis:
  artifactName: "...-win-${arch}-setup.${ext}"
portable:
  artifactName: "...-win-${arch}-portable.${ext}"
```

## 2. 本地构建

```powershell
# 1) 后端 + 前端
npm run build

# 2) Electron 三个 bundle（OCX_BUILD=1 = 非官方构建，编译掉更新器）
cd packages/electron
$env:OCX_BUILD = '1'
node electron/build.mjs

# 3) 准备打包输入（复制 config/public/bin/native 到 packages/electron）
npm run prepack

# 4) 打包（需要访问 GitHub 下载 electron / nsis，走本机混合代理）
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY  = 'http://127.0.0.1:7897'
npx electron-builder --config electron-builder.yml --win portable nsis --x64 --publish never

# 5) 清理打包输入
npm run postpack
```

产物在 `packages/electron/release/`。CI 用 `electron-builder.ocx.yml`，输出到
`release-ocx/`，appId / productName / 可执行名都与上游隔离。

## 3. 启动验证（唯一可信的判据）

```powershell
$exe = "packages\electron\release\win-unpacked\OpenCodeX-Router.exe"
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = (Resolve-Path $exe).Path
$psi.UseShellExecute = $false
# 关键：清除 ELECTRON_RUN_AS_NODE，见下一节
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
[System.Diagnostics.Process]::Start($psi) | Out-Null

Start-Sleep 10
Get-Process -Name 'OpenCodeX-Router' | Measure-Object          # 期望 3–4 个进程
Get-NetTCPConnection -State Listen -LocalPort 8080            # 期望有监听
Invoke-WebRequest http://127.0.0.1:8080/ -UseBasicParsing     # 期望 200
```

期望的日志行：`[Electron] Server started on port 8080` +
`[desktop] migrated user data from ...`（首次迁移时）。

## 4. `ELECTRON_RUN_AS_NODE` 陷阱（曾浪费一小时）

若父进程环境里存在 `ELECTRON_RUN_AS_NODE=1`（Electron 宿主型 shell / 部分 AI 终端
会设置它），双击或命令行启动 `OpenCodeX-Router.exe` 会**按纯 Node 运行**：
`require("electron")` 拿不到 `app`，主进程在 `ready` 之前就退出。

症状：**没有窗口、没有进程、退出码 0 或 9、stdout 无任何输出**。
这不是包坏了。判断方法：

```powershell
$env:ELECTRON_RUN_AS_NODE   # 有值就是它
```

启动前用 `ProcessStartInfo` + `EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')`
（或 `cmd /c set ELECTRON_RUN_AS_NODE= && start "" app.exe`）即可。

## 5. 打包失败时的排查顺序

1. **GUI 子系统的 exe 不产生可读 stdout**：`Start-Process -RedirectStandardOutput`
   与 `cmd /c ... > log` 都拿不到主进程的 `console.log`。不要在这上面浪费时间。
2. **先证明二进制没问题**：`.\OpenCodeX-Router.exe --version` 能打印
   `v22.16.0` 之类，说明 electron 本体是好的，问题在 app 加载。
3. **读 Electron 的错误弹窗**（比猜快得多）：

   ```powershell
   Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
   $root = [System.Windows.Automation.AutomationElement]::RootElement
   $cond = [System.Windows.Automation.PropertyCondition]::new(
     [System.Windows.Automation.AutomationElement]::NameProperty, 'Error')
   $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
   $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
     [System.Windows.Automation.Condition]::TrueCondition) |
     ForEach-Object { $_.Current.Name } | Where-Object { $_ }
   ```

   弹窗正文会直接给出 `Uncaught Exception: ...` 与行号。
4. **单实例锁**：`<userData>\data\instance.lock`。被强杀后若 pid 被复用，桌面版会弹
   “already running” 后退出。删掉该文件再试。
5. **`<userData>` 位置**：打包版是 `%APPDATA%\@opencodex-router\electron`（合法数据目录
   迁移自 `Codex Proxy OCGo (unofficial)`），CLI 版是仓库下 `data/`。

## 6. 已知的本地打包限制

* `winCodeSign` 解包失败：该 7z 内含 macOS 符号链接，非管理员 Windows 无创建权限，
  报 `ERROR: Cannot create symbolic link : 客户端没有所需的特权`。
  影响的是**签名与 exe 资源编辑**（`signAndEditExecutable`），不影响 `zip` 目标。
  GitHub Actions 的 Windows runner 以管理员运行，因此 **CI 可以正常产出 nsis 与 portable**。
  本地若要图标/版本资源，用 `--config.win.signAndEditExecutable=false` 跳过，或开启
  Windows 开发者模式后重试。
* `electron-builder` 每次运行都会把 `winCodeSign` 重新解压到新的随机缓存目录，手工预置
  缓存无效（已验证）。
* 首次打包需要下载 electron（约 121 MB）与 nsis 工具包；本机直连 GitHub 会超时，
  必须挂 `http://127.0.0.1:7897`。
* `scripts/prepare-pack.mjs` 的过滤器必须先把路径分隔符归一化成 `/` 再匹配：
  Windows 上 `src.slice()` 得到的是 `\target\...`，只用 `/target` 的正则永远不命中，
  会把 `native/target`（约 810 MB）打进包，成品从 300 MB 膨胀到 1.1 GB。

## 7. 发布通道

```powershell
git tag -a ocx-v2.0.77-beta.1 -m "OpenCodeX-Router 2.0.77-beta.1"
git push origin dev
git push origin ocx-v2.0.77-beta.1
```

推送 `ocx-v*` 标签即触发 `.github/workflows/ocx-release.yml`：

1. `validate`：校验标签可达 `origin/dev`、依赖锁定、回归测试；
2. `build-windows`：`electron-builder --config electron-builder.ocx.yml --win --x64`
   产出 **setup + portable**，随后对 `win-unpacked` 做冒烟测试（启动 → HTTP 探活）；
3. `build-linux`：AppImage；
4. `publish`：先建 draft release，上传资产 → 校验每个资产与 SHA256 → 改正式 prerelease。

工作流永不覆盖既有标签或发布（全程无 `--clobber`），也不会写入上游仓库。
