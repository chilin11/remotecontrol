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
  for (const quality of ['data', 'balanced24', 'balanced', 'high15', 'high']) {
    const before = spawned.length;
    const { ws, stop } = start(quality);
    assert.deepEqual(spawned[before], ['h264', quality]);
    assert.equal(ws.code, undefined);
    stop();
  }
});

test('invalid or flag-like quality is rejected before spawning an agent', () => {
  for (const quality of ['custom', '--help', '../low', null, 600, { fps: 60 }]) {
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
  const qualityRef = { current: 'balanced' };
  const calls = [];
  const timers = [];
  const schedule = new Function('qualityRef', 'retryTimer', 'setTimeout', 'connectVideo', 'forcedCodec', 'delay', `${retry[0]}`);
  schedule(qualityRef, { current: null }, (callback, delay) => { timers.push({ callback, delay }); }, (...args) => calls.push(args), undefined, 2000);
  qualityRef.current = 'balanced24'; // Quality Apply while disconnected during retry backoff.
  assert.equal(timers[0].delay, 2000);
  timers[0].callback();
  assert.deepEqual(calls, [['balanced24', true, undefined]]);
});

test('retired low-resolution presets map to Data saver for older clients', () => {
  for (const quality of ['minimal', 'low', 'hotel']) {
    const before = spawned.length;
    const { ws, stop } = start(quality);
    assert.deepEqual(spawned[before], ['h264', 'data']);
    assert.equal(ws.code, undefined);
    stop();
  }
});
