import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const dotnet = process.env.REMOTECONTROL_TEST_DOTNET || 'dotnet';
const available = spawnSync(dotnet, ['--version'], { encoding: 'utf8' }).status === 0;

test('Windows desktop is windowless at login, single-instance and explicitly stoppable', () => {
  const host = read('native/windows/DesktopHost.cs');
  assert.match(read('native/windows/RemoteControl.Windows.csproj'), /<OutputType>WinExe<\/OutputType>/);
  assert.match(read('native/windows/Program.cs'), /"--desktop" or "--background"/);
  assert.match(host, /mutex\.WaitOne\(0\)/);
  assert.match(host, /if \(!owner\) \{ if \(!background\) activation\.Set\(\); return 0; \}/);
  assert.match(host, /SetVisibleCore[\s\S]*?!background \|\| showRequested/);
  assert.match(host, /e\.CloseReason == CloseReason\.UserClosing[\s\S]*?e\.Cancel = true;\s*Hide\(\)/);
  assert.match(host, /退出（停止远控）[\s\S]*?closing = true; Close\(\)/);
  assert.match(host, /autoStartPending = false;\s*readinessRetry\.Stop\(\);\s*Send\(new \{ action = "stop"/);
  assert.match(host, /!autoStartPending \|\| busy \|\| !configured \|\| !ready \|\| running \|\| closing/);
  assert.match(host, /settings\.AllowLan && string\.Equals\(settings\.FirewallProgram, NodePath/);
  assert.match(host, /lan\.Enabled = configured && !running && !busy && !starting && !configuringFirewall/);
  assert.match(host, /if \(checking \|\| closing\) return;\s*checking = true;/);
  assert.match(host, /finally\s*\{\s*checking = false;/);
});

test('Windows startup and LAN permissions stay scoped to current user and private subnet', () => {
  const settings = read('native/windows/DesktopSettings.cs');
  const host = read('native/windows/DesktopHost.cs');
  assert.match(settings, /Registry\.CurrentUser\.CreateSubKey\(RunKey\)/);
  assert.match(settings, /key\.DeleteValue\(StartupName/);
  assert.doesNotMatch(settings, /Registry\.LocalMachine/);
  assert.match(host, /-Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block/);
  assert.match(host, /Set-NetFirewallApplicationFilter -Program \$program/);
  assert.match(host, /if \(!await RequestFirewall\(\)\)[\s\S]*?allowLan = false/);
  assert.doesNotMatch(host, /Set-NetFirewallProfile|Set-ExecutionPolicy|ExecutionPolicy Bypass/);
});

test('FFmpeg missing detection and packaging share the pinned automatic installer', () => {
  const host = read('native/windows/DesktopHost.cs');
  const packager = read('scripts/package-desktop.mjs');
  const spec = JSON.parse(read('native/windows/ffmpeg-distribution.json'));
  assert.match(spec.url, /^https:\/\/www\.gyan\.dev\//);
  assert.match(spec.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(spec.executableSha256, /^[a-f0-9]{64}$/);
  assert.match(host, /if \(File\.Exists\(bundled\)\) resolvedFfmpeg = bundled;[\s\S]*?FfmpegInstaller\.EnsureAsync/);
  assert.match(host, /await PrepareController\(\);\s*await CheckReadiness\(\)/);
  assert.match(host, /lifetime\.Cancel\(\)/);
  assert.match(packager, /if \(!ffmpeg\)[\s\S]*?'--install-ffmpeg'/);
});

test('actual C# Windows preferences roundtrip and fail closed on corruption', { skip: available ? false : '.NET SDK not installed', timeout: 120000 }, () => {
  const temporary = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'rc-desktop-settings-'));
  try {
    const project = fileURLToPath(new URL('./windows-desktop/Settings.Tests.csproj', import.meta.url));
    const build = spawnSync(dotnet, ['build', project, '-c', 'Release', '--nologo',
      `-p:BaseIntermediateOutputPath=${path.join(temporary, 'obj')}${path.sep}`, '-o', path.join(temporary, 'bin')], { encoding: 'utf8', timeout: 90000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = spawnSync(dotnet, [path.join(temporary, 'bin', 'Settings.Tests.dll'), path.join(temporary, 'data')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS: Windows desktop settings/);
    assert.match(run.stdout, /PASS: FFmpeg auto-install/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
