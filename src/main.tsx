import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import RFB from '@novnc/novnc';
import { VideoClient } from './video';
import './style.css';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected';
type Credentials = { username: string; password: string; needsUsername: boolean };
type Quality = 'data' | 'balanced' | 'high';

const modifierKeys = { Command: 0xffe7, Control: 0xffe3, Option: 0xffe9, Shift: 0xffe1 } as const;
const specialKeys = { Escape: 0xff1b, Tab: 0xff09, Return: 0xff0d, Backspace: 0xff08, Delete: 0xffff, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54 } as const;
const videoSpecialCodes: Record<keyof typeof specialKeys, string> = { Escape: 'Escape', Tab: 'Tab', Return: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Left: 'ArrowLeft', Up: 'ArrowUp', Right: 'ArrowRight', Down: 'ArrowDown' };
const videoModifierCodes: Record<keyof typeof modifierKeys, string> = { Command: 'MetaLeft', Control: 'ControlLeft', Option: 'AltLeft', Shift: 'ShiftLeft' };

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
  const [quality, setQuality] = useState<Quality>(() => {
    try {
      const value = localStorage.getItem('remotecontrol-quality');
      return value === 'data' || value === 'high' ? value : 'balanced';
    } catch { return 'balanced'; }
  });
  const [activeCodec, setActiveCodec] = useState('');
  const [modifiers, setModifiers] = useState<string[]>([]);
  const [mobileKeys, setMobileKeys] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<VideoClient | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const intentional = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const noRetry = useRef(false);
  const cachedCredentials = useRef<{ username: string; password: string } | null>(null);
  const pressedKeys = useRef(new Set<string>());
  const pressedButton = useRef<'left' | 'right' | null>(null);

  useEffect(() => {
    api('session').then((result) => {
      setAuthenticated(result.authenticated);
      setConfigured(result.configured);
    }).catch(() => setAuthError('Cannot reach the service.')).finally(() => setLoading(false));
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current); rfbRef.current?.disconnect(); videoRef.current?.close(); };
  }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    try {
      await api('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      setPassword('');
      setAuthenticated(true);
    } catch (error) { setAuthError((error as Error).message); }
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
    viewerRef.current.replaceChildren();
    setStatus('connecting');
    setMessage('Connecting to your Mac…');
    setCredentials(null);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(viewerRef.current, `${protocol}//${location.host}/ws`, { shared: true });
    rfbRef.current = rfb;
    rfb.scaleViewport = fit;
    rfb.clipViewport = true;
    rfb.qualityLevel = quality === 'data' ? 3 : quality === 'high' ? 9 : 6;
    rfb.compressionLevel = quality === 'data' ? 7 : quality === 'high' ? 2 : 4;
    rfb.background = '#111827';
    rfb.addEventListener('connect', () => { retryCount.current = 0; setStatus('connected'); setMessage(''); rfb.focus(); });
    rfb.addEventListener('credentialsrequired', (event) => {
      const types = (event as CustomEvent<{ types: string[] }>).detail.types;
      if (cachedCredentials.current) {
        rfb.sendCredentials(cachedCredentials.current);
        return;
      }
      setCredentials({ username: '', password: '', needsUsername: types.includes('username') });
      setMessage('Enter your Mac Screen Sharing credentials.');
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
        setStatus('disconnected');
        const clean = (event as CustomEvent<{ clean: boolean }>).detail.clean;
        setMessage((previous) => previous && !clean ? previous : 'Connection ended. Check that Screen Sharing is enabled, then reconnect.');
        if (!noRetry.current && retryCount.current < 3) {
          const delay = 1000 * 2 ** retryCount.current++;
          retryTimer.current = setTimeout(() => connectVnc(true), delay);
        }
      }
    });
  }

  function connectVideo(selectedQuality: Quality = quality, retrying = false, forcedCodec?: 'h264') {
    if (!canvasRef.current) return;
    intentional.current = false;
    if (!retrying) { retryCount.current = 0; noRetry.current = false; }
    if (retryTimer.current) clearTimeout(retryTimer.current);
    videoRef.current?.close();
    setStatus('connecting');
    setActiveCodec('');
    setMessage('Starting the video stream…');
    const client = new VideoClient(canvasRef.current, (codec) => {
      if (videoRef.current !== client) return;
      retryCount.current = 0;
      setActiveCodec(codec === 'hevc' ? 'HEVC' : 'H.264');
      setStatus('connected');
      setMessage('');
      canvasRef.current?.focus();
    }, (error) => {
      if (videoRef.current !== client) return;
      if (error === 'Video connection failed.') { setMessage(error); return; }
      if (client.activeCodec === 'hevc' && /decod|encod/i.test(error)) {
        client.close();
        videoRef.current = null;
        connectVideo(selectedQuality, false, 'h264');
        return;
      }
      noRetry.current = true;
      client.close();
      videoRef.current = null;
      setStatus('disconnected');
      setMessage(error);
    }, () => {
      if (videoRef.current !== client || intentional.current) return;
      videoRef.current = null;
      setStatus('disconnected');
      setMessage((previous) => previous || 'Video connection ended.');
      if (!noRetry.current && retryCount.current < 3) {
        const delay = 1000 * 2 ** retryCount.current++;
        retryTimer.current = setTimeout(() => connectVideo(selectedQuality, true, forcedCodec), delay);
      }
    });
    videoRef.current = client;
    void client.connect(selectedQuality, forcedCodec).catch((error) => {
      if (videoRef.current !== client) return;
      noRetry.current = true;
      setStatus('disconnected');
      setMessage((error as Error).message);
    });
  }

  function connect() { if (mode === 'video') connectVideo(); else connectVnc(); }

  function changeQuality(value: Quality) {
    setQuality(value);
    try { localStorage.setItem('remotecontrol-quality', value); } catch { /* preference is optional */ }
    if (mode === 'video' && (status === 'connected' || status === 'connecting')) connectVideo(value);
    if (mode === 'vnc' && rfbRef.current) {
      const settings = value === 'data' ? [3, 7] : value === 'high' ? [9, 2] : [6, 4];
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
    setMessage('Authenticating with Screen Sharing…');
  }

  function sendKey(name: keyof typeof specialKeys) {
    if (mode === 'video') {
      for (const modifier of modifiers) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as keyof typeof modifierKeys], down: true });
      videoRef.current?.sendInput({ type: 'key', code: videoSpecialCodes[name], down: true });
      videoRef.current?.sendInput({ type: 'key', code: videoSpecialCodes[name], down: false });
      for (const modifier of [...modifiers].reverse()) videoRef.current?.sendInput({ type: 'key', code: videoModifierCodes[modifier as keyof typeof modifierKeys], down: false });
      setModifiers([]);
      canvasRef.current?.focus();
      return;
    }
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const modifier of modifiers) rfb.sendKey(modifierKeys[modifier as keyof typeof modifierKeys], null, true);
    rfb.sendKey(specialKeys[name], null);
    for (const modifier of [...modifiers].reverse()) rfb.sendKey(modifierKeys[modifier as keyof typeof modifierKeys], null, false);
    setModifiers([]);
    rfb.focus();
  }

  function sendCharacter(character: string) {
    if (mode === 'video') { videoRef.current?.sendInput({ type: 'text', text: character }); return; }
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

  function videoPosition(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const imageRatio = event.currentTarget.width / event.currentTarget.height;
    const boxRatio = rect.width / rect.height;
    const shownWidth = boxRatio > imageRatio ? rect.height * imageRatio : rect.width;
    const shownHeight = boxRatio > imageRatio ? rect.height : rect.width / imageRatio;
    const x = (event.clientX - rect.left - (rect.width - shownWidth) / 2) / shownWidth;
    const y = (event.clientY - rect.top - (rect.height - shownHeight) / 2) / shownHeight;
    videoRef.current?.sendInput({ type: 'move', x, y });
  }

  function releaseVideoInput() {
    for (const code of pressedKeys.current) videoRef.current?.sendInput({ type: 'key', code, down: false });
    pressedKeys.current.clear();
    if (pressedButton.current) videoRef.current?.sendInput({ type: 'button', button: pressedButton.current, down: false });
    pressedButton.current = null;
  }

  function videoKey(event: React.KeyboardEvent<HTMLCanvasElement>, down: boolean) {
    event.preventDefault();
    if (down) {
      if (pressedKeys.current.has(event.code)) return;
      pressedKeys.current.add(event.code);
    } else {
      pressedKeys.current.delete(event.code);
    }
    videoRef.current?.sendInput({ type: 'key', code: event.code, down });
  }

  if (loading) return <main className="landing"><div className="card">Loading Remote Control…</div></main>;
  if (!authenticated) return <main className="landing"><section className="card login-card">
    <div className="mark">⌘</div><p className="eyebrow">YOUR MAC, ANYWHERE</p><h1>Remote Control</h1>
    <p className="subtle">Sign in to open your Mac desktop.</p>
    {!configured ? <div className="notice">Owner setup is required. Run <code>pnpm setup</code> on the Mac mini.</div> :
      <form onSubmit={signIn}><label htmlFor="password">Owner password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button className="primary" type="submit">Sign in</button></form>}
    {authError && <p className="error" role="alert">{authError}</p>}
  </section></main>;

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-icon">⌘</span><span>Remote Control</span></div><div className="top-actions"><span className={`status-dot ${status}`} /><span className="status-text">{status === 'connected' ? `Connected · ${activeCodec || 'VNC'}` : status === 'connecting' ? 'Connecting' : 'Offline'}</span><button className="ghost" onClick={signOut}>Sign out</button></div></header>
    <section className="stage">
      <div className="viewer" aria-label="Remote Mac desktop">
        <div ref={viewerRef} className="vnc-viewer" style={{ display: mode === 'vnc' ? 'block' : 'none' }} />
        <canvas ref={canvasRef} className="video-canvas" style={{ display: mode === 'video' ? 'block' : 'none' }} tabIndex={0}
          onPointerMove={(event) => { if (mode === 'video' && status === 'connected') videoPosition(event); }}
          onPointerDown={(event) => { if (mode !== 'video' || status !== 'connected') return; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); videoPosition(event); const button = event.button === 2 ? 'right' : 'left'; pressedButton.current = button; videoRef.current?.sendInput({ type: 'button', button, down: true }); }}
          onPointerUp={() => { if (pressedButton.current) videoRef.current?.sendInput({ type: 'button', button: pressedButton.current, down: false }); pressedButton.current = null; }}
          onPointerCancel={releaseVideoInput}
          onWheel={(event) => { if (mode === 'video') { event.preventDefault(); videoRef.current?.sendInput({ type: 'wheel', dy: event.deltaY }); } }}
          onKeyDown={(event) => { if (mode === 'video') videoKey(event, true); }}
          onKeyUp={(event) => { if (mode === 'video') videoKey(event, false); }}
          onBlur={releaseVideoInput}
          onContextMenu={(event) => event.preventDefault()} />
      </div>
      {status !== 'connected' && <div className="stage-overlay"><div className="connect-card"><div className="desktop-icon">▣</div><h2>{status === 'connecting' ? 'Connecting to your Mac' : status === 'disconnected' ? 'Connection ended' : 'Connect to your Mac'}</h2><p>{message || 'Open your Mac desktop from this browser.'}</p>{status !== 'connecting' && <button className="primary" onClick={connect}>{status === 'disconnected' ? 'Reconnect' : 'Connect to Mac'}</button>}{status !== 'connecting' && <button className="fallback-link" onClick={() => switchMode(mode === 'video' ? 'vnc' : 'video')}>{mode === 'video' ? 'Use VNC fallback' : 'Use video stream'}</button>}</div></div>}
      {credentials && <div className="modal-backdrop"><form className="modal" onSubmit={submitCredentials}><h2>Mac Screen Sharing</h2><p>Enter the credentials configured in macOS Sharing. They are sent directly to your Mac and are not saved.</p>{credentials.needsUsername && <><label htmlFor="vnc-username">Mac username</label><input id="vnc-username" autoComplete="username" value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} required /></>}<label htmlFor="vnc-password">Screen Sharing password</label><input id="vnc-password" type="password" autoComplete="off" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} required autoFocus /><button className="primary" type="submit">Continue</button></form></div>}
      {clipboardOpen && <div className="clipboard-panel"><div className="panel-heading"><strong>Send text</strong><button className="icon-button" onClick={() => setClipboardOpen(false)} aria-label="Close clipboard">×</button></div><textarea value={clipboard} onChange={(event) => setClipboard(event.target.value)} placeholder="Paste text here" /><button onClick={() => { if (mode === 'video') for (const char of clipboard) sendCharacter(char); else rfbRef.current?.clipboardPasteFrom(clipboard); setClipboardOpen(false); }}>Send to Mac</button></div>}
    </section>
    <nav className="toolbar" aria-label="Remote controls"><div className="toolbar-group"><label className="quality-label">Quality <select aria-label="Stream quality" value={quality} onChange={(event) => changeQuality(event.target.value as Quality)}><option value="data">Data saver</option><option value="balanced">Balanced</option><option value="high">High</option></select></label>{mode === 'vnc' && <button onClick={() => { setFit(!fit); if (rfbRef.current) rfbRef.current.scaleViewport = !fit; }}>{fit ? 'Actual size' : 'Fit screen'}</button>}<button onClick={() => setClipboardOpen(!clipboardOpen)}>Text</button><button className="mobile-keyboard" onClick={() => { setMobileKeys(true); inputRef.current?.focus(); }}>Keyboard</button></div><div className="toolbar-group keys">{Object.keys(modifierKeys).map((name) => <button className={modifiers.includes(name) ? 'selected' : ''} onClick={() => toggleModifier(name)} key={name}>{name === 'Command' ? '⌘' : name === 'Option' ? '⌥' : name === 'Control' ? '⌃' : '⇧'}</button>)}{(['Escape', 'Tab', 'Return', 'Backspace'] as const).map((name) => <button onClick={() => sendKey(name)} key={name}>{name === 'Escape' ? 'Esc' : name === 'Return' ? '↵' : name === 'Backspace' ? '⌫' : 'Tab'}</button>)}</div><div className="toolbar-group"><button className="danger" onClick={disconnect}>Disconnect</button></div></nav>
    <input ref={inputRef} className="mobile-input" aria-label="Type on Mac" autoComplete="off" autoCorrect="off" autoCapitalize="off" onInput={(event) => { const value = event.currentTarget.value; for (const char of value) sendCharacter(char); event.currentTarget.value = ''; }} onKeyDown={(event) => { if (event.key === 'Backspace') { event.preventDefault(); sendKey('Backspace'); } else if (event.key === 'Enter') { event.preventDefault(); sendKey('Return'); } }} onBlur={() => setMobileKeys(false)} />
    {mobileKeys && <span className="keyboard-hint">Typing on Mac · tap outside to close</span>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
