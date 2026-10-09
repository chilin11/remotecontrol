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
  env: { ...process.env, REMOTECONTROL_DATA_DIR: temp, REMOTECONTROL_PORT: String(appPort), REMOTECONTROL_AGENT_PATH: fakeAgent },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.on('data', (data) => { childOutput += data.toString(); });
child.stderr.on('data', (data) => { childOutput += data.toString(); });
for (let i = 0; i < 100 && !childOutput.includes('listening on'); i++) await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(childOutput, /listening on/, childOutput);
const base = `http://127.0.0.1:${appPort}`;
const origin = base;
after(() => { child.kill(); rmSync(temp, { recursive: true, force: true }); });

function socket(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_request, response) => resolve({ ws, status: response.statusCode }));
    ws.once('error', () => undefined);
  });
}

test('login protects the API and the legacy VNC endpoint no longer exists', async () => {
  const anon = await fetch(`${base}/api/session`);
  assert.equal((await anon.json()).authenticated, false);
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/stream`, { Origin: origin })).status, 403);

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
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/stream`, { Origin: 'https://evil.example', Cookie: cookie })).status, 403);
  // The old VNC proxy is removed: even an authenticated, same-origin upgrade is refused.
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/ws`, { Origin: origin, Cookie: cookie })).status, 403);

  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
  assert.equal(logout.status, 200);
  const revoked = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await revoked.json()).authenticated, false);
  assert.equal((await socket(`ws://127.0.0.1:${appPort}/stream`, { Origin: origin, Cookie: cookie })).status, 403);
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
  ws.send(JSON.stringify({ type: 'stats' }));
  ws.send(JSON.stringify({ type: 'stats' })); // within 250 ms: rate limited, no second reply
  for (let i = 0; i < 100 && messages.length < 5; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stats = messages.slice(4).map((m) => JSON.parse(m.data.toString()));
  assert.equal(stats.length, 1);
  assert.equal(stats[0].type, 'stats');
  assert.equal(stats[0].framesIn, 1);
  assert.equal(stats[0].framesSent, 1);
  assert.equal(stats[0].keyframes, 1);
  assert.ok(stats[0].rssMb > 0 && stats[0].uptimeMs >= 0);
  assert.equal(messages.filter((m) => !m.binary && JSON.parse(m.data.toString()).input?.type === 'stats').length, 0, 'stats requests never reach the agent');
  ws.terminate();
});

test('gateway reports native video by host platform', async () => {
  const secondReservation = createServer();
  await new Promise((resolve) => secondReservation.listen(0, '127.0.0.1', resolve));
  const secondPort = secondReservation.address().port;
  await new Promise((resolve) => secondReservation.close(resolve));
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, REMOTECONTROL_DATA_DIR: temp, REMOTECONTROL_PORT: String(secondPort) },
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
    const { ws: videoWs, status: videoStatus } = await socket(`ws://127.0.0.1:${secondPort}/stream`, { Origin: platformBase, Cookie: cookie });
    assert.equal(videoStatus, 101);
    if (process.platform === 'darwin') videoWs.terminate();
    else assert.equal(await new Promise((resolve) => videoWs.once('close', (closeCode) => resolve(closeCode))), 1008);
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
