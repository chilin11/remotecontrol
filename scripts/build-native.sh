#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$PROJECT_DIR/dist-native/RemoteControlAgent.app"
mkdir -p "$APP/Contents/MacOS"
cp "$PROJECT_DIR/native/Info.plist" "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources"
cp "$PROJECT_DIR/native/assets/RemoteControl.icns" "$APP/Contents/Resources/RemoteControl.icns"
SDK="${REMOTECONTROL_SWIFT_SDK:-$(xcrun --show-sdk-path)}"
xcrun swiftc -parse-as-library -sdk "$SDK" -module-cache-path "$PROJECT_DIR/dist-native/module-cache" -O "$PROJECT_DIR/native/RemoteControlAgent.swift" "$PROJECT_DIR/native/DesktopHost.swift" -o "$APP/Contents/MacOS/RemoteControlAgent"
IDENTITY="${REMOTECONTROL_SIGN_IDENTITY:--}"
if [ "$IDENTITY" = '-' ]; then
  codesign --force --sign - "$APP"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
fi
echo "Built $APP"
