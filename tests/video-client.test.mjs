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

function installBrowserMocks(t) {
  const previous = new Map();
  const values = {
    WebSocket: FakeWebSocket,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk,
    location: { protocol: 'http:', host: 'localhost' },
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

  decoder.decodeQueueSize = 4;
  ws.onmessage({ data: packet(false) });
  assert.equal(decoder.resetCount, 1);
  assert.equal(decoder.configurations.length, 2);
  assert.equal(decoder.chunks.length, 0, 'delta frames must be dropped until a keyframe arrives');

  ws.onmessage({ data: packet(true) });
  ws.onmessage({ data: packet(false) });
  assert.deepEqual(decoder.chunks.map(({ type }) => type), ['key', 'delta']);
  client.close();
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
