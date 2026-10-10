import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import WebSocket from 'ws';
import { hostPlatform, nativeAgentPath } from './config.js';
type Codec = 'hevc' | 'h264';
export const qualities = ['720p30', '1080p24', '1080p30', '1080p60', '2160p24', '2160p30', '2160p60'] as const;
type Quality = typeof qualities[number];
// Preset names used by earlier versions, still accepted from cached browsers.
const legacyQualities: Record<string, Quality> = { minimal: '720p30', low: '720p30', hotel: '720p30', data: '720p30', balanced24: '1080p24', balanced: '1080p30', high15: '2160p24', high: '2160p30' };
// Encoder bitrate targets (bits/s), mirrored from the agents; they size the send backlog allowed before dropping.
const qualityBitrate: Record<Quality, number> = { '720p30': 4e6, '1080p24': 6e6, '1080p30': 8e6, '1080p60': 12e6, '2160p24': 16e6, '2160p30': 20e6, '2160p60': 35e6 };
export function normalizeQuality(value: unknown): Quality | undefined {
  if (typeof value !== 'string') return undefined;
  if ((qualities as readonly string[]).includes(value)) return value as Quality;
  return Object.hasOwn(legacyQualities, value) ? legacyQualities[value] : undefined;
}
const agentPath = nativeAgentPath;
const MAX_CAPTURE_PACKET = 16 * 1024 * 1024;
const captures = new Set<ChildProcessWithoutNullStreams>();
export async function stopAllCapture(): Promise<void> {
  await Promise.all([...captures].map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => child.kill(), 1200);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
  })));
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}
function u16(value: number): Buffer { const result = Buffer.alloc(2); result.writeUInt16BE(value & 0xffff); return result; }
function u32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32BE(value >>> 0); return result; }
function u64(value: number): Buffer { const result = Buffer.alloc(8); result.writeBigUInt64BE(BigInt(value)); return result; }
function fullBox(version: number, flags: number): Buffer { return Buffer.from([version, flags >>> 16, flags >>> 8, flags]); }

function makeInitSegment(sps: Buffer, pps: Buffer, width: number, height: number): Buffer {
  if (sps.length < 4 || sps.length > 0xffff || pps.length === 0 || pps.length > 0xffff || width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('Invalid H.264 stream configuration');
  const matrix = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const mvhd = box('mvhd', Buffer.concat([fullBox(0, 0), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2)]));
  const tkhd = box('tkhd', Buffer.concat([fullBox(0, 7), u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width * 0x10000), u32(height * 0x10000)]));
  const mdhd = box('mdhd', Buffer.concat([fullBox(0, 0), u32(0), u32(0), u32(90000), u32(0), u16(0x55c4), u16(0)]));
  const hdlr = box('hdlr', Buffer.concat([fullBox(0, 0), u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0')]));
  const vmhd = box('vmhd', Buffer.concat([fullBox(0, 1), u16(0), u16(0), u16(0), u16(0)]));
  const url = box('url ', fullBox(0, 1));
  const dinf = box('dinf', box('dref', Buffer.concat([fullBox(0, 0), u32(1), url])));
  const avcC = box('avcC', Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps]));
  const avc1 = box('avc1', Buffer.concat([Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x0018), u16(0xffff), avcC]));
  const stbl = box('stbl', Buffer.concat([
    box('stsd', Buffer.concat([fullBox(0, 0), u32(1), avc1])),
    box('stts', Buffer.concat([fullBox(0, 0), u32(0)])), box('stsc', Buffer.concat([fullBox(0, 0), u32(0)])),
    box('stsz', Buffer.concat([fullBox(0, 0), u32(0), u32(0)])), box('stco', Buffer.concat([fullBox(0, 0), u32(0)])),
  ]));
  const minf = box('minf', Buffer.concat([vmhd, dinf, stbl]));
  const trak = box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([mdhd, hdlr, minf]))]));
  const mvex = box('mvex', box('trex', Buffer.concat([fullBox(0, 0), u32(1), u32(1), u32(3000), u32(0), u32(0)])));
  const moov = box('moov', Buffer.concat([mvhd, trak, mvex]));
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0x200), Buffer.from('isomiso6mp41avc1')]));
  return Buffer.concat([ftyp, moov]);
}

type HevcProfile = { profileSpace: number; tier: number; profileIdc: number; compatibility: number; constraints: Buffer; level: number; maxSubLayers: number; temporalIdNested: number; chromaFormat: number; bitDepthLumaMinus8: number; bitDepthChromaMinus8: number };

function parseHevcSpsProfile(sps: Buffer): HevcProfile {
  if (sps.length < 4 || ((sps[0] >> 1) & 0x3f) !== 33) throw new Error('Invalid HEVC SPS');
  const rbsp: number[] = [];
  let zeros = 0;
  for (const byte of sps.subarray(2)) {
    if (zeros >= 2 && byte === 3) { zeros = 0; continue; }
    rbsp.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  let bitOffset = 0;
  const readBits = (count: number): number => {
    if (count < 0 || count > 32 || bitOffset + count > rbsp.length * 8) throw new Error('Truncated HEVC SPS');
    let value = 0;
    for (let i = 0; i < count; i++, bitOffset++) value = value * 2 + ((rbsp[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1);
    return value;
  };
  const skip = (count: number) => { while (count > 0) { const bits = Math.min(count, 32); readBits(bits); count -= bits; } };
  const readUe = (): number => {
    let leading = 0;
    while (readBits(1) === 0) { if (++leading > 31) throw new Error('Invalid HEVC SPS Exp-Golomb value'); }
    return leading === 0 ? 0 : (2 ** leading - 1) + readBits(leading);
  };
  skip(4); // sps_video_parameter_set_id
  const maxSubLayers = readBits(3);
  const temporalIdNested = readBits(1);
  const profileSpace = readBits(2);
  const tier = readBits(1);
  const profileIdc = readBits(5);
  const compatibility = readBits(32);
  const constraints = Buffer.from(Array.from({ length: 6 }, () => readBits(8)));
  const level = readBits(8);
  const subLayerFlags = Array.from({ length: maxSubLayers }, () => [readBits(1), readBits(1)]);
  if (maxSubLayers > 0) skip((8 - maxSubLayers) * 2);
  for (const [profilePresent, levelPresent] of subLayerFlags) {
    if (profilePresent) skip(88);
    if (levelPresent) skip(8);
  }
  readUe(); // sps_seq_parameter_set_id
  const chromaFormat = readUe();
  if (chromaFormat > 3) throw new Error('Invalid HEVC chroma format');
  if (chromaFormat === 3) skip(1);
  readUe(); // pic_width_in_luma_samples
  readUe(); // pic_height_in_luma_samples
  if (readBits(1)) { readUe(); readUe(); readUe(); readUe(); }
  const bitDepthLumaMinus8 = readUe();
  const bitDepthChromaMinus8 = readUe();
  if (bitDepthLumaMinus8 > 7 || bitDepthChromaMinus8 > 7) throw new Error('Unsupported HEVC bit depth');
  return { profileSpace, tier, profileIdc, compatibility, constraints, level, maxSubLayers, temporalIdNested, chromaFormat, bitDepthLumaMinus8, bitDepthChromaMinus8 };
}

function makeHevcConfig(vps: Buffer, sps: Buffer, pps: Buffer): Buffer {
  const types = [32, 33, 34];
  if ([vps, sps, pps].some((nal, i) => nal.length < 3 || nal.length > 0xffff || ((nal[0] >> 1) & 0x3f) !== types[i])) throw new Error('Invalid HEVC parameter sets');
  const profile = parseHevcSpsProfile(sps);
  const arrays = [vps, sps, pps].map((nal, i) => Buffer.concat([Buffer.from([0x80 | types[i]]), u16(1), u16(nal.length), nal]));
  return Buffer.concat([
    Buffer.from([1, (profile.profileSpace << 6) | (profile.tier << 5) | profile.profileIdc]),
    u32(profile.compatibility), profile.constraints, Buffer.from([profile.level]),
    Buffer.from([0xf0, 0, 0xfc, 0xfc | profile.chromaFormat, 0xf8 | profile.bitDepthLumaMinus8, 0xf8 | profile.bitDepthChromaMinus8]),
    u16(0), Buffer.from([(profile.maxSubLayers + 1) << 3 | profile.temporalIdNested << 2 | 3, arrays.length]),
    ...arrays,
  ]);
}

function makeHevcInitSegment(vps: Buffer, sps: Buffer, pps: Buffer, width: number, height: number): Buffer {
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('Invalid HEVC stream dimensions');
  const matrix = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const mvhd = box('mvhd', Buffer.concat([fullBox(0, 0), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2)]));
  const tkhd = box('tkhd', Buffer.concat([fullBox(0, 7), u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width * 0x10000), u32(height * 0x10000)]));
  const mdhd = box('mdhd', Buffer.concat([fullBox(0, 0), u32(0), u32(0), u32(90000), u32(0), u16(0x55c4), u16(0)]));
  const hdlr = box('hdlr', Buffer.concat([fullBox(0, 0), u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0')]));
  const vmhd = box('vmhd', Buffer.concat([fullBox(0, 1), u16(0), u16(0), u16(0), u16(0)]));
  const url = box('url ', fullBox(0, 1));
  const dinf = box('dinf', box('dref', Buffer.concat([fullBox(0, 0), u32(1), url])));
  const hvc1 = box('hvc1', Buffer.concat([Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x0018), u16(0xffff), box('hvcC', makeHevcConfig(vps, sps, pps))]));
  const stbl = box('stbl', Buffer.concat([box('stsd', Buffer.concat([fullBox(0, 0), u32(1), hvc1])), box('stts', Buffer.concat([fullBox(0, 0), u32(0)])), box('stsc', Buffer.concat([fullBox(0, 0), u32(0)])), box('stsz', Buffer.concat([fullBox(0, 0), u32(0), u32(0)])), box('stco', Buffer.concat([fullBox(0, 0), u32(0)]))]));
  const trak = box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([mdhd, hdlr, box('minf', Buffer.concat([vmhd, dinf, stbl]))]))]));
  const mvex = box('mvex', box('trex', Buffer.concat([fullBox(0, 0), u32(1), u32(1), u32(3000), u32(0), u32(0)])));
  const moov = box('moov', Buffer.concat([mvhd, trak, mvex]));
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0x200), Buffer.from('isomiso6mp41hvc1')]));
  return Buffer.concat([ftyp, moov]);
}

function annexBNals(data: Buffer): Buffer[] {
  const nals: Buffer[] = [];
  const findStart = (from: number): { offset: number; size: number } | undefined => {
    for (let i = from; i + 2 < data.length; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue;
      if (data[i + 2] === 1) return { offset: i, size: 3 };
      if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) return { offset: i, size: 4 };
    }
    return undefined;
  };
  let start = findStart(0);
  while (start) {
    const begin = start.offset + start.size;
    const next = findStart(begin);
    let end = next?.offset ?? data.length;
    while (end > begin && data[end - 1] === 0) end--;
    if (end > begin) nals.push(data.subarray(begin, end));
    start = next;
  }
  return nals;
}

function makeFragment(sequence: number, decodeTime: number, duration: number, sample: Buffer, key: boolean): Buffer {
  const mfhd = box('mfhd', Buffer.concat([fullBox(0, 0), u32(sequence)]));
  const tfhd = box('tfhd', Buffer.concat([fullBox(0, 0x020000), u32(1)]));
  const tfdt = box('tfdt', Buffer.concat([fullBox(1, 0), u64(decodeTime)]));
  const sampleFlags = key ? 0x02000000 : 0x01010000;
  const makeTraf = (offset: number) => box('traf', Buffer.concat([tfhd, tfdt, box('trun', Buffer.concat([fullBox(0, 0x000701), u32(1), u32(offset), u32(duration), u32(sample.length), u32(sampleFlags)]))]));
  const firstMoof = box('moof', Buffer.concat([mfhd, makeTraf(0)]));
  const moof = box('moof', Buffer.concat([mfhd, makeTraf(firstMoof.length + 8)]));
  return Buffer.concat([moof, box('mdat', sample)]);
}

export function attachVideo(ws: WebSocket): void {
  let child: ChildProcessWithoutNullStreams | undefined;
  let started = false;
  let waitingForKey = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let mse = false;
  let flowPaused = false;
  let width = 0;
  let height = 0;
  let fps = 30;
  let streamCodec: Codec | undefined;
  let vps: Buffer | undefined;
  let sps: Buffer | undefined;
  let pps: Buffer | undefined;
  let initialized = false;
  let decodeTime = 0;
  let sequence = 0;
  // Latency budget for queued video: past ~150 ms of backlog skip to the next keyframe instead of
  // letting every later frame (and the result of every click) arrive late. Floor fits one keyframe.
  let dropBacklog = 2_000_000;
  // Stats for nerds counters; reported only when the browser asks with {type:'stats'}.
  const openedAt = Date.now();
  const counters = { framesIn: 0, framesSent: 0, framesDropped: 0, bytesSent: 0, keyframes: 0 };
  let lastStatsAt = 0;

  function sendJson(value: unknown) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
  function stop() {
    if (startupTimer) clearTimeout(startupTimer);
    const running = child;
    running?.stdin.end();
    if (running) setTimeout(() => { if (running.exitCode === null && running.signalCode === null) running.kill(); }, 1200).unref();
    child = undefined;
  }
  function fail(message: string): void { sendJson({ type: 'error', message }); ws.close(1011); stop(); }

  function sendMseFrame(payload: Buffer, key: boolean): boolean {
    const nals = annexBNals(payload.subarray(1));
    if (streamCodec === 'hevc') {
      for (const nal of nals) {
        if (nal.length < 2) continue;
        const type = (nal[0] >> 1) & 0x3f;
        if (type === 32) vps = nal;
        else if (type === 33) sps = nal;
        else if (type === 34) pps = nal;
      }
      if (!initialized && key && vps && sps && pps && width > 0 && height > 0) {
        try {
          const profile = parseHevcSpsProfile(sps);
          // x265 and GPU encoders (NVENC/AMF/QSV) differ in constraint/compatibility bits; hvcC copies the real
          // values, so only require what the browser decoder depends on: Main profile, Main tier, 8-bit 4:2:0, level <= 5.2 (4K60).
          if (profile.profileSpace !== 0 || profile.tier !== 0 || profile.profileIdc !== 1 || profile.level > 156 || profile.chromaFormat !== 1 || profile.bitDepthLumaMinus8 !== 0 || profile.bitDepthChromaMinus8 !== 0) throw new Error('HEVC SPS does not match the configured Windows Main profile');
          ws.send(Buffer.concat([Buffer.from([0]), makeHevcInitSegment(vps, sps, pps, width, height)]), { binary: true });
          initialized = true;
        } catch {
          fail('Could not create a valid HEVC MSE initialization segment for the configured Windows profile.');
          return false;
        }
      }
      if (!initialized) return false;
      const parts: Buffer[] = [];
      for (const nal of nals) {
        if (nal.length < 2) continue;
        const type = (nal[0] >> 1) & 0x3f;
        if (type === 32 || type === 33 || type === 34 || type === 35) continue;
        parts.push(u32(nal.length), nal);
      }
      const sample = Buffer.concat(parts);
      if (sample.length === 0) return false;
      const duration = Math.max(1, Math.round(90000 / fps));
      ws.send(Buffer.concat([Buffer.from([1, key ? 1 : 0]), makeFragment(++sequence, decodeTime, duration, sample, key)]), { binary: true });
      decodeTime += duration;
      return true;
    }

    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === 7) sps = nal;
      else if (type === 8) pps = nal;
    }
    if (!initialized && key && sps && pps && width > 0 && height > 0) {
      try {
        ws.send(Buffer.concat([Buffer.from([0]), makeInitSegment(sps, pps, width, height)]), { binary: true });
        initialized = true;
      } catch {
        fail('Could not create the H.264 MSE initialization segment.');
        return false;
      }
    }
    if (!initialized) return false;
    const parts: Buffer[] = [];
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === 7 || type === 8 || type === 9 || nal.length === 0) continue;
      parts.push(u32(nal.length), nal);
    }
    const sample = Buffer.concat(parts);
    if (sample.length === 0) return false;
    const duration = Math.max(1, Math.round(90000 / fps));
    ws.send(Buffer.concat([Buffer.from([1, key ? 1 : 0]), makeFragment(++sequence, decodeTime, duration, sample, key)]), { binary: true });
    decodeTime += duration;
    return true;
  }

  function onPacket(type: number, payload: Buffer): void {
    if (type === 1 || type === 3) {
      try {
        const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
        if (mse && value.type === 'stream') {
          if (value.codec !== streamCodec) { fail('MSE playback requires the requested capture codec.'); return; }
          width = typeof value.width === 'number' && Number.isInteger(value.width) ? value.width : 0;
          height = typeof value.height === 'number' && Number.isInteger(value.height) ? value.height : 0;
          fps = typeof value.fps === 'number' && Number.isFinite(value.fps) && value.fps > 0 ? value.fps : 30;
          value.format = 'mse';
        }
        sendJson(value);
      } catch { /* malformed agent output */ }
      if (type === 3) ws.close(1011, 'Capture failed');
      return;
    }
    if (type !== 2 || payload.length < 2 || ws.readyState !== WebSocket.OPEN) return;
    counters.framesIn++;
    if (flowPaused) { counters.framesDropped++; return; }
    const key = payload[0] === 1;
    if (ws.bufferedAmount > dropBacklog) waitingForKey = true;
    if (waitingForKey) {
      if (!key || ws.bufferedAmount > dropBacklog / 4) { counters.framesDropped++; return; }
      waitingForKey = false;
    }
    const before = ws.bufferedAmount;
    const sent = mse ? sendMseFrame(payload, key) : (ws.send(payload, { binary: true }), true);
    if (sent) {
      counters.framesSent++;
      if (key) counters.keyframes++;
      counters.bytesSent += Math.max(payload.length, ws.bufferedAmount - before);
    }
    if (sent && key && startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
  }

  // Reassemble agent packets without re-copying the whole pending buffer on every 64 KB pipe chunk.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  function receive(chunk: Buffer): void {
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes >= 5) {
      if (pending[0].length < 5) pending = [Buffer.concat(pending, pendingBytes)];
      const length = pending[0].readUInt32BE(1);
      if (length > MAX_CAPTURE_PACKET) { fail('Invalid capture packet'); return; }
      if (pendingBytes < 5 + length) break;
      const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      const rest = all.subarray(5 + length);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
      onPacket(all[0], all.subarray(5, 5 + length));
    }
  }

  // Newest mouse position waiting for the agent's stdin to drain (older ones are superseded, not queued).
  let pendingMove: string | undefined;
  function flushMove(): void {
    const line = pendingMove;
    pendingMove = undefined;
    if (line && child?.stdin.writable) child.stdin.write(line);
  }

  ws.on('message', (raw, binary) => {
    if (binary) return;
    const body = raw.toString();
    if (body.length > 2048) return;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch { return; }
    if (event.type === 'start' && !started) {
      const codec = event.codec;
      const quality = event.quality;
      mse = event.format === 'mse';
      streamCodec = codec === 'h264' || codec === 'hevc' ? codec : undefined;
      if (mse && codec === 'hevc' && hostPlatform !== 'win32') {
        sendJson({ type: 'error', message: 'HEVC MSE playback is only supported on Windows. Retry with H.264 MSE or HEVC WebCodecs.' });
        ws.close(1008);
        return;
      }
      const selectedQuality = normalizeQuality(quality);
      if ((codec !== 'hevc' && codec !== 'h264') || !selectedQuality || (mse && codec !== 'h264' && codec !== 'hevc')) {
        sendJson({ type: 'error', message: 'Invalid stream settings' });
        ws.close(1008);
        return;
      }
      started = true;
      dropBacklog = Math.max(256_000, Math.round(qualityBitrate[selectedQuality] / 8 * 0.15));
      // Local cursor: the browser draws the pointer with no round trip; the agent hides it from the video
      // and reports its shape instead.
      const agentArgs = [codec as Codec, selectedQuality, ...(event.cursor === 'local' ? ['local-cursor'] : [])];
      const scriptAgent = agentPath.endsWith('.mjs');
      child = spawn(scriptAgent ? process.execPath : agentPath, scriptAgent ? [agentPath, ...agentArgs] : agentArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const capture = child;
      captures.add(capture);
      capture.once('close', () => captures.delete(capture));
      child.stdin.on('error', () => { if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Capture input failed'); stop(); });
      child.stdout.on('data', receive);
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
      const windows = hostPlatform === 'win32';
      child.on('error', () => { sendJson({ type: 'error', message: windows ? 'Capture agent unavailable. Run `pnpm build:windows` or reinstall the desktop package.' : 'Capture agent unavailable. Run `pnpm build:native` or reinstall the desktop app.' }); ws.close(1011); });
      child.on('exit', (code) => {
        if (startupTimer) clearTimeout(startupTimer);
        if (ws.readyState === WebSocket.OPEN) {
          sendJson({ type: 'error', message: code === 0 ? 'Capture ended.' : windows ? 'Capture stopped. Make sure the Windows desktop is unlocked and FFmpeg is available, then reconnect.' : 'Capture stopped. Check Screen Recording and Accessibility permissions.' });
          ws.close(1011);
        }
        if (stderr) console.error(`Capture agent: ${stderr}`);
      });
      startupTimer = setTimeout(() => { sendJson({ type: 'error', message: windows ? 'Capture produced no video frames. Make sure the desktop is unlocked and FFmpeg supports gdigrab/libx264.' : 'Capture produced no video frames. Check Screen Recording permission and encoder support.' }); ws.close(1011); stop(); }, 15_000);
      return;
    }
    if (event.type === 'ping') { sendJson({ type: 'pong' }); return; }
    if (event.type === 'stats') {
      const now = Date.now();
      if (now - lastStatsAt < 250) return; // at most 4 replies/s even if a client spams requests
      lastStatsAt = now;
      const load = os.loadavg()[0];
      sendJson({ type: 'stats', ...counters, buffered: ws.bufferedAmount, rssMb: Math.round(process.memoryUsage().rss / 1048576), uptimeMs: now - openedAt, ...(load > 0 ? { load: Math.round(load * 100) / 100 } : {}) });
      return;
    }
    if (event.type === 'flow' && typeof event.paused === 'boolean') {
      flowPaused = event.paused;
      if (!flowPaused) waitingForKey = true;
      return;
    }
    if (!started || !child?.stdin.writable) return;
    if (child.stdin.writableLength > 128 * 1024) { fail('Capture input is not responding.'); return; }
    const type = event.type;
    if (type === 'move' && typeof event.x === 'number' && typeof event.y === 'number' && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      const line = JSON.stringify({ type, x: Math.max(0, Math.min(1, event.x)), y: Math.max(0, Math.min(1, event.y)) }) + '\n';
      // If the agent pipe is backed up, only the newest position matters: replaying stale ones is pure lag.
      if (child.stdin.writableLength > 0) {
        const waiting = pendingMove !== undefined;
        pendingMove = line;
        if (!waiting) child.stdin.once('drain', flushMove);
      } else child.stdin.write(line);
      return;
    }
    // Anything else must stay ordered after the moves before it.
    flushMove();
    if (type === 'button' && (event.button === 'left' || event.button === 'right') && typeof event.down === 'boolean') {
      child.stdin.write(JSON.stringify({ type, button: event.button, down: event.down }) + '\n');
    } else if (type === 'wheel' && typeof event.dy === 'number' && Number.isFinite(event.dy)) {
      child.stdin.write(JSON.stringify({ type, dy: Math.trunc(Math.max(-1000, Math.min(1000, event.dy))) }) + '\n');
    } else if (type === 'key' && typeof event.code === 'string' && /^[A-Za-z0-9]{1,20}$/.test(event.code) && typeof event.down === 'boolean') {
      child.stdin.write(JSON.stringify({ type, code: event.code, down: event.down, ...(process.platform === 'darwin' && event.fn === true ? { fn: true } : {}) }) + '\n');
    } else if (type === 'text' && typeof event.text === 'string' && event.text.length <= 32) {
      child.stdin.write(JSON.stringify({ type, text: event.text }) + '\n');
    }
  });
  ws.on('close', (code) => {
    if (started) console.info(`Video connection closed (code ${code}).`);
    stop();
  });
  ws.on('error', stop);
}
