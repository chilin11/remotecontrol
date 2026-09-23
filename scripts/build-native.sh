#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$PROJECT_DIR/dist-native/RemoteControlAgent.app"
mkdir -p "$APP/Contents/MacOS"
cp "$PROJECT_DIR/native/Info.plist" "$APP/Contents/Info.plist"
if [ -n "${REMOTECONTROL_SWIFT_SDK:-}" ]; then
  xcrun swiftc -parse-as-library -sdk "$REMOTECONTROL_SWIFT_SDK" -module-cache-path "$PROJECT_DIR/dist-native/module-cache" -O "$PROJECT_DIR/native/RemoteControlAgent.swift" -o "$APP/Contents/MacOS/RemoteControlAgent"
else
  xcrun swiftc -parse-as-library -module-cache-path "$PROJECT_DIR/dist-native/module-cache" -O "$PROJECT_DIR/native/RemoteControlAgent.swift" -o "$APP/Contents/MacOS/RemoteControlAgent"
fi
codesign --force --sign - "$APP"
echo "Built $APP"
