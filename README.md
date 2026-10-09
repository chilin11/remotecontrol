# Remote Control

A browser remote desktop for one computer. The Node gateway listens on LAN by default (`0.0.0.0:8787`); use only on a trusted private network or behind HTTPS/VPN. It streams native video (macOS hardware encoding, Windows FFmpeg) to the browser over an authenticated WebSocket. There is no VNC mode.

## 快速部署（选一种）

| 场景 | 做法 |
| --- | --- |
| **Windows，最省事** | 下载/构建 `RemoteControl-windows-x64.zip` → 完整解压 → 双击 `RemoteControl.exe` → 设置密码。托盘常驻，可选开机自启。见 [WINDOWS-DEPLOY.md](WINDOWS-DEPLOY.md)。 |
| **macOS，最省事** | 打开 `RemoteControl-mac-arm64.dmg` → 拖入 Applications → 打开后设密码并授权屏幕录制/辅助功能。见 [DESKTOP-DEPLOY.md](DESKTOP-DEPLOY.md)。 |
| **macOS，从源码一条命令** | `pnpm deploy:mac`（或 `sh scripts/mac.sh`；仅本机访问加 `--local`）。自动检查 Node/Xcode 工具、安装依赖、构建、首次设密码（已有密码则保留）、安装登录自启服务，并打印可访问地址。更新：`git pull && pnpm deploy:mac`。 |
| **Windows，从源码** | `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\windows.ps1`（前台运行，见下文）。 |

启动后在本机打开 `http://127.0.0.1:8787`；局域网模式下，终端/日志会直接列出其它设备可用的 `http://<局域网IP>:8787` 地址。端口被占用时会直接报错退出，不会挂起。

## 桌面应用：打包与本机授权

原生桌面设置入口：macOS 使用 Swift/AppKit，Windows 使用 WinForms，随包携带 Node 与运行依赖。已有密码与会话保留，默认仅本机，局域网需明确确认。Windows 支持托盘后台运行及可选的用户登录自启动；关闭窗口不停止服务，彻底退出使用托盘菜单。

- macOS（Apple Silicon / macOS 13.5 Ventura 及以上）：`pnpm package:mac` → App、可拖拽到 Applications 的 DMG、ZIP 与 SHA-256。匹配 SDK 的设置沿用下文。默认用构建机上固定的本机自签名证书（重建后授权可保留，见 DESKTOP-DEPLOY.md）；DMG 不会免除系统权限确认，正式分发需 Developer ID/公证。
- Windows x64：在 Windows 上执行 `pnpm package:windows` → 完整目录与 ZIP；缺失的 FFmpeg 自动下载、校验并随包携带，无需手动准备目录。应用普通用户运行，只有主动配置私有网络防火墙时弹 UAC。
- 安装步骤、旧 launchd 迁移、签名/离线组件要求和真实验收边界见 [DESKTOP-DEPLOY.md](DESKTOP-DEPLOY.md)。下文命令行流程仍作为开发/旧部署方式保留。

## Windows: H.264 streaming with experimental HEVC

Windows has a native **video** agent in `native/windows/`: FFmpeg `gdigrab` captures the logged-in desktop; `libx264` encodes H.264, and optional `libx265` encodes HEVC. A .NET 8 process relays video and handles mouse/keyboard input. The user has run the H.264 Windows path successfully; the newly added HEVC path still needs Windows browser and performance validation. Both encoders are software-based, not Moonlight-style hardware/game capture.

### Windows 推荐部署：完整桌面包

在 Windows 构建机执行 `pnpm package:windows`，自动检测并安装 FFmpeg，得到 `release/RemoteControl-windows-x64.zip`。目标机完整解压后双击 **RemoteControl.exe**，完整包无需安装 Node/.NET/FFmpeg 或首次联网安装依赖；若随包 FFmpeg 缺失，自动联网下载到当前用户目录，可通过“检查并自动修复”重试。首次保存密码后自动检查并启动；局域网、防火墙及登录自启动统一在窗口设置。关闭窗口隐藏到托盘，重复双击恢复同一实例。

详细步骤、后台机制和 Windows 真机验收见 [WINDOWS-DEPLOY.md](WINDOWS-DEPLOY.md)。根目录旧 `remotecontrol-windows-deploy.zip` / `Start-Windows.cmd` 是前台命令行兼容入口，不包含新版托盘和自启动，不要混用。

### Windows quick start (private GitHub repository)

Use a signed-in Windows 10/11 x64 desktop session. Install **Git, Node.js 24+, .NET 8 SDK, and FFmpeg** once. If a tool is missing, `scripts/windows.ps1` prints a `winget` install command; reopen PowerShell afterward. No global pnpm or separate .NET Desktop Runtime is needed: the script obtains pinned pnpm through npm and publishes a self-contained agent. FFmpeg must support `gdigrab` and `libx264` (`libx265` for HEVC).

This repository is **private**; sign in to GitHub with permission to clone it. In a normal PowerShell window (no administrator needed), use process-local `RemoteSigned` for the script; organization-enforced policies may still prohibit scripts:

```powershell
git clone https://github.com/chilin11/remotecontrol.git
cd remotecontrol
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\windows.ps1
```

The script installs locked dependencies, builds the web gateway and Windows agent, asks for an owner password **only on first run**, then starts the website on `0.0.0.0:8787`. Open `http://127.0.0.1:8787` on Windows or `http://<Windows-LAN-IP>:8787` from another device on the same trusted LAN. Existing password/session data in `%LOCALAPPDATA%\RemoteControl` is preserved. Press Ctrl+C to stop; rerun after pulling updates. No service, auto-start task or firewall rule is created. Windows Firewall may ask for **Private** network access; do not allow Public. If another process already uses 8787, stop it yourself before launching a second copy.

For a localhost-only Windows gateway (for example behind an HTTPS tunnel or VPN), add `-Local`: `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\windows.ps1 -Local`. By default LAN HTTP is unencrypted: do not use direct access on hotel/public Wi-Fi or port-forward 8787. HTTP exposes passwords, cookies, desktop images and input in cleartext; for untrusted networks use an HTTPS tunnel or trusted VPN. The script never configures HTTPS or a firewall for you.

Windows captures with FFmpeg `gdigrab`; `libx264` streams H.264 and optional `libx265` streams HEVC. The viewer tries HEVC when the browser supports the required codec, then falls back to H.264. On LAN HTTP, HEVC is attempted only when the browser reports compatible HEVC MediaSource support. Confirm that frames render and pointer/keyboard/reconnect work, not just that the header says HEVC. Windows software encoding may be slower than macOS hardware encoding. See `native/windows/README.md` for advanced build and protocol details.

### Windows limitations

Windows uses FFmpeg/GDI and software `libx264` / `libx265`, not DXGI Desktop Duplication or hardware video encoding. HEVC may use more CPU and add latency at the same frame rate; lower bitrate does not automatically mean clearer video. It does not provide audio, gamepad, file transfer, UAC/secure desktop control, locked-session capture, guaranteed mixed-DPI alignment, or Windows hardware-encoder optimization. The desktop package provides optional per-user login startup and tray operation (not a Session 0 service). See `native/windows/README.md` for protocol and agent limitations.

## macOS: native video

The macOS default path uses ScreenCaptureKit and VideoToolbox hardware encoding. Browsers with WebCodecs request **HEVC (H.265) first**, then **H.264** if needed. On LAN HTTP, where WebCodecs is usually unavailable, the browser automatically uses **H.264 MediaSource (MSE)**; no separate desktop client is required. The active codec appears in the header. The native agent preserves the display aspect ratio and does not upscale beyond its actual resolution. Video uses the authenticated WebSocket; no UDP or second public port is needed. Audio and file transfer are not included.

Open Quality, choose a preset, then Apply. Applying a video preset reconnects the stream once; Cancel does not interrupt it. **Balanced · 24 fps** keeps Balanced's resolution while reducing frame rate; **High · 15 fps** keeps High's resolution for sharper, mostly static work with fewer frames. Video has no audio track, so there is no audio bandwidth to disable.

| Preset | Maximum width | Frame rate | macOS target bitrate | Windows rate control |
| --- | ---: | ---: | ---: | ---: |
| Data saver | 1280 px | 24 fps | 1.5 Mbps | Variable |
| Balanced · 24 fps | Mac 2560 px / Windows 1920 px | 24 fps | 5 Mbps | Variable |
| Balanced · 30 fps | Mac 2560 px / Windows 1920 px | 30 fps | 6 Mbps | Variable |
| High · 15 fps | Mac 3840 px / Windows 2560 px | 15 fps | 8 Mbps | Variable |
| High | Mac 3840 px / Windows 2560 px | Mac 30 / Windows up to 60 fps¹ | 14 Mbps | Variable |

¹ Windows H.264 is constrained to Level 5.0: 2560×1440 High falls back to 30 fps; unusual tall/large desktops may also be scaled down or use a lower frame rate. The stream metadata reports the actual dimensions and fps. HEVC presets are unchanged.

Bitrates are encoder targets, **not guaranteed network throughput**; WebSocket overhead and bursts remain. Legacy Minimal/Low bandwidth preferences are moved to Data saver so saved clients stay connectable. Public Wi-Fi is untrusted: access over HTTPS or a trusted VPN; do not expose HTTP port 8787 on public networks.

Requirements: Apple Silicon with macOS 13.5 (Ventura) or newer, Node.js 24 or newer, pnpm, and Apple Command Line Tools with a matching Swift compiler/SDK. Grant Screen Recording and Accessibility permissions to **Remote Control Agent** while physically present.

Install on the Mac (or run everything at once with `pnpm deploy:mac`):

```sh
pnpm install
pnpm build
pnpm build:native
pnpm run setup
pnpm service:install
```

On macOS 26 with Command Line Tools 26.6, if `xcrun` picks the installed macOS 27 SDK and `pnpm build:native` fails with a Swift compiler/SDK mismatch, explicitly use the matching macOS 26.5 SDK instead: `REMOTECONTROL_SWIFT_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk pnpm build:native`. Verify the SDK exists on that Mac; do not change system SDK symlinks.

The setup command asks for the owner password privately in the terminal. `pnpm service:install` installs a per-user LaunchAgent that starts at login and restarts the website process; the native app must be built first. Visit `http://127.0.0.1:8787` locally and sign in. Add `dist-native/RemoteControlAgent.app` to **System Settings → Privacy & Security → Accessibility**, then start a video connection locally to trigger the screen recording permission request. Approve and reconnect; macOS may require quitting/restarting the agent. Test screen and input locally before relying on remote access.

### macOS streaming 验收（不能用假帧代替）

若 `pnpm build:native` 报告 Swift 编译器与 SDK 不匹配，先查 `swiftc --version` 与 `/Library/Developer/CommandLineTools/SDKs/` 中可用的 SDK；优先按上文设置 `REMOTECONTROL_SWIFT_SDK` 选匹配版本后重建。只有没有匹配 SDK 时才更新 Command Line Tools / Xcode；不要修改系统 SDK 链接。原生代理必须实际生成在 `dist-native/RemoteControlAgent.app`，网页和网关测试通过并不代表屏幕流可用。

在这台 Mac 的图形会话中，由用户给该 app 授予辅助功能和屏幕录制权限。先在 `http://127.0.0.1:8787` 登录并选 **video stream**，确认浏览器实际显示持续变化的桌面图像、状态显示 HEVC 或 H.264，且鼠标、拖拽和键盘可用；分别尝试两种编码及画质。只有本地真实采集与播放通过后才配置 Cloudflare Tunnel。若系统自带 `screencapture` 也无法从显示器创建图像，应先排查当前会话/录屏授权，而非把网关假代理测试当作画面验收。

For an existing tunnel, point the HTTP origin to `http://127.0.0.1:8787` (or your configured port), use HTTPS publicly, and allow WebSocket upgrades. The host must be awake, unlocked after FileVault, and have a logged-in user session. `pnpm service:uninstall` removes the LaunchAgent but preserves owner data; rebuild and rerun `pnpm service:install` after updates.

### Trusted-LAN HTTP video test

With a built native agent and owner password configured, `pnpm start` listens on the Mac's LAN interfaces by default. On another computer on the same trusted private network, visit `http://<Mac-LAN-IP>:8787`, enter the owner password, and press **Connect**. To restrict the gateway to this Mac only (for an HTTPS tunnel, for example), use `REMOTECONTROL_HOST=127.0.0.1 pnpm start`. Chrome/Edge on LAN HTTP use H.264 MSE instead of WebCodecs. Stop the gateway with Ctrl+C when finished. HTTP exposes credentials, sessions, desktop images, and input unencrypted to observers on the network; do not use direct HTTP on public Wi-Fi or port-forward 8787 to the Internet.

## Use

- Only one browser controls the desktop at a time; a new connection takes over the previous one.
- Click/touch or drag the desktop to control the pointer; use wheel/touch gestures to scroll.
- Toolbar buttons provide modifier/special keys, text entry, mobile keyboard, and disconnect.
- On a Mac video connection, physical Fn/FnLock is not forwarded. To send Fn with a remote key, open **More**, tap **Fn**, then press the desired key; Fn clears automatically after that key. Ordinary `f` remains an ordinary key. Browser/OS-level Fn shortcuts cannot be overridden by this page.
- **Fullscreen** requests browser fullscreen; if blocked or unavailable, it switches to a near-fullscreen **Theater** view. Use **Exit** or Escape to return. **Fit** shows the entire desktop with letterboxing; **Fill** crops the edges to occupy the viewer. Pointer/touch coordinates follow the visible portion of the image. **Hide controls** keeps an Exit/Show controls bar accessible.
- Windows HEVC quality presets use CRF/preset tradeoffs (data 27/ultrafast, balanced 25/superfast, high 22/veryfast); see `native/windows/README.md`. H.264 MSE remains the reliable LAN HTTP playback mode.
- **Disconnect** ends remote control. **Sign out** also revokes the website session.
- Network interruptions trigger up to three reconnect attempts.
- Browser video uses WebCodecs or H.264 MediaSource over WebSocket (TCP), not WebRTC. Browser-reserved shortcuts and some keyboard layouts may require the toolbar's text or modifier controls.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REMOTECONTROL_PORT` | `8787` | Website port; LAN-facing by default |
| `REMOTECONTROL_HOST` | `0.0.0.0` | LAN access by default; set `127.0.0.1` for localhost-only, e.g. with an HTTPS tunnel |
| `REMOTECONTROL_DATA_DIR` | Windows: `%LOCALAPPDATA%\RemoteControl`; macOS: `~/Library/Application Support/RemoteControl`; Linux: `$XDG_DATA_HOME/RemoteControl` or `~/.local/share/RemoteControl` | Owner hash and sessions database |

On Windows, set optional variables in the PowerShell session before `pnpm start`, for example `$env:REMOTECONTROL_PORT = '8788'`. The default `%LOCALAPPDATA%` directory inherits the current user's ACL; if overriding `REMOTECONTROL_DATA_DIR`, use a directory accessible only to that user and administrators, never a shared or other-users-writable directory. On macOS, set variables before `pnpm service:install`; the LaunchAgent records them, so reinstall it if a port or installation path changes.

## Security

The website owner password is hashed with Argon2id. Sessions use random HttpOnly, SameSite=Strict cookies; HTTPS sessions receive the Secure flag. Mutating API calls and WebSocket upgrades require a matching Origin. The gateway exposes only the website and the authenticated video WebSocket; it has no VNC or other proxy endpoint. The website gateway defaults to `0.0.0.0`, which listens on all IPv4 network interfaces; set `REMOTECONTROL_HOST=127.0.0.1` (Windows quick start: `-Local`) to restrict it. Direct HTTP is appropriate only on a trusted private LAN: HTTP does **not** encrypt the owner password, session cookie, desktop video, or input. Never port-forward 8787 to the Internet or use direct HTTP on hotel/public Wi-Fi, and protect any public tunnel with HTTPS and an access policy. The application has no arbitrary command, file, or network proxy endpoint.
