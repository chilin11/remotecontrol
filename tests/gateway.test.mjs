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

const temp = mkdtempSync(path.join(tmpdir(), 'remotecontrol-test-'));
const fakeAgent = path.resolve('tests/fake-agent.mjs');
const mockVnc = createServer((socket) => {
  socket.write('RFB 003.008\n');
  socket.on('data', (data) => socket.write(data));
});
await new Promise((resolve) => mockVnc.listen(0, '127.0.0.1', resolve));
const vncPort = mockVnc.address().port;
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const appPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const db = new DatabaseSync(path.join(temp, 'remotecontrol.db'));
db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id = 1), password_hash TEXT NOT NULL)');
db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)');
db.prepare('INSERT INTO owner (id, password_hash) VALUES (1, ?)').run(await hash('testing-password-123', { algorithm: Algorithm.Argon2id }));
db.close();

const child = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, REMOTECONTROL_DATA_DIR: temp, REMOTECONTROL_PORT: String(appPort), REMOTECONTROL_VNC_PORT: String(vncPort), REMOTECONTROL_AGENT_PATH: fakeAgent },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.on('data', (data) => { childOutput += data.toString(); });
child.stderr.on('data', (data) => { childOutput += data.toString(); });
for (let i = 0; i < 100 && !childOutput.includes('listening on'); i++) await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(childOutput, /listening on/, childOutput);
const base = `http://127.0.0.1:${appPort}`;
const origin = base;
after(() => { child.kill(); mockVnc.close(); rmSync(temp, { recursive: true, force: true }); });

function socket(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_request, response) => resolve({ ws, status: response.statusCode }));
    ws.once('error', () => undefined);
  });
}

test('login protects API and VNC bridge', async () => {
  const anon = await fetch(`${base}/api/session`);
  assert.equal((await anon.json()).authenticated, false);
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/ws`, { Origin: origin })).status, 403);

  const forged = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testing-password-123' }) });
  assert.equal(forged.status, 403);

  const wrong = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testing-password-123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^rc_session=/);
  const session = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).authenticated, true);
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/ws`, { Origin: 'https://evil.example', Cookie: cookie })).status, 403);

  const { ws, status } = await socket(`ws://127.0.0.1:${appPort}/ws`, { Origin: origin, Cookie: cookie });
  assert.equal(status, 101);
  const greeting = await new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
  assert.equal(greeting, 'RFB 003.008\n');
  ws.send('client data');
  const echoed = await new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
  assert.equal(echoed, 'client data');

  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(logout.status, 200);
  const revoked = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await revoked.json()).authenticated, false);
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/ws`, { Origin: origin, Cookie: cookie })).status, 403);
  ws.terminate();
});

test('video stream is authenticated and forwards capture and input', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/stream`, { Origin: origin })).status, 403);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testing-password-123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { ws, status } = await socket(`ws://127.0.0.1:${appPort}/stream`, { Origin: origin, Cookie: cookie });
  assert.equal(status, 101);
  const messages = [];
  ws.on('message', (data, binary) => messages.push({ data, binary }));
  ws.send(JSON.stringify({ type: 'start', codec: 'hevc', quality: 'data' }));
  for (let i = 0; i < 100 && messages.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages.length, 2);
  assert.equal(JSON.parse(messages[0].data.toString()).codec, 'hevc');
  assert.equal(messages[1].binary, true);
  assert.deepEqual([...messages[1].data], [1, 0, 0, 0, 1, 0x26]);
  ws.send(JSON.stringify({ type: 'move', x: 0.25, y: 0.5 }));
  for (let i = 0; i < 100 && messages.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(JSON.parse(messages[2].data.toString()).input, { type: 'move', x: 0.25, y: 0.5 });
  ws.send(JSON.stringify({ type: 'ping' }));
  for (let i = 0; i < 100 && messages.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(messages[3].data.toString()).type, 'pong');
  ws.terminate();
});

test('gateway reports native video by host platform and relays authenticated VNC', async () => {
  const secondReservation = createServer();
  await new Promise((resolve) => secondReservation.listen(0, '127.0.0.1', resolve));
  const secondPort = secondReservation.address().port;
  await new Promise((resolve) => secondReservation.close(resolve));
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, REMOTECONTROL_DATA_DIR: temp, REMOTECONTROL_PORT: String(secondPort), REMOTECONTROL_VNC_PORT: String(vncPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const platformBase = `http://127.0.0.1:${secondPort}`;
  try {
    for (let i = 0; i < 100 && !output.includes('listening on'); i++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(output, /listening on/, output);
    const status = await fetch(`${platformBase}/api/session`);
    assert.equal((await status.json()).nativeVideo, process.platform === 'darwin');
    assert.match((await fetch(platformBase)).status.toString(), /^200$/);
    const login = await fetch(`${platformBase}/api/login`, { method: 'POST', headers: { Origin: platformBase, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testing-password-123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { ws, status: wsStatus } = await socket(`ws://127.0.0.1:${secondPort}/ws`, { Origin: platformBase, Cookie: cookie });
    assert.equal(wsStatus, 101);
    const greeting = await new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
    assert.equal(greeting, 'RFB 003.008\n');
    const { ws: videoWs, status: videoStatus } = await socket(`ws://127.0.0.1:${secondPort}/stream`, { Origin: platformBase, Cookie: cookie });
    assert.equal(videoStatus, 101);
    if (process.platform === 'darwin') videoWs.terminate();
    else {
      const code = await new Promise((resolve) => videoWs.once('close', (closeCode) => resolve(closeCode)));
      assert.equal(code, 1008);
      ws.send('still controlling');
      const echo = await Promise.race([
        new Promise((resolve) => ws.once('message', (data) => resolve(data.toString()))),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('unsupported video displaced VNC')), 3000)),
      ]);
      assert.equal(echo, 'still controlling');
    }
    ws.terminate();
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
test('malformed video messages cannot crash the gateway', { skip: process.platform !== 'darwin' }, async () => {
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testing-password-123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { ws, status } = await socket(`ws://127.0.0.1:${appPort}/stream`, { Origin: origin, Cookie: cookie });
  assert.equal(status, 101);
  ws.send('null');
  ws.send('[]');
  ws.send(JSON.stringify({ type: 'start', codec: 'h264', quality: 'data' }));
  const packet = await Promise.race([
    new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString())))),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('stream did not start after malformed input')), 3000)),
  ]);
  assert.equal(packet.codec, 'h264');
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.send('x'.repeat(3000));
  await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('oversized socket did not close')), 3000))]);
  const health = await fetch(`${base}/api/session`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authenticated, false);
});

test('delta-only capture fails instead of hanging without a keyframe', { skip: process.platform !== 'darwin', timeout: 25000 }, async () => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, REMOTECONTROL_DATA_DIR: temp, REMOTECONTROL_PORT: String(port), REMOTECONTROL_AGENT_PATH: fakeAgent, REMOTECONTROL_FAKE_METADATA_ONLY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (data) => { output += data.toString(); });
  server.stderr.on('data', (data) => { output += data.toString(); });
  const local = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100 && !output.includes('listening on'); i++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(output, /listening on/, output);
    const login = await fetch(`${local}/api/login`, { method: 'POST', headers: { Origin: local, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testing-password-123' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { ws, status } = await socket(`ws://127.0.0.1:${port}/stream`, { Origin: local, Cookie: cookie });
    assert.equal(status, 101);
    const received = [];
    ws.on('message', (data, binary) => { if (!binary) received.push(JSON.parse(data.toString())); });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send(JSON.stringify({ type: 'start', codec: 'h264', quality: 'data' }));
    const code = await closed;
    assert.equal(code, 1011);
    assert.equal(received[0].type, 'stream');
    assert.match(received.at(-1).message, /no video frames/);
    assert.equal((await fetch(`${local}/api/session`)).status, 200);
  } finally {
    server.kill();
    if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve));
  }
});
