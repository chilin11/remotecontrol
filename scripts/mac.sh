#!/bin/sh
# One-command macOS deployment from source: check tools, install, build, set password (first run only), install the login service.
#   sh scripts/mac.sh            LAN access (trusted private network)
#   sh scripts/mac.sh --local    only this Mac (e.g. behind an HTTPS tunnel)
set -eu
cd "$(dirname "$0")/.."

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail 'Run this on the Mac you want to control.'
HOST=0.0.0.0
for arg in "$@"; do
  case "$arg" in
    --local) HOST=127.0.0.1 ;;
    *) fail "Unknown option $arg (use --local for this-Mac-only access)." ;;
  esac
done

command -v node >/dev/null 2>&1 || fail 'Node.js 24+ is required: brew install node (or https://nodejs.org).'
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24+ is required (found $(node -v))."
command -v xcrun >/dev/null 2>&1 || fail 'Apple Command Line Tools are required: xcode-select --install'
if command -v pnpm >/dev/null 2>&1; then PNPM=pnpm
elif command -v corepack >/dev/null 2>&1; then PNPM='corepack pnpm'
else PNPM='npx --yes pnpm@10.28.2'
fi

step 'Install locked dependencies'
$PNPM install --frozen-lockfile
step 'Build website and gateway'
$PNPM run build
step 'Build native capture agent'
if ! sh scripts/build-native.sh; then
  printf '\nIf this is a Swift compiler/SDK mismatch, rerun with a matching SDK, e.g.\n  REMOTECONTROL_SWIFT_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk sh scripts/mac.sh\n' >&2
  exit 1
fi
step 'Owner password'
node dist-server/setup.js --if-missing
step 'Install login service'
REMOTECONTROL_HOST=$HOST node scripts/launchd.mjs install

PORT=${REMOTECONTROL_PORT:-8787}
printf '\nDone. Open http://127.0.0.1:%s on this Mac.\n' "$PORT"
if [ "$HOST" = 0.0.0.0 ]; then
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  [ -n "$IP" ] && printf 'Other devices on this trusted LAN: http://%s:%s\n' "$IP" "$PORT"
  printf 'LAN HTTP is unencrypted; never use it on public Wi-Fi or port-forward it.\n'
fi
printf 'First time only: grant Screen Recording and Accessibility to "Remote Control Agent" in System Settings, then reconnect.\n'
printf 'Update later: git pull && sh scripts/mac.sh   Remove service: pnpm service:uninstall\n'
