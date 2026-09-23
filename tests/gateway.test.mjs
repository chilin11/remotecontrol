import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, Algorithm } from '@node-rs/argon2';
import WebSocket from 'ws';

const temp = mkdtempSync(path.join(tmpdir(), 'remotecontrol-test-'));
const fakeAgent = path.join(temp, 'fake-agent.sh');
writeFileSync(fakeAgent, `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('tests/fake-agent.mjs')}" "$@"\n`);
chmodSync(fakeAgent, 0o700);
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

test('video stream is authenticated and forwards capture and input', async () => {
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
  ws.terminate();
});
