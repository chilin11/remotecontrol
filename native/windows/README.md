# Windows screen-stream agent

This .NET 8 Windows GUI-subsystem executable serves two roles: no arguments / `--desktop` opens the tray-enabled desktop host; `--background` starts it hidden at login. Explicit codec/quality arguments run the capture agent, using redirected stdin/stdout without a console window. FFmpeg `gdigrab` captures the virtual desktop; `libx264` / `libx265` encode low-latency H.264 / HEVC. No audio or file transfer.

## Prerequisites

- Windows 10/11 desktop session (not a locked or inaccessible desktop).
- .NET 8 SDK to build; the quick-start publishes a self-contained executable (no separate .NET Desktop Runtime). A manual framework-dependent publish needs the .NET 8 Desktop Runtime.
- FFmpeg available as `ffmpeg.exe` on `PATH`, or set `REMOTECONTROL_FFMPEG_PATH` to its executable path. The FFmpeg build must include `gdigrab` and `libx264`; HEVC selection additionally requires `libx265`.
- Permissions/policy allowing desktop capture and synthetic input. `SendInput` may be blocked by UIPI when the target application runs at a higher integrity level.

## Build and publish

The recommended distribution is `pnpm package:windows`: it automatically downloads and installs pinned FFmpeg if not cached, verifies SHA-256, preserves upstream license/build notices, validates capture/encoder support, and bundles it. `REMOTECONTROL_FFMPEG_DIR` is an optional advanced override, not a prerequisite. It produces `release/RemoteControl-windows-x64.zip`, containing the native host, Node, dependencies, website and FFmpeg. Extract fully and double-click `RemoteControl.exe`; the target needs no SDK/runtime installation. If bundled FFmpeg is missing, the desktop host automatically downloads it to the current user's data directory without UAC or PATH changes; failures can be retried with the repair button. See root `WINDOWS-DEPLOY.md`.

The desktop host preserves existing passwords/sessions, checks readiness automatically, and starts a configured gateway. Optional HKCU Run startup is per-user after login, not a Windows service. Closing the window hides to the tray; explicit tray exit shuts down the process tree. LAN consent persists; only firewall setup requests elevation. Legacy `Start-Windows.cmd` / `scripts/windows.ps1` remain foreground developer/compatibility entries, not the tray deployment. Manual agent build:

```powershell
dotnet publish .\RemoteControl.Windows.csproj -c Release -r win-x64 --self-contained false -o .\publish
```

For a self-contained .NET deployment, use `--self-contained true`; this does not bundle FFmpeg. No compiled output is checked in. Launch `RemoteControl.Windows.exe` (or `dotnet RemoteControl.Windows.dll`) with an optional quality preset: `720p30`, `1080p24`, `1080p30` (default), `1080p60`, `2160p24`, `2160p30`, or `2160p60`. Earlier names (`data`, `balanced24`, `balanced`, `high15`, `high`) are still accepted.

The gateway argument order is `[codec, quality]`. Supported codecs are `hevc` (the default) and `h264`, so for example `RemoteControl.Windows.exe h264 1080p30` selects H.264. A lone codec argument uses the balanced preset; the one-argument quality form (such as `2160p30`) selects HEVC. If `libx265` is missing, the agent reports an actionable type-3 error recommending an FFmpeg build with `libx265` or switching to H.264.

## GPU encoding (NVIDIA / AMD / Intel)

Each connection picks an encoder automatically and caches the result in `%LOCALAPPDATA%\RemoteControl\video-encoder.json` (keyed by FFmpeg path, size and timestamp, so an FFmpeg update re-probes):

1. A 5-frame test encode (3 s each, 5 s total, cancelled if the viewer disconnects) tries **NVIDIA NVENC** (`hevc_nvenc` / `h264_nvenc`), then **AMD AMF** (`hevc_amf` / `h264_amf`), then **Intel Quick Sync** (`hevc_qsv` / `h264_qsv`). The first that succeeds is used; otherwise software `libx265` / `libx264`.
2. On a single, unrotated display, GPU encoders capture with Desktop Duplication (`ddagrab`) and convert/scale on the GPU (`scale_d3d11`, NV12), so frames do not pass through the CPU (Intel downloads NV12 once for QSV). Multi-display and rotated (portrait) desktops keep `gdigrab` so the whole virtual screen still matches pointer mapping.
3. If a GPU pipeline fails before its first frame, the agent retries the same GPU encoder with `gdigrab`, then software encoding, and clears the cache so the next connection probes again.

GPU settings: lowest-latency tuning, no B-frames, one IDR per second, AUD, Main (HEVC) / Baseline (H.264), level chosen per stream (5.0–5.2), variable bitrate at the preset target (720p30 4; 1080p 6/8/12; 2160p 16/20/35 Mbps; peak 2×, capped at the HEVC level's maximum). The stream metadata includes `encoder` (`nvenc`, `amf`, `qsv` or `software`), shown as **Encoder** in Stats for nerds. Set `REMOTECONTROL_VIDEO_ENCODER=nvenc|amf|qsv|software` to force one (`auto` is the default). The pinned Gyan FFmpeg 9.0.2 essentials build includes all of these; a current GPU driver is required.

## Protocol

The process writes only binary packets to stdout. Each packet is `[u8 type][u32 big-endian payload length][payload]`:

- Type `1`: JSON metadata with `type: "stream"`, `codec` (`"h264"` or `"hevc"`), the codec string for the stream's level (`avc1.42E032`–`avc1.42E034` for H.264 Baseline Level 5.0–5.2, `hvc1.1.6.L150.90`–`hvc1.1.6.L156.90` for HEVC Main, Main tier, 8-bit 4:2:0), `width`, `height`, `fps`, and `encoder`. Metadata is sent immediately before the first frame, so a GPU attempt that fails silently falls back without confusing the browser.
- Type `2`: one Annex-B access unit. The first payload byte is `1` for a key access unit and `0` otherwise; remaining bytes are Annex-B NAL units. Access units are delimited using FFmpeg's AUD NALs. For HEVC the key flag covers IRAP NAL types 16–23. Every key access unit carries the cached parameter sets (HEVC VPS/SPS/PPS, H.264 SPS/PPS) right after its AUD, even when the GPU encoder emits them only once, so each keyframe is independently decodable.
- Type `3`: JSON error with `type: "error"` and `message`.

The agent reads newline-delimited JSON from stdin. Supported events are `{"type":"move","x":0.5,"y":0.5}` (normalized to the virtual desktop), `{"type":"button","button":"left","down":true}` (left/right), `{"type":"wheel","dy":120}`, `{"type":"key","code":"KeyA","down":true}`, and `{"type":"text","text":"hello"}` (up to 32 Unicode code points). Key names use browser `KeyboardEvent.code` spelling for letters, digits, common navigation/modifier/punctuation keys, numpad keys, and F1–F24; unsupported codes/events are ignored. At stdin EOF, the agent releases tracked held keys/buttons and stops FFmpeg.

Keep stdout connected to the protocol consumer; logs/errors are emitted as type-3 packets rather than plain text. Capture naturally follows pipe backpressure. Process termination or a broken output pipe shuts down capture.

## Limitations

- On LAN HTTP, WebCodecs is usually unavailable. The Windows gateway now attempts HEVC MSE only when the viewing browser reports support for `video/mp4; codecs="hvc1.1.6.L150.90"`; otherwise it uses H.264 MSE. An advertised capability does not guarantee decoding: startup, encoder, or playback failure falls back to H.264. The Windows header status tooltip retains the HEVC failure reason after fallback. The browser must actually support this HEVC profile, and FFmpeg must include `libx265`; macOS playback is unchanged.
- Software fallback: HEVC uses `libx265`, `zerolatency`, no B-frames, a closed GOP, and one keyframe per second. 720p uses `ultrafast`/CRF 27, 1080p `superfast`/CRF 25, 2160p `ultrafast`/CRF 24 so the CPU can keep up; 4K60 on CPU is usually too slow, so use a GPU encoder for it.
- H.264 Baseline uses the lowest level from 5.0 to 5.2 that fits (1080p60 → 5.0, 4K30 → 5.1, 4K60 → 5.2); only desktops larger than Level 5.2's frame size are scaled down, with frame rate capped by its macroblock rate. HEVC picks the lowest Main-tier level that covers the frame, sample rate and peak bitrate (1080p → 5.0, 4K24/30 → 5.1, 4K60 → 5.2); the peak (2× target) is capped at that level's maximum bitrate. Metadata, capture rate, and GOP all use the actual values.
- FFmpeg/GDI capture and `SystemInformation.VirtualScreen` sizing follow the current interactive desktop and monitor layout. Display topology changes during a session are not renegotiated. Mixed-DPI setups, secure desktop/UAC prompts, protected content, and locked sessions may not capture or accept input correctly.
- The Annex-B parser expects FFmpeg output with AUD enabled and emits each access unit at the next AUD (normally a one-frame buffering delay). Pending NAL/access units and outgoing packets are bounded to 16 MiB to match the gateway.
- Dimensions fit the preset box (1280×720, 1920×1080 or 3840×2160) keeping the desktop aspect ratio, are even, and are never upscaled. FFmpeg encoding and screen-capture performance depend on the host.
- Input is synthetic `SendInput`, not a physical-device stream. Scan-code/layout-specific edge cases may vary; lower-privilege processes may not control elevated windows. No audio, clipboard, cursor metadata channel, display reconfiguration, or file transfer is implemented.
