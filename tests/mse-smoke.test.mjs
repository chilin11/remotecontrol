import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', 'ffmpeg'].find((candidate) => {
  const result = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
  return result.status === 0;
});
test('ffmpeg parses the generated H.264 fragmented MP4 initialization and media fragments', { skip: !ffmpeg }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remotecontrol-mse-smoke-'));
  try {
    const source = path.join(directory, 'source.h264');
    const output = path.join(directory, 'output.mp4');
    const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=2', '-frames:v', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level:v', '5.0', '-x264-params', 'aud=1:keyint=1:min-keyint=1:scenecut=0:repeat-headers=1', '-f', 'h264', source], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.stderr);
    const raw = readFileSync(source);
    const nals = [];
    for (let offset = 0; offset < raw.length;) {
      let start = -1;
      let prefix = 0;
      for (let i = offset; i + 3 < raw.length; i++) {
        if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 1) { start = i; prefix = 4; break; }
        if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1) { start = i; prefix = 3; break; }
      }
      if (start < 0) break;
      let next = raw.length;
      for (let i = start + prefix; i + 2 < raw.length; i++) {
        if (raw[i] === 0 && raw[i + 1] === 0 && (raw[i + 2] === 1 || (raw[i + 2] === 0 && raw[i + 3] === 1))) { next = i; break; }
      }
      let end = next;
      while (end > start + prefix && raw[end - 1] === 0) end--;
      if (end > start + prefix) nals.push(Buffer.from(raw.subarray(start + prefix, end)));
      offset = next;
      if (next === raw.length) break;
    }
    const sps = nals.find((nal) => (nal[0] & 0x1f) === 7);
    const pps = nals.find((nal) => (nal[0] & 0x1f) === 8);
    const idr = nals.find((nal) => (nal[0] & 0x1f) === 5);
    assert.ok(sps && pps && idr, 'encoder should create SPS, PPS and IDR NAL units');
    const avcC = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), uint16(sps.length), sps, Buffer.from([1]), uint16(pps.length), pps]);
    const avc1 = Buffer.concat([Buffer.alloc(6), uint16(1), Buffer.alloc(16), uint16(64), uint16(64), uint32(0x00480000), uint32(0x00480000), uint32(0), uint16(1), Buffer.alloc(32), uint16(0x0018), uint16(0xffff), box('avcC', avcC)]);
    const matrix = Buffer.concat([uint32(0x00010000), uint32(0), uint32(0), uint32(0), uint32(0x00010000), uint32(0), uint32(0), uint32(0), uint32(0x40000000)]);
    const mvhd = box('mvhd', Buffer.concat([full(0, 0), uint32(0), uint32(0), uint32(1000), uint32(0), uint32(0x00010000), uint16(0x0100), Buffer.alloc(10), matrix, Buffer.alloc(24), uint32(2)]));
    const tkhd = box('tkhd', Buffer.concat([full(0, 7), uint32(0), uint32(0), uint32(1), uint32(0), uint32(0), Buffer.alloc(8), uint16(0), uint16(0), uint16(0), uint16(0), matrix, uint32(64 * 65536), uint32(64 * 65536)]));
    const mdhd = box('mdhd', Buffer.concat([full(0, 0), uint32(0), uint32(0), uint32(90000), uint32(0), uint16(0x55c4), uint16(0)]));
    const hdlr = box('hdlr', Buffer.concat([full(0, 0), uint32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0')]));
    const vmhd = box('vmhd', Buffer.concat([full(0, 1), Buffer.alloc(8)]));
    const url = box('url ', full(0, 1));
    const dinf = box('dinf', box('dref', Buffer.concat([full(0, 0), uint32(1), url])));
    const stbl = box('stbl', Buffer.concat([box('stsd', Buffer.concat([full(0, 0), uint32(1), box('avc1', avc1)])), box('stts', Buffer.concat([full(0, 0), uint32(0)])), box('stsc', Buffer.concat([full(0, 0), uint32(0)])), box('stsz', Buffer.concat([full(0, 0), uint32(0), uint32(0)])), box('stco', Buffer.concat([full(0, 0), uint32(0)]))]));
    const trak = box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([mdhd, hdlr, box('minf', Buffer.concat([vmhd, dinf, stbl]))]))]));
    const trex = box('trex', Buffer.concat([full(0, 0), uint32(1), uint32(1), uint32(45000), uint32(0), uint32(0)]));
    const init = Buffer.concat([box('ftyp', Buffer.concat([Buffer.from('isom'), uint32(0x200), Buffer.from('isomiso6mp41avc1')])), box('moov', Buffer.concat([mvhd, trak, box('mvex', trex)]))]);
    const mfhd = box('mfhd', Buffer.concat([full(0, 0), uint32(1)]));
    const tfhd = box('tfhd', Buffer.concat([full(0, 0x020000), uint32(1)]));
    const tfdt = box('tfdt', Buffer.concat([full(1, 0), uint64(0)]));
    const sample = Buffer.concat([uint32(idr.length), idr]);
    const makeTraf = (offset) => box('traf', Buffer.concat([tfhd, tfdt, box('trun', Buffer.concat([full(0, 0x000701), uint32(1), uint32(offset), uint32(45000), uint32(sample.length), uint32(0x02000000)]))]));
    const firstMoof = box('moof', Buffer.concat([mfhd, makeTraf(0)]));
    const fragment = Buffer.concat([box('moof', Buffer.concat([mfhd, makeTraf(firstMoof.length + 8)])), box('mdat', sample)]);
    writeFileSync(output, Buffer.concat([init, fragment]));
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function box(type, data) { const head = Buffer.alloc(8); head.writeUInt32BE(data.length + 8); head.write(type, 4, 4, 'ascii'); return Buffer.concat([head, data]); }
function uint16(value) { const out = Buffer.alloc(2); out.writeUInt16BE(value); return out; }
function uint32(value) { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0); return out; }
function uint64(value) { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; }
function full(version, flags) { return Buffer.from([version, flags >>> 16, flags >>> 8, flags]); }
