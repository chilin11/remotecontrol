import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../server/video.ts', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const nativeRequire = createRequire(new URL('../server/video.ts', import.meta.url));
let spawnCount = 0;
let lastChild;
const fakeChild = () => {
  const child = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { writable: true, writableLength: 0, write() {}, end() {} });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  lastChild = child;
  return child;
};
function loadServer(hostPlatform) {
  const module = { exports: {} };
  const requireServerDependency = (specifier) => {
    if (specifier === './config.js') return { hostPlatform, nativeAgentPath: '/fake-agent' };
    if (specifier === 'node:child_process') return { spawn: () => { spawnCount++; return fakeChild(); } };
    return nativeRequire(specifier);
  };
  new Function('require', 'module', 'exports', compiled)(requireServerDependency, module, module.exports);
  return module.exports.attachVideo;
}

class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent = [];
  handlers = {};
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = { code, reason }; }
  request(data) { this.handlers.message(data, false); }
  on(name, callback) { this.handlers[name] = callback; }
}
function connect(attachVideo, codec, format) {
  const ws = new FakeWebSocket();
  attachVideo(ws);
  ws.request(JSON.stringify({ type: 'start', codec, quality: 'data', ...(format ? { format } : {}) }));
  return ws;
}
function bits(value, count) { return Array.from({ length: count }, (_, i) => (value >>> (count - i - 1)) & 1); }
function ue(value) {
  const encoded = value + 1;
  const body = bits(encoded, Math.floor(Math.log2(encoded)) + 1);
  return [...Array(body.length - 1).fill(0), ...body];
}
function makeSps() {
  const data = [
    ...bits(0, 4), ...bits(0, 3), ...bits(1, 1), // VPS id, temporal layers, nesting
    ...bits(0, 2), ...bits(0, 1), ...bits(1, 5), ...bits(0x60000000, 32), ...bits(0x90, 8), ...bits(0, 40), ...bits(150, 8),
    ...ue(0), ...ue(1), ...ue(640), ...ue(480), 0, ...ue(0), ...ue(0),
  ];
  while (data.length % 8) data.push(0);
  const rbsp = [];
  for (let i = 0; i < data.length; i += 8) rbsp.push(data.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  const escaped = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from([66, 1, ...escaped]);
}
function annexB(...nals) { return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal])); }
function capturePacket(type, payload) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
function sendAgentPacket(type, payload) { lastChild.stdout.emit('data', capturePacket(type, payload)); }
function boxes(buffer, offset, end = buffer.length) {
  const result = [];
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= end, 'valid ISO BMFF box bounds');
    result.push({ type: buffer.toString('ascii', offset + 4, offset + 8), start: offset, end: offset + size, payload: offset + 8 });
    offset += size;
  }
  assert.equal(offset, end);
  return result;
}

test('Mac HEVC MSE requests are refused before spawning capture', () => {
  const attachVideo = loadServer('darwin');
  spawnCount = 0;
  const ws = connect(attachVideo, 'hevc', 'mse');
  assert.equal(ws.sent.length, 1);
  assert.match(JSON.parse(ws.sent[0]).message, /only supported on Windows/);
  assert.equal(ws.closed.code, 1008);
  assert.equal(spawnCount, 0);
});

test('Windows HEVC MSE emits hvc1/hvcC init and length-prefixed key samples', () => {
  const attachVideo = loadServer('win32');
  spawnCount = 0;
  const ws = connect(attachVideo, 'hevc', 'mse');
  assert.equal(ws.sent.length, 0);
  assert.equal(spawnCount, 1);
  sendAgentPacket(1, Buffer.from(JSON.stringify({ type: 'stream', codec: 'hevc', codecString: 'hvc1.1.6.L150.90', width: 640, height: 480, fps: 30 })));
  const vps = Buffer.from([64, 1, 0xaa]);
  const sps = makeSps();
  const pps = Buffer.from([68, 1, 0xbb]);
  const aud = Buffer.from([70, 1, 0xf0]); // HEVC AUD type 35
  const idr = Buffer.from([38, 1, 0x80, 0x55]); // HEVC IDR_W_RADL type 19
  sendAgentPacket(2, Buffer.concat([Buffer.from([1]), annexB(aud, vps, sps, pps, idr)]));
  assert.equal(typeof ws.sent[0], 'string', 'stream metadata is forwarded first');
  const init = ws.sent[1];
  assert.equal(init[0], 0);
  const initBoxes = boxes(init, 1);
  assert.deepEqual(initBoxes.map(({ type }) => type), ['ftyp', 'moov']);
  const moovChildren = boxes(init, initBoxes[1].payload, initBoxes[1].end);
  const trak = moovChildren.find(({ type }) => type === 'trak');
  const trakChildren = boxes(init, trak.payload, trak.end);
  const mdia = trakChildren.find(({ type }) => type === 'mdia');
  const mdiaChildren = boxes(init, mdia.payload, mdia.end);
  const minf = mdiaChildren.find(({ type }) => type === 'minf');
  const minfChildren = boxes(init, minf.payload, minf.end);
  const stbl = minfChildren.find(({ type }) => type === 'stbl');
  const stblChildren = boxes(init, stbl.payload, stbl.end);
  const stsd = stblChildren.find(({ type }) => type === 'stsd');
  const sampleEntry = boxes(init, stsd.payload + 8, stsd.end)[0];
  assert.equal(sampleEntry.type, 'hvc1');
  const hvcC = boxes(init, sampleEntry.payload + 78, sampleEntry.end)[0];
  assert.equal(hvcC.type, 'hvcC');
  assert.equal(init[hvcC.payload], 1, 'hvcC configuration version');
  assert.deepEqual(init.subarray(hvcC.payload + 6, hvcC.payload + 12), Buffer.from([0x90, 0, 0, 0, 0, 0]), 'hvcC profile constraint indicator flags');
  assert.equal(init[hvcC.payload + 16] & 0x03, 1, '4:2:0 chroma format');
  const media = ws.sent[2];
  assert.equal(media[0], 1);
  assert.equal(media[1], 1, 'keyframe sample flag');
  const fragmentBoxes = boxes(media, 2);
  assert.deepEqual(fragmentBoxes.map(({ type }) => type), ['moof', 'mdat']);
  const mdat = fragmentBoxes[1];
  assert.equal(media.readUInt32BE(mdat.payload), idr.length);
  assert.deepEqual(media.subarray(mdat.payload + 4, mdat.end), idr, 'VPS/SPS/PPS/AUD are removed from sample');
  ws.handlers.close();
});

test('HEVC non-MSE stream requests remain allowed', () => {
  const attachVideo = loadServer('darwin');
  spawnCount = 0;
  const ws = connect(attachVideo, 'hevc');
  assert.equal(ws.sent.length, 0);
  assert.equal(ws.closed, undefined);
  assert.equal(spawnCount, 1);
  ws.handlers.close();
});
