# 桌面应用打包与授权

桌面包复用 Swift / WinForms 原生程序，不依赖 Electron。双击进入本机设置窗口；视频子进程使用同一可执行文件。成品随包包含官方 Node 24.14.1、网站、网关和平台匹配的运行依赖，无需目标电脑安装 Node / pnpm / .NET。

## macOS（Apple Silicon、macOS 13.5 Ventura 及以上）

构建机器需要 Node 24、pnpm、匹配的 Swift / macOS SDK：

```sh
pnpm install --frozen-lockfile
REMOTECONTROL_SWIFT_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk pnpm package:mac
```

输出 `release/RemoteControlAgent.app`、`release/RemoteControl-mac-arm64.dmg` 和 ZIP（归档均附 SHA-256）。DMG 打开后以大图标显示 App 与 Applications 入口，拖拽即可安装；已有成品可执行 `pnpm package:dmg` 单独生成 DMG。打包时从 nodejs.org 下载固定版本官方 Node 并核对官方 SHA-256 清单，不复制依赖 Homebrew 动态库的 Node。临时下载放在会话 scratch / 系统临时目录。

1. 双击 DMG，将左边的 `RemoteControlAgent.app` 拖到右边 **Applications**。如已安装并正在运行旧版，先退出旧 App 再确认替换；退出会中断远控但不会删除密码/session。从“应用程序”启动安装后的 App，不要直接从 DMG 运行。
2. 如果以前安装了开发版 LaunchAgent，先在旧源码目录执行 `pnpm service:uninstall`，否则旧服务会占用 8787 并自动重启。它保留密码和会话；应用不擅自杀占用端口的未知进程。
3. 首次在窗口设置两次相同的 12–256 字符密码。已有密码自动沿用，不覆盖，也不撤销既有会话。密码通过私有进程管道传输，不放到 HTTP 设置接口、命令行或日志。
4. 点击 **申请屏幕录制**、**申请辅助功能**，在系统界面给 **Remote Control Agent** 授权。不是给 Terminal / Node 授权。应用不需要完全磁盘访问、摄像头、麦克风权限。
5. 授权后刷新；屏幕录制如仍显示待授权，退出并重新打开同一 App。系统确认必须由本机用户完成，不能自动批准。
6. 两项权限和密码就绪后服务自动启动，从菜单栏图标打开控制网页。默认仅本机 `127.0.0.1:8787`；需要其它设备连接时，在窗口或菜单栏勾选“允许可信局域网访问”并确认风险，运行中会自动切换，选择会被记住。
7. App 只显示菜单栏图标，不在 Dock 常驻。关闭设置窗口不停止服务；菜单栏图标可启动/停止、开关局域网、打开设置与日志、退出。勾选“登录时自动打开”会通过 `SMAppService` 加入 **系统设置 › 通用 › 登录项**，登录后静默在菜单栏启动并自动开启服务（沿用上次的局域网选择）；若系统要求批准，会自动打开登录项设置页。

### macOS 防火墙与网络助手身份

屏幕录制、辅助功能和入站防火墙是不同权限。App 外壳不会让实际监听 TCP 的进程自动获得防火墙允许；正式签名也不能保证永远没有系统提示。

网络网关仍使用自带 Node 运行，但装在 `Contents/Helpers/RemoteControlGateway.app` 内，执行文件名为 `RemoteControlGateway`，bundle / 签名标识为 `local.remotecontrol.gateway`。授权身份有明确的产品名称，不再分发裸 `runtime/node`。Node 许可证保留，改名不代表已经移除 Node。系统实际弹窗名称仍须在本机验证，不能仅凭改名保证。

开启可信局域网后，macOS 防火墙可能请求允许 **Remote Control Gateway** 的入站连接。这个对话框只能由用户点击，普通 App 无法代为同意；用 `socketfilterfw --add/--unblockapp` 预先放行需要管理员密码，本应用不擅自提权。真正避免反复弹出的办法是签名稳定：防火墙按代码签名记住决定。以前的 ad-hoc 签名每次构建都变化，系统会把新版当成新程序重新询问；现在默认使用固定的本机证书签名（见下），**在新版上点一次“允许”后，之后重新构建/更新都会沿用**。若用 Developer ID 正式签名，且开启了“自动允许已下载的签名软件”，则通常不会弹出。

旧包的入站提示显示 `node`，若进程路径确实在已安装的 `RemoteControlAgent.app` 内，那是随包运行时，不代表在使用机器上另外安装的 Node。更新前先完成本机准备；本次构建只生成 release 产物，不替换正在运行的 App，不清除密码/session 或自动重置权限。

**签名：** 未设置 `REMOTECONTROL_SIGN_IDENTITY` 时，打包脚本自动在 `~/Library/Application Support/RemoteControl-Signing/` 创建一个固定的自签名代码签名证书（独立钥匙串，不加入用户钥匙串列表），之后每次构建都用它，因此防火墙、屏幕录制、辅助功能的授权在重新构建后可保留。该证书只在构建机上有效，不是 Developer ID：Gatekeeper / 公证不适用，删掉该目录会生成新证书并需重新授权一次。设置 `REMOTECONTROL_SIGN_IDENTITY=-` 可回退为 ad-hoc。下载后的 Gatekeeper 行为与正式发布不同，不自动删除 quarantine、不绕过系统策略。

正式分发可设置 `REMOTECONTROL_SIGN_IDENTITY='Developer ID Application: ...'`，脚本按原生模块、内置 Node、App 由内到外签名。可再设置 `REMOTECONTROL_NOTARY_PROFILE=<已保存的 notarytool 凭据名>` 完成公证和 staple。没有证书/账户无法生成正式公证包。Developer ID 更新身份、Node hardened-runtime/JIT 和真实权限归属仍需签名真机验收。

## Windows（Windows 10/11 x64，已登录桌面）

在 Windows 构建机器安装 Node 24、pnpm、.NET 8 SDK；FFmpeg 缺失会自动准备，无需手动安装：

```powershell
pnpm install --frozen-lockfile
pnpm package:windows
```

不设置 `REMOTECONTROL_FFMPEG_DIR` 时，打包器自动检测缓存并下载固定版本 Gyan Windows x64 静态 FFmpeg，通过固定 SHA-256 校验后安装，保留 LICENSE、README/精确构建配置并生成 `THIRD-PARTY.txt`。校验 `gdigrab`、`libx264`、`libx265` 后装入完整包。高级用户可用该环境变量提供自定义分发目录。桌面端随包 FFmpeg 缺失时也会自动下载到当前用户数据目录，显示进度，失败可点击“检查并自动修复”重试；不修改 PATH、不请求 UAC、不执行未校验文件。携带 x264/x265 通常涉及 GPL 分发义务，记录信息不等于法律合规自动审查。

输出 `release/RemoteControl-Windows/` 和 `release/RemoteControl-windows-x64.zip`（附 SHA-256）。完整解压后双击 `RemoteControl.exe`，不再运行旧 `Start-Windows.cmd`。保留完整 .NET publish 内容，目标机器不需要 .NET SDK/Runtime。首次设置窗口沿用 `%LOCALAPPDATA%\RemoteControl` 中的旧密码与会话。

Windows GDI/SendInput 没有 macOS 式录屏/辅助功能授权开关。向导检查当前交互桌面和随包 FFmpeg，并提供真实限制说明：锁屏、UAC 安全桌面和更高权限窗口不受普通进程控制。整个远控应用不默认管理员运行。

默认仅本机；已配置密码后自动检查并启动。启用可信 LAN 时集中申请私有网络防火墙，由用户确认 UAC；规则仅针对随包 `runtime/node.exe`、TCP 8787、Private、LocalSubnet，不放行 Public/Domain，不关闭防火墙。取消授权退回本机模式，组织策略仍可能阻止连接。保存 LAN 选择后下次沿用；移动程序目录后须重新申请，可更新属于本产品且其余属性匹配的规则路径，不覆盖未知规则。
新增可选的当前用户登录自启动（HKCU Run，无需管理员权限），以 `--background` 隐藏窗口并自动启动服务。窗口关闭改为托盘后台，托盘可恢复、启动/停止、查看日志和彻底退出；重复双击唤起同一实例。不安装 Session 0 系统服务。具体操作与真机验收见 `WINDOWS-DEPLOY.md`。

## 运行与数据

- macOS 关闭设置窗口仅隐藏，服务继续运行；菜单栏“退出”才停止网关及采集。Windows 关闭窗口仅隐藏到托盘，托盘“退出”或注销/关机才退出宿主，Job Object 清理自有进程树。
- 不自动接管其它占用 8787 的服务；先停止旧实例。
- 数据仍在 macOS `~/Library/Application Support/RemoteControl` / Windows `%LOCALAPPDATA%\RemoteControl`，不会写到安装目录。日志为其中的 `desktop.log`。
- HTTP 局域网不加密密码、会话、屏幕、输入；勿使用公共 Wi-Fi、勿转发公网端口。公网使用 HTTPS / 可信 VPN。
- 命令行开发入口仍保留；`pnpm build:native` 只生成原生程序，必须用 `pnpm package:mac` 才得到自带运行资源的桌面成品。

## 验收

自动测试覆盖本机 IPC、首次密码校验/原子创建、不覆盖旧数据、端口冲突、启动/停止、EOF 清理；保留现有网关与视频测试。打包过程检查内置 Node、Argon2、SQLite、WebSocket 并验证 macOS 签名。

发布前仍应在未安装开发工具、断网的干净系统验证双击、系统授权拒绝/批准/重启、真正持续变化的屏幕及输入、退出后无残留进程、Windows UAC 取消与 Private/Public 网络、同证书升级保留数据。模拟代理测试不能代替真实屏幕流验收。
