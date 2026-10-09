import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, Algorithm } from '@node-rs/argon2';
import { lanUrls } from '../dist-server/config.js';

const scratch = process.env.PI_SCRATCH_DIR || tmpdir();

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function gateway(env) {
  const child = spawn(process.execPath, ['dist-server/index.js'], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

test('LAN hints list only reachable IPv4 addresses', () => {
  const interfaces = {
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    en5: [{ family: 'IPv4', internal: false, address: '169.254.10.2' }],
  };
  assert.deepEqual(lanUrls(8787, interfaces), ['http://192.168.1.20:8787']);
});

test('successful sign-ins never lock out the owner while failures are still throttled', { timeout: 30000 }, async () => {
  const data = mkdtempSync(path.join(scratch, 'rc-login-limit-'));
  const db = new DatabaseSync(path.join(data, 'remotecontrol.db'));
  db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id = 1), password_hash TEXT NOT NULL)');
  db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)');
  db.prepare('INSERT INTO owner (id, password_hash) VALUES (1, ?)').run(await hash('limit-test-password', { algorithm: Algorithm.Argon2id }));
  db.close();
  const port = await freePort();
  const app = gateway({ REMOTECONTROL_DATA_DIR: data, REMOTECONTROL_PORT: String(port), REMOTECONTROL_HOST: '127.0.0.1' });
  const base = `http://127.0.0.1:${port}`;
  const login = (password) => fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  try {
    for (let i = 0; i < 100 && !app.output().includes('listening on'); i++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(app.output(), /listening on/, app.output());
    for (let i = 0; i < 12; i++) assert.equal((await login('limit-test-password')).status, 200, `successful login ${i + 1}`);
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await login('wrong')).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    const limited = await login('wrong');
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Try again in \d+ minute/);
  } finally {
    app.child.kill();
    await app.exited;
    rmSync(data, { recursive: true, force: true });
  }
});

test('gateway exits with a clear message when the port is already in use', { timeout: 15000 }, async () => {
  const data = mkdtempSync(path.join(scratch, 'rc-port-busy-'));
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const app = gateway({ REMOTECONTROL_DATA_DIR: data, REMOTECONTROL_PORT: String(blocker.address().port), REMOTECONTROL_HOST: '127.0.0.1' });
  try {
    const code = await Promise.race([app.exited, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('gateway hung on a busy port')), 10000))]);
    assert.equal(code, 1);
    assert.match(app.output(), /already in use \(EADDRINUSE\)/);
    assert.doesNotMatch(app.output(), /\n\s+at /, 'no raw stack trace');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    rmSync(data, { recursive: true, force: true });
  }
});

test('setup outside a terminal explains how to run it instead of crashing', () => {
  const data = mkdtempSync(path.join(scratch, 'rc-setup-'));
  try {
    const result = spawnSync(process.execPath, ['dist-server/setup.js'], { encoding: 'utf8', input: '', env: { ...process.env, REMOTECONTROL_DATA_DIR: data } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pnpm run setup/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('deployment scripts use valid PowerShell env syntax and persist the chosen bind address', () => {
  const packager = readFileSync('scripts/package-desktop.mjs', 'utf8');
  assert.doesNotMatch(packager, /\$env\.[A-Z]/, 'PowerShell environment variables need $env:NAME');
  assert.match(packager, /Expand-Archive -LiteralPath \$env:RC_ARCHIVE -DestinationPath \$env:RC_EXTRACT/);
  assert.match(packager, /Compress-Archive -LiteralPath \$env:RC_PRODUCT -DestinationPath \$env:RC_ZIP/);
  const launchd = readFileSync('scripts/launchd.mjs', 'utf8');
  assert.match(launchd, /REMOTECONTROL_HOST: host/);
  const mac = readFileSync('scripts/mac.sh', 'utf8');
  assert.match(mac, /setup\.js --if-missing/);
  assert.equal(spawnSync('sh', ['-n', 'scripts/mac.sh']).status, 0);
});
