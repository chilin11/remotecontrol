import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import RFB from '@novnc/novnc';
import { VideoClient } from './video';
import './style.css';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected';
type Credentials = { username: string; password: string; needsUsername: boolean };
type Quality = 'data' | 'balanced24' | 'balanced' | 'high15' | 'high';
const qualityPresets: { value: Quality; label: string; detail: string }[] = [
  { value: 'data', label: 'Data saver', detail: '1280px · 24 fps · ~1.5 Mbps target on Mac' },
  { value: 'balanced24', label: 'Balanced · 24 fps', detail: 'Mac: 2560px · 24 fps · ~5 Mbps target; Windows: 1920px · 24 fps' },
  { value: 'balanced', label: 'Balanced · 30 fps', detail: 'Mac: 2560px · 30 fps · ~6 Mbps target; Windows: 1920px · 30 fps' },
  { value: 'high15', label: 'High · 15 fps', detail: 'Static work · Mac: 3840px · 15 fps · ~8 Mbps target; Windows: 2560px · 15 fps · variable bitrate' },
  { value: 'high', label: 'High', detail: 'Mac: 3840px · 30 fps · ~14 Mbps target; Windows: 2560px · 60 fps' },
];
const lowQuality = (value: Quality) => value === 'data';

const modifierKeys = { Command: 0xffe7, Control: 0xffe3, Option: 0xffe9, Shift: 0xffe1 } as const;
const specialKeys = { Escape: 0xff1b, Tab: 0xff09, Return: 0xff0d, Backspace: 0xff08, Delete: 0xffff, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54 } as const;
const videoSpecialCodes: Record<keyof typeof specialKeys, string> = { Escape: 'Escape', Tab: 'Tab', Return: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Left: 'ArrowLeft', Up: 'ArrowUp', Right: 'ArrowRight', Down: 'ArrowDown' };
const videoModifierCodes: Record<keyof typeof modifierKeys, string> = { Command: 'MetaLeft', Control: 'ControlLeft', Option: 'AltLeft', Shift: 'ShiftLeft' };
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
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [clipboard, setClipboard] = useState('');
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [fit, setFit] = useState(true);
  const [mode, setMode] = useState<'video' | 'vnc'>('video');
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
      const value = localStorage.getItem('remotecontrol-quality');
      return value === 'minimal' || value === 'low' || value === 'hotel' ? 'data' : qualityPresets.some((preset) => preset.value === value) ? value as Quality : 'balanced';
    } catch { return 'balanced'; }
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
  const viewerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<VideoClient | null>(null);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const [videoPlayback, setVideoPlayback] = useState<'canvas' | 'mse'>('canvas');
  const inputRef = useRef<HTMLInputElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const intentional = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const connectedAt = useRef(0);
  const noRetry = useRef(false);
  const hevcFallbackReason = useRef('');
  const cachedCredentials = useRef<{ username: string; password: string } | null>(null);
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
    if (mode !== 'video' || !authenticated || status === 'idle') void exitViewing();
  }, [mode, authenticated, status]);

  useEffect(() => {
    if (mode !== 'video' || status !== 'connected') return;
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
  }, [mode, status, videoFill]);

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
  }, [authenticated, loading, mode, modifiers, status, mobileKeys]);

  useEffect(() => {
    if (mode !== 'video' || status !== 'connected') { fnArmedRef.current = false; fnKeyCode.current = null; setFnArmed(false); }
  }, [mode, status]);

  useEffect(() => {
    if (status !== 'connected') { releaseVideoInput(); setMobileKeys(false); setClipboardOpen(false); }
  }, [status]);

  useEffect(() => {
    api('session').then((result) => {
      setAuthenticated(result.authenticated);
      setConfigured(result.configured);
      setHostPlatform(result.platform || '');
      const canStreamVideo = result.nativeVideo !== false;
      setNativeVideo(canStreamVideo);
      if (!canStreamVideo) setMode('vnc');
      setHevcVideo(result.hevcVideo === true);
      setHevcMseVideo(result.hevcMseVideo === true);
      if (result.hevcCodecString === 'hvc1.1.6.L150.90' || result.hevcCodecString === 'hvc1.1.6.L150.B0') setHevcCodecString(result.hevcCodecString);
    }).catch(() => setAuthError('Cannot reach the service.')).finally(() => setLoading(false));
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); rfbRef.current?.disconnect(); videoRef.current?.close(); };
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
      const canStreamVideo = session.nativeVideo === true;
      setNativeVideo(canStreamVideo);
      if (!canStreamVideo) setMode('vnc');
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
    cachedCredentials.current = null;
    releaseVideoInput();
    rfbRef.current?.disconnect();
    videoRef.current?.close();
    videoRef.current = null;
    rfbRef.current = null;
    await api('logout', { method: 'POST' }).catch(() => undefined);
    setAuthenticated(false);
    setStatus('idle');
    setCredentials(null);
  }

  function connectVnc(retrying = false) {
    if (!viewerRef.current) return;
    intentional.current = false;
    if (!retrying) { retryCount.current = 0; noRetry.current = false; }
    if (retryTimer.current) clearTimeout(retryTimer.current);
    rfbRef.current?.disconnect();
    connectedAt.current = 0;
    viewerRef.current.replaceChildren();
    setStatus('connecting');
    setMessage('Connecting to your VNC server…');
    setCredentials(null);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(viewerRef.current, `${protocol}//${location.host}/ws`, { shared: true });
    rfbRef.current = rfb;
    rfb.scaleViewport = fit;
    rfb.clipViewport = true;
    rfb.qualityLevel = lowQuality(qualityRef.current) ? 3 : qualityRef.current === 'high' || qualityRef.current === 'high15' ? 9 : 6;
    rfb.compressionLevel = lowQuality(qualityRef.current) ? 7 : qualityRef.current === 'high' || qualityRef.current === 'high15' ? 2 : 4;
    rfb.background = '#111827';
    rfb.addEventListener('connect', () => { if (rfbRef.current !== rfb) return; connectedAt.current = Date.now(); setStatus('connected'); setMessage(''); rfb.focus(); });
    rfb.addEventListener('credentialsrequired', (event) => {
      const types = (event as CustomEvent<{ types: string[] }>).detail.types;
      if (cachedCredentials.current) {
        rfb.sendCredentials(cachedCredentials.current);
        return;
      }
      setCredentials({ username: '', password: '', needsUsername: types.includes('username') });
      setMessage('Enter the credentials configured on the VNC server.');
    });
    rfb.addEventListener('securityfailure', (event) => {
      noRetry.current = true;
      cachedCredentials.current = null;
      const reason = (event as CustomEvent<{ reason?: string }>).detail.reason;
      setMessage(reason || 'Screen Sharing rejected the credentials.');
    });
    rfb.addEventListener('clipboard', (event) => {
      setClipboard((event as CustomEvent<{ text: string }>).detail.text);
    });
    rfb.addEventListener('disconnect', (event) => {
      if (rfbRef.current !== rfb) return;
      rfbRef.current = null;
      setCredentials(null);
      if (!intentional.current) {
        if (connectedAt.current && Date.now() - connectedAt.current >= 30_000) retryCount.current = 0;
        connectedAt.current = 0;
        setStatus('disconnected');
        const clean = (event as CustomEvent<{ clean: boolean }>).detail.clean;
        setMessage((previous) => previous && !clean ? previous : 'Connection ended. Check that the VNC server is running, then reconnect.');
        if (!noRetry.current && retryCount.current < 3) {
          const delay = 1000 * 2 ** retryCount.current++;
          retryTimer.current = setTimeout(() => connectVnc(true), delay);
        }
      }
    });
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
    }, (code) => {
      if (videoRef.current !== client || intentional.current) return;
      client.close();
      videoRef.current = null;
      // First frames do not prove stability: short-lived connections keep their retry budget.
      if (connectedAt.current && Date.now() - connectedAt.current >= 30_000) retryCount.current = 0;
      connectedAt.current = 0;
      setStatus('disconnected');
      if (code === 4000 || code === 4001) {
        noRetry.current = true;
        setMessage(code === 4000 ? 'Another session took control of this stream.' : 'Your session expired or was signed out.');
        return;
      }
      setMessage((previous) => previous || 'Video connection ended.');
      if (!noRetry.current && retryCount.current < 3) {
        const delay = 1000 * 2 ** retryCount.current++;
        retryTimer.current = setTimeout(() => connectVideo(qualityRef.current, true, forcedCodec), delay);
      }
    }, mediaRef.current);
    videoRef.current = client;
    void client.connect(selectedQuality, forcedCodec ?? (hevcVideo ? undefined : 'h264'), hevcCodecString, hevcMseVideo).catch((error) => {
      if (videoRef.current !== client) return;
      client.close();
      videoRef.current = null;
      noRetry.current = true;
      setStatus('disconnected');
      setMessage((error as Error).message);
    });
  }

  function connect() { if (mode === 'video') connectVideo(); else connectVnc(); }

  function changeQuality(value: Quality) {
    if (value === quality) return;
    qualityRef.current = value;
    setQuality(value);
    try { localStorage.setItem('remotecontrol-quality', value); } catch { /* preference is optional */ }
    if (mode === 'video' && (status === 'connected' || status === 'connecting')) connectVideo(value);
    if (mode === 'vnc' && rfbRef.current) {
      const settings = lowQuality(value) ? [3, 7] : value === 'high' || value === 'high15' ? [9, 2] : [6, 4];
      rfbRef.current.qualityLevel = settings[0];
      rfbRef.current.compressionLevel = settings[1];
    }
  }

  function switchMode(next: 'video' | 'vnc') {
    if (next === mode) return;
    disconnect();
    setMode(next);
    setMessage('');
  }

  function disconnect() {
    intentional.current = true;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    cachedCredentials.current = null;
    releaseVideoInput();
    rfbRef.current?.disconnect();
    videoRef.current?.close();
    videoRef.current = null;
    rfbRef.current = null;
    setStatus('idle');
    setActiveCodec('');
    setCredentials(null);
    setModifiers([]);
  }

  function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (!credentials || !rfbRef.current) return;
    cachedCredentials.current = { username: credentials.username, password: credentials.password };
    rfbRef.current.sendCredentials(cachedCredentials.current);
    setCredentials(null);
    setMessage('Authenticating with the VNC server…');
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
    const active = fnArmedRef.current && mode === 'video' && hostPlatform === 'darwin';
    if (active) clearFn();
    return active;
  }
  function sendKey(name: keyof typeof specialKeys, focusDesktop = true) {
    if (status !== 'connected') return;
    if (mode === 'video') {
      const fn = consumeFn();
      for (const modifier of modifiers) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as keyof typeof modifierKeys], down: true });
      videoRef.current?.sendInput({ type: 'key', code: videoSpecialCodes[name], down: true, ...(fn ? { fn: true } : {}) });
      videoRef.current?.sendInput({ type: 'key', code: videoSpecialCodes[name], down: false, ...(fn ? { fn: true } : {}) });
      for (const modifier of [...modifiers].reverse()) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as keyof typeof modifierKeys], down: false });
      setModifiers([]);
      if (focusDesktop && !mobileKeys) (videoPlayback === 'mse' ? mediaRef.current : canvasRef.current)?.focus({ preventScroll: true });
      return;
    }
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const modifier of modifiers) rfb.sendKey(modifierKeys[modifier as keyof typeof modifierKeys], null, true);
    rfb.sendKey(specialKeys[name], null);
    for (const modifier of [...modifiers].reverse()) rfb.sendKey(modifierKeys[modifier as keyof typeof modifierKeys], null, false);
    setModifiers([]);
    if (focusDesktop && !mobileKeys) rfb.focus();
  }

  function sendCharacter(character: string) {
    if (status !== 'connected') return;
    if (mode === 'video') {
      const code = /^[a-z]$/i.test(character) ? `Key${character.toUpperCase()}` : /^[0-9]$/.test(character) ? `Digit${character}` : null;
      if ((modifiers.length || fnArmedRef.current) && code) {
        const fn = consumeFn();
        for (const modifier of modifiers) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as keyof typeof modifierKeys], down: true });
        videoRef.current?.sendInput({ type: 'key', code, down: true, ...(fn ? { fn: true } : {}) });
        videoRef.current?.sendInput({ type: 'key', code, down: false, ...(fn ? { fn: true } : {}) });
        for (const modifier of [...modifiers].reverse()) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as keyof typeof modifierKeys], down: false });
        setModifiers([]);
      } else {
        if (fnArmedRef.current) clearFn(); // IME commits must not leave Fn armed for a later f.
        videoRef.current?.sendInput({ type: 'text', text: character });
        if (modifiers.length) setModifiers([]);
      }
      return;
    }
    const code = character.codePointAt(0);
    if (code === undefined || !rfbRef.current) return;
    const keysym = code > 0xff ? code + 0x01000000 : code;
    for (const modifier of modifiers) rfbRef.current.sendKey(modifierKeys[modifier as keyof typeof modifierKeys], null, true);
    rfbRef.current.sendKey(keysym, null);
    for (const modifier of [...modifiers].reverse()) rfbRef.current.sendKey(modifierKeys[modifier as keyof typeof modifierKeys], null, false);
    setModifiers([]);
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
    if (mode !== 'video' || status !== 'connected') return;
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
    if (mode !== 'video' || status !== 'connected') return;
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
    if (viewMode !== 'normal' && event.key === 'Tab') return; // Remote Tab remains available in the toolbar.
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

  if (loading) return <main className="landing"><div className="card loading-card" role="status"><span className="loading-indicator" />Opening Remote Control…</div></main>;
  if (!authenticated) return <main className="landing"><section className="card login-card">
    <div className="mark" aria-hidden="true">⌘</div><p className="eyebrow">YOUR DESKTOP, WITH YOU</p><h1>Remote Control</h1>
    <p className="subtle">A quiet place to get things done.<br />Sign in to access your computer.</p>
    {!configured ? <div className="notice">Owner setup is required. Run <code>pnpm run setup</code> on the host computer.</div> :
      <form onSubmit={signIn}><label htmlFor="password">Owner password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button className="primary" type="submit" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Sign in'}</button></form>}
    {authError && <p className="error" role="alert">{authError}</p>}
    <p className="login-safety">Use HTTPS or a trusted VPN. Keep port 8787 private.</p>
  </section></main>;
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
      <div className="brand"><span className="brand-icon" aria-hidden="true">⌘</span><div><span>Remote Control</span><small>Your personal workspace</small></div></div>
      <div className="top-actions"><span className="connection-status"><span className={`status-dot ${status}`} /><span className="status-text" role="status" title={status === 'connected' && activeCodec === 'H.264' && hevcMseVideo ? message : undefined}>{status === 'connected' ? `Connected · ${mode === 'vnc' ? 'VNC' : activeCodec || 'Video'}` : status === 'connecting' ? 'Connecting…' : status === 'disconnected' ? 'Disconnected' : 'Ready to connect'}</span></span>
        <button className={status === 'connected' || status === 'connecting' ? 'danger' : 'primary'} onClick={status === 'connected' || status === 'connecting' ? disconnect : connect}>{status === 'connecting' ? 'Cancel connection' : status === 'connected' ? 'Disconnect' : status === 'disconnected' ? 'Reconnect' : 'Connect'}</button>
      </div>
    </header>
    <section className="stage">
      <div className="viewer" aria-label="Remote desktop">
        <div ref={viewerRef} className="vnc-viewer" style={{ display: mode === 'vnc' ? 'block' : 'none' }} />
        <canvas ref={canvasRef} className="video-canvas" style={{ display: mode === 'video' && videoPlayback === 'canvas' ? 'block' : 'none' }} tabIndex={0}
          aria-label="Remote desktop video"
          onPointerMove={pointerMove} onPointerDown={pointerDown} onPointerUp={pointerUp}
          onPointerCancel={releaseVideoInput} onLostPointerCapture={(event) => { if (touches.current.has(event.pointerId) || pointerStartedHere.current) releaseVideoInput(); }}
          onKeyDown={(event) => { if (mode === 'video') videoKey(event, true); }}
          onKeyUp={(event) => { if (mode === 'video') videoKey(event, false); }}
          onBlur={releaseVideoInput}
          onContextMenu={(event) => event.preventDefault()} />
        <video ref={mediaRef} className="video-canvas" style={{ display: mode === 'video' && videoPlayback === 'mse' ? 'block' : 'none' }} tabIndex={0} muted playsInline
          aria-label="Remote desktop video"
          onPointerMove={pointerMove} onPointerDown={pointerDown} onPointerUp={pointerUp}
          onPointerCancel={releaseVideoInput} onLostPointerCapture={(event) => { if (touches.current.has(event.pointerId) || pointerStartedHere.current) releaseVideoInput(); }}
          onKeyDown={(event) => { if (mode === 'video') videoKey(event, true); }}
          onKeyUp={(event) => { if (mode === 'video') videoKey(event, false); }}
          onBlur={releaseVideoInput}
          onContextMenu={(event) => event.preventDefault()} />
      </div>
      {status !== 'connected' && <div className="stage-overlay"><div className={`connect-card ${status === 'connecting' ? 'is-connecting' : ''}`}><div className="desktop-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><rect x="5" y="7" width="38" height="27" rx="4" /><path d="M17 41h14M24 34v7M12 27h24" /></svg></div><p className="eyebrow">{status === 'connecting' ? 'ESTABLISHING SESSION' : status === 'disconnected' ? 'SESSION PAUSED' : 'YOUR WORKSPACE AWAITS'}</p><h2>{status === 'connecting' ? 'Getting you connected' : status === 'disconnected' ? 'Connection ended' : 'Right where you left off.'}</h2><p role="status">{message || 'Your computer, in this browser. Connect when you’re ready to pick things up.'}</p><div className="session-summary"><span>{mode === 'video' ? 'Video stream' : 'VNC fallback'}</span><span>{qualityPresets.find((preset) => preset.value === quality)?.label}</span></div>{status !== 'connecting' && <button className="primary" onClick={connect}>{status === 'disconnected' ? 'Reconnect to desktop' : 'Connect to desktop'}<span aria-hidden="true"> →</span></button>}{nativeVideo && status !== 'connecting' && <button className="fallback-link" onClick={() => switchMode(mode === 'video' ? 'vnc' : 'video')}>{mode === 'video' ? 'Use VNC fallback' : 'Use video stream'}</button>}<p className="connection-safety">Private access · Use HTTPS or a trusted VPN</p></div></div>}
      {credentials && <div className="modal-backdrop"><form className="modal" onSubmit={submitCredentials}><h2>VNC server authentication</h2><p>Enter the credentials configured on your VNC server. Kept only in this page's memory for reconnection, not saved to disk.</p>{credentials.needsUsername && <><label htmlFor="vnc-username">VNC username</label><input id="vnc-username" autoComplete="username" value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} required /></>}<label htmlFor="vnc-password">VNC password</label><input id="vnc-password" type="password" autoComplete="off" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} required autoFocus /><button className="primary" type="submit">Continue</button></form></div>}
    </section>
    {clipboardOpen && <section className="clipboard-panel" aria-labelledby="clipboard-title"><div className="panel-heading"><strong id="clipboard-title">Send text</strong><button className="icon-button" onClick={() => { setClipboardOpen(false); clipboardButtonRef.current?.focus({ preventScroll: true }); }} aria-label="Close clipboard">×</button></div><textarea aria-label="Text to send to desktop" autoFocus value={clipboard} onChange={(event) => setClipboard(event.target.value)} placeholder="Paste text here" /><button disabled={status !== 'connected' || !clipboard.trim()} onClick={() => { if (mode === 'video') void videoRef.current?.sendText(clipboard); else rfbRef.current?.clipboardPasteFrom(clipboard); setClipboardOpen(false); clipboardButtonRef.current?.focus({ preventScroll: true }); }}>Send to desktop</button></section>}
    <nav id="remote-controls" className="toolbar" aria-label="Remote controls">
      <div className="toolbar-group">
        <button className="quality-trigger" ref={qualityButtonRef} aria-haspopup="dialog" onClick={() => { releaseVideoInput(); setDraftQuality(quality); setQualityOpen(true); }}><span className="control-caption">Quality</span><span>{qualityPresets.find((preset) => preset.value === quality)?.label}</span><span className="control-chevron" aria-hidden="true">⌃</span></button>
        {mode === 'video' && <>
          <button className="fullscreen-trigger" ref={fullscreenButtonRef} disabled={viewPending} aria-pressed={viewMode !== 'normal'} onClick={() => void (viewMode === 'normal' ? enterViewing() : exitViewing())}>{viewPending ? 'Opening…' : viewMode === 'normal' ? 'Fullscreen' : 'Exit view'}</button>
        </>}
        <button ref={clipboardButtonRef} disabled={status !== 'connected'} aria-expanded={clipboardOpen} onClick={() => { clearFn(); setMobileKeys(false); setMoreOpen(false); setClipboardOpen(!clipboardOpen); }}>Text</button>
        <button ref={keyboardButtonRef} className="mobile-keyboard" disabled={status !== 'connected'} aria-expanded={mobileKeys} onClick={() => { clearFn(); flushSync(() => { setClipboardOpen(false); setMoreOpen(false); setMobileKeys(true); }); inputRef.current?.focus({ preventScroll: true }); }}>Keyboard</button>
        <button ref={moreButtonRef} aria-expanded={moreOpen} aria-controls="more-controls" onClick={() => setMoreOpen(!moreOpen)}>More {moreOpen ? '−' : '+'}</button>
      </div>
      <div id="more-controls" className="more-controls" hidden={!moreOpen && !mobileKeys}>
      <div className="toolbar-group secondary-controls" hidden={!moreOpen}>
        {mode === 'vnc' ? <button onClick={() => { setFit(!fit); if (rfbRef.current) rfbRef.current.scaleViewport = !fit; }}>{fit ? 'Actual size' : 'Fit screen'}</button> : <label className="quality-label">View <select aria-label="Video sizing" value={videoFill ? 'fill' : 'fit'} onChange={(event) => { releaseVideoInput(); setVideoFill(event.target.value === 'fill'); }}><option value="fit">Fit — full frame</option><option value="fill">Fill — crop</option></select></label>}
        {nativeVideo && <button onClick={() => switchMode(mode === 'video' ? 'vnc' : 'video')}>{mode === 'video' ? 'Use VNC fallback' : 'Use video stream'}</button>}
        {viewMode !== 'normal' && <button disabled={status === 'idle'} onClick={disconnect}>Disconnect</button>}
        <button onClick={signOut}>Sign out</button>
        <span className="audio-note">No audio is transmitted</span>
        <span className="transport-note">{location.protocol === 'https:' ? 'HTTPS connection' : 'HTTP connection — use a trusted VPN or switch to HTTPS.'} Keep port 8787 private.</span>
      </div>
      <div className="toolbar-group keys" aria-label="Remote keys">
        {mode === 'video' && hostPlatform === 'darwin' && <button disabled={status !== 'connected'} aria-label="Fn (next key)" aria-pressed={fnArmed} className={fnArmed ? 'selected' : ''} onPointerDown={(event) => { if (mobileKeys) event.preventDefault(); }} onClick={() => { toggleFn(); if (!mobileKeys) (videoPlayback === 'mse' ? mediaRef.current : canvasRef.current)?.focus({ preventScroll: true }); }}>Fn</button>}
        {Object.keys(modifierKeys).map((name) => <button disabled={status !== 'connected'} aria-label={name === 'Command' && !nativeVideo ? 'Windows' : name} aria-pressed={modifiers.includes(name)} className={modifiers.includes(name) ? 'selected' : ''} onPointerDown={(event) => { if (mobileKeys) event.preventDefault(); }} onClick={() => toggleModifier(name)} key={name}>{name === 'Command' ? nativeVideo ? '⌘' : 'Win' : name === 'Option' ? '⌥' : name === 'Control' ? '⌃' : '⇧'}</button>)}
        {(['Escape', 'Tab', 'Return', 'Backspace'] as const).map((name) => <button disabled={status !== 'connected'} aria-label={name} onPointerDown={(event) => { if (mobileKeys) event.preventDefault(); }} onClick={() => sendKey(name)} key={name}>{name === 'Escape' ? 'Esc' : name === 'Return' ? '↵' : name === 'Backspace' ? '⌫' : 'Tab'}</button>)}
      </div>
      </div>
    </nav>
    <dialog ref={qualityDialogRef} className="quality-dialog" aria-labelledby="quality-title" aria-describedby="quality-description" onCancel={(event) => { event.preventDefault(); setQualityOpen(false); }}>
      <form onSubmit={(event) => { event.preventDefault(); changeQuality(draftQuality); setQualityOpen(false); }}>
        <h2 id="quality-title">Stream quality</h2>
        <p id="quality-description" className="subtle">Clarity or motion. Choose what fits your work and your connection.</p>
        <fieldset className="quality-options"><legend className="sr-only">Quality preset</legend>
          {qualityPresets.map((preset) => <label key={preset.value} className={`quality-option ${draftQuality === preset.value ? 'selected' : ''}`}>
            <input type="radio" name="quality" value={preset.value} checked={draftQuality === preset.value} onChange={() => setDraftQuality(preset.value)} />
            <span><strong>{preset.label}</strong>{preset.value === 'high15' && <span className="recommendation">Static work</span>}<small>{mode === 'vnc' ? lowQuality(preset.value) ? 'VNC · Data saver compression' : preset.value === 'high' || preset.value === 'high15' ? 'VNC · High quality (no frame-rate effect)' : 'VNC · Balanced compression (no frame-rate effect)' : preset.detail}</small></span>
          </label>)}
        </fieldset>
        <p className="quality-note">{mode === 'video' ? 'Maximum width shown; actual size depends on your display. Rates are targets, not guarantees. Windows presets use variable bitrate.' : 'VNC uses its own display size and update rate; fps presets do not change VNC frame rate.'} No audio is transmitted.</p>
        <p className="security-note"><strong>Public Wi-Fi safety</strong><br />Use HTTPS or a trusted VPN on untrusted networks. Never expose port 8787 publicly.</p>
        <p className="quality-note" role="status">{draftQuality === quality ? 'Current setting — no changes.' : mode === 'video' && (status === 'connected' || status === 'connecting') ? 'Apply will reconnect the stream once.' : mode === 'vnc' && status === 'connected' ? 'Apply updates VNC quality without reconnecting.' : 'Apply saves this setting for your next connection.'}</p>
        <div className="sheet-actions"><button type="button" onClick={() => setQualityOpen(false)}>Cancel</button><button type="submit" className="primary" disabled={draftQuality === quality}>Apply</button></div>
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
    <p className="gesture-help">{mode === 'video' ? 'Touch: tap to click · slide to drag · two fingers to scroll · two-finger tap to right-click' : 'Touch: tap to click · long press to drag · two fingers to scroll / right-click'}</p>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
