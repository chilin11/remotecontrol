import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const dotnet = process.env.REMOTECONTROL_TEST_DOTNET || 'dotnet';
const available = spawnSync(dotnet, ['--version'], { encoding: 'utf8' }).status === 0;

test('Windows H.264 Level 5.0-5.2 limits are applied before capture and metadata', () => {
  const source = readFileSync(new URL('../native/windows/Program.cs', import.meta.url), 'utf8');
  const pipeline = readFileSync(new URL('../native/windows/VideoPipeline.cs', import.meta.url), 'utf8');
  assert.match(source, /VideoLimits\.H264\(width, height, preset\.Fps\)[\s\S]*?width = limits\.Width;[\s\S]*?height = limits\.Height;[\s\S]*?preset = preset with \{ Fps = limits\.Fps, Level = limits\.Level \};[\s\S]*?Agent\.RunAsync\(preset, screen, width, height\)/);
  assert.match(source, /codecString = preset\.CodecString/);
  assert.match(source, /fps = preset\.Fps/);
  // Both capture paths (GDI and Desktop Duplication) use the limited frame rate.
  assert.match(pipeline, /"-framerate", preset\.Fps\.ToString/);
  assert.match(pipeline, /string fps = preset\.Fps\.ToString[\s\S]*?ddagrab=output_idx=0:framerate=\{fps\}/);
});

test('actual C# H.264 fallback respects Level 5.0-5.2 across desktop sizes', { skip: available ? false : '.NET SDK not installed', timeout: 120000 }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'rc-video-limits-'));
  try {
    const project = fileURLToPath(new URL('./windows-video-limits/VideoLimits.Tests.csproj', import.meta.url));
    const result = spawnSync(dotnet, ['build', project, '-c', 'Release', '--nologo',
      `-p:BaseIntermediateOutputPath=${path.join(temporary, 'obj')}${path.sep}`,
      '-o', path.join(temporary, 'bin')], { encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const check = spawnSync(dotnet, [path.join(temporary, 'bin', 'VideoLimits.Tests.dll')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /PASS: H.264 Level 5.0-5.2/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
