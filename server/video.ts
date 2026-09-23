import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

type Codec = 'hevc' | 'h264';
type Quality = 'data' | 'balanced' | 'high';
const agentPath = process.env.REMOTECONTROL_AGENT_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-native/RemoteControlAgent.app/Contents/MacOS/RemoteControlAgent');

export function attachVideo(ws: WebSocket): void {
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffer = Buffer.alloc(0);
  let started = false;
  let waitingForKey = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;

  function sendJson(value: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  }

  function stop() {
    if (startupTimer) clearTimeout(startupTimer);
    const running = child;
    running?.stdin.end();
    if (running) setTimeout(() => running.kill(), 200).unref();
    child = undefined;
  }

  function onPacket(type: number, payload: Buffer) {
    if (type === 1 || type === 3) {
      try { sendJson(JSON.parse(payload.toString('utf8'))); } catch { /* malformed agent output */ }
      if (type === 1 && startupTimer) clearTimeout(startupTimer);
      if (type === 3) ws.close(1011, 'Capture failed');
      return;
    }
    if (type !== 2 || payload.length < 2 || ws.readyState !== WebSocket.OPEN) return;
    const key = payload[0] === 1;
    if (ws.bufferedAmount > 2_000_000) waitingForKey = true;
    if (waitingForKey) {
      if (!key || ws.bufferedAmount > 512_000) return;
      waitingForKey = false;
    }
    ws.send(payload, { binary: true });
  }

  function receive(chunk: Buffer) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(1);
      if (length > 16 * 1024 * 1024) { sendJson({ type: 'error', message: 'Invalid capture packet' }); ws.close(1011); stop(); return; }
      if (buffer.length < 5 + length) break;
      onPacket(buffer[0], buffer.subarray(5, 5 + length));
      buffer = buffer.subarray(5 + length);
    }
  }

  ws.on('message', (raw, binary) => {
    if (binary) return;
    const body = raw.toString();
    if (body.length > 2048) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(body) as Record<string, unknown>; } catch { return; }
    if (event.type === 'start' && !started) {
      const codec = event.codec;
      const quality = event.quality;
      if ((codec !== 'hevc' && codec !== 'h264') || (quality !== 'data' && quality !== 'balanced' && quality !== 'high')) {
        sendJson({ type: 'error', message: 'Invalid stream settings' });
        ws.close(1008);
        return;
      }
      started = true;
      child = spawn(agentPath, [codec as Codec, quality as Quality], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', receive);
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
      child.on('error', () => { sendJson({ type: 'error', message: 'Capture agent unavailable. Build the native app first.' }); ws.close(1011); });
      child.on('exit', (code) => {
        if (startupTimer) clearTimeout(startupTimer);
        if (ws.readyState === WebSocket.OPEN) {
          sendJson({ type: 'error', message: code === 0 ? 'Capture ended.' : 'Capture stopped. Check Screen Recording and Accessibility permissions.' });
          ws.close(1011);
        }
        if (stderr) console.error(`Capture agent: ${stderr}`);
      });
      startupTimer = setTimeout(() => { sendJson({ type: 'error', message: 'Capture did not start. Check Screen Recording permission.' }); ws.close(1011); stop(); }, 60_000);
      return;
    }
    if (!started || !child?.stdin.writable) return;
    const type = event.type;
    if (type === 'move' && typeof event.x === 'number' && typeof event.y === 'number' && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      child.stdin.write(JSON.stringify({ type, x: Math.max(0, Math.min(1, event.x)), y: Math.max(0, Math.min(1, event.y)) }) + '\n');
    } else if (type === 'button' && (event.button === 'left' || event.button === 'right') && typeof event.down === 'boolean') {
      child.stdin.write(JSON.stringify({ type, button: event.button, down: event.down }) + '\n');
    } else if (type === 'wheel' && typeof event.dy === 'number' && Number.isFinite(event.dy)) {
      child.stdin.write(JSON.stringify({ type, dy: Math.trunc(Math.max(-1000, Math.min(1000, event.dy))) }) + '\n');
    } else if (type === 'key' && typeof event.code === 'string' && /^[A-Za-z0-9]{1,20}$/.test(event.code) && typeof event.down === 'boolean') {
      child.stdin.write(JSON.stringify({ type, code: event.code, down: event.down }) + '\n');
    } else if (type === 'text' && typeof event.text === 'string' && event.text.length <= 32) {
      child.stdin.write(JSON.stringify({ type, text: event.text }) + '\n');
    }
  });
  ws.on('close', stop);
}
