import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSync } from 'esbuild';

// Bundle so video.ts's local imports (stats helpers) are inlined into one evaluable CJS module.
const compiled = buildSync({ entryPoints: [new URL('../src/video.ts', import.meta.url).pathname], bundle: true, format: 'cjs', write: false, platform: 'neutral', logLevel: 'silent' }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', compiled)(module, module.exports);
const { VideoClient } = module.exports;

class FakeWebSocket {
  static OPEN = 1;
  static latest;
  readyState = FakeWebSocket.OPEN;
  sent = [];
  constructor(url) { this.url = url; FakeWebSocket.latest = this; }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

class FakeVideoDecoder {
  static supportConfigs = [];
  static instances = [];
  static async isConfigSupported(config) {
    this.supportConfigs.push(config);
    return { supported: true, config };
  }
  state = 'unconfigured';
  decodeQueueSize = 0;
  configurations = [];
  chunks = [];
  resetCount = 0;
  constructor(callbacks) { this.callbacks = callbacks; FakeVideoDecoder.instances.push(this); }
  configure(config) { if (this.state === 'closed') throw new Error('closed'); this.state = 'configured'; this.configurations.push(config); }
  reset() { this.resetCount++; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
  decode(chunk) { if (this.state !== 'configured') throw new Error('unconfigured'); this.chunks.push(chunk); }
  close() { if (this.state === 'closed') throw new Error('already closed'); this.state = 'closed'; }
}

class FakeEncodedVideoChunk {
  constructor(options) { Object.assign(this, options); }
}

// Playout clock. By default every read advances it far more than a frame interval, so each frame counts as late and
// is decoded the moment it arrives; playout tests set `step` to 0 and move time explicitly.
const clock = { time: 0, step: 50, now() { this.time += this.step; return this.time; } };

function installBrowserMocks(t) {
  clock.time = 0;
  clock.step = 50;
  const previous = new Map();
  const values = {
    WebSocket: FakeWebSocket,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    location: { protocol: 'http:', host: 'localhost' },
    performance: clock,
  };
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  FakeWebSocket.latest = undefined;
  FakeVideoDecoder.instances = [];
  FakeVideoDecoder.supportConfigs = [];
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

function canvas() {
  return { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
}

function packet(key) {
  return new Uint8Array([key ? 1 : 0, 0x26]).buffer;
}

test('decoder overload reset reconfigures and waits for a keyframe', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, (message) => assert.fail(message), () => {});
  await client.connect('balanced');
  assert.deepEqual(FakeVideoDecoder.supportConfigs, [{ codec: 'hvc1.1.6.L150.B0' }]);
  const ws = FakeWebSocket.latest;
  assert.equal(ws.url, 'ws://localhost/stream');
  ws.onopen();
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'start', codec: 'hevc', quality: 'balanced' });
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720, fps: 24 }) });
  const decoder = FakeVideoDecoder.instances[0];
  assert.equal(decoder.configurations.length, 1);

  decoder.decodeQueueSize = 13;
  ws.onmessage({ data: packet(false) });
  assert.equal(decoder.resetCount, 1);
  assert.equal(decoder.configurations.length, 2);
  assert.equal(decoder.chunks.length, 0, 'delta frames must be dropped until a keyframe arrives');
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { type: 'keyframe' }, 'a reset asks the host for a keyframe');

  ws.onmessage({ data: packet(true) });
  ws.onmessage({ data: packet(false) });
  assert.deepEqual(decoder.chunks.map(({ type }) => type), ['key', 'delta']);
  client.close();
});

test('a transient decode burst keeps playing without requesting a keyframe', async t => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, message => assert.fail(message), () => {});
  t.after(() => client.close());
  await client.connect('1080p30');
  const ws = FakeWebSocket.latest;
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720, fps: 30 }) });
  const decoder = FakeVideoDecoder.instances[0];
  ws.onmessage({ data: packet(true) });
  decoder.decodeQueueSize = 6;
  ws.onmessage({ data: packet(false) });
  ws.onmessage({ data: packet(false) });
  assert.equal(decoder.resetCount, 0, 'a small delivery burst must not force a frozen keyframe wait');
  assert.equal(decoder.chunks.length, 3);
  assert.equal(ws.sent.filter(value => JSON.parse(value).type === 'keyframe').length, 0, 'a burst that drains on its own does not cost a keyframe');
  decoder.decodeQueueSize = 0;
  ws.onmessage({ data: packet(true) });
  assert.equal(decoder.resetCount, 0, 'a drained decoder does not need resetting');
  assert.equal(client.stats().framesDropped, 0);
});

test('persistent moderate decode backlog switches on the arriving keyframe without discarding preceding deltas', async t => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, message => assert.fail(message), () => {});
  t.after(() => client.close());
  await client.connect('1080p60');
  const ws = FakeWebSocket.latest;
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720, fps: 60 }) });
  const decoder = FakeVideoDecoder.instances[0];
  ws.onmessage({ data: packet(true) });
  decoder.decodeQueueSize = 10;
  ws.onmessage({ data: packet(false) });
  assert.equal(decoder.resetCount, 0);
  assert.equal(decoder.chunks.at(-1).type, 'delta');
  ws.onmessage({ data: packet(true) });
  assert.equal(decoder.resetCount, 1);
  assert.equal(decoder.chunks.at(-1).type, 'key', 'the recovery frame is decoded in the same message');
  ws.onmessage({ data: packet(false) });
  assert.equal(decoder.chunks.at(-1).type, 'delta', 'no extra waiting phase after the recovery keyframe');
  assert.equal(ws.sent.filter(value => JSON.parse(value).type === 'keyframe').length, 0, 'the keyframe that arrived anyway is the recovery point');
});

test('stream metadata must match the negotiated codec and close codes are forwarded', async (t) => {
  installBrowserMocks(t);
  const errors = [];
  let closed;
  const client = new VideoClient(canvas(), () => {}, (message) => errors.push(message), (code) => { closed = code; });
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'avc1.42E032', width: 640, height: 480 }) });
  assert.deepEqual(errors, ['Video stream configuration is invalid.']);
  assert.equal(FakeVideoDecoder.instances.length, 0);
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'h264', codecString: 'avc1.42E032', width: 640, height: 480 }) });
  assert.deepEqual(errors.at(-1), 'Video stream codec did not match requested codec.');
  ws.onclose({ code: 4000 });
  assert.equal(closed, 4000);
  ws.onclose({ code: 4001 });
  assert.equal(closed, 4001);
});

test('cleanup is safe after a fatal decoder error and when called twice', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, () => {}, () => {});
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 640, height: 480 }) });
  const decoder = FakeVideoDecoder.instances[0];
  decoder.state = 'closed';
  assert.doesNotThrow(() => { client.close(); client.close(); });
  assert.equal(ws.readyState, 3);
});

test('input backlog drops motion and closes on a critical key event', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, () => {}, () => {});
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  ws.bufferedAmount = 70 * 1024;
  client.sendInput({ type: 'move', x: 0.5, y: 0.5 });
  assert.equal(ws.sent.length, 0);
  assert.equal(ws.readyState, FakeWebSocket.OPEN);
  client.sendInput({ type: 'key', code: 'KeyA', down: false });
  assert.equal(ws.readyState, 3);
  client.close();
});

test('long text is paced and sent without disconnecting', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, () => {}, () => {});
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  await client.sendText('x'.repeat(64));
  assert.equal(ws.readyState, FakeWebSocket.OPEN);
  assert.equal(ws.sent.length, 4);
  assert.equal(ws.sent.map((message) => JSON.parse(message).text).join(''), 'x'.repeat(64));
  client.close();
});

test('pastes and subsequent keys retain input order', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, () => {}, () => {});
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  const first = client.sendText('A'.repeat(32));
  const second = client.sendText('B'.repeat(32));
  client.sendInput({ type: 'key', code: 'Enter', down: true });
  await Promise.all([first, second]);
  assert.deepEqual(ws.sent.map((value) => JSON.parse(value)), [
    { type: 'text', text: 'A'.repeat(16) }, { type: 'text', text: 'A'.repeat(16) },
    { type: 'text', text: 'B'.repeat(16) }, { type: 'text', text: 'B'.repeat(16) },
    { type: 'key', code: 'Enter', down: true },
  ]);
  client.close();
});

test('key between pastes and pointer before click preserve order', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, () => {}, () => {});
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  const first = client.sendText('A'.repeat(32));
  client.sendInput({ type: 'key', code: 'Enter', down: true });
  const second = client.sendText('B'.repeat(32));
  client.sendInput({ type: 'move', x: 0.25, y: 0.5 });
  client.sendInput({ type: 'button', button: 'left', down: true });
  await Promise.all([first, second]);
  assert.deepEqual(ws.sent.map((value) => JSON.parse(value)), [
    { type: 'text', text: 'A'.repeat(16) }, { type: 'text', text: 'A'.repeat(16) },
    { type: 'key', code: 'Enter', down: true },
    { type: 'text', text: 'B'.repeat(16) }, { type: 'text', text: 'B'.repeat(16) },
    { type: 'move', x: 0.25, y: 0.5 }, { type: 'button', button: 'left', down: true },
  ]);
  client.close();
});

test('H.264-only host does not request HEVC from a capable browser', async (t) => {
  installBrowserMocks(t);
  const client = new VideoClient(canvas(), () => {}, () => {}, () => {});
  await client.connect('balanced', 'h264');
  assert.deepEqual(FakeVideoDecoder.supportConfigs, [{ codec: 'avc1.42E032' }]);
  const ws = FakeWebSocket.latest;
  ws.onopen();
  assert.equal(JSON.parse(ws.sent[0]).codec, 'h264');
  client.close();
});

test('Windows HEVC codec string is negotiated and accepted by WebCodecs', async (t) => {
  installBrowserMocks(t);
  const errors = [];
  const client = new VideoClient(canvas(), () => {}, (error) => errors.push(error), () => {});
  await client.connect('balanced', undefined, 'hvc1.1.6.L150.90');
  assert.deepEqual(FakeVideoDecoder.supportConfigs, [{ codec: 'hvc1.1.6.L150.90' }]);
  const ws = FakeWebSocket.latest;
  ws.onopen();
  assert.equal(JSON.parse(ws.sent[0]).codec, 'hevc');
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.90', width: 1280, height: 720, fps: 24 }) });
  assert.deepEqual(errors, []);
  assert.equal(FakeVideoDecoder.instances[0].configurations[0].codec, 'hvc1.1.6.L150.90');
  client.close();
});

test('video traffic prevents false heartbeat timeouts, but a silent connection still closes', async (t) => {
  installBrowserMocks(t);
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const closed = [];
  const client = new VideoClient(canvas(), () => {}, (message) => assert.fail(message), (code) => closed.push(code));
  t.after(() => client.close());
  await client.connect('balanced');
  const ws = FakeWebSocket.latest;
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720 }) });
  const decoder = FakeVideoDecoder.instances[0];
  decoder.callbacks.output({ close() {} });
  for (let i = 0; i < 8; i++) {
    ws.onmessage({ data: packet(true) });
    t.mock.timers.tick(15_000);
  }
  assert.equal(ws.readyState, FakeWebSocket.OPEN, 'video traffic is sufficient without a pong');
  assert.deepEqual(closed, []);
  for (let i = 0; i < 4; i++) t.mock.timers.tick(15_000);
  assert.equal(ws.readyState, 3);
  assert.deepEqual(closed, [1006]);
});

test('closed clients ignore late frames and cannot become ready again', async (t) => {
  installBrowserMocks(t);
  let ready = 0;
  const client = new VideoClient(canvas(), () => ready++, (message) => assert.fail(message), () => {});
  await client.connect('balanced');
  const ws = FakeWebSocket.latest;
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 640, height: 480 }) });
  const decoder = FakeVideoDecoder.instances[0];
  client.close();
  ws.onmessage({ data: packet(true) });
  decoder.callbacks.output({ close() {} });
  assert.equal(decoder.chunks.length, 0);
  assert.equal(ready, 0);
});

test('background timer suspension gets one fresh probe, not unlimited timeout grace', async (t) => {
  installBrowserMocks(t);
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 });
  const closed = [];
  const client = new VideoClient(canvas(), () => {}, (message) => assert.fail(message), (code) => closed.push(code));
  t.after(() => client.close());
  await client.connect('balanced');
  const ws = FakeWebSocket.latest;
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 640, height: 480 }) });
  FakeVideoDecoder.instances[0].callbacks.output({ close() {} });
  t.mock.timers.tick(90_000);
  assert.equal(ws.readyState, FakeWebSocket.OPEN, 'allow a fresh probe after suspension');
  assert.equal(JSON.parse(ws.sent.at(-1)).type, 'ping');
  t.mock.timers.tick(60_000);
  assert.equal(ws.readyState, 3, 'without new data, a later delayed tick must not extend grace');
  assert.deepEqual(closed, [1006]);
});

function playoutClient(t, fps = 25) {
  installBrowserMocks(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  clock.step = 0;
  const client = new VideoClient(canvas(), () => {}, message => assert.fail(message), () => {});
  t.after(() => client.close());
  return client.connect('1080p30').then(() => {
    const ws = FakeWebSocket.latest;
    ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720, fps }) });
    const advance = ms => { clock.time += ms; t.mock.timers.tick(ms); };
    return { client, ws, decoder: FakeVideoDecoder.instances[0], advance, send: key => ws.onmessage({ data: packet(key) }) };
  });
}

test('canvas playout spreads clumped arrivals back to the frame interval and adds no delay on a steady link', async t => {
  const { client, decoder, advance, send } = await playoutClient(t);
  // Steady 40 ms arrivals: decoded on arrival.
  send(true);
  for (let i = 0; i < 4; i++) { advance(40); send(false); }
  assert.equal(decoder.chunks.length, 5);
  assert.equal(client.stats().playoutMs, 0);
  // A tunnel stalls for 120 ms, then delivers the three held frames at once.
  advance(120);
  for (let i = 0; i < 3; i++) send(false);
  assert.equal(decoder.chunks.length, 6, 'only the overdue frame is decoded immediately');
  advance(39);
  assert.equal(decoder.chunks.length, 6);
  advance(1);
  assert.equal(decoder.chunks.length, 7, 'the clump is released one frame interval apart');
  assert.equal(client.stats().playoutMs, 80, 'the buffer now covers the observed spread');
  // The link is steady again (frames on their original schedule).
  for (let i = 0; i < 100; i++) { send(false); advance(40); }
  assert.equal(client.stats().playoutMs, 80, 'the jitter peak is held for a while so the next stall is absorbed as well');
  for (let i = 0; i < 400; i++) { send(false); advance(40); }
  t.mock.timers.tick(200);
  assert.equal(decoder.chunks.length, 508);
  assert.equal(client.stats().playoutMs, 0, 'then the added delay eases back to zero');
});

test('canvas playout delay is capped and a decoder reset drops buffered frames', async t => {
  const { client, decoder, send } = await playoutClient(t);
  send(true);
  clock.time += 500;
  send(false);
  assert.equal(client.stats().playoutMs, 250);
  // The stalled frames arrive with it: those more than the cap overdue are decoded at once, the rest are paced.
  for (let i = 0; i < 15; i++) send(false);
  assert.equal(decoder.chunks.length, 7, 'frames inside the capped window wait for their turn');
  decoder.decodeQueueSize = 13;
  const before = decoder.chunks.length;
  send(true);
  assert.equal(decoder.resetCount, 1);
  assert.equal(decoder.chunks.length, before + 1, 'the recovery keyframe is decoded at once');
  assert.equal(decoder.chunks.at(-1).type, 'key');
  t.mock.timers.tick(1000);
  assert.equal(decoder.chunks.length, before + 1, 'buffered pre-reset deltas are discarded');
});

test('decoded frames are drawn at once, late ones counted, and playback counters reported every 5 s', async t => {
  const { client, ws, decoder, advance, send } = await playoutClient(t);
  ws.onopen();
  const closed = [];
  const output = () => { const chunk = decoder.chunks.at(-1); decoder.callbacks.output({ timestamp: chunk.timestamp, close() { closed.push(chunk.timestamp); } }); };
  send(true); output();
  assert.equal(client.stats().framesRendered, 1, 'no frame is held back from the decoder');
  advance(40); send(false);
  advance(90); output();
  assert.equal(client.stats().framesLate, 1, 'a frame drawn more than an interval after its playout time is counted');
  assert.equal(closed.length, 2);
  for (let i = 0; i < 100; i++) { clock.time += 50; t.mock.timers.tick(50); }
  const diag = ws.sent.map(value => JSON.parse(value)).find(value => value.type === 'diag');
  // The test clock jumps in steps larger than the 50 ms timer above, so `block` is checked separately below.
  assert.deepEqual({ ...diag, rtt: 0, block: 0 }, { type: 'diag', rendered: 2, dropped: 0, late: 1, resets: 0, smoothing: 0, gap: 130, queue: 0, rtt: 0, lateNearKey: 1, lateMax: 90, jitter: 0, decodeMax: 90, block: 0 });
  assert.equal(client.stats().inputsSent, 0, 'diagnostics are not counted as input');
  // A page busy for 300 ms delays the 50 ms timer by 250 ms.
  clock.time += 300; t.mock.timers.tick(50);
  for (let i = 0; i < 99; i++) { clock.time += 50; t.mock.timers.tick(50); }
  const next = ws.sent.map(value => JSON.parse(value)).filter(value => value.type === 'diag').at(-1);
  assert.equal(next.block, 250);
});

test('canvas playout re-anchors after upstream drops shift every later frame past the cap', async t => {
  const { client, advance, send } = await playoutClient(t);
  send(true);
  advance(400); // the gateway dropped ten frames: the next ones keep arriving 400 ms after their sequence time
  for (let i = 0; i < 20; i++) { send(false); advance(40); }
  assert.equal(client.stats().playoutMs, 0, 'the estimate follows the new host clock offset instead of leaving frames unpaced');
});
