import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const dotnet = process.env.REMOTECONTROL_TEST_DOTNET || 'dotnet';
const ffmpeg = process.env.REMOTECONTROL_TEST_FFMPEG || 'ffmpeg';
const dotnetAvailable = spawnSync(dotnet, ['--version'], { encoding: 'utf8' }).status === 0;
const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const x26xAvailable = encoders.status === 0 && /libx264/.test(encoders.stdout) && /libx265/.test(encoders.stdout);
// CI sets REMOTECONTROL_TEST_FFMPEG to the packaged FFmpeg: a broken path must fail, not silently skip.
if (process.env.REMOTECONTROL_TEST_FFMPEG && !x26xAvailable) throw new Error(`REMOTECONTROL_TEST_FFMPEG=${ffmpeg} is not an FFmpeg with libx264/libx265`);

function build(temporary) {
  const project = fileURLToPath(new URL('./windows-video-pipeline/VideoPipeline.Tests.csproj', import.meta.url));
  const result = spawnSync(dotnet, ['build', project, '-c', 'Release', '--nologo',
    `-p:BaseIntermediateOutputPath=${path.join(temporary, 'obj')}${path.sep}`,
    '-o', path.join(temporary, 'bin')], { encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return path.join(temporary, 'bin', 'VideoPipeline.Tests.dll');
}

function packets(buffer) {
  const result = [];
  for (let offset = 0; offset + 5 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset + 1);
    result.push({ type: buffer[offset], payload: buffer.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return result;
}

function nalTypes(annexB, hevc) {
  const types = [];
  for (let i = 0; i + 3 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && (annexB[i + 2] === 1 || (annexB[i + 2] === 0 && annexB[i + 3] === 1))) {
      const header = annexB[i + (annexB[i + 2] === 1 ? 3 : 4)];
      types.push(hevc ? (header >> 1) & 0x3f : header & 0x1f);
      i += 2;
    }
  }
  return types;
}

/** Keeps parameter sets only before the first frame, mimicking encoders that send them once. */
function stripRepeatedParameterSets(annexB, hevc) {
  const starts = [];
  for (let i = 0; i + 3 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) { starts.push(i > 0 && annexB[i - 1] === 0 ? i - 1 : i); i += 2; }
  }
  const parts = [];
  let seenFrame = false;
  starts.forEach((start, index) => {
    const nal = annexB.subarray(start, starts[index + 1] ?? annexB.length);
    const header = nal[nal[2] === 1 ? 3 : 4];
    const type = hevc ? (header >> 1) & 0x3f : header & 0x1f;
    const parameterSet = hevc ? type >= 32 && type <= 34 : type === 7 || type === 8;
    const vcl = hevc ? type <= 31 : type === 1 || type === 5;
    if (parameterSet && seenFrame) return;
    if (vcl) seenFrame = true;
    parts.push(nal);
  });
  return Buffer.concat(parts);
}

const dotnetSkip = dotnetAvailable ? false : '.NET SDK not installed';

test('C# Windows pipelines select NVIDIA/AMD/Intel GPU encoders with low-latency settings and default to HEVC', { skip: dotnetSkip, timeout: 120000 }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'rc-video-pipeline-'));
  try {
    const check = spawnSync(dotnet, [build(temporary)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /PASS: Windows GPU\/CPU FFmpeg pipelines/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('agent repeats parameter sets on every keyframe when the encoder emits them only once (GPU encoder behaviour)', { skip: dotnetSkip || (x26xAvailable ? false : 'FFmpeg with libx264/libx265 not installed'), timeout: 180000 }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'rc-video-pipeline-'));
  try {
    const dll = build(temporary);
    for (const codec of ['h264', 'hevc']) {
      const hevc = codec === 'hevc';
      const input = path.join(temporary, `${codec}.bin`);
      const encode = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '90',
        ...(hevc
          ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:aud=1:repeat-headers=1:keyint=30:min-keyint=30:scenecut=0:bframes=0']
          : ['-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-x264-params', 'aud=1:repeat-headers=1:keyint=30:min-keyint=30:scenecut=0']),
        '-pix_fmt', 'yuv420p', '-f', codec, input], { encoding: 'utf8', timeout: 60000 });
      assert.equal(encode.status, 0, encode.stderr);
      const original = readFileSync(input);
      const once = stripRepeatedParameterSets(original, hevc);
      assert.ok(once.length < original.length, `${codec}: later keyframes lost their parameter sets`);
      writeFileSync(input, once);
      const split = spawnSync(dotnet, [dll, 'split', input, codec], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(split.status, 0, split.stderr?.toString());
      const frames = packets(split.stdout).filter((packet) => packet.type === 2);
      assert.equal(frames.length, 90, `${codec}: one packet per frame`);
      const keyframes = frames.filter((frame) => frame.payload[0] === 1);
      assert.equal(keyframes.length, 3, `${codec}: one keyframe per second`);
      const parameterTypes = hevc ? [32, 33, 34] : [7, 8];
      for (const key of keyframes) {
        const types = nalTypes(key.payload.subarray(1), hevc);
        assert.equal(types[0], hevc ? 35 : 9, `${codec}: AUD first`);
        assert.deepEqual(types.slice(1, 1 + parameterTypes.length), parameterTypes, `${codec}: parameter sets follow the AUD on every keyframe`);
      }
      // Every keyframe must now be independently decodable: decode starting from the last one alone.
      const lastKey = frames.lastIndexOf(keyframes.at(-1));
      const tail = path.join(temporary, `${codec}-tail.bin`);
      writeFileSync(tail, Buffer.concat(frames.slice(lastKey).map((frame) => frame.payload.subarray(1))));
      const decode = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', codec, '-i', tail, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(decode.status, 0, decode.stderr);
      assert.equal(decode.stderr.trim(), '', `${codec}: tail decodes without errors`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
