import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../src/video.ts', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
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

class FakeMediaSource {
  static latest;
  static hevcSupported = false;
  static isTypeSupported(type) { return type.includes('avc1.42E032') || (this.hevcSupported && type.includes('hvc1.1.6.L150.90')); }
  readyState = 'closed';
  listeners = {};
  sourceBuffer;
  constructor() { FakeMediaSource.latest = this; }
  addEventListener(name, callback, options) { this.listeners[name] = { callback, options }; }
  addSourceBuffer() { this.sourceBuffer = new FakeSourceBuffer(); return this.sourceBuffer; }
  open() { this.readyState = 'open'; this.listeners.sourceopen.callback(); }
  endOfStream() { this.readyState = 'ended'; }
}

class FakeSourceBuffer {
  updating = false;
  appended = [];
  buffered = { length: 0, start: () => 0, end: () => 0 };
  listeners = {};
  appendBuffer(buffer) { this.appended.push(buffer); this.updating = true; }
  remove() {}
  addEventListener(name, callback) { this.listeners[name] = callback; }
  finish() { this.updating = false; this.buffered = { length: this.appended.length ? 1 : 0, start: () => 0, end: () => 0.1 }; this.listeners.updateend(); }
}

function installMocks(t) {
  const previous = new Map();
  const values = {
    WebSocket: FakeWebSocket,
    MediaSource: FakeMediaSource,
    VideoDecoder: undefined,
    location: { protocol: 'http:', host: 'lan-host:8787' },
    URL: { createObjectURL: () => 'blob:mse-test', revokeObjectURL() {} },
  };
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  FakeMediaSource.latest = undefined;
  FakeMediaSource.hevcSupported = false;
  FakeWebSocket.latest = undefined;
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

function videoElement() {
  const listeners = {};
  return {
    width: 0, height: 0, muted: false, playsInline: false, src: '', currentTime: 0,
    listeners,
    addEventListener(name, callback) { listeners[name] = callback; },
    removeEventListener(name, callback) { if (listeners[name] === callback) delete listeners[name]; },
    play: async () => {}, pause() {}, removeAttribute(name) { if (name === 'src') this.src = ''; }, load() {}, focus() {}, requestVideoFrameCallback(callback) { callback(); },
  };
}

function initPacket() { return new Uint8Array([0, 1, 2, 3, 4, 5]).buffer; }
function mediaPacket(key) { return new Uint8Array([1, key ? 1 : 0, 0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]).buffer; }

test('WebCodecs absence negotiates H.264 MSE and appends init before fragmented media', async (t) => {
  installMocks(t);
  let ready;
  const media = videoElement();
  const client = new VideoClient({ width: 0, height: 0, getContext: () => null }, (codec) => { ready = codec; }, (error) => assert.fail(error), () => {}, media);
  await client.connect('balanced');
  const ws = FakeWebSocket.latest;
  assert.equal(ws.url, 'ws://lan-host:8787/stream');
  ws.onopen();
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'start', codec: 'h264', quality: 'balanced', format: 'mse' });
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'h264', codecString: 'avc1.42E032', width: 640, height: 480, fps: 24, format: 'mse' }) });
  const mediaSource = FakeMediaSource.latest;
  mediaSource.open();
  ws.onmessage({ data: initPacket() });
  ws.onmessage({ data: mediaPacket(true) });
  const source = mediaSource.sourceBuffer;
  assert.equal(source.appended.length, 1, 'init is first append');
  source.finish();
  assert.equal(source.appended.length, 2, 'media fragment follows init');
  assert.equal(new Uint8Array(source.appended[1])[4], 0x6d, 'fragment starts with moof');
  source.finish();
  media.listeners.playing();
  assert.equal(media.width, 640);
  assert.equal(media.height, 480);
  client.close();
  assert.equal(ws.readyState, 3);
  assert.equal(media.src, '');
});

test('MSE initialization is queued before sourceopen and keyframe gating drops deltas', async (t) => {
  installMocks(t);
  const media = videoElement();
  const client = new VideoClient({ width: 0, height: 0, getContext: () => null }, () => {}, (error) => assert.fail(error), () => {}, media);
  await client.connect('data');
  const ws = FakeWebSocket.latest;
  ws.onmessage({ data: JSON.stringify({ type: 'stream', codec: 'h264', codecString: 'avc1.42E032', width: 320, height: 240, fps: 30, format: 'mse' }) });
  ws.onmessage({ data: initPacket() });
  ws.onmessage({ data: mediaPacket(false) });
  FakeMediaSource.latest.open();
  const source = FakeMediaSource.latest.sourceBuffer;
  assert.equal(source.appended.length, 1, 'queued init segment is installed');
  source.finish();
  assert.equal(source.appended.length, 1, 'delta frames are dropped until a keyframe');
  client.close();
});

test('HTTP MSE selects HEVC only when explicitly enabled and supported, otherwise H.264', async (t) => {
  installMocks(t);
  FakeMediaSource.hevcSupported = true;
  const optedIn = new VideoClient({ width: 0, height: 0, getContext: () => null }, () => {}, (error) => assert.fail(error), () => {}, videoElement());
  await optedIn.connect('balanced', undefined, 'hvc1.1.6.L150.90', true);
  const hevc = FakeWebSocket.latest;
  hevc.onopen();
  assert.deepEqual(JSON.parse(hevc.sent[0]), { type: 'start', codec: 'hevc', quality: 'balanced', format: 'mse' });
  optedIn.close();

  const fallbackWhenUnflagged = new VideoClient({ width: 0, height: 0, getContext: () => null }, () => {}, (error) => assert.fail(error), () => {}, videoElement());
  await fallbackWhenUnflagged.connect('balanced', undefined, 'hvc1.1.6.L150.90', false);
  const h264Unflagged = FakeWebSocket.latest;
  h264Unflagged.onopen();
  assert.equal(JSON.parse(h264Unflagged.sent[0]).codec, 'h264');
  fallbackWhenUnflagged.close();

  FakeMediaSource.hevcSupported = false;
  const fallbackWhenUnsupported = new VideoClient({ width: 0, height: 0, getContext: () => null }, () => {}, (error) => assert.fail(error), () => {}, videoElement());
  await fallbackWhenUnsupported.connect('balanced', undefined, 'hvc1.1.6.L150.90', true);
  const h264Unsupported = FakeWebSocket.latest;
  h264Unsupported.onopen();
  assert.equal(JSON.parse(h264Unsupported.sent[0]).codec, 'h264');
  fallbackWhenUnsupported.close();
});

for (const codec of ['hevc', 'h264']) {
  test(`${codec} MSE reports video errors after the first frame and unbinds on close`, async (t) => {
    installMocks(t);
    FakeMediaSource.hevcSupported = true;
    const errors = [];
    const media = videoElement();
    let ready;
    const client = new VideoClient({ width: 0, height: 0, getContext: () => null }, (value) => { ready = value; }, (error) => errors.push(error), () => {}, media);
    t.after(() => client.close());
    await client.connect('balanced', codec === 'h264' ? 'h264' : undefined, 'hvc1.1.6.L150.90', true);
    FakeWebSocket.latest.onopen();
    FakeWebSocket.latest.onmessage({ data: JSON.stringify({ type: 'stream', codec, codecString: codec === 'hevc' ? 'hvc1.1.6.L150.90' : 'avc1.42E032', width: 640, height: 480, format: 'mse' }) });
    assert.equal(typeof media.listeners.error, 'function');
    media.listeners.playing();
    assert.equal(ready, codec, 'first frame has rendered and cleared the startup timer');
    const handler = media.listeners.error;
    handler();
    assert.deepEqual(errors, [`${codec === 'hevc' ? 'HEVC' : 'H.264'} decoding failed in the video element.`]);
    client.close();
    assert.equal(media.listeners.error, undefined);
    handler();
    assert.equal(errors.length, 1, 'a queued error after close is ignored');
  });
}
