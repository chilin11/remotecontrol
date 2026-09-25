import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, Algorithm } from '@node-rs/argon2';
import WebSocket from 'ws';
import { nativeVideoAvailable } from '../dist-server/config.js';

const temp = mkdtempSync(path.join(tmpdir(), 'remotecontrol-mse-'));
const fakeAgent = path.resolve('tests/fake-agent.mjs');
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const db = new DatabaseSync(path.join(temp, 'remotecontrol.db'));
db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id = 1), password_hash TEXT NOT NULL)');
db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)');
db.prepare('INSERT INTO owner (id, password_hash) VALUES (1, ?)').run(await hash('mse-test-password', { algorithm: Algorithm.Argon2id }));
db.close();
const child = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, REMOTECONTROL_DATA_DIR: temp, REMOTECONTROL_PORT: String(port), REMOTECONTROL_AGENT_PATH: fakeAgent, REMOTECONTROL_FAKE_MSE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => { output += data.toString(); });
child.stderr.on('data', (data) => { output += data.toString(); });
for (let i = 0; i < 100 && !output.includes('listening on'); i++) await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(output, /listening on/, output);
const base = `http://127.0.0.1:${port}`;
after(() => { child.kill(); rmSync(temp, { recursive: true, force: true }); });

function socket(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_request, response) => resolve({ ws, status: response.statusCode }));
    ws.once('error', () => undefined);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MSE stream message (buffered=${ws.bufferedAmount})`)), 3000);
    ws.once('message', (data, binary) => { clearTimeout(timer); resolve({ data, binary }); });
  });
}

test('authenticated MSE websocket transmuxes H.264 keyframe init and moof/mdat', { skip: !nativeVideoAvailable }, async () => {
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'mse-test-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const denied = await socket(`ws://127.0.0.1:${port}/stream`, { Origin: 'https://evil.example', Cookie: cookie });
  assert.equal(denied.status, 403);
  const { ws, status } = await socket(`ws://127.0.0.1:${port}/stream`, { Origin: base, Cookie: cookie });
  assert.equal(status, 101);
  const received = [];
  ws.on('message', (data, binary) => received.push({ data, binary }));
  const waitForMessages = async (count) => {
    for (let i = 0; i < 100 && received.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(received.length >= count, `Expected ${count} stream messages; got ${received.map(({ binary, data }) => binary ? `binary:${data.length}` : data.toString()).join(', ')}`);
    return received;
  };
  ws.send(JSON.stringify({ type: 'start', codec: 'h264', quality: 'data', format: 'mse' }));
  const messages = await waitForMessages(3);
  const metadata = messages[0];
  assert.deepEqual(JSON.parse(metadata.data.toString()), { type: 'stream', codec: 'h264', codecString: 'avc1.42E032', width: 640, height: 480, fps: 24, format: 'mse' });
  const init = messages[1];
  assert.equal(init.binary, true);
  assert.equal(init.data[0], 0);
  assert.equal(init.data.toString('ascii', 5, 9), 'ftyp');
  const boxes = [];
  for (let offset = 1; offset + 8 <= init.data.length;) {
    const size = init.data.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= init.data.length);
    boxes.push(init.data.toString('ascii', offset + 4, offset + 8));
    offset += size;
  }
  assert.deepEqual(boxes, ['ftyp', 'moov']);
  const media = messages[2];
  assert.equal(media.binary, true);
  assert.equal(media.data[0], 1);
  assert.equal(media.data[1], 1);
  const mediaBoxes = [];
  for (let offset = 2; offset + 8 <= media.data.length;) {
    const size = media.data.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= media.data.length);
    mediaBoxes.push(media.data.toString('ascii', offset + 4, offset + 8));
    offset += size;
  }
  assert.deepEqual(mediaBoxes, ['moof', 'mdat']);
  ws.send(JSON.stringify({ type: 'move', x: 0.25, y: 0.5 }));
  for (let i = 0; i < 100 && received.length < 5; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const withAck = received.find(({ binary, data }) => !binary && data.toString().includes('input-ack'));
  assert.ok(withAck, 'input remains forwarded while receiving MSE fragments');
  assert.deepEqual(JSON.parse(withAck.data.toString()).input, { type: 'move', x: 0.25, y: 0.5 });
  ws.terminate();
});
