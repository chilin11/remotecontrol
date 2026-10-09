import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// Run the real connection handlers with a controllable clock and transports.
const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('  function expireSession('), source.indexOf('  function connect()'));
const compiled = transformSync(handlers, { loader: 'ts', format: 'cjs' }).code;
function fixture(session = async () => ({ authenticated: true })) {
  let now = 1000;
  const clients = [], timers = [], delays = [];
  const state = { authenticated: true, authError: '', status: 'idle', password: 'old password' };
  let sessionChecks = 0;
  const ref = (current) => ({ current });
  const element = { focus() {} };
  const refs = {
    canvasRef: ref(element), mediaRef: ref(element),
    videoRef: ref(null), intentional: ref(false),
    retryTimer: ref(null), retryCount: ref(0), connectedAt: ref(0), noRetry: ref(false),
    hevcFallbackReason: ref(''), qualityRef: ref('balanced'),
  };
  class Client {
    renderMode = 'canvas';
    constructor(_canvas, ready, error, closed) { Object.assign(this, { ready, error, closed }); clients.push(this); }
    async connect(_quality, codec) { this.activeCodec = codec ?? 'hevc'; }
    close() { this.stopped = true; }
  }
  const noop = () => {};
  const values = {
    ...refs, VideoClient: Client, VideoDecoder: Client,
    quality: 'balanced', hevcVideo: true, hevcCodecString: 'hvc1.1.6.L150.B0', hevcMseVideo: true,
    releaseVideoInput: noop, setVideoPlayback: noop, setVideoCursor: noop, cursorStyle: noop,
    setStatus: (value) => { state.status = value; },
    setActiveCodec: noop, setMessage: noop,
    setPassword: (value) => { state.password = value; },
    setModifiers: noop, setQualityOpen: noop, setMoreOpen: noop, setStatsOpen: noop,
    setAuthError: (value) => { state.authError = value; },
    setAuthenticated: (value) => { state.authenticated = value; },
    api: async () => { sessionChecks++; return session(); },
    Date: { now: () => now },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); delays.push(delay); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  };
  const api = new Function(...Object.keys(values), `${compiled}; return { connectVideo };`)(...Object.values(values));
  return {
    ...refs, clients, timers, delays, state,
    get sessionChecks() { return sessionChecks; },
    connect: () => api.connectVideo(),
    advance(ms) { now += ms; },
    retry() { const timer = timers.shift(); assert.ok(timer, 'expected retry'); now += timer.delay; timer.callback(); },
  };
}

test('first frames do not reset the bounded retry budget', async () => {
  const f = fixture();
  f.connect();
  for (let i = 0; i < 4; i++) {
    const client = f.clients.at(-1);
    client.ready('hevc');
    f.advance(500);
    await client.closed(1006);
    if (i < 3) f.retry();
  }
  assert.deepEqual(f.delays, [1000, 2000, 4000]);
  assert.equal(f.timers.length, 0);
  assert.equal(f.clients.length, 4);
  f.connect();
  assert.equal(f.retryCount.current, 0, 'manual connect starts a fresh budget');
});

test('a stable connection restores the retry budget', async () => {
  const f = fixture();
  f.connect();
  await f.clients.at(-1).closed(1006); f.retry();
  await f.clients.at(-1).closed(1006); f.retry();
  f.clients.at(-1).ready('hevc');
  f.advance(30_000);
  await f.clients.at(-1).closed(1006);
  assert.equal(f.timers.at(-1).delay, 1000);
  assert.equal(f.retryCount.current, 1);
});

test('VNC fallback is gone from the viewer', () => {
  assert.doesNotMatch(source, /novnc|\bRFB\b|connectVnc|VNC/i);
});

test('HEVC fallback during an automatic retry preserves its budget', async () => {
  const f = fixture();
  f.connect();
  await f.clients.at(-1).closed(1006); f.retry();
  f.clients.at(-1).error('HEVC decoding failed.');
  assert.equal(f.clients.at(-1).activeCodec, 'h264');
  assert.equal(f.retryCount.current, 1);
  f.clients.at(-1).ready('h264');
  await f.clients.at(-1).closed(1006);
  assert.equal(f.timers.at(-1).delay, 2000);
});

test('takeover and sign-out never reconnect and stale callbacks cannot replace the current client', async () => {
  for (const code of [4000, 4001]) {
    const f = fixture();
    f.connect();
    const previous = f.clients.at(-1);
    f.connect();
    const current = f.videoRef.current;
    previous.ready('hevc'); await previous.closed(1006);
    assert.equal(f.videoRef.current, current);
    assert.equal(f.connectedAt.current, 0);
    assert.equal(f.timers.length, 0);
    await current.closed(code);
    assert.equal(f.noRetry.current, true);
    assert.equal(f.timers.length, 0);
  }
});

test('explicit session expiry returns to sign-in with a re-login alert and no retry', async () => {
  const f = fixture();
  f.connect();
  const client = f.clients.at(-1);
  client.ready('hevc');
  await client.closed(4001);
  assert.equal(f.state.authenticated, false);
  assert.equal(f.state.authError, '登录已过期或已退出，请重新登录。');
  assert.equal(f.state.password, '');
  assert.equal(f.state.status, 'idle');
  assert.equal(f.videoRef.current, null);
  assert.equal(client.stopped, true);
  assert.equal(f.noRetry.current, true);
  assert.equal(f.sessionChecks, 0);
  assert.equal(f.timers.length, 0);
});

test('an expired token rejected during handshake prompts re-login instead of retrying', async () => {
  const f = fixture(async () => ({ authenticated: false }));
  f.connect();
  const client = f.clients.at(-1);
  client.error('Video connection failed.');
  await client.closed(1006);
  assert.equal(f.sessionChecks, 1);
  assert.equal(f.state.authenticated, false);
  assert.match(f.state.authError, /登录已过期.*请重新登录/);
  assert.equal(f.noRetry.current, true);
  assert.equal(f.timers.length, 0);
});

test('a network failure during session checking does not log the user out', async () => {
  const f = fixture(async () => { throw new TypeError('Failed to fetch'); });
  f.connect();
  await f.clients.at(-1).closed(1006);
  assert.equal(f.state.authenticated, true);
  assert.equal(f.state.authError, '');
  assert.equal(f.state.status, 'disconnected');
  assert.equal(f.timers.at(-1).delay, 1000);
});

test('takeover does not check or invalidate authentication', async () => {
  const f = fixture(async () => ({ authenticated: false }));
  f.connect();
  await f.clients.at(-1).closed(4000);
  assert.equal(f.sessionChecks, 0);
  assert.equal(f.state.authenticated, true);
  assert.equal(f.timers.length, 0);
});

test('an old session check cannot sign out or replace a newer connection', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  f.connect();
  const closing = f.clients.at(-1).closed(1006);
  f.connect();
  const current = f.videoRef.current;
  resolve({ authenticated: false });
  await closing;
  assert.equal(f.videoRef.current, current);
  assert.equal(f.state.authenticated, true);
  assert.equal(f.timers.length, 0);
});

test('cancelling while a session check is pending does not force re-login or retry', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  f.connect();
  const closing = f.clients.at(-1).closed(1006);
  f.intentional.current = true;
  f.videoRef.current = null;
  resolve({ authenticated: false });
  await closing;
  assert.equal(f.state.authenticated, true);
  assert.equal(f.timers.length, 0);
});

test('time spent checking authentication does not restore the retry budget', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  f.connect();
  f.retryCount.current = 2;
  f.clients.at(-1).ready('hevc');
  f.advance(29_000);
  const closing = f.clients.at(-1).closed(1006);
  f.advance(5000);
  resolve({ authenticated: true });
  await closing;
  assert.equal(f.retryCount.current, 3);
  assert.equal(f.timers.at(-1).delay, 4000);
});
