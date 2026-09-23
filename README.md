# Remote Control

A private browser remote desktop for one Mac. It captures the Mac screen, encodes live video with macOS VideoToolbox, and sends mouse and keyboard input back to macOS. It serves everything through one local HTTP/WebSocket port, so your existing Cloudflare Tunnel can point to `http://127.0.0.1:8787`.

## Streaming

The default path uses ScreenCaptureKit and hardware video encoding. The browser checks decoder support and requests **HEVC (H.265) first**, then **H.264** if needed. If HEVC fails to encode or decode, it retries with H.264. The M4 Mac mini has hardware HEVC encoding; Apple lists AV1 decoding, but not AV1 hardware encoding, so this release does not offer AV1 encoding. The active codec is shown in the header.

Choose streaming quality in the toolbar. Changing it restarts the video stream with the new settings:

| Quality | Maximum width | Frame rate | Target bitrate |
| --- | ---: | ---: | ---: |
| Data saver | 1280 px | 24 fps | 1.5 Mbps |
| Balanced | 1920 px | 30 fps | 4 Mbps |
| High | 2560 px | 60 fps | 10 Mbps |

The native agent preserves the display's aspect ratio and does not upscale beyond its actual resolution. Actual frame rate and bitrate vary with desktop activity and network conditions. Video travels over the same authenticated WebSocket as the website, so no UDP or second public port is required. This does not include audio or file transfer.

If the video path is unavailable on a browser, **Use VNC fallback** connects to macOS Screen Sharing through the same protected website. The quality control then sets noVNC's image quality and compression preferences; these are not video codecs and the Mac's VNC server may not honor them.

## Requirements

- Apple Silicon Mac running macOS 26; designed for an M4 Mac mini.
- Node.js 24 or newer, pnpm, and Apple Command Line Tools with a matching Swift compiler and macOS SDK.
- Screen Recording and Accessibility permission for **Remote Control Agent**. Grant these on the Mac mini while you are physically present before relying on remote access.
- An existing Cloudflare Tunnel route to the local service. The project does not configure Cloudflare.
- Optional VNC fallback: enable macOS Screen Sharing in System Settings → General → Sharing and enable **VNC viewers may control screen with password**. Use a separate VNC password.

## Install on the Mac mini

```sh
pnpm install
pnpm build
pnpm build:native
pnpm setup
pnpm service:install
```

`pnpm setup` asks for the website owner password privately in the terminal. Rerunning it changes the password and revokes every website session. `pnpm service:install` creates a per-user LaunchAgent that starts after login and restarts the website process if it exits. It expects the native app to have been built first.

Visit `http://127.0.0.1:8787` locally and sign in. On the Mac mini, open **System Settings → Privacy & Security → Accessibility** and add **Remote Control Agent** from `dist-native/RemoteControlAgent.app`. Start a video connection locally once to trigger the **Screen & System Audio Recording** permission request for the same app; approve it and reconnect. macOS may require quitting and restarting the agent after granting permission. Test screen and input locally before using the tunnel.

Point your tunnel's origin at `http://127.0.0.1:8787` or the selected `REMOTECONTROL_PORT`. Use HTTPS on the public hostname and allow WebSocket upgrades. Do not publish VNC port 5900.

## Use

- Only one browser controls the Mac at a time. A new connection takes over the previous one.
- Click or touch the video to control the pointer; drag to drag; scroll with a wheel or touch gestures. Tap **Keyboard** on a phone to bring up its software keyboard.
- Use the modifier and special-key buttons for shortcuts. **Text** sends typed or pasted text to the Mac.
- **Disconnect** ends remote control. **Sign out** also revokes the website session.
- A brief network interruption triggers up to three reconnect attempts. The active video codec appears beside the connection status.

This is a first version of the video path. Test the exact browsers you use; HEVC WebCodecs support varies by browser and device. H.264 is the compatibility fallback. Browser-reserved shortcuts and some international keyboard layouts may require the toolbar's text or modifier controls.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REMOTECONTROL_PORT` | `8787` | Local website port; always binds to `127.0.0.1` |
| `REMOTECONTROL_DATA_DIR` | `~/Library/Application Support/RemoteControl` | Owner hash and sessions database |
| `REMOTECONTROL_VNC_PORT` | `5900` | Optional local Screen Sharing port |

Set environment variables when running `pnpm service:install`; the generated LaunchAgent records them. Reinstall the agent if a port or installation path changes. `pnpm service:uninstall` removes the LaunchAgent while preserving owner data. Rebuild and rerun `pnpm service:install` after updates.

## Troubleshooting

- **Website unavailable:** Check that the LaunchAgent and `cloudflared` are running, and that the Mac is awake. Logs are in the data directory.
- **Capture permission error:** Grant both Accessibility and Screen Recording access to `Remote Control Agent.app`, then reconnect. Remote approval is not possible while the Mac is unattended.
- **Video decoding error:** The browser should retry H.264. If neither works, use VNC fallback and report the browser/device.
- **No pointer or keyboard control:** Check Accessibility permission for the native agent.
- **VNC fallback ends immediately:** Check Screen Sharing and its separate VNC password.
- **Unavailable after reboot:** Confirm macOS has completed FileVault unlock and the user session has started. A sleeping or powered-off Mac cannot serve its own tunnel.

## Security

The website password is hashed with Argon2id. Sessions use random HttpOnly, SameSite=Strict cookies; HTTPS sessions receive the Secure flag. Mutating API calls and WebSocket upgrades require a matching Origin. The native agent only starts for an authenticated video session, and input events are sent only to the fixed local child process. VNC fallback connects only to `127.0.0.1:5900`. Session records expire after 30 minutes of inactivity or seven days total. The application has no arbitrary command, file, or network proxy endpoint.

Cloudflare terminates the public HTTPS connection and is part of the trust boundary. Keep the VNC password distinct and restrict Screen Sharing if you enable the fallback.
