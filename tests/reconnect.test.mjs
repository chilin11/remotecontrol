import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// Run the real connection handlers with a controllable clock and transports.
const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('  function connectVnc('), source.indexOf('  function connect()'));
const compiled = transformSync(handlers, { loader: 'ts', format: 'cjs' }).code;
function fixture(mode = 'video') {
  let now = 1000;
  const clients = [], timers = [], delays = [];
  const ref = (current) => ({ current });
  const element = { focus() {}, replaceChildren() {} };
  const refs = {
    canvasRef: ref(element), mediaRef: ref(element), viewerRef: ref(element),
    videoRef: ref(null), rfbRef: ref(null), intentional: ref(false),
    retryTimer: ref(null), retryCount: ref(0), connectedAt: ref(0), noRetry: ref(false),
    hevcFallbackReason: ref(''), qualityRef: ref('balanced'), cachedCredentials: ref(null),
  };
  class Client {
    renderMode = 'canvas';
    constructor(_canvas, ready, error, closed) { Object.assign(this, { ready, error, closed }); clients.push(this); }
    async connect(_quality, codec) { this.activeCodec = codec ?? 'hevc'; }
    close() {}
  }
  class Rfb {
    listeners = {};
    constructor() { clients.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    ready() { this.listeners.connect(); }
    closed() { this.listeners.disconnect({ detail: { clean: false } }); }
    focus() {}
    disconnect() {}
  }
  const noop = () => {};
  const values = {
    ...refs, VideoClient: Client, VideoDecoder: Client, RFB: Rfb,
    quality: 'balanced', hevcVideo: true, hevcCodecString: 'hvc1.1.6.L150.B0', hevcMseVideo: true,
    fit: true, lowQuality: () => false, location: { protocol: 'http:', host: 'localhost' },
    releaseVideoInput: noop, setVideoPlayback: noop, setStatus: noop,
    setActiveCodec: noop, setMessage: noop, setCredentials: noop,
    Date: { now: () => now },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); delays.push(delay); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  };
  const api = new Function(...Object.keys(values), `${compiled}; return { connectVideo, connectVnc };`)(...Object.values(values));
  return {
    ...refs, clients, timers, delays,
    connect: () => mode === 'video' ? api.connectVideo() : api.connectVnc(),
    advance(ms) { now += ms; },
    retry() { const timer = timers.shift(); assert.ok(timer, 'expected retry'); now += timer.delay; timer.callback(); },
  };
}

for (const mode of ['video', 'vnc']) {
  test(`${mode}: first frames do not reset the bounded retry budget`, () => {
    const f = fixture(mode);
    f.connect();
    for (let i = 0; i < 4; i++) {
      const client = f.clients.at(-1);
      client.ready('hevc');
      f.advance(500);
      client.closed(1006);
      if (i < 3) f.retry();
    }
    assert.deepEqual(f.delays, [1000, 2000, 4000]);
    assert.equal(f.timers.length, 0);
    assert.equal(f.clients.length, 4);
    f.connect();
    assert.equal(f.retryCount.current, 0, 'manual connect starts a fresh budget');
  });

  test(`${mode}: a stable connection restores the retry budget`, () => {
    const f = fixture(mode);
    f.connect();
    f.clients.at(-1).closed(1006); f.retry();
    f.clients.at(-1).closed(1006); f.retry();
    f.clients.at(-1).ready('hevc');
    f.advance(30_000);
    f.clients.at(-1).closed(1006);
    assert.equal(f.timers.at(-1).delay, 1000);
    assert.equal(f.retryCount.current, 1);
  });
}

test('HEVC fallback during an automatic retry preserves its budget', () => {
  const f = fixture();
  f.connect();
  f.clients.at(-1).closed(1006); f.retry();
  f.clients.at(-1).error('HEVC decoding failed.');
  assert.equal(f.clients.at(-1).activeCodec, 'h264');
  assert.equal(f.retryCount.current, 1);
  f.clients.at(-1).ready('h264');
  f.clients.at(-1).closed(1006);
  assert.equal(f.timers.at(-1).delay, 2000);
});

test('takeover and sign-out never reconnect and stale callbacks cannot replace the current client', () => {
  for (const code of [4000, 4001]) {
    const f = fixture();
    f.connect();
    const previous = f.clients.at(-1);
    f.connect();
    const current = f.videoRef.current;
    previous.ready('hevc'); previous.closed(1006);
    assert.equal(f.videoRef.current, current);
    assert.equal(f.connectedAt.current, 0);
    assert.equal(f.timers.length, 0);
    current.closed(code);
    assert.equal(f.noRetry.current, true);
    assert.equal(f.timers.length, 0);
  }
});
