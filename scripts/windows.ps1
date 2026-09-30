# Run from a signed-in Windows desktop: powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\windows.ps1
# LAN HTTP is enabled by default. -Local restricts the gateway to this computer.
param([switch]$Local, [switch]$Prebuilt)
$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name, [string]$Install) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. Install with: $Install`nOpen a new PowerShell window afterward and rerun this script."
    }
}
function Run-Step([string]$Label, [scriptblock]$Step) {
    Write-Host "`n== $Label ==" -ForegroundColor Cyan
    & $Step
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE). Fix the error above and rerun; no password is reset." }
}

if ($env:OS -ne 'Windows_NT') { throw 'Run this script on the Windows desktop you want to control.' }
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Require-Command 'node.exe' 'winget install --id OpenJS.NodeJS.LTS -e'
Require-Command 'npm.cmd' 'winget install --id OpenJS.NodeJS.LTS -e'
if (-not $Prebuilt) { Require-Command 'dotnet.exe' 'winget install --id Microsoft.DotNet.SDK.8 -e' }
$ffmpeg = if ($env:REMOTECONTROL_FFMPEG_PATH) { $env:REMOTECONTROL_FFMPEG_PATH } else { 'ffmpeg.exe' }
if (-not (Get-Command $ffmpeg -ErrorAction SilentlyContinue)) {
    throw "FFmpeg is required. Install with: winget install --id Gyan.FFmpeg -e`nOpen a new PowerShell window afterward and rerun this script."
}
$nodeVersion = & node.exe -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 24) { throw "Node.js 24 or newer is required (found $nodeVersion). Install with: winget install --id OpenJS.NodeJS.LTS -e" }
if (-not $Prebuilt) {
    $dotnetList = & dotnet.exe --list-sdks
    if ($LASTEXITCODE -ne 0 -or -not ($dotnetList | Where-Object { $_ -match '^8\.' })) { throw 'The .NET 8 SDK is required. Install with: winget install --id Microsoft.DotNet.SDK.8 -e' }
} else {
    foreach ($artifact in @('dist/index.html', 'dist-server/index.js', 'dist-server/setup.js', 'dist-native/windows/RemoteControlAgent.exe')) {
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Prebuilt deployment is incomplete: missing $artifact. Extract the entire deployment ZIP before starting." }
    }
}
$encoders = & $ffmpeg -hide_banner -encoders 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($encoders | Where-Object { $_ -match '\blibx264\b' })) { throw 'FFmpeg must include libx264; install a full FFmpeg build.' }
$devices = & $ffmpeg -hide_banner -devices 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($devices | Where-Object { $_ -match '\bgdigrab\b' })) { throw 'FFmpeg must include gdigrab; use a Windows FFmpeg build.' }
if (-not ($encoders | Where-Object { $_ -match '\blibx265\b' })) { Write-Warning 'This FFmpeg build lacks libx265. H.264 playback will still work; HEVC requires an FFmpeg build with libx265.' }

# npm ships with Node; pin pnpm so a separate global installation is not required.
$pnpm = @('exec', '--yes', '--package=pnpm@10.28.2', '--', 'pnpm')
if ($Prebuilt) {
    Run-Step 'Install locked runtime dependencies' { & npm.cmd @pnpm install --prod --frozen-lockfile }
} else {
    Run-Step 'Install locked dependencies' { & npm.cmd @pnpm install --frozen-lockfile }
    Run-Step 'Build website and gateway' { & npm.cmd @pnpm run build }
    Run-Step 'Build self-contained Windows capture agent' { & npm.cmd @pnpm run build:windows }
}

# Inspect the existing private owner database without resetting passwords or sessions.
& node.exe scripts/windows-owner.mjs
$ownerStatus = $LASTEXITCODE
if ($ownerStatus -eq 2 -or $ownerStatus -eq 3) {
    Run-Step 'Set owner password (first run only)' { & node.exe dist-server/setup.js }
} elseif ($ownerStatus -ne 0) {
    throw 'Cannot read the owner database. Check permissions/data directory; refusing to overwrite existing credentials.'
} else {
    Write-Host 'Existing owner password preserved.'
}

if ($Local) {
    $env:REMOTECONTROL_HOST = '127.0.0.1'
    Write-Host 'Local-only mode: only this computer can connect.'
} else {
    $env:REMOTECONTROL_HOST = '0.0.0.0'
    Write-Warning 'LAN HTTP is unencrypted. Use only on a trusted private network; never on hotel/public Wi-Fi or with port forwarding. No firewall rule is created.'
}
Write-Host "`nOpen http://127.0.0.1:8787 locally or http://<Windows-LAN-IP>:8787 from a device on the same private LAN. Press Ctrl+C to stop."
Run-Step 'Start Remote Control' { & node.exe dist-server/index.js }
