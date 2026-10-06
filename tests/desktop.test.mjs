import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

function host(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist-server/desktop.js'], { env: { ...process.env, REMOTECONTROL_DATA_DIR: dataDir, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', errors = '';
  const messages = [];
  const pending = [];
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      if (pending.length) pending.shift()(value); else messages.push(value);
    }
  });
  return {
    child,
    next() { return Promise.race([messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => pending.push(resolve)), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('IPC timeout: ' + errors)), 10000); timer.unref(); })]); },
    send(value) { child.stdin.write(JSON.stringify(value) + '\n'); },
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    },
  };
}

test('desktop IPC creates owner once, preserves sessions and rejects unsafe setup', async () => {
  const data = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'desktop-test-'));
  const first = host(data);
  try {
    assert.equal((await first.next()).configured, false);
    first.send({ action: 'start' });
    assert.match((await first.next()).error, /密码/);
    first.send({ action: 'setup', password: 'short', confirmation: 'short' });
    assert.match((await first.next()).error, /12–256/);
    first.send({ action: 'setup', password: 'testing-desktop-password', confirmation: 'other' });
    assert.match((await first.next()).error, /不一致/);
    first.send({ action: 'setup', password: 'testing-desktop-password', confirmation: 'testing-desktop-password' });
    assert.equal((await first.next()).configured, true);
    const db = new DatabaseSync(path.join(data, 'remotecontrol.db'));
    const original = db.prepare('SELECT password_hash FROM owner').get().password_hash;
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('existing-session', 1, 1);
    first.send({ action: 'setup', password: 'replacement-password', confirmation: 'replacement-password' });
    assert.match((await first.next()).error, /保留/);
    assert.equal(db.prepare('SELECT password_hash FROM owner').get().password_hash, original);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    db.close();
    const second = host(data);
    assert.equal((await second.next()).configured, true);
    await second.close();
  } finally { await first.close(); rmSync(data, { recursive: true, force: true }); }
});

test('desktop start reports port conflicts without killing the existing listener', async () => {
  const data = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'desktop-port-test-'));
  const blocker = createServer();
  await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  const app = host(data, { REMOTECONTROL_PORT: String(blocker.address().port) });
  try {
    await app.next();
    app.send({ action: 'setup', password: 'testing-desktop-password', confirmation: 'testing-desktop-password' }); await app.next();
    app.send({ action: 'start', lan: false });
    const state = await app.next();
    assert.equal(state.running, false);
    assert.match(state.error, /端口已被占用/);
    assert.equal(blocker.listening, true);
  } finally { await app.close(); await new Promise((resolve) => blocker.close(resolve)); rmSync(data, { recursive: true, force: true }); }
});

test('desktop concurrent first creation cannot overwrite the winning password', async () => {
  const data = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'desktop-race-test-'));
  const a = host(data), b = host(data);
  try {
    await a.next(); await b.next();
    a.send({ action: 'setup', password: 'first-desktop-password', confirmation: 'first-desktop-password' });
    b.send({ action: 'setup', password: 'other-desktop-password', confirmation: 'other-desktop-password' });
    const states = await Promise.all([a.next(), b.next()]);
    assert.equal(states.filter((state) => !state.error).length, 1);
    assert.equal(states.filter((state) => state.error).length, 1);
  } finally { await a.close(); await b.close(); rmSync(data, { recursive: true, force: true }); }
});

test('desktop setup and permissions have no remote HTTP endpoint', () => {
  const server = readFileSync('server/index.ts', 'utf8');
  assert.doesNotMatch(server, /\/api\/(?:setup|permissions|desktop)/);
  const script = readFileSync('scripts/package-desktop.mjs', 'utf8');
  assert.match(script, /SHASUMS256/);
  assert.match(script, /dereference: true/);
  assert.match(script, /THIRD-PARTY\.txt/);
});

test('macOS networking runtime has a product helper identity, not bare node', () => {
  const helper = readFileSync('native/GatewayInfo.plist', 'utf8');
  const host = readFileSync('native/DesktopHost.swift', 'utf8');
  const packager = readFileSync('scripts/package-desktop.mjs', 'utf8');
  assert.match(helper, /<key>CFBundleIdentifier<\/key><string>local\.remotecontrol\.gateway<\/string>/);
  assert.match(helper, /<key>CFBundleExecutable<\/key><string>RemoteControlGateway<\/string>/);
  assert.match(helper, /<key>CFBundleDisplayName<\/key><string>Remote Control Gateway<\/string>/);
  assert.match(host, /Contents\/Helpers\/RemoteControlGateway\.app\/Contents\/MacOS\/RemoteControlGateway/);
  assert.doesNotMatch(host, /runtime\/node/);
  assert.match(packager, /sign\(gatewayApp, true\)/);
  assert.match(packager, /sign\(nodeBinary, true, 'local\.remotecontrol\.gateway'\)/);
});

test('desktop starts local-only, stops, restarts on LAN and cleans up on EOF', async () => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const data = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'desktop-lifecycle-test-'));
  const app = host(data, { REMOTECONTROL_PORT: String(port) });
  let closed = false;
  try {
    assert.equal((await app.next()).running, false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/session`));
    app.send({ action: 'setup', password: 'testing-desktop-password', confirmation: 'testing-desktop-password' }); await app.next();
    app.send({ action: 'start', lan: false });
    const state = await app.next();
    assert.equal(state.running, true);
    assert.equal(state.lan, false);
    assert.deepEqual(state.addresses, []);
    assert.equal((await (await fetch(`${state.url}/api/session`)).json()).configured, true);
    app.send({ action: 'stop' });
    assert.equal((await app.next()).running, false);
    await assert.rejects(fetch(`${state.url}/api/session`));
    // stop may emit the close event plus its command acknowledgement.
    app.send({ action: 'start', lan: true });
    let restarted = await app.next();
    if (!restarted.running && !restarted.error) restarted = await app.next();
    assert.equal(restarted.running, true);
    assert.equal(restarted.lan, true);
    await app.close(); closed = true;
    await assert.rejects(fetch(`${state.url}/api/session`));
    const log = readFileSync(path.join(data, 'desktop.log'), 'utf8');
    assert.doesNotMatch(log, /testing-desktop-password/);
  } finally { if (!closed) await app.close(); rmSync(data, { recursive: true, force: true }); }
});

test('macOS capture stays out of the Dock while the desktop host remains visible', () => {
  const plist = readFileSync('native/Info.plist', 'utf8');
  const agent = readFileSync('native/RemoteControlAgent.swift', 'utf8');
  const host = readFileSync('native/DesktopHost.swift', 'utf8');
  assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
  assert.match(agent, /NSApplication\.shared\.setActivationPolicy\(\.prohibited\)/);
  assert.ok(agent.indexOf('DesktopHost.launch()') < agent.indexOf('setActivationPolicy(.prohibited)'));
  assert.match(host, /app\.setActivationPolicy\(\.regular\)/);
});
