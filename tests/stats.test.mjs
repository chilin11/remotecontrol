import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

const load = (file) => {
  const code = buildSync({ entryPoints: [new URL(file, import.meta.url).pathname], bundle: true, format: 'cjs', write: false, platform: 'neutral', logLevel: 'silent' }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
};
const { rates, parseServerStats, formatBitrate, formatBytes, formatDuration, sparkPoints } = load('../src/stats.ts');
const { VideoClient } = load('../src/video.ts');

const snapshot = (at, extra = {}) => ({ at, playback: 'canvas', width: 0, height: 0, declaredFps: 30, connectedMs: 0, bytes: 0, packets: 0, keyframes: 0, lastKeyframeBytes: 0, framesRendered: 0, framesDropped: 0, decoderResets: 0, decodeQueue: 0, bufferedSec: 0, queuedBytes: 0, uplinkBuffered: 0, inputsSent: 0, flowPaused: false, ...extra });

test('rates derive bitrate, fps and drops from cumulative counters', () => {
  const a = snapshot(1000, { bytes: 0, framesRendered: 0, framesDropped: 0, server: { framesIn: 0, framesSent: 0, framesDropped: 0, bytesSent: 0, keyframes: 0, buffered: 0, rssMb: 50, uptimeMs: 1000 } });
  const b = snapshot(3000, { bytes: 1_500_000, framesRendered: 60, framesDropped: 4, rttMs: 12, server: { framesIn: 62, framesSent: 60, framesDropped: 2, bytesSent: 1_500_000, keyframes: 2, buffered: 0, rssMb: 50, uptimeMs: 3000 } });
  const r = rates(a, b);
  assert.equal(r.bitrateKbps, 6000);
  assert.equal(r.fps, 30);
  assert.equal(r.dropPerSec, 2);
  assert.equal(r.rttMs, 12);
  assert.equal(r.serverFps, 30);
  // A reconnect resets counters: never report negative or garbage rates.
  assert.deepEqual(rates(b, snapshot(4000, { bytes: 10 })), { bitrateKbps: 0, fps: 0, dropPerSec: 0, rttMs: undefined });
  assert.equal(rates(undefined, b).bitrateKbps, 0);
});

test('server stats are validated and formatting is human-readable', () => {
  const good = { type: 'stats', framesIn: 1, framesSent: 1, framesDropped: 0, bytesSent: 10, keyframes: 1, buffered: 0, rssMb: 40, uptimeMs: 500, load: 1.5 };
  assert.deepEqual(parseServerStats(good), { framesIn: 1, framesSent: 1, framesDropped: 0, bytesSent: 10, keyframes: 1, buffered: 0, rssMb: 40, uptimeMs: 500, load: 1.5 });
  assert.equal(parseServerStats({ ...good, framesSent: -1 }), undefined);
  assert.equal(parseServerStats({ ...good, rssMb: '40' }), undefined);
  assert.equal(formatBitrate(850), '850 Kbps');
  assert.equal(formatBitrate(6000), '6.00 Mbps');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatDuration(3_725_000), '01:02:05');
  assert.equal(sparkPoints([], 120, 28), '');
  assert.equal(sparkPoints([0, 10], 120, 28), '0.0,27.0 120.0,1.0');
});

class FakeWebSocket {
  static OPEN = 1; static latest;
  readyState = 1; sent = []; bufferedAmount = 0;
  constructor(url) { this.url = url; FakeWebSocket.latest = this; }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
}
class FakeVideoDecoder {
  static async isConfigSupported(config) { return { supported: true, config }; }
  state = 'unconfigured'; decodeQueueSize = 0; chunks = [];
  constructor(callbacks) { this.callbacks = callbacks; FakeVideoDecoder.latest = this; }
  configure() { this.state = 'configured'; }
  reset() { this.decodeQueueSize = 0; }
  decode(chunk) { this.chunks.push(chunk); }
  close() { this.state = 'closed'; }
}

test('video client counts traffic, frames, drops, RTT and gateway stats', async (t) => {
  const globals = { WebSocket: FakeWebSocket, VideoDecoder: FakeVideoDecoder, EncodedVideoChunk: class { constructor(o) { Object.assign(this, o); } }, location: { protocol: 'http:', host: 'localhost' } };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, d] of Object.entries(previous)) d ? Object.defineProperty(globalThis, key, d) : delete globalThis[key]; });

  const client = new VideoClient({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }, () => {}, (m) => assert.fail(m), () => {});
  await client.connect('balanced');
  const ws = FakeWebSocket.latest;
  ws.onopen();
  assert.deepEqual(ws.sent.map((m) => JSON.parse(m).type), ['start', 'ping'], 'start is sent first, then an RTT probe');
  ws.onmessage({ data: JSON.stringify({ type: 'pong' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 1920, height: 1080, fps: 30 }) });
  ws.onmessage({ data: new Uint8Array([0, 1]).buffer }); // delta before keyframe: dropped
  ws.onmessage({ data: new Uint8Array([1, 1, 2, 3]).buffer });
  FakeVideoDecoder.latest.callbacks.output({ close() {} });
  client.sendInput({ type: 'move', x: 0.5, y: 0.5 });
  client.requestServerStats();
  assert.deepEqual(ws.sent.slice(-2).map((m) => JSON.parse(m).type), ['stats', 'ping'], 'the stats poll also probes RTT');
  ws.onmessage({ data: JSON.stringify({ type: 'stats', framesIn: 5, framesSent: 4, framesDropped: 1, bytesSent: 99, keyframes: 1, buffered: 0, rssMb: 42, uptimeMs: 1000 }) });

  const s = client.stats();
  assert.equal(s.codec, 'hevc');
  assert.equal(s.width, 1920);
  assert.equal(s.height, 1080);
  assert.equal(s.bytes, 6);
  assert.equal(s.packets, 2);
  assert.equal(s.keyframes, 1);
  assert.equal(s.lastKeyframeBytes, 3);
  assert.equal(s.framesRendered, 1);
  assert.equal(s.framesDropped, 1);
  assert.equal(s.inputsSent, 1, 'pings and stats requests are not counted as input');
  assert.ok(s.rttMs >= 0 && s.rttMinMs >= 0);
  assert.equal(s.server.rssMb, 42);
  client.close();
});

test('stats for nerds is opt-in and the gateway answers stats requests without user input side effects', () => {
  const ui = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(ui, /localStorage\.getItem\('remotecontrol-nerd-stats'\) === '1'/, 'defaults to off unless explicitly enabled');
  assert.match(ui, /\{nerdStatsAllowed && <button className="stats-trigger"/, 'Stats button only exists after opting in');
  assert.match(ui, /\{statsOpen && nerdStatsAllowed && <StatsPanel/);
  const server = readFileSync(new URL('../server/video.ts', import.meta.url), 'utf8');
  assert.match(server, /if \(event\.type === 'stats'\) \{[\s\S]*?now - lastStatsAt < 250\) return;[\s\S]*?return;\s*\}/, 'stats replies are rate limited and never reach the capture agent');
});
