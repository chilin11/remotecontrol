# Windows screen-stream agent

This is a .NET 8 Windows console executable that captures the Windows virtual desktop with FFmpeg `gdigrab`, encodes low-latency H.264 (`libx264`) or HEVC (`libx265`), and sends the remote-control binary packet protocol on stdout. It is intentionally limited to video and input: no audio or file transfer.

## Prerequisites

- Windows 10/11 desktop session (not a locked or inaccessible desktop).
- .NET 8 SDK to build; the quick-start publishes a self-contained executable (no separate .NET Desktop Runtime). A manual framework-dependent publish needs the .NET 8 Desktop Runtime.
- FFmpeg available as `ffmpeg.exe` on `PATH`, or set `REMOTECONTROL_FFMPEG_PATH` to its executable path. The FFmpeg build must include `gdigrab` and `libx264`; HEVC selection additionally requires `libx265`.
- Permissions/policy allowing desktop capture and synthetic input. `SendInput` may be blocked by UIPI when the target application runs at a higher integrity level.

## Build and publish

From the repository root, use `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\windows.ps1` for the supported build + first-run setup + local start. The script validates FFmpeg and publishes a self-contained `dist-native/windows/RemoteControlAgent.exe`. For a manual framework-dependent build from this directory:

The prebuilt `remotecontrol-windows-deploy.zip` includes the self-contained Windows x64 agent and built web gateway. Extract it and double-click `Start-Windows.cmd`; only Node.js 24+ and FFmpeg are required on the target. See the root `WINDOWS-DEPLOY.md`. The `-Prebuilt` PowerShell mode installs production dependencies and skips compilation.

```powershell
dotnet publish .\RemoteControl.Windows.csproj -c Release -r win-x64 --self-contained false -o .\publish
```

For a self-contained .NET deployment, use `--self-contained true`; this does not bundle FFmpeg. No compiled output is checked in. Launch `RemoteControl.Windows.exe` (or `dotnet RemoteControl.Windows.dll`) with an optional quality preset: `data`, `balanced24`, `balanced` (default), `high15`, or `high`.

The gateway argument order is `[codec, quality]`. Supported codecs are `h264` (the default) and `hevc`, so for example `RemoteControl.Windows.exe hevc balanced` selects HEVC. A lone codec argument uses the balanced preset; the existing one-argument quality form (such as `high`) continues to select H.264. If `libx265` is missing, the agent reports an actionable type-3 error recommending an FFmpeg build with `libx265` or switching to H.264.

## Protocol

The process writes only binary packets to stdout. Each packet is `[u8 type][u32 big-endian payload length][payload]`:

- Type `1`: JSON metadata with `type: "stream"`, `codec` (`"h264"` or `"hevc"`), the corresponding codec string (`"avc1.42E032"` or `"hvc1.1.6.L150.90"` for the configured HEVC Main-profile, Main-tier, Level 5.0, 8-bit 4:2:0 stream), `width`, `height`, and `fps`.
- Type `2`: one Annex-B access unit. The first payload byte is `1` for a key access unit and `0` otherwise; remaining bytes are Annex-B NAL units. Access units are delimited using FFmpeg's AUD NALs. For HEVC the key flag covers IRAP NAL types 16–23, and each key access unit is prefixed with cached VPS/SPS/PPS parameter-set NAL units so the access unit itself is independently initialized.
- Type `3`: JSON error with `type: "error"` and `message`.

The agent reads newline-delimited JSON from stdin. Supported events are `{"type":"move","x":0.5,"y":0.5}` (normalized to the virtual desktop), `{"type":"button","button":"left","down":true}` (left/right), `{"type":"wheel","dy":120}`, `{"type":"key","code":"KeyA","down":true}`, and `{"type":"text","text":"hello"}` (up to 32 Unicode code points). Key names use browser `KeyboardEvent.code` spelling for letters, digits, common navigation/modifier/punctuation keys, numpad keys, and F1–F24; unsupported codes/events are ignored. At stdin EOF, the agent releases tracked held keys/buttons and stops FFmpeg.

Keep stdout connected to the protocol consumer; logs/errors are emitted as type-3 packets rather than plain text. Capture naturally follows pipe backpressure. Process termination or a broken output pipe shuts down capture.

## Limitations

- On LAN HTTP, WebCodecs is usually unavailable. The Windows gateway now attempts HEVC MSE only when the viewing browser reports support for `video/mp4; codecs="hvc1.1.6.L150.90"`; otherwise it uses H.264 MSE. An advertised capability does not guarantee decoding: startup, encoder, or playback failure falls back to H.264. The Windows header status tooltip retains the HEVC failure reason after fallback. The browser must actually support this HEVC profile, and FFmpeg must include `libx265`; macOS playback is unchanged.
- HEVC uses software `libx265`, `zerolatency`, no B-frames, a closed GOP, and one keyframe per preset FPS. Presets: **data** 1280/24, `ultrafast`, CRF 27; **balanced24** 1920/24 and **balanced** 1920/30, `superfast`, CRF 25; **high15** 2560/15 and **high** 2560/60, `veryfast`, CRF 22. Removed low-resolution preset names remain accepted as aliases for Data saver by older clients. HEVC may add CPU load and latency; actual results depend on the Windows host and FFmpeg build.
- H.264 keeps its Baseline Level 5.0 codec declaration. Capture dimensions are limited to Level 5.0 frame-size/dimension limits and the frame rate is capped to its macroblock-rate budget; a 2560×1440 High fallback uses 30 fps, while 1920×1080 can retain 60 fps. Metadata, capture rate, and GOP all use the adjusted fps. HEVC is unaffected.
- FFmpeg/GDI capture and `SystemInformation.VirtualScreen` sizing follow the current interactive desktop and monitor layout. Display topology changes during a session are not renegotiated. Mixed-DPI setups, secure desktop/UAC prompts, protected content, and locked sessions may not capture or accept input correctly.
- The Annex-B parser expects FFmpeg output with AUD enabled and emits each access unit at the next AUD (normally a one-frame buffering delay). Pending NAL/access units and outgoing packets are bounded to 16 MiB to match the gateway.
- Dimensions are scaled to an even width, capped at 1280/1920/2560 pixels by the selected preset; height preserves the desktop aspect ratio and is made even. Video presets set 24/24/30/15/60 fps respectively. FFmpeg encoding and screen-capture performance depend on the host.
- Input is synthetic `SendInput`, not a physical-device stream. Scan-code/layout-specific edge cases may vary; lower-privilege processes may not control elevated windows. No audio, clipboard, cursor metadata channel, display reconfiguration, or file transfer is implemented.
