#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$PROJECT_DIR/dist-native/RemoteControlAgent.app"
mkdir -p "$APP/Contents/MacOS"
cp "$PROJECT_DIR/native/Info.plist" "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources"
cp "$PROJECT_DIR/native/assets/RemoteControl.icns" "$APP/Contents/Resources/RemoteControl.icns"
SDK="${REMOTECONTROL_SWIFT_SDK:-$(xcrun --show-sdk-path)}"
# Pin the deployment target to Info.plist's LSMinimumSystemVersion. Without it, swiftc defaults to the
# toolchain's own OS (e.g. macOS 28) and the app refuses to launch on older systems (Finder shows a 🚫).
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PROJECT_DIR/native/Info.plist")
xcrun swiftc -parse-as-library -target "arm64-apple-macos$MIN_OS" -sdk "$SDK" -module-cache-path "$PROJECT_DIR/dist-native/module-cache" -O "$PROJECT_DIR/native/RemoteControlAgent.swift" "$PROJECT_DIR/native/DesktopHost.swift" -o "$APP/Contents/MacOS/RemoteControlAgent"
MINOS=$(vtool -show-build "$APP/Contents/MacOS/RemoteControlAgent" | awk '/minos/ {print $2}')
if [ "$MINOS" != "$MIN_OS" ]; then echo "Built minos $MINOS does not match LSMinimumSystemVersion $MIN_OS" >&2; exit 1; fi
# Unset: stable local self-signed identity (permissions/firewall decisions survive rebuilds).
# '-': ad-hoc. Anything else: Developer ID with hardened runtime.
IDENTITY="${REMOTECONTROL_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  LOCAL=$(node "$PROJECT_DIR/scripts/local-signing.mjs" | tail -2)
  NAME=$(printf '%s\n' "$LOCAL" | sed -n 1p)
  KEYCHAIN=$(printf '%s\n' "$LOCAL" | sed -n 2p)
  codesign --force --keychain "$KEYCHAIN" --sign "$NAME" "$APP"
elif [ "$IDENTITY" = '-' ]; then
  codesign --force --sign - "$APP"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
fi
echo "Built $APP"
