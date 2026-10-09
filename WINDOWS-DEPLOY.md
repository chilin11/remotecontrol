# Windows 桌面版部署（推荐，Windows 10/11 x64）

统一使用 **RemoteControl.exe 桌面版**，不需要保持终端或设置窗口打开。当前仓库根目录的旧 `remotecontrol-windows-deploy.zip` 是命令行旧包，不包含新的托盘/自启动功能；不要混用。

## 直接下载云端构建的安装包（无需本机编译）

登录有仓库权限的 GitHub 账号，打开仓库 **Releases → Latest**，在 **Assets** 下载 `RemoteControl-windows-x64.zip`（不要下载 Source code）。完整解压到固定目录，然后按下面“首次设置”双击 `RemoteControl.exe`。安装电脑无需 Node / .NET / pnpm / FFmpeg。Release 附件不会像 Actions 临时产物那样在 30 天后过期。

如需重建最新版，在 **Actions → Build and publish macOS + Windows** 点击 **Run workflow**，选择 `main`。云端使用同一提交分别构建 macOS / Windows；两边全部检查通过后，才在同一个 Release 上传 Mac DMG/ZIP、Windows ZIP 及各自 SHA-256 文件，并发布为 Latest。旧 Release 保留。Windows 不签署 Authenticode，SmartScreen 可能显示未知发布者；仅使用本仓库可信构建，不关闭系统安全策略。

Actions 的 `Windows-desktop-x64` 产物仍保留 30 天作备用；它外面有一层 GitHub ZIP，需要先解压外层，再解压里面的安装包。

**Code → Download ZIP 是源码，不是安装包。** 云端检查覆盖编译、C# 测试、ZIP 完整性和内置运行时；托盘、UAC、登录自启及实际屏幕/输入仍需 Windows 真机验证。

## 1. 构建完整桌面包

在 Windows 构建机准备 Node 24、pnpm、.NET 8 SDK 即可，**无需手动安装 FFmpeg 或准备分发目录**：

```powershell
pnpm install --frozen-lockfile
pnpm package:windows
```

打包时自动检测 FFmpeg 缓存，缺失则下载固定版本的 Gyan Windows x64 静态发行包，校验固定 SHA-256、保留许可证/README/构建信息并生成 `THIRD-PARTY.txt`，然后检查 `gdigrab`、`libx264`、`libx265` 并随包分发。下载需联网，最多重试 3 次，失败后修复网络再运行同一命令。高级用户仍可用 `REMOTECONTROL_FFMPEG_DIR` 提供完整自定义目录；不设置时走自动安装。自动记录信息不等于已满足全部 GPL/第三方源码分发义务，正式分发者仍须完成合规准备。

输出 `release/RemoteControl-windows-x64.zip` 及 SHA-256 校验文件。完整包携带 Node、.NET 自包含运行时、网站、网关、依赖和 FFmpeg，目标电脑不需要安装开发工具或首次联网安装依赖。

## 2. 首次设置

1. 完整解压到固定的本机目录，**双击 `RemoteControl.exe`**，不要在 ZIP 内运行，也不要以管理员身份运行应用。
2. 首次设置两次相同的 12–256 字符访问密码，点击“保存密码并启动”。已有 `%LOCALAPPDATA%\RemoteControl` 中的密码与 session 会保留，不覆盖。程序自动检查桌面、FFmpeg 和编码器，检查通过后自动启动；默认仅本机。
3. 需要手机或另一台电脑访问：先停止服务，勾选“允许可信私有局域网访问”，再启动。首次确认 HTTP 风险后，向导集中申请防火墙权限；Windows UAC 必须在本机由用户确认。拒绝或配置失败则退回本机模式，可稍后重试。
4. 将可信家庭/办公网络在 **Windows 设置 → 网络和 Internet → 当前网络属性**中设置为“专用”。规则只允许本程序的 TCP 8787、Private、LocalSubnet；不开放 Public/Domain，不关闭防火墙。
5. 按窗口地址在浏览器登录并 Connect。手机和电脑应在同一可信局域网，关闭路由器 AP/客户端隔离；组织网络策略可能仍会阻止连接。

密码、会话保存在原数据库，非敏感界面设置单独保存在 `%LOCALAPPDATA%\RemoteControl\windows-desktop.json`；日志为 `desktop.log` / `desktop-host.log`。

### FFmpeg 自动检测与安装

- 完整桌面包已携带 FFmpeg，正常启动无需联网，也不依赖系统 PATH。
- 若 `ffmpeg/ffmpeg.exe` 缺失，程序自动从固定 HTTPS 地址下载、校验并安装到 `%LOCALAPPDATA%\RemoteControl\ffmpeg-<版本>`，显示下载进度；无需管理员权限，不修改系统 PATH。
- 下载包和可执行文件分别核对项目内固定的 SHA-256；校验失败不执行下载文件，不覆盖原有可用安装。拒绝 ZIP 越界路径并限制下载/解压大小。
- 断网、代理/防病毒或磁盘限制时显示失败原因；点击 **“检查并自动修复”** 重试。退出会取消下载，后续成功安装会缓存，下次不重复下载。
- 首次缺失时必须联网；不能在断网且无随包/缓存 FFmpeg 的情况下自动安装。此流程只准备 FFmpeg，不自动重装损坏的 Node/网站等部署文件。

## 3. 开机启动与后台运行

- 勾选 **“开机后登录当前用户时自动启动（后台托盘）”**。使用当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\RemoteControl`，不需要管理员权限；取消勾选会删除此启动项。
- 这是**登录后启动**，不是登录前的系统服务。登录后不显示窗口、不打开浏览器、不弹 UAC；自动沿用保存的本机/局域网选择。桌面暂时不可用时会等待重试，端口冲突不会杀掉未知进程或无限重启。
- 普通双击也自动启动已配置的服务，并显示设置。重复双击只唤起现有窗口，避免重复占用端口。
- 点击窗口 × 或“隐藏到托盘”后，远控继续运行。双击托盘图标恢复窗口；右键提供启动、停止、日志及 **“退出（停止远控）”**。
- “停止”不会关闭托盘，但本次不再自动重启；“退出”会停止网关、采集进程并清理进程树。关闭自启动选项不会停止当前服务。退出后下次登录仍会启动，除非取消自启动。
- Windows 任务管理器/设置里若禁用了此启动应用，需要在那里重新启用；组织策略可能禁止启动项。
- 请保持安装目录固定。移动目录后重新勾选自启动以更新路径，并在新目录重新申请防火墙；路径不匹配时自动启动退回本机模式，不会在登录时提权。

后台进程必须运行才能提供远控，但不需要一直显示窗口。没有安装 Windows 系统服务，因为 Session 0 服务无法直接采集/控制普通用户的交互桌面。

## 4. 权限和安全边界

- Windows 无需 macOS 式录屏/辅助功能授权；只有局域网防火墙配置需要一次管理员确认。不能自动批准 UAC 或绕过企业安全策略。
- 主机必须保持登录、普通桌面可访问；锁屏、UAC 安全桌面、受保护内容和更高权限窗口不支持控制。机器睡眠后也无法连接，本程序不自动关闭锁屏/睡眠策略。
- 本机使用 `http://127.0.0.1:8787`，局域网使用窗口给出的 IP 地址。HTTP 不加密密码、会话、画面和输入，仅用于可信私有网络；禁止公网端口映射。外网使用 HTTPS 或可信 VPN。
- 改动仅触及属于本产品且属性匹配的私有网络规则；规则冲突时不覆盖未知规则。规则存在不保证网络可达。
- 默认使用 HEVC，自动选择显卡编码（NVIDIA NVENC → AMD AMF → Intel Quick Sync），单显示器时用 Desktop Duplication 采集；没有可用显卡编码时回退软件 libx265/libx264。打开 Stats for nerds 的 **Encoder** 一行可确认是否在用 GPU。需要较新的显卡驱动；可用环境变量 `REMOTECONTROL_VIDEO_ENCODER=nvenc|amf|qsv|software` 强制指定。浏览器或编码失败时回退 H.264。请用 Balanced 验证画面持续变化、鼠标键盘和断开重连，不只看 Connected 标签。

## 5. 发布前 Windows 真机验收

在未安装 Node/.NET/FFmpeg 的干净 Windows 10/11 x64 上验证：

- 断网双击、首次密码与旧数据保留。
- 删除随包 FFmpeg 后联网启动 → 自动下载完成；断网失败可重试；已安装缓存可离线使用；退出下载后无半安装状态。
- 托盘隐藏/恢复、重复双击、停止后不自动重启、彻底退出无残留进程。
- 勾选自启动 → 注销或重启 → 登录后仅托盘、网关自动启动；取消后下次不启动。
- UAC 拒绝/批准，Private 网络手机可连，Public 网络不因本规则而放行；移动目录后重配。
- 真实桌面连续画面、鼠标键盘、重连，锁屏/UAC 边界，以及端口占用提示。

交叉编译和自动化测试不能替代这些系统交互验收，也不能保证所有企业策略/网络环境下都能连接。

## 旧命令行入口（仅兼容/开发）

旧包 `Start-Windows.cmd` / `scripts/windows.ps1` 仍保留，需目标机安装 Node/FFmpeg，前台运行并用 Ctrl+C 停止。它不提供新版托盘和自启动；新版日常使用应选择上面的完整桌面包。
