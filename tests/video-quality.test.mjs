import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../server/video.ts', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const nativeRequire = createRequire(new URL('../server/video.ts', import.meta.url));
const spawned = [];
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  if (specifier === './config.js') return { hostPlatform: 'win32', nativeAgentPath: '/fake-agent' };
  if (specifier === 'node:child_process') return { spawn: (_path, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { writable: true, writableLength: 0, write() {}, end() {} });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  } };
  return nativeRequire(specifier);
}, module, module.exports);

function start(quality) {
  const handlers = {};
  const ws = { readyState: 1, sent: [], on(name, callback) { handlers[name] = callback; }, send(value) { this.sent.push(value); }, close(code) { this.code = code; } };
  module.exports.attachVideo(ws);
  handlers.message(JSON.stringify({ type: 'start', codec: 'h264', quality }), false);
  return { ws, stop: () => handlers.close() };
}

test('visible quality presets are forwarded as fixed agent arguments', () => {
  for (const quality of ['720p30', '1080p24', '1080p30', '1080p60', '2160p24', '2160p30', '2160p60']) {
    const before = spawned.length;
    const { ws, stop } = start(quality);
    assert.deepEqual(spawned[before], ['h264', quality]);
    assert.equal(ws.code, undefined);
    stop();
  }
});

test('a local-cursor request adds only the fixed local-cursor agent argument', () => {
  for (const [cursor, expected] of [['local', ['h264', '1080p30', 'local-cursor']], ['remote', ['h264', '1080p30']], ['--help', ['h264', '1080p30']]]) {
    const handlers = {};
    const ws = { readyState: 1, sent: [], on(name, callback) { handlers[name] = callback; }, send(value) { this.sent.push(value); }, close(code) { this.code = code; } };
    module.exports.attachVideo(ws);
    const before = spawned.length;
    handlers.message(JSON.stringify({ type: 'start', codec: 'h264', quality: '1080p30', cursor }), false);
    assert.deepEqual(spawned[before], expected);
    handlers.close();
  }
});

test('invalid or flag-like quality is rejected before spawning an agent', () => {
  for (const quality of ['custom', '--help', '../low', '720p60', '2160p15', 'constructor', '__proto__', null, 600, { fps: 60 }]) {
    const before = spawned.length;
    const { ws, stop } = start(quality);
    assert.equal(spawned.length, before);
    assert.equal(ws.code, 1008);
    assert.match(JSON.parse(ws.sent[0]).message, /Invalid stream settings/);
    stop();
  }
});

test('a pending video retry uses the latest applied quality without resetting its delay', () => {
  const ui = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const retry = ui.match(/retryTimer\.current = setTimeout\(\(\) => connectVideo\(([^)]*)\), delay\);/);
  assert.ok(retry, 'video retry must be scheduled');
  const qualityRef = { current: '1080p30' };
  const calls = [];
  const timers = [];
  const schedule = new Function('qualityRef', 'retryTimer', 'setTimeout', 'connectVideo', 'forcedCodec', 'delay', `${retry[0]}`);
  schedule(qualityRef, { current: null }, (callback, delay) => { timers.push({ callback, delay }); }, (...args) => calls.push(args), undefined, 2000);
  qualityRef.current = '1080p60'; // Quality Apply while disconnected during retry backoff.
  assert.equal(timers[0].delay, 2000);
  timers[0].callback();
  assert.deepEqual(calls, [['1080p60', true, undefined]]);
});

test('preset names from earlier versions map to the closest resolution/frame-rate option', () => {
  const legacy = { minimal: '720p30', low: '720p30', hotel: '720p30', data: '720p30', balanced24: '1080p24', balanced: '1080p30', high15: '2160p24', high: '2160p30' };
  for (const [quality, mapped] of Object.entries(legacy)) {
    const before = spawned.length;
    const { ws, stop } = start(quality);
    assert.deepEqual(spawned[before], ['h264', mapped]);
    assert.equal(ws.code, undefined);
    stop();
  }
});

test('quality dialog offers 720p at 30 fps and 1080p/2160p at 24, 30 and 60 fps', () => {
  const ui = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(ui, /value: '720p', [^\n]*fps: \[30\]/);
  assert.match(ui, /value: '1080p', [^\n]*fps: \[24, 30, 60\]/);
  assert.match(ui, /value: '2160p', [^\n]*fps: \[24, 30, 60\]/);
  assert.doesNotMatch(ui, /Data saver|Balanced · 24|High · 15/);
});
