import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// Exercise the real UI handlers without a gateway, native agent, or browser socket.
const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('const isFnKey ='), source.indexOf('\n\nasync function api(')) + '\n' + source.slice(source.indexOf('  function clearFn('), source.indexOf('  function sendKey(')) + source.slice(source.indexOf('  function sendCharacter('), source.indexOf('  function toggleModifier(')) + source.slice(source.indexOf('  function videoPoint('), source.indexOf('  if (loading) return'));
function fixture(videoFill = false) {
  const sent = [];
  const refs = {
    videoRef: { current: { sendInput: value => sent.push(value) } },
    touches: { current: new Map() },
    gesture: { current: { multi: false, moved: false, started: 0 } },
    pressedKeys: { current: new Set() },
    fnKeyCode: { current: null },
    fnArmedRef: { current: false },
    pressedButtons: { current: new Set() },
    pointerStartedHere: { current: false },
  };
  class Video {}
  const code = transformSync(handlers, { loader: 'ts', format: 'cjs' }).code;
  const api = new Function(...Object.keys(refs), 'HTMLVideoElement', 'setModifiers', 'setFnArmed', 'modifiers', 'mode', 'status', 'videoFill', 'mobileKeys', 'viewMode', 'hostPlatform', 'videoModifierCodes', `${code}; return { pointerDown, pointerMove, pointerUp, releaseVideoInput, videoPoint, videoKey, toggleFn, sendCharacter };`)(...Object.values(refs), Video, () => {}, () => {}, [], 'video', 'connected', videoFill, false, 'normal', 'darwin', {});
  const captures = new Set();
  const target = { width: 1920, height: 1080, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }), setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const event = (id, x, y, pointerType = 'touch', buttons = 0) => ({ pointerId: id, clientX: x, clientY: y, currentTarget: target, pointerType, buttons, preventDefault() {} });
  return { ...api, refs, sent, event, target, Video };
}
test('touch tap clicks once; movement starts a drag and up releases it', () => {
  const f = fixture();
  f.pointerDown(f.event(1, 160, 120));
  assert.deepEqual(f.sent, [{ type: 'move', x: .5, y: .5 }]);
  f.pointerUp(f.event(1, 160, 120));
  assert.deepEqual(f.sent.slice(1), [{ type: 'button', button: 'left', down: true }, { type: 'button', button: 'left', down: false }]);
  f.sent.length = 0;
  f.pointerDown(f.event(2, 160, 120));
  f.refs.gesture.current.started -= 150;
  f.pointerMove(f.event(2, 190, 120));
  f.pointerUp(f.event(2, 190, 120));
  assert.deepEqual(f.sent.filter(v => v.type === 'button').map(v => v.down), [true, false]);
  assert.deepEqual(f.sent, [
    { type: 'move', x: .5, y: .5 },
    { type: 'move', x: .5, y: .5 },
    { type: 'button', button: 'left', down: true },
    { type: 'move', x: 190 / 320, y: .5 },
    { type: 'button', button: 'left', down: false },
  ]);
});
test('two quick touch taps emit two full left clicks for the native double-click counter', () => {
  const f = fixture();
  for (const id of [1, 2]) { f.pointerDown(f.event(id, 160, 120)); f.pointerUp(f.event(id, 160, 120)); }
  assert.deepEqual(f.sent.filter(v => v.type === 'button'), [
    { type: 'button', button: 'left', down: true }, { type: 'button', button: 'left', down: false },
    { type: 'button', button: 'left', down: true }, { type: 'button', button: 'left', down: false },
  ]);
});

test('staggered second finger does not start an accidental left drag', () => {
  const f = fixture();
  f.pointerDown(f.event(1, 100, 100));
  f.pointerMove(f.event(1, 115, 100));
  f.pointerDown(f.event(2, 200, 100));
  f.pointerMove(f.event(1, 115, 130));
  f.pointerUp(f.event(1, 115, 130));
  f.pointerUp(f.event(2, 200, 100));
  assert.equal(f.sent.some(v => v.type === 'button' && v.button === 'left'), false);
  assert.equal(f.sent.some(v => v.type === 'wheel'), true);
});
test('two-finger tap right-clicks without a preceding left click', () => {
  const f = fixture();
  f.pointerDown(f.event(1, 100, 100)); f.pointerDown(f.event(2, 200, 100));
  f.pointerUp(f.event(1, 100, 100)); f.pointerUp(f.event(2, 200, 100));
  assert.deepEqual(f.sent.filter(v => v.type === 'button'), [{ type: 'button', button: 'right', down: true }, { type: 'button', button: 'right', down: false }]);
});
test('two-finger movement scrolls and does not click when lifted', () => {
  const f = fixture();
  f.pointerDown(f.event(1, 100, 100)); f.pointerDown(f.event(2, 200, 100));
  f.pointerMove(f.event(1, 100, 130));
  f.pointerUp(f.event(1, 100, 130)); f.pointerUp(f.event(2, 200, 100));
  assert.deepEqual(f.sent.filter(v => v.type === 'wheel'), [{ type: 'wheel', dy: -15 }]);
  assert.equal(f.sent.filter(v => v.type === 'button').length, 0);
});
test('cancel/blur releases held inputs and suppresses a later touch click', () => {
  const f = fixture();
  f.pointerDown(f.event(1, 100, 100)); f.pointerMove(f.event(1, 140, 100));
  f.refs.pressedKeys.current.add('ShiftLeft');
  f.releaseVideoInput();
  const count = f.sent.length;
  f.pointerUp(f.event(1, 140, 100));
  assert.equal(f.sent.length, count);
  assert.equal(f.refs.pressedKeys.current.size, 0);
  assert.equal(f.refs.pressedButtons.current.size, 0);
  assert.ok(f.sent.some(v => v.type === 'key' && v.code === 'ShiftLeft' && !v.down));
});
test('letterbox input is ignored; captured desktop drag clamps at image edges', () => {
  const f = fixture();
  f.pointerDown(f.event(1, -20, -20, 'mouse', 1));
  assert.deepEqual(f.sent, []);
  f.pointerDown(f.event(1, 160, 120, 'mouse', 1));
  f.pointerMove(f.event(1, -20, -20, 'mouse', 1));
  assert.deepEqual(f.sent.at(-1), { type: 'move', x: 0, y: 0 });
  f.pointerUp(f.event(1, -20, -20, 'mouse', 0));
  assert.equal(f.sent.at(-1).down, false);
});
test('MSE pointer geometry uses intrinsic video dimensions', () => {
  const f = fixture();
  Object.setPrototypeOf(f.target, f.Video.prototype);
  f.target.videoWidth = 100; f.target.videoHeight = 100;
  f.pointerDown(f.event(1, 40, 120));
  assert.deepEqual(f.sent[0], { type: 'move', x: 0, y: .5 });
});

for (const mse of [false, true]) {
  for (const fill of [false, true]) {
    test(`${mse ? 'MSE' : 'canvas'} ${fill ? 'Fill' : 'Fit'} maps center, visible edges and captured touch drag`, () => {
      const f = fixture(fill);
      if (mse) { Object.setPrototypeOf(f.target, f.Video.prototype); f.target.videoWidth = 1920; f.target.videoHeight = 1080; }
      f.pointerDown(f.event(1, 160, 120));
      assert.deepEqual(f.sent[0], { type: 'move', x: .5, y: .5 });
      f.refs.gesture.current.started -= 150;
      f.pointerMove(f.event(1, -100, 120));
      assert.ok(Math.abs(f.sent.findLast(v => v.type === 'move').x - (fill ? .125 : 0)) < 1e-10);
      f.pointerMove(f.event(1, 500, 120));
      assert.ok(Math.abs(f.sent.findLast(v => v.type === 'move').x - (fill ? .875 : 1)) < 1e-10);
      f.pointerUp(f.event(1, 500, 120));
      assert.equal(f.sent.at(-1).down, false);
    });
  }
}
test('touch in letterbox cannot click or seed a multi-touch gesture', () => {
  const f = fixture();
  f.pointerDown(f.event(1, 160, 10)); f.pointerUp(f.event(1, 160, 10));
  assert.deepEqual(f.sent, []);
  assert.equal(f.refs.touches.current.size, 0);
});
test('MSE without metadata cannot send input', () => {
  const f = fixture(true);
  Object.setPrototypeOf(f.target, f.Video.prototype);
  f.target.videoWidth = 0; f.target.videoHeight = 0;
  f.pointerDown(f.event(1, 160, 120));
  assert.deepEqual(f.sent, []);
});
test('physical Fn is ignored; plain f goes to remote, UI Fn applies only to next key', () => {
  const f = fixture();
  const event = (key, code) => ({ key, code, preventDefault() {} });
  f.videoKey(event('Fn', 'Fn'), true);
  f.videoKey(event('Fn', 'Fn'), false);
  f.videoKey(event('FnLock', 'FnLock'), true);
  f.videoKey(event('FnLock', 'FnLock'), false);
  assert.deepEqual(f.sent, []);
  f.videoKey(event('f', 'KeyF'), true);
  f.videoKey(event('f', 'KeyF'), false);
  assert.deepEqual(f.sent.splice(0), [{ type: 'key', code: 'KeyF', down: true }, { type: 'key', code: 'KeyF', down: false }]);
  f.toggleFn();
  f.videoKey(event('f', 'KeyF'), true);
  f.videoKey(event('f', 'KeyF'), false);
  f.videoKey(event('g', 'KeyG'), true);
  f.videoKey(event('g', 'KeyG'), false);
  assert.deepEqual(f.sent, [
    { type: 'key', code: 'KeyF', down: true, fn: true },
    { type: 'key', code: 'KeyF', down: false, fn: true },
    { type: 'key', code: 'KeyG', down: true },
    { type: 'key', code: 'KeyG', down: false },
  ]);
  assert.equal(f.refs.fnArmedRef.current, false);
});

test('blur releases an armed Fn key without affecting subsequent keys', () => {
  const f = fixture();
  const event = (key, code) => ({ key, code, preventDefault() {} });
  f.toggleFn();
  f.videoKey(event('f', 'KeyF'), true);
  f.releaseVideoInput();
  f.videoKey(event('g', 'KeyG'), true);
  assert.deepEqual(f.sent.filter(v => v.type === 'key'), [
    { type: 'key', code: 'KeyF', down: true, fn: true },
    { type: 'key', code: 'KeyF', down: false, fn: true },
    { type: 'key', code: 'KeyG', down: true },
  ]);
});
test('IME composition is not forwarded as keys and consumes pending Fn on commit', () => {
  const f = fixture();
  const event = (key, code, isComposing = false, keyCode = 0) => ({ key, code, keyCode, nativeEvent: { isComposing }, preventDefault() {} });
  f.toggleFn();
  f.videoKey(event('Process', 'KeyF', true, 229), true);
  assert.equal(f.refs.fnArmedRef.current, false);
  f.videoKey(event('Process', 'KeyF', true, 229), false);
  f.sendCharacter('你');
  f.videoKey(event('f', 'KeyF'), true);
  f.videoKey(event('f', 'KeyF'), false);
  assert.deepEqual(f.sent, [
    { type: 'text', text: '你' },
    { type: 'key', code: 'KeyF', down: true }, { type: 'key', code: 'KeyF', down: false },
  ]);
  assert.equal(f.refs.fnArmedRef.current, false);
});

test('IME-marked key release still releases a previously held key', () => {
  const f = fixture();
  f.videoKey({ key: 'f', code: 'KeyF', nativeEvent: {}, preventDefault() {} }, true);
  f.videoKey({ key: 'Process', code: 'KeyF', keyCode: 229, nativeEvent: { isComposing: true }, preventDefault() {} }, false);
  assert.deepEqual(f.sent, [{ type: 'key', code: 'KeyF', down: true }, { type: 'key', code: 'KeyF', down: false }]);
  assert.equal(f.refs.pressedKeys.current.size, 0);
});
test('Mac native agent tags both halves of a double-click and strips unintended Fn flags', () => {
  const agent = readFileSync(new URL('../native/RemoteControlAgent.swift', import.meta.url), 'utf8');
  assert.match(agent, /clickCount = button == lastClickButton && now - lastClickTime < 0\.5/);
  assert.match(agent, /mouse\.setIntegerValueField\(\.mouseEventClickState, value: clickCount\)/);
  assert.match(agent, /key\.flags = \(event\["fn"\] as\? Bool == true \? key\.flags\.union\(\.maskSecondaryFn\) : key\.flags\.subtracting\(\.maskSecondaryFn\)\)/);
  assert.match(agent, /keyboardSetUnicodeString[\s\S]*key\.post\(tap: \.cghidEventTap\)/);
});

function viewingFixture(requestFullscreen) {
  const state = {};
  const shell = { requestFullscreen };
  const document = { fullscreenElement: null, async exitFullscreen() { this.fullscreenElement = null; } };
  const refs = { shellRef: { current: shell }, viewRequest: { current: 0 }, fullscreenButtonRef: { current: { focus() {} } }, document, requestAnimationFrame: callback => callback(), releaseVideoInput() {}, setViewPending: v => state.pending = v, setControlsHidden: v => state.hidden = v, setViewMode: v => state.mode = v, setViewNotice: v => state.notice = v };
  const code = transformSync(source.slice(source.indexOf('  async function exitViewing('), source.indexOf('  useEffect(() => {\n    const shell = shellRef.current;')), { loader: 'ts' }).code;
  return { state, shell, document, ...new Function(...Object.keys(refs), `${code}; return { enterViewing, exitViewing };`)(...Object.values(refs)) };
}
test('unsupported and rejected fullscreen use theater; exit restores normal', async () => {
  for (const request of [undefined, async () => { throw new Error('blocked'); }]) {
    const f = viewingFixture(request);
    await f.enterViewing();
    assert.equal(f.state.mode, 'theater');
    assert.equal(f.state.pending, false);
    assert.match(f.state.notice, /unavailable/);
    await f.exitViewing();
    assert.equal(f.state.mode, 'normal');
  }
});
test('fullscreen success and exit invoke the browser API', async () => {
  const f = viewingFixture(async () => { f.document.fullscreenElement = f.shell; });
  await f.enterViewing();
  assert.equal(f.state.mode, 'fullscreen');
  await f.exitViewing();
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.state.mode, 'normal');
});
test('late fullscreen fulfillment after exit is unwound', async () => {
  let resolve;
  const f = viewingFixture(() => new Promise(done => { resolve = () => { f.document.fullscreenElement = f.shell; done(); }; }));
  const entered = f.enterViewing();
  await f.exitViewing(); resolve(); await entered;
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.state.mode, 'normal');
});

test('hide controls closes auxiliary input without disabling the persistent toggle', () => {
  const button = source.match(/<button ref=\{controlsButtonRef\}[^\n]+/)[0];
  assert.doesNotMatch(button, /disabled=/);
  assert.match(button, /aria-controls="remote-controls"/);
  const handler = button.match(/onClick=\{\(\) => \{ (.*?) \}\}>/)[1];
  for (const hidden of [false, true]) {
    const state = { more: true, clipboard: true, keyboard: true };
    let released = false;
    let blurred = false;
    new Function('controlsHidden', 'releaseVideoInput', 'setMoreOpen', 'setClipboardOpen', 'inputRef', 'setMobileKeys', 'setControlsHidden', handler)(
      hidden, () => released = true, v => state.more = v, v => state.clipboard = v,
      { current: { blur() { blurred = true; } } }, v => state.keyboard = v, v => state.hidden = v,
    );
    assert.equal(released, true);
    assert.equal(state.hidden, !hidden);
    assert.equal(blurred, !hidden);
    if (!hidden) assert.deepEqual(state, { more: false, clipboard: false, keyboard: false, hidden: true });
  }
});

test('immersive controls reserve layout space and retain narrow-screen single rows', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.immersive \.toolbar > \.toolbar-group \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
  assert.match(css, /\.immersive \.keys \{[^}]*flex-wrap: nowrap;/);
  assert.match(css, /\.immersive \.more-controls \{[^}]*max-height:[^}]*overflow: auto;/);
  assert.doesNotMatch(css.match(/\.clipboard-panel \{[^}]+\}/)[0], /position: absolute/);
  assert.match(source, /<\/section>\s*\{clipboardOpen && <section className="clipboard-panel"/);
  assert.match(source, /if \(viewMode !== 'normal'\) controlsButtonRef.current\?\.focus/);
});

test('fullscreen is only offered while connected, but an open view can always be exited', () => {
  const button = source.match(/<button className="fullscreen-trigger"[^\n]+/)[0];
  const disabled = button.match(/disabled=\{(.*?)\} title=/)[1];
  const isDisabled = (status, viewMode, viewPending = false) => new Function('status', 'viewMode', 'viewPending', `return ${disabled};`)(status, viewMode, viewPending);
  for (const status of ['idle', 'connecting', 'disconnected']) assert.equal(isDisabled(status, 'normal'), true, `${status}: nothing to view yet`);
  assert.equal(isDisabled('connected', 'normal'), false);
  assert.equal(isDisabled('disconnected', 'theater'), false, 'Exit view stays usable');
  assert.equal(isDisabled('connected', 'normal', true), true, 'pending request blocks double taps');
});
