# Windows 一键部署（x64）

## 1. 首次准备

使用已登录、未锁屏的 Windows 10/11 x64 桌面。安装 **Node.js 24+** 和包含 `gdigrab`、`libx264`、`libx265` 的 Windows FFmpeg：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
```

安装完成后关闭旧终端，再运行启动入口。已安装的工具不必重复安装。

部署包包含已构建的网站、网关和自包含 Windows 原生代理；不需要 Git、.NET SDK 或单独安装 .NET Runtime。**Node.js、FFmpeg 和 npm 依赖不随包分发**，首次运行需要联网安装锁定版本的运行依赖。仅有 libx264 的 FFmpeg 仍可播放 H.264，HEVC 需要 libx265。

## 2. 双击启动

1. 将 `remotecontrol-windows-deploy.zip` **完整解压**到本机目录，不要从 ZIP 内直接运行。
2. 双击 **`Start-Windows.cmd`**。
3. 首次运行按提示设置网站 owner 密码；已有 `%LOCALAPPDATA%\RemoteControl` 的密码和 session 不会被重置。自定义 `REMOTECONTROL_DATA_DIR` 也会沿用。
4. 本机打开 `http://127.0.0.1:8787`，同一可信私有局域网设备打开 `http://<Windows局域网IP>:8787`，登录并 Connect。
5. 保持窗口打开，Ctrl+C 停止。程序不安装服务、不创建自启动任务、不自动开防火墙。

如 8787 已被使用，请自行关闭旧进程；启动器不会杀掉或接管已有 session。Windows 防火墙只允许 **Private** 网络，不允许 Public。

仅本机访问时，从解压目录执行：

```powershell
.\Start-Windows.cmd -Local
```

启动入口通过包内 `WINDOWS-PREBUILT.txt` 标记使用 `scripts/windows.ps1 -Prebuilt`，只安装运行依赖；从纯源码使用此入口则需要 .NET 8 SDK，并完整构建。

## 3. HEVC 与 H.264 fallback 验收

- 先用 **Balanced**：查看画面是否持续变化，验证鼠标、键盘、断开与重连，不能只看 Connected 标签。
- 浏览器支持对应 HEVC profile 时优先尝试 HEVC；LAN HTTP 使用 HEVC MSE，HTTPS/localhost 支持 WebCodecs 时可使用 WebCodecs。
- 浏览器不支持 HEVC，或编码/初始化/解码失败时，自动回退 H.264。Windows 回退后状态栏 tooltip 会保留失败原因。
- HEVC 是 FFmpeg **软件 libx265**，不是 GPU 硬编码，性能取决于 CPU。High 档 H.264 在 2560×1440 时会降至 30 fps，保证 Level 5.0 合规；HEVC 档位不变。

本包已进行跨平台 Windows x64 发布检查、C# Level 限制测试、Web 构建/回归测试及真实 x265/fMP4 解码检查。**Windows GDI 采集、真实桌面输入及具体 Chrome/Edge 解码仍需在目标机验收**。

## 4. 常见问题与安全边界

- 找不到 Node/FFmpeg：安装后重新打开终端；也可先在 PowerShell 设置 `$env:REMOTECONTROL_FFMPEG_PATH = 'C:\tools\ffmpeg.exe'`，再运行启动器。
- 下载的 PowerShell 脚本被阻止：确认 ZIP 来源可信后，在解压目录运行 `Unblock-File .\scripts\windows.ps1`，再双击入口。启动器只使用进程级 `RemoteSigned`，不会更改系统执行策略；组织策略仍可能禁止运行。
- FFmpeg 启动或抓屏失败：确认主机未锁屏且当前用户已登录，FFmpeg 包含 gdigrab 和对应 encoder。
- 安装依赖失败：检查网络或 npm registry；启动器不会重置已有密码。
- HTTP 会明文传输密码、session、画面和输入。仅用于可信私有网络；公共/酒店网络使用 HTTPS 隧道或可信 VPN，禁止将 8787 端口转发到公网。
- 不支持音频、锁屏/UAC 安全桌面控制，也不配置 HTTPS、防火墙或自动启动。

包内 `DEPLOYMENT-MANIFEST.json` 记录每个打包文件的 SHA-256；ZIP 旁的 `.sha256` 文件校验整个压缩包。
