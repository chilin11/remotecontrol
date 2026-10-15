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
const children = [];
function loadVideo(platform) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
  if (specifier === './config.js') return { hostPlatform: platform, nativeAgentPath: '/fake-agent' };
  if (specifier === 'node:child_process') return { spawn: (_path, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    child.inputs = [];
    child.stdin = Object.assign(new EventEmitter(), { writable: true, writableLength: 0, write(line) { child.inputs.push(JSON.parse(line)); }, end() {} });
    children.push(child);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  } };
  return nativeRequire(specifier);
}, module, module.exports);
  return module;
}
const module = loadVideo('win32');

function start(quality, platform = 'win32') {
  const handlers = {};
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], on(name, callback) { handlers[name] = callback; }, send(value) { this.sent.push(value); }, close(code) { this.code = code; } };
  (platform === 'win32' ? module : loadVideo(platform)).exports.attachVideo(ws);
  handlers.message(JSON.stringify({ type: 'start', codec: 'h264', quality }), false);
  return { ws, message: value => handlers.message(JSON.stringify(value), false), child: children.at(-1), stop: () => handlers.close() };
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

test('browser recovery retries throttled or dropped keyframes until an uncongested keyframe arrives', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 10_000 });
  const f = start('1080p30');
  t.after(f.stop);
  const emit = key => {
    const packet = Buffer.from([2, 0, 0, 0, 2, key ? 1 : 0, 0x26]);
    f.child.stdout.emit('data', packet);
  };
  emit(true);
  f.message({ type: 'keyframe' });
  assert.equal(f.child.inputs.length, 1);
  const beforeRecovery = f.ws.sent.length;
  emit(false);
  emit(false);
  assert.equal(f.ws.sent.length, beforeRecovery + 2, 'requesting a keyframe must not pause an intact stream');
  emit(true); // first request satisfied
  t.mock.timers.tick(100);
  f.message({ type: 'keyframe' }); // second reset inside the one-second request limit
  assert.equal(f.child.inputs.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(f.child.inputs.length, 2, 'the throttled browser request is retried on a still screen');
  f.ws.bufferedAmount = 600_000;
  emit(true); // requested keyframe cannot be forwarded
  const sent = f.ws.sent.length;
  f.ws.bufferedAmount = 0;
  emit(false);
  assert.equal(f.ws.sent.length, sent, 'dependent frames wait for an intact keyframe');
  t.mock.timers.tick(1000);
  assert.equal(f.child.inputs.length, 3);
  emit(true);
  emit(false);
  assert.equal(f.ws.sent.length, sent + 2);
  t.mock.timers.tick(2000);
  assert.equal(f.child.inputs.length, 3, 'successful recovery stops retries');
});

test('Mac motion bursts keep forwarding after a transient backlog; sustained congestion still recovers at a keyframe', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 10_000 });
  for (const platform of ['darwin', 'win32']) {
    const f = start('1080p30', platform);
    try {
      const emit = key => f.child.stdout.emit('data', Buffer.from([2, 0, 0, 0, 2, key ? 1 : 0, 0x26]));
      emit(true);
      f.ws.bufferedAmount = 600_000;
      emit(false);
      f.ws.bufferedAmount = 0;
      for (let i = 0; i < 10; i++) emit(false);
      assert.equal(f.ws.sent.length, platform === 'darwin' ? 12 : 1,
        `${platform}: the uncapped Mac encoder needs the pre-regression burst budget; Windows retains its capped-encoder budget`);
      emit(true);
      const before = f.ws.sent.length;
      f.ws.bufferedAmount = 1_200_000;
      emit(false);
      f.ws.bufferedAmount = 0;
      emit(false);
      assert.equal(f.ws.sent.length, before, 'genuine congestion still drops dependent frames');
      assert.ok(f.child.inputs.some(input => input.type === 'keyframe'));
      emit(true);
      emit(false);
      assert.equal(f.ws.sent.length, before + 2, 'keyframe resumes normal forwarding');
    } finally { f.stop(); }
  }
});

test('Mac agent keeps a constant frame clock and sets its keyframe interval explicitly', () => {
  const agent = readFileSync(new URL('../native/RemoteControlAgent.swift', import.meta.url), 'utf8');
  // One frame per interval: an empty slot repeats the newest image (MSE timestamps and playout pacing count frames).
  assert.match(agent, /schedule\(deadline: \.now\(\) \+ frameInterval, repeating: frameInterval\)/);
  // Unset is not unlimited (the hardware encoder then inserts one every 30 frames); WebCodecs gets them on request only.
  assert.match(agent, /let keyframeSeconds = onDemandKeyframes \? 3600 : 4/);
  assert.match(agent, /MaxKeyFrameInterval, value: \(quality\.fps \* keyframeSeconds\)/);
  // A hard data-rate cap makes the hardware encoder drop frames (even forced keyframes) on busy video.
  assert.doesNotMatch(agent, /DataRateLimits/);
});

test('gateway logs one combined line per playback hitch and keeps agent diagnostics off the browser socket', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 10_000 });
  const lines = [];
  t.mock.method(console, 'info', line => lines.push(line));
  const f = start('1080p30', 'darwin');
  t.after(f.stop);
  const emit = key => f.child.stdout.emit('data', Buffer.from([2, 0, 0, 0, 2, key ? 1 : 0, 0x26]));
  const agentDiag = Buffer.from(JSON.stringify({ type: 'diag', captured: 140, repeated: 10, encoderDrops: 0 }));
  const header = Buffer.alloc(5); header[0] = 1; header.writeUInt32BE(agentDiag.length, 1);
  f.child.stdout.emit('data', Buffer.concat([header, agentDiag]));
  assert.ok(!f.ws.sent.some(value => typeof value === 'string' && value.includes('"diag"')), 'agent diagnostics are not forwarded');
  const smooth = { type: 'diag', rendered: 150, dropped: 0, late: 0, resets: 0, smoothing: 20, gap: 60, queue: 0, rtt: 40 };
  emit(true);
  f.message(smooth);
  assert.equal(lines.length, 0, 'smooth playback logs nothing');
  f.ws.bufferedAmount = 1_200_000;
  emit(false);
  f.ws.bufferedAmount = 0;
  emit(false);
  t.mock.timers.tick(1800);
  emit(true);
  f.message({ ...smooth, rendered: 260, dropped: 3, gap: 1900 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /longest gap 1900 ms, shown 110\/5s/);
  assert.match(lines[0], /browser dropped \+3/);
  assert.match(lines[0], /gateway in 3 sent 1 dropped 2 keyframes 1 key waits 1 \(max 1800 ms\) key requests 2/);
  assert.match(lines[0], /agent captured 140 repeated 10 encoder drops 0/);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z Video hitch/);
  assert.match(lines[0], /late \+0 \(\? after a keyframe, max \? ms\) jitter peak \? ms decode max \? ms page blocked max \? ms/, 'older pages without the new fields still log');
  assert.match(lines[0], /largest keyframe 0 KB delta 0 KB longest send gap 1800 ms max buffered 1172 KB now 0 KB/);
  f.message({ ...smooth, rendered: 410, dropped: 3 });
  assert.equal(lines.length, 1, 'counters are compared per report window');
});

test('Mac WebCodecs streams ask the agent for on-demand keyframes only; MSE and Windows keep periodic ones', () => {
  for (const [platform, format, expected] of [['darwin', undefined, true], ['darwin', 'mse', false], ['win32', undefined, false]]) {
    const handlers = {};
    const ws = { readyState: 1, bufferedAmount: 0, sent: [], on(name, callback) { handlers[name] = callback; }, send(value) { this.sent.push(value); }, close() {} };
    (platform === 'win32' ? module : loadVideo(platform)).exports.attachVideo(ws);
    handlers.message(JSON.stringify({ type: 'start', codec: 'h264', quality: '1080p60', ...(format ? { format } : {}) }), false);
    assert.equal(spawned.at(-1).includes('on-demand-keyframes'), expected, `${platform} ${format ?? 'webcodecs'}`);
    handlers.close();
  }
});

test('a recovery keyframe does not itself trip the backlog budget and restart the drop-and-wait cycle', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 10_000 });
  const f = start('1080p60', 'darwin');
  t.after(f.stop);
  const emit = (key, size = 2) => {
    const body = Buffer.alloc(size, 0x26); body[0] = key ? 1 : 0;
    const header = Buffer.alloc(5); header[0] = 2; header.writeUInt32BE(size, 1);
    f.child.stdout.emit('data', Buffer.concat([header, body]));
  };
  emit(true, 750_000);
  // The 750 KB keyframe plus a scroll burst sits above the 1 MB burst budget, but within budget + one keyframe.
  f.ws.bufferedAmount = 1_500_000;
  const before = f.ws.sent.length;
  emit(false, 300_000);
  assert.equal(f.ws.sent.length, before + 1, 'the delta after the keyframe is still forwarded');
  assert.ok(!f.child.inputs.some(input => input.type === 'keyframe'), 'no second keyframe is requested');
  f.ws.bufferedAmount = 1_800_000;
  emit(false);
  assert.equal(f.ws.sent.length, before + 1, 'real congestion beyond the keyframe allowance still drops');
});
