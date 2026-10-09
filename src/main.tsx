import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VideoClient, cursorStyle, type Quality } from './video';
import { StatsPanel } from './StatsPanel';
import { Arrow, Chart, Dots, Expand, Keyboard, LogOut, Logo, Monitor, Play, Power, Shield, Sliders, TextIcon } from './icons';
import './style.css';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected';
type Resolution = '720p' | '1080p' | '2160p';
const resolutions: { value: Resolution; label: string; detail: string; fps: readonly number[] }[] = [
  { value: '720p', label: '720p', detail: '1280×720 · lowest bandwidth', fps: [30] },
  { value: '1080p', label: '1080p', detail: '1920×1080 · everyday work', fps: [24, 30, 60] },
  { value: '2160p', label: '2160p (4K)', detail: '3840×2160 · needs a GPU encoder and fast LAN', fps: [24, 30, 60] },
];
// Approximate GPU-encoder targets; software encoding uses constant quality instead.
const qualityBitrate: Record<Quality, string> = { '720p30': '~4 Mbps', '1080p24': '~6 Mbps', '1080p30': '~8 Mbps', '1080p60': '~12 Mbps', '2160p24': '~16 Mbps', '2160p30': '~20 Mbps', '2160p60': '~35 Mbps' };
const qualityLabel = (value: Quality) => `${value.replace(/p(\d+)$/, 'p · $1 fps')}`;
const legacyQualities: Record<string, Quality> = { minimal: '720p30', low: '720p30', hotel: '720p30', data: '720p30', balanced24: '1080p24', balanced: '1080p30', high15: '2160p24', high: '2160p30' };
function storedQuality(value: string | null): Quality {
  if (value && Object.hasOwn(legacyQualities, value)) return legacyQualities[value];
  return value && Object.hasOwn(qualityBitrate, value) ? value as Quality : '1080p30';
}
const splitQuality = (value: Quality) => { const [resolution, fps] = value.split('p'); return { resolution: `${resolution}p` as Resolution, fps: Number(fps) }; };

const videoSpecialCodes = { Escape: 'Escape', Tab: 'Tab', Return: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Left: 'ArrowLeft', Up: 'ArrowUp', Right: 'ArrowRight', Down: 'ArrowDown' } as const;
type SpecialKey = keyof typeof videoSpecialCodes;
const videoModifierCodes = { Command: 'MetaLeft', Control: 'ControlLeft', Option: 'AltLeft', Shift: 'ShiftLeft' } as const;
type ModifierKey = keyof typeof videoModifierCodes;
const isFnKey = (event: React.KeyboardEvent) => event.key === 'Fn' || event.key === 'FnLock' || event.code === 'Fn' || event.code === 'FnLock';

async function api(path: string, options?: RequestInit) {
  const response = await fetch(`/api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function App() {
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [clipboard, setClipboard] = useState('');
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [videoFill, setVideoFill] = useState(false);
  const [viewMode, setViewMode] = useState<'normal' | 'fullscreen' | 'theater'>('normal');
  const [viewPending, setViewPending] = useState(false);
  const [viewNotice, setViewNotice] = useState('');
  const [controlsHidden, setControlsHidden] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const viewRequest = useRef(0);
  const [nativeVideo, setNativeVideo] = useState(true);
  const [hostPlatform, setHostPlatform] = useState('');
  const [fnArmed, setFnArmed] = useState(false);
  const fnArmedRef = useRef(false);
  const fnKeyCode = useRef<string | null>(null);
  const [hevcVideo, setHevcVideo] = useState(true);
  const [hevcCodecString, setHevcCodecString] = useState('hvc1.1.6.L150.B0');
  const [hevcMseVideo, setHevcMseVideo] = useState(false);
  const [quality, setQuality] = useState<Quality>(() => {
    try {
      return storedQuality(localStorage.getItem('remotecontrol-quality'));
    } catch { return '1080p30'; }
  });
  const qualityRef = useRef(quality);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [draftQuality, setDraftQuality] = useState<Quality>(quality);
  const [moreOpen, setMoreOpen] = useState(false);
  const qualityDialogRef = useRef<HTMLDialogElement>(null);
  const qualityButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const controlsButtonRef = useRef<HTMLButtonElement>(null);
  const clipboardButtonRef = useRef<HTMLButtonElement>(null);
  const keyboardButtonRef = useRef<HTMLButtonElement>(null);
  const escapeHandled = useRef(false);
  // Stats for nerds is opt-in: hidden until the owner enables it in Settings (persisted per browser).
  const [nerdStatsAllowed, setNerdStatsAllowed] = useState(() => { try { return localStorage.getItem('remotecontrol-nerd-stats') === '1'; } catch { return false; } });
  const [statsOpen, setStatsOpen] = useState(false);
  function allowNerdStats(allowed: boolean) {
    setNerdStatsAllowed(allowed);
    if (!allowed) setStatsOpen(false);
    try { localStorage.setItem('remotecontrol-nerd-stats', allowed ? '1' : '0'); } catch { /* preference is optional */ }
  }
  useEffect(() => {
    if (qualityOpen) qualityDialogRef.current?.showModal();
    else if (qualityDialogRef.current?.open) {
      qualityDialogRef.current.close();
      qualityButtonRef.current?.focus({ preventScroll: true });
    }
  }, [qualityOpen]);
  const [activeCodec, setActiveCodec] = useState('');
  const [modifiers, setModifiers] = useState<string[]>([]);
  const [mobileKeys, setMobileKeys] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<VideoClient | null>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const [videoPlayback, setVideoPlayback] = useState<'canvas' | 'mse'>('canvas');
  // With a mouse/trackpad the browser draws the pointer itself (zero latency) in the host's current shape;
  // touch-only devices keep the cursor drawn into the video. Empty = stylesheet default.
  const [videoCursor, setVideoCursor] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const intentional = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const connectedAt = useRef(0);
  const noRetry = useRef(false);
  const hevcFallbackReason = useRef('');
  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(new Set<'left' | 'right'>());
  const pointerStartedHere = useRef(false);
  const touches = useRef(new Map<number, { x: number; y: number; startX: number; startY: number }>());
  const gesture = useRef({ multi: false, moved: false, started: 0 });
  const composing = useRef(false);
  const [signingIn, setSigningIn] = useState(false);

  // visualViewport follows the soft keyboard on browsers where dvh does not.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty('--viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    resize();
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); };
  }, []);
  useEffect(() => {
    if (viewMode !== 'normal') controlsButtonRef.current?.focus({ preventScroll: true });
  }, [viewMode]);

  async function exitViewing() {
    ++viewRequest.current;
    releaseVideoInput();
    setViewPending(false);
    setControlsHidden(false);
    if (shellRef.current && document.fullscreenElement === shellRef.current && document.exitFullscreen) {
      try { await document.exitFullscreen(); }
      catch { setViewNotice('Use your browser’s Escape / fullscreen control to exit.'); return; }
    }
    setViewMode('normal');
    setViewNotice('');
    requestAnimationFrame(() => fullscreenButtonRef.current?.focus({ preventScroll: true }));
  }

  async function enterViewing() {
    const shell = shellRef.current;
    if (!shell) return;
    const request = ++viewRequest.current;
    releaseVideoInput();
    setViewPending(true);
    setViewNotice('');
    try {
      if (!shell.requestFullscreen) throw new Error('Fullscreen unavailable');
      await shell.requestFullscreen();
      if (request === viewRequest.current) setViewMode('fullscreen');
      else if (document.fullscreenElement === shell) await document.exitFullscreen();
    } catch {
      if (request === viewRequest.current) {
        setViewMode('theater');
        setViewNotice('Theater view — browser fullscreen unavailable.');
      }
    } finally { if (request === viewRequest.current) setViewPending(false); }
  }

  useEffect(() => {
    const shell = shellRef.current;
    const changed = () => {
      releaseVideoInput();
      setViewMode(shellRef.current && document.fullscreenElement === shellRef.current ? 'fullscreen' : 'normal');
      setControlsHidden(false);
      setViewNotice('');
      if (!document.fullscreenElement) requestAnimationFrame(() => fullscreenButtonRef.current?.focus({ preventScroll: true }));
    };
    document.addEventListener('fullscreenchange', changed);
    return () => {
      ++viewRequest.current;
      document.removeEventListener('fullscreenchange', changed);
      if (shell && document.fullscreenElement === shell) void document.exitFullscreen().catch(() => {});
    };
  }, [authenticated, loading]);

  useEffect(() => {
    if (!authenticated || status === 'idle') void exitViewing();
  }, [authenticated, status]);

  useEffect(() => {
    if (status !== 'connected') return;
    const wheel = (event: WheelEvent) => {
      const target = event.currentTarget as HTMLCanvasElement | HTMLVideoElement;
      if (!videoPoint(target, event.clientX, event.clientY)?.inside) return;
      event.preventDefault();
      videoRef.current?.sendInput({ type: 'wheel', dy: event.deltaY });
    };
    const canvas = canvasRef.current;
    const video = mediaRef.current;
    canvas?.addEventListener('wheel', wheel, { passive: false });
    video?.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas?.removeEventListener('wheel', wheel);
      video?.removeEventListener('wheel', wheel);
    };
  }, [status, videoFill]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      if (event.inputType === 'deleteContentBackward' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        sendKey(event.inputType === 'deleteContentBackward' ? 'Backspace' : 'Return', false);
      }
    };
    input.addEventListener('beforeinput', beforeInput);
    return () => input.removeEventListener('beforeinput', beforeInput);
  }, [authenticated, loading, modifiers, status, mobileKeys]);

  useEffect(() => {
    if (status !== 'connected') { fnArmedRef.current = false; fnKeyCode.current = null; setFnArmed(false); }
  }, [status]);

  useEffect(() => {
    if (status !== 'connected') { releaseVideoInput(); setMobileKeys(false); setClipboardOpen(false); }
  }, [status]);

  useEffect(() => {
    api('session').then((result) => {
      setAuthenticated(result.authenticated);
      setConfigured(result.configured);
      setHostPlatform(result.platform || '');
      setNativeVideo(result.nativeVideo !== false);
      setHevcVideo(result.hevcVideo === true);
      setHevcMseVideo(result.hevcMseVideo === true);
      if (result.hevcCodecString === 'hvc1.1.6.L150.90' || result.hevcCodecString === 'hvc1.1.6.L150.B0') setHevcCodecString(result.hevcCodecString);
    }).catch(() => setAuthError('Cannot reach the service.')).finally(() => setLoading(false));
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); videoRef.current?.close(); };
  }, []);
  useEffect(() => {
    const release = () => releaseVideoInput();
    const hidden = () => { if (document.hidden) releaseVideoInput(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    setSigningIn(true);
    try {
      await api('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const session = await api('session');
      setHostPlatform(session.platform || '');
      setNativeVideo(session.nativeVideo === true);
      setHevcVideo(session.hevcVideo === true);
      setHevcMseVideo(session.hevcMseVideo === true);
      if (session.hevcCodecString === 'hvc1.1.6.L150.90' || session.hevcCodecString === 'hvc1.1.6.L150.B0') setHevcCodecString(session.hevcCodecString);
      setPassword('');
      setAuthenticated(true);
    } catch (error) { setAuthError((error as Error).message); }
    finally { setSigningIn(false); }
  }

  async function signOut() {
    intentional.current = true;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    releaseVideoInput();
    videoRef.current?.close();
    videoRef.current = null;
    await api('logout', { method: 'POST' }).catch(() => undefined);
    setAuthenticated(false);
    setStatus('idle');
  }

  function expireSession() {
    intentional.current = true;
    noRetry.current = true;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    releaseVideoInput();
    videoRef.current?.close();
    videoRef.current = null;
    connectedAt.current = 0;
    setStatus('idle');
    setActiveCodec('');
    setMessage('');
    setPassword('');
    setModifiers([]);
    setQualityOpen(false);
    setMoreOpen(false);
    setStatsOpen(false);
    setAuthError('登录已过期或已退出，请重新登录。');
    setAuthenticated(false);
  }

  function connectVideo(selectedQuality: Quality = quality, retrying = false, forcedCodec?: 'h264') {
    if (!canvasRef.current || !mediaRef.current) return;
    intentional.current = false;
    if (!retrying && !forcedCodec) hevcFallbackReason.current = '';
    if (!retrying) { retryCount.current = 0; noRetry.current = false; }
    if (retryTimer.current) clearTimeout(retryTimer.current);
    releaseVideoInput();
    videoRef.current?.close();
    connectedAt.current = 0;
    setVideoPlayback(typeof VideoDecoder === 'undefined' ? 'mse' : 'canvas');
    const localCursor = globalThis.matchMedia?.('(any-pointer: fine)').matches === true;
    setVideoCursor(localCursor ? 'default' : '');
    setStatus('connecting');
    setActiveCodec('');
    setMessage('Starting the video stream…');
    const client = new VideoClient(canvasRef.current, (codec) => {
      if (videoRef.current !== client) return;
      connectedAt.current = Date.now();
      setVideoPlayback(client.renderMode);
      setActiveCodec(codec === 'hevc' ? 'HEVC' : 'H.264');
      setStatus('connected');
      setMessage(hevcMseVideo && codec === 'h264' && hevcFallbackReason.current ? `HEVC failed: ${hevcFallbackReason.current} Playing H.264.` : '');
      if (client.renderMode === 'mse') mediaRef.current?.focus(); else canvasRef.current?.focus();
    }, (error) => {
      if (videoRef.current !== client) return;
      if (error === 'Video connection failed.') { setMessage(error); return; }
      if (client.activeCodec === 'hevc') {
        if (hevcMseVideo) hevcFallbackReason.current = error;
        client.close();
        videoRef.current = null;
        connectVideo(selectedQuality, retrying, 'h264');
        return;
      }
      noRetry.current = true;
      client.close();
      videoRef.current = null;
      setStatus('disconnected');
      setMessage(error);
    }, async (code) => {
      if (videoRef.current !== client || intentional.current) return;
      const wasStable = connectedAt.current > 0 && Date.now() - connectedAt.current >= 30_000;
      client.close();
      if (code === 4001) { expireSession(); return; }
      // Browsers hide the HTTP status of a rejected WebSocket handshake.
      // Confirm authentication before treating that failure as a network disconnect.
      if (code !== 4000 && !noRetry.current) {
        try {
          const session = await api('session', { signal: AbortSignal.timeout(5000) });
          if (videoRef.current !== client || intentional.current) return;
          if (session.authenticated === false) { expireSession(); return; }
        } catch { /* An unreachable service is not evidence of an expired session. */ }
      }
      if (videoRef.current !== client || intentional.current) return;
      videoRef.current = null;
      // First frames do not prove stability: short-lived connections keep their retry budget.
      if (wasStable) retryCount.current = 0;
      connectedAt.current = 0;
      setStatus('disconnected');
      if (code === 4000) {
        noRetry.current = true;
        setMessage('Another session took control of this stream.');
        return;
      }
      setMessage((previous) => previous || 'Video connection ended.');
      if (!noRetry.current && retryCount.current < 3) {
        const delay = 1000 * 2 ** retryCount.current++;
        retryTimer.current = setTimeout(() => connectVideo(qualityRef.current, true, forcedCodec), delay);
      }
    }, mediaRef.current);
    client.onCursor = (cursor) => { if (videoRef.current === client) setVideoCursor(cursorStyle(cursor)); };
    videoRef.current = client;
    void client.connect(selectedQuality, forcedCodec ?? (hevcVideo ? undefined : 'h264'), hevcCodecString, hevcMseVideo, localCursor).catch((error) => {
      if (videoRef.current !== client) return;
      client.close();
      videoRef.current = null;
      noRetry.current = true;
      setStatus('disconnected');
      setMessage((error as Error).message);
    });
  }

  function connect() {
    if (!nativeVideo) {
      setStatus('disconnected');
      setMessage(hostPlatform === 'win32' ? 'The Windows capture agent is missing. Run `pnpm build:windows` or reinstall the desktop package.' : hostPlatform === 'darwin' ? 'The macOS capture agent is missing. Run `pnpm build:native` or reinstall the desktop app.' : 'Video streaming is only supported on macOS and Windows hosts.');
      return;
    }
    connectVideo();
  }

  function changeQuality(value: Quality) {
    if (value === quality) return;
    qualityRef.current = value;
    setQuality(value);
    try { localStorage.setItem('remotecontrol-quality', value); } catch { /* preference is optional */ }
    if (status === 'connected' || status === 'connecting') connectVideo(value);
  }

  function disconnect() {
    intentional.current = true;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    releaseVideoInput();
    videoRef.current?.close();
    videoRef.current = null;
    setStatus('idle');
    setActiveCodec('');
    setModifiers([]);
  }

  function clearFn() {
    fnArmedRef.current = false;
    setFnArmed(false);
  }
  function toggleFn() {
    if (fnArmedRef.current) clearFn();
    else { fnArmedRef.current = true; setFnArmed(true); }
  }
  function consumeFn() {
    const active = fnArmedRef.current && hostPlatform === 'darwin';
    if (active) clearFn();
    return active;
  }
  function sendKey(name: SpecialKey, focusDesktop = true) {
    if (status !== 'connected') return;
    const fn = consumeFn();
    for (const modifier of modifiers) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as ModifierKey], down: true });
    videoRef.current?.sendInput({ type: 'key', code: videoSpecialCodes[name], down: true, ...(fn ? { fn: true } : {}) });
    videoRef.current?.sendInput({ type: 'key', code: videoSpecialCodes[name], down: false, ...(fn ? { fn: true } : {}) });
    for (const modifier of [...modifiers].reverse()) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as ModifierKey], down: false });
    setModifiers([]);
    if (focusDesktop && !mobileKeys) (videoPlayback === 'mse' ? mediaRef.current : canvasRef.current)?.focus({ preventScroll: true });
  }

  function sendCharacter(character: string) {
    if (status !== 'connected') return;
    const code = /^[a-z]$/i.test(character) ? `Key${character.toUpperCase()}` : /^[0-9]$/.test(character) ? `Digit${character}` : null;
    if ((modifiers.length || fnArmedRef.current) && code) {
      const fn = consumeFn();
      for (const modifier of modifiers) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as ModifierKey], down: true });
      videoRef.current?.sendInput({ type: 'key', code, down: true, ...(fn ? { fn: true } : {}) });
      videoRef.current?.sendInput({ type: 'key', code, down: false, ...(fn ? { fn: true } : {}) });
      for (const modifier of [...modifiers].reverse()) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as ModifierKey], down: false });
      setModifiers([]);
    } else {
      if (fnArmedRef.current) clearFn(); // IME commits must not leave Fn armed for a later f.
      videoRef.current?.sendInput({ type: 'text', text: character });
      if (modifiers.length) setModifiers([]);
    }
  }

  function toggleModifier(name: string) {
    setModifiers((value) => value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  }

  function videoPoint(target: HTMLCanvasElement | HTMLVideoElement, clientX: number, clientY: number) {
    const rect = target.getBoundingClientRect();
    const width = target instanceof HTMLVideoElement ? target.videoWidth : target.width;
    const height = target instanceof HTMLVideoElement ? target.videoHeight : target.height;
    if (!width || !height || !rect.width || !rect.height) return;
    const scale = (videoFill ? Math.max : Math.min)(rect.width / width, rect.height / height);
    const shownWidth = width * scale, shownHeight = height * scale;
    // Clamp captured drags to the visible image, not the offscreen crop.
    const left = Math.max(0, (rect.width - shownWidth) / 2);
    const top = Math.max(0, (rect.height - shownHeight) / 2);
    const right = Math.min(rect.width, (rect.width + shownWidth) / 2);
    const bottom = Math.min(rect.height, (rect.height + shownHeight) / 2);
    const localX = clientX - rect.left, localY = clientY - rect.top;
    return {
      inside: localX >= left && localX <= right && localY >= top && localY <= bottom,
      x: Math.max(0, Math.min(1, (Math.max(left, Math.min(right, localX)) - (rect.width - shownWidth) / 2) / shownWidth)),
      y: Math.max(0, Math.min(1, (Math.max(top, Math.min(bottom, localY)) - (rect.height - shownHeight) / 2) / shownHeight)),
    };
  }

  function videoPosition(event: React.PointerEvent<HTMLCanvasElement | HTMLVideoElement>, captured = false) {
    const point = videoPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point || (!captured && !point.inside)) return false;
    videoRef.current?.sendInput({ type: 'move', x: point.x, y: point.y });
    return true;
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement | HTMLVideoElement>) {
    if (status !== 'connected') return;
    event.preventDefault();
    if (!videoPoint(event.currentTarget, event.clientX, event.clientY)?.inside) return;
    if (!mobileKeys) event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType !== 'touch') {
      pointerStartedHere.current = true;
      videoPosition(event);
      syncVideoButtons(event.buttons, true);
      return;
    }
    if (!touches.current.size) gesture.current = { multi: false, moved: false, started: Date.now() };
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    if (touches.current.size === 1) videoPosition(event);
    else { gesture.current.multi = true; syncVideoButtons(0); }
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement | HTMLVideoElement>) {
    if (status !== 'connected') return;
    if (event.pointerType !== 'touch') {
      videoPosition(event, pointerStartedHere.current); syncVideoButtons(event.buttons, pointerStartedHere.current); return;
    }
    const touch = touches.current.get(event.pointerId);
    if (!touch) return;
    event.preventDefault();
    const dy = event.clientY - touch.y;
    touch.x = event.clientX; touch.y = event.clientY;
    if (Math.hypot(touch.x - touch.startX, touch.y - touch.startY) > 8) gesture.current.moved = true;
    if (gesture.current.multi) {
      if (touches.current.size === 2 && gesture.current.moved) videoRef.current?.sendInput({ type: 'wheel', dy: -dy / 2 });
    } else if (gesture.current.moved && Date.now() - gesture.current.started >= 120) {
      if (!pressedButtons.current.has('left')) {
        const start = videoPoint(event.currentTarget, touch.startX, touch.startY);
        if (start) videoRef.current?.sendInput({ type: 'move', x: start.x, y: start.y });
        syncVideoButtons(1, true);
      }
      videoPosition(event, true);
    }
  }

  function pointerUp(event: React.PointerEvent<HTMLCanvasElement | HTMLVideoElement>) {
    if (event.pointerType !== 'touch') {
      syncVideoButtons(event.buttons); if (!event.buttons) pointerStartedHere.current = false;
    } else if (touches.current.delete(event.pointerId) && !touches.current.size) {
      const { multi, moved, started } = gesture.current;
      if (!moved && (!multi || Date.now() - started < 500)) {
        const button = multi ? 'right' : 'left';
        videoRef.current?.sendInput({ type: 'button', button, down: true });
        videoRef.current?.sendInput({ type: 'button', button, down: false });
      }
      syncVideoButtons(0);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function syncVideoButtons(buttons: number, allowPress = false) {
    for (const [button, mask] of [['left', 1], ['right', 2]] as const) {
      const down = (buttons & mask) !== 0;
      if (down && allowPress && !pressedButtons.current.has(button)) {
        pressedButtons.current.add(button);
        videoRef.current?.sendInput({ type: 'button', button, down: true });
      } else if (!down && pressedButtons.current.delete(button)) {
        videoRef.current?.sendInput({ type: 'button', button, down: false });
      }
    }
  }
  function releaseVideoInput() {
    for (const code of pressedKeys.current) videoRef.current?.sendInput({ type: 'key', code, down: false, ...(code === fnKeyCode.current ? { fn: true } : {}) });
    fnKeyCode.current = null;
    pressedKeys.current.clear();
    for (const button of pressedButtons.current) videoRef.current?.sendInput({ type: 'button', button, down: false });
    pressedButtons.current.clear();
    pointerStartedHere.current = false;
    touches.current.clear();
    setModifiers([]);
  }

  function videoKey(event: React.KeyboardEvent<HTMLCanvasElement | HTMLVideoElement>, down: boolean) {
    if (isFnKey(event)) { event.preventDefault(); return; }
    if (event.nativeEvent?.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Dead') {
      event.preventDefault();
      if (fnArmedRef.current) clearFn();
      if (!down && pressedKeys.current.has(event.code)) {
        pressedKeys.current.delete(event.code);
        videoRef.current?.sendInput({ type: 'key', code: event.code, down: false, ...(fnKeyCode.current === event.code ? { fn: true } : {}) });
        if (fnKeyCode.current === event.code) fnKeyCode.current = null;
      }
      return;
    }
    if (status !== 'connected') return;
    event.preventDefault();
    if (down) {
      if (pressedKeys.current.has(event.code)) return;
      pressedKeys.current.add(event.code);
      if (consumeFn()) fnKeyCode.current = event.code;
    } else {
      pressedKeys.current.delete(event.code);
    }
    videoRef.current?.sendInput({ type: 'key', code: event.code, down, ...(fnKeyCode.current === event.code ? { fn: true } : {}) });
    if (!down && fnKeyCode.current === event.code) fnKeyCode.current = null;
  }

  if (loading) return <main className="landing"><div className="boot" role="status"><span className="boot-ring" aria-hidden="true" /><span>initializing secure link…</span></div></main>;
  const platformName = hostPlatform === 'darwin' ? 'macOS' : hostPlatform === 'win32' ? 'Windows' : hostPlatform || 'unknown';
  const presetLabel = qualityLabel(quality);
  const draft = splitQuality(draftQuality);
  const draftResolution = resolutions.find((item) => item.value === draft.resolution) ?? resolutions[1];
  // Switching resolution keeps the frame rate when available, otherwise the closest one (720p is 30 fps only).
  const pickResolution = (value: Resolution) => {
    const options = resolutions.find((item) => item.value === value)!.fps;
    const fps = options.includes(draft.fps) ? draft.fps : options.reduce((best, item) => Math.abs(item - draft.fps) < Math.abs(best - draft.fps) ? item : best);
    setDraftQuality(`${value}${fps}` as Quality);
  };
  const secure = location.protocol === 'https:';
  if (!authenticated) return <main className="landing">
    <section className="login-card">
      <div className="login-brand"><Logo className="logo" /><span className="wordmark">REMOTE<span>//</span>CONTROL</span></div>
      <h1>Your desktop,<br /><span className="gradient-text">anywhere on your network.</span></h1>
      <p className="subtle">Hardware‑encoded video straight to the browser. Sign in with the owner password.</p>
      <div className="chip-row"><span className="chip"><span className="chip-dot" />host · {platformName}</span><span className="chip">{secure ? 'https' : 'http'} · :{location.port || (secure ? 443 : 80)}</span></div>
      {!configured ? <div className="notice">No owner password yet. On the host computer, open the Remote Control desktop app and set one, or run <code>pnpm run setup</code> in the project folder. Then reload this page.</div> :
        <form onSubmit={signIn}><label htmlFor="password">owner_password</label><input id="password" type="password" autoComplete="current-password" placeholder="••••••••••••" value={password} onChange={(event) => setPassword(event.target.value)} required /><button className="primary" type="submit" disabled={signingIn}>{signingIn ? 'Authenticating…' : <>Sign in <Arrow className="icon" /></>}</button></form>}
      {authError && <p className="error" role="alert">{authError}</p>}
      <p className="login-safety"><Shield className="icon" />Use HTTPS or a trusted VPN. Keep port 8787 private.</p>
    </section>
  </main>;
  return <main ref={shellRef} className={`app-shell ${viewMode !== 'normal' ? 'immersive' : ''} ${controlsHidden ? 'controls-hidden' : ''} ${videoFill ? 'video-fill' : ''}`}
    onKeyDownCapture={(event) => {
      if (event.key !== 'Escape') return;
      if (qualityOpen) setQualityOpen(false);
      else if (clipboardOpen) { setClipboardOpen(false); clipboardButtonRef.current?.focus({ preventScroll: true }); }
      else if (mobileKeys) { inputRef.current?.blur(); setMobileKeys(false); keyboardButtonRef.current?.focus({ preventScroll: true }); }
      else if (moreOpen) { setMoreOpen(false); moreButtonRef.current?.focus(); }
      else if (viewMode !== 'normal') void exitViewing();
      else return;
      escapeHandled.current = true;
      event.preventDefault(); event.stopPropagation();
    }}
    onKeyUpCapture={(event) => { if (event.key === 'Escape' && escapeHandled.current) { escapeHandled.current = false; event.preventDefault(); event.stopPropagation(); } }}>
    {viewMode !== 'normal' && <div className="view-controls" aria-label="Viewing controls">
      <span role="status">{viewMode === 'theater' ? 'Theater' : 'Fullscreen'} · Keyboard {mobileKeys ? 'open' : 'closed'}</span>
      <button ref={controlsButtonRef} aria-controls="remote-controls" aria-expanded={!controlsHidden} onClick={() => { releaseVideoInput(); if (!controlsHidden) { setMoreOpen(false); setClipboardOpen(false); inputRef.current?.blur(); setMobileKeys(false); } setControlsHidden(!controlsHidden); }}> {controlsHidden ? 'Show controls' : 'Hide controls'}</button>
      <button onClick={() => void exitViewing()}>Exit · Esc</button>
    </div>}
    {viewNotice && <p className="view-notice" role="status">{viewNotice}</p>}
    <header className="topbar">
      <div className="brand"><Logo className="logo" /><span className="wordmark">REMOTE<span>//</span>CONTROL</span><span className="host-tag">{platformName}</span></div>
      <div className="top-actions"><span className={`connection-status ${status}`}><span className={`status-dot ${status}`} /><span className="status-text" role="status" title={status === 'connected' && activeCodec === 'H.264' && hevcMseVideo ? message : undefined}>{status === 'connected' ? `Connected · ${activeCodec || 'Video'}` : status === 'connecting' ? 'Connecting…' : status === 'disconnected' ? 'Disconnected' : 'Ready to connect'}</span></span>
        <button className={status === 'connected' || status === 'connecting' ? 'danger' : 'primary'} onClick={status === 'connected' || status === 'connecting' ? disconnect : connect}><Power className="icon" />{status === 'connecting' ? 'Cancel connection' : status === 'connected' ? 'Disconnect' : status === 'disconnected' ? 'Reconnect' : 'Connect'}</button>
      </div>
    </header>
    <section className="stage">
      <div className="viewer" aria-label="Remote desktop">
        <canvas ref={canvasRef} className="video-canvas" style={{ display: videoPlayback === 'canvas' ? 'block' : 'none', cursor: videoCursor || undefined }} tabIndex={0}
          aria-label="Remote desktop video"
          onPointerMove={pointerMove} onPointerDown={pointerDown} onPointerUp={pointerUp}
          onPointerCancel={releaseVideoInput} onLostPointerCapture={(event) => { if (touches.current.has(event.pointerId) || pointerStartedHere.current) releaseVideoInput(); }}
          onKeyDown={(event) => videoKey(event, true)}
          onKeyUp={(event) => videoKey(event, false)}
          onBlur={releaseVideoInput}
          onContextMenu={(event) => event.preventDefault()} />
        <video ref={mediaRef} className="video-canvas" style={{ display: videoPlayback === 'mse' ? 'block' : 'none', cursor: videoCursor || undefined }} tabIndex={0} muted playsInline
          aria-label="Remote desktop video"
          onPointerMove={pointerMove} onPointerDown={pointerDown} onPointerUp={pointerUp}
          onPointerCancel={releaseVideoInput} onLostPointerCapture={(event) => { if (touches.current.has(event.pointerId) || pointerStartedHere.current) releaseVideoInput(); }}
          onKeyDown={(event) => videoKey(event, true)}
          onKeyUp={(event) => videoKey(event, false)}
          onBlur={releaseVideoInput}
          onContextMenu={(event) => event.preventDefault()} />
      </div>
      {status !== 'connected' && <div className="stage-overlay"><div className={`connect-card ${status === 'connecting' ? 'is-connecting' : ''} ${status}`}>
        <div className="desktop-icon" aria-hidden="true"><span className="orbit" /><Monitor className="monitor" /></div>
        <p className="eyebrow">{status === 'connecting' ? '> establishing session' : status === 'disconnected' ? '> session paused' : '> standby'}<span className="cursor">_</span></p>
        <h2>{status === 'connecting' ? 'Getting you connected' : status === 'disconnected' ? 'Connection ended' : 'Right where you left off.'}</h2>
        <p role="status">{message || 'Your computer, in this browser. Connect when you’re ready to pick things up.'}</p>
        <div className="session-summary"><span>video · {hevcVideo ? 'hevc/h.264' : 'h.264'}</span><span>{presetLabel}</span><span>{secure ? 'tls' : 'lan · http'}</span></div>
        {status !== 'connecting' && <button className="primary connect-cta" onClick={connect}><Play className="icon" />{status === 'disconnected' ? 'Reconnect to desktop' : 'Connect to desktop'}</button>}
        <p className="connection-safety">Private access · Use HTTPS or a trusted VPN</p>
      </div></div>}
      {statsOpen && nerdStatsAllowed && <StatsPanel client={status === 'connected' ? videoRef.current : null} quality={presetLabel} onClose={() => setStatsOpen(false)} />}
    </section>
    {clipboardOpen && <section className="clipboard-panel" aria-labelledby="clipboard-title"><div className="panel-heading"><strong id="clipboard-title">Send text</strong><button className="icon-button" onClick={() => { setClipboardOpen(false); clipboardButtonRef.current?.focus({ preventScroll: true }); }} aria-label="Close clipboard">×</button></div><textarea aria-label="Text to send to desktop" autoFocus value={clipboard} onChange={(event) => setClipboard(event.target.value)} placeholder="Paste text here" /><button disabled={status !== 'connected' || !clipboard.trim()} onClick={() => { void videoRef.current?.sendText(clipboard); setClipboardOpen(false); clipboardButtonRef.current?.focus({ preventScroll: true }); }}>Send to desktop</button></section>}
    <nav id="remote-controls" className="toolbar" aria-label="Remote controls">
      <div className="toolbar-group">
        <button className="quality-trigger" ref={qualityButtonRef} aria-haspopup="dialog" onClick={() => { releaseVideoInput(); setDraftQuality(quality); setQualityOpen(true); }}><Sliders className="icon" /><span className="control-caption">Quality</span><span>{presetLabel}</span></button>
        <button className="fullscreen-trigger" ref={fullscreenButtonRef} disabled={viewPending || (viewMode === 'normal' && status !== 'connected')} title={status !== 'connected' && viewMode === 'normal' ? 'Connect first to view the desktop fullscreen' : undefined} aria-pressed={viewMode !== 'normal'} onClick={() => void (viewMode === 'normal' ? enterViewing() : exitViewing())}><Expand className="icon" /><span>{viewPending ? 'Opening…' : viewMode === 'normal' ? 'Fullscreen' : 'Exit view'}</span></button>
        <button ref={clipboardButtonRef} disabled={status !== 'connected'} aria-expanded={clipboardOpen} onClick={() => { clearFn(); setMobileKeys(false); setMoreOpen(false); setClipboardOpen(!clipboardOpen); }}><TextIcon className="icon" /><span>Text</span></button>
        <button ref={keyboardButtonRef} className="mobile-keyboard" disabled={status !== 'connected'} aria-expanded={mobileKeys} onClick={() => { clearFn(); flushSync(() => { setClipboardOpen(false); setMoreOpen(false); setMobileKeys(true); }); inputRef.current?.focus({ preventScroll: true }); }}><Keyboard className="icon" /><span>Keyboard</span></button>
        {nerdStatsAllowed && <button className="stats-trigger" aria-pressed={statsOpen} onClick={() => setStatsOpen(!statsOpen)}><Chart className="icon" /><span>Stats</span></button>}
        <button ref={moreButtonRef} aria-expanded={moreOpen} aria-controls="more-controls" onClick={() => setMoreOpen(!moreOpen)}><Dots className="icon" /><span>More</span></button>
      </div>
      <div id="more-controls" className="more-controls" hidden={!moreOpen && !mobileKeys}>
      <div className="toolbar-group secondary-controls" hidden={!moreOpen}>
        <label className="quality-label">View <select aria-label="Video sizing" value={videoFill ? 'fill' : 'fit'} onChange={(event) => { releaseVideoInput(); setVideoFill(event.target.value === 'fill'); }}><option value="fit">Fit — full frame</option><option value="fill">Fill — crop</option></select></label>
        {viewMode !== 'normal' && <button disabled={status === 'idle'} onClick={disconnect}>Disconnect</button>}
        <button onClick={signOut}><LogOut className="icon" />Sign out</button>
        <span className="transport-note"><Shield className="icon" />{secure ? 'HTTPS connection.' : 'HTTP connection — use a trusted VPN or switch to HTTPS.'} Keep port 8787 private. No audio is transmitted.</span>
      </div>
      <div className="toolbar-group keys" aria-label="Remote keys">
        {hostPlatform === 'darwin' && <button disabled={status !== 'connected'} aria-label="Fn (next key)" aria-pressed={fnArmed} className={fnArmed ? 'selected' : ''} onPointerDown={(event) => { if (mobileKeys) event.preventDefault(); }} onClick={() => { toggleFn(); if (!mobileKeys) (videoPlayback === 'mse' ? mediaRef.current : canvasRef.current)?.focus({ preventScroll: true }); }}>Fn</button>}
        {(Object.keys(videoModifierCodes) as ModifierKey[]).map((name) => <button disabled={status !== 'connected'} aria-label={name === 'Command' && hostPlatform === 'win32' ? 'Windows' : name} aria-pressed={modifiers.includes(name)} className={modifiers.includes(name) ? 'selected' : ''} onPointerDown={(event) => { if (mobileKeys) event.preventDefault(); }} onClick={() => toggleModifier(name)} key={name}>{name === 'Command' ? hostPlatform === 'win32' ? 'Win' : '⌘' : name === 'Option' ? '⌥' : name === 'Control' ? '⌃' : '⇧'}</button>)}
        {(['Escape', 'Tab', 'Return', 'Backspace'] as const).map((name) => <button disabled={status !== 'connected'} aria-label={name} onPointerDown={(event) => { if (mobileKeys) event.preventDefault(); }} onClick={() => sendKey(name)} key={name}>{name === 'Escape' ? 'Esc' : name === 'Return' ? '↵' : name === 'Backspace' ? '⌫' : 'Tab'}</button>)}
      </div>
      </div>
    </nav>
    <dialog ref={qualityDialogRef} className="quality-dialog" aria-labelledby="quality-title" aria-describedby="quality-description" onCancel={(event) => { event.preventDefault(); setQualityOpen(false); }}>
      <form onSubmit={(event) => { event.preventDefault(); changeQuality(draftQuality); setQualityOpen(false); }}>
        <p className="eyebrow">&gt; settings</p>
        <h2 id="quality-title">Stream quality</h2>
        <p id="quality-description" className="subtle">Clarity or motion. Choose what fits your work and your connection.</p>
        <fieldset className="quality-options"><legend className="quality-legend">Resolution</legend>
          {resolutions.map((item) => <label key={item.value} className={`quality-option ${draft.resolution === item.value ? 'selected' : ''}`}>
            <input type="radio" name="resolution" value={item.value} checked={draft.resolution === item.value} onChange={() => pickResolution(item.value)} />
            <span><strong>{item.label}</strong>{item.value === '2160p' && <span className="recommendation">GPU</span>}<small>{item.detail} · {item.fps.join(' / ')} fps</small></span>
          </label>)}
        </fieldset>
        <fieldset className="fps-options"><legend className="quality-legend">Frame rate</legend>
          {draftResolution.fps.map((fps) => <label key={fps} className={`fps-option ${draft.fps === fps ? 'selected' : ''}`}>
            <input type="radio" name="fps" value={fps} checked={draft.fps === fps} onChange={() => setDraftQuality(`${draft.resolution}${fps}` as Quality)} />
            <span>{fps} fps</span>
          </label>)}
        </fieldset>
        <p className="quality-note">{qualityLabel(draftQuality)} · {qualityBitrate[draftQuality]} target. Never upscaled beyond your display; rates are targets, not guarantees. 4K60 needs a GPU encoder on Windows and may fall back to a lower rate on older Macs. No audio is transmitted.</p>
        <div className="advanced">
          <p className="eyebrow">&gt; advanced</p>
          <label className="switch-row"><span><strong>Stats for nerds</strong><small>Live codec, bitrate, frame rate, round-trip time and buffer telemetry. Off by default; saved only in this browser.</small></span>
            <input type="checkbox" role="switch" className="switch" checked={nerdStatsAllowed} onChange={(event) => allowNerdStats(event.target.checked)} /></label>
        </div>
        <p className="security-note"><strong>Public Wi-Fi safety</strong><br />Use HTTPS or a trusted VPN on untrusted networks. Never expose port 8787 publicly.</p>
        <p className="quality-note" role="status">{draftQuality === quality ? 'Current setting — no changes.' : status === 'connected' || status === 'connecting' ? 'Apply will reconnect the stream once.' : 'Apply saves this setting for your next connection.'}</p>
        <div className="sheet-actions"><button type="button" onClick={() => setQualityOpen(false)}>{draftQuality === quality ? 'Done' : 'Cancel'}</button><button type="submit" className="primary" disabled={draftQuality === quality}>Apply</button></div>
      </form>
    </dialog>
    <div className={`keyboard-entry ${mobileKeys ? 'open' : ''}`}>
      <label htmlFor="remote-input">Type on remote desktop</label>
      <input id="remote-input" ref={inputRef} className="mobile-input" disabled={status !== 'connected'} tabIndex={mobileKeys ? 0 : -1} aria-label="Type on remote desktop" placeholder="Type here…" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onCompositionStart={() => { composing.current = true; clearFn(); }}
        onCompositionEnd={(event) => { composing.current = false; clearFn(); for (const char of event.currentTarget.value) sendCharacter(char); event.currentTarget.value = ''; }}
        onInput={(event) => { if (composing.current || (event.nativeEvent as InputEvent).isComposing) return; for (const char of event.currentTarget.value) sendCharacter(char); event.currentTarget.value = ''; }}
        onKeyDown={(event) => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Backspace' || event.key === 'Enter') { event.preventDefault(); sendKey(event.key === 'Backspace' ? 'Backspace' : 'Return', false); } }} />
      <button onClick={() => { inputRef.current?.blur(); setMobileKeys(false); keyboardButtonRef.current?.focus({ preventScroll: true }); }}>Done</button>
    </div>
    <p className="gesture-help">Touch: tap to click · slide to drag · two fingers to scroll · two-finger tap to right-click</p>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
