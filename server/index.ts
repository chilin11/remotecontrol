import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '@node-rs/argon2';
import WebSocket, { WebSocketServer } from 'ws';
import { hasOwner, ownerHash, createSession, validSession, revokeSession } from './store.js';
import { gatewayHost, hostPlatform, lanUrls, nativeVideoAvailable, port } from './config.js';
import { attachVideo, stopAllCapture } from './video.js';

const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const server = http.createServer((req, res) => {
  void handleHttp(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    else res.destroy();
  });
});
const videoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2048 });
let videoController: { ws: WebSocket; token: string } | undefined;
const loginAttempts: number[] = [];

function cookie(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie || '';
  return raw.split(';').map((part) => part.trim()).find((part) => part.startsWith('rc_session='))?.slice('rc_session='.length);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return url.host === host && (url.protocol === 'https:' || url.protocol === 'http:');
  } catch { return false; }
}

function secureCookie(req: IncomingMessage): boolean {
  return req.headers.origin?.startsWith('https://') === true || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req: IncomingMessage, token: string, maxAge: number): string {
  return `rc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie(req) ? '; Secure' : ''}`;
}

function headers(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss: ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString();
    if (data.length > 4096) throw new Error('Request too large');
  }
  return JSON.parse(data || '{}') as unknown;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  headers(res);
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/session' && req.method === 'GET') {
      json(res, 200, { authenticated: validSession(cookie(req), true), configured: hasOwner(), controlling: !!videoController, platform: hostPlatform, nativeVideo: nativeVideoAvailable, hevcVideo: nativeVideoAvailable && (hostPlatform === 'darwin' || hostPlatform === 'win32'), hevcCodecString: hostPlatform === 'win32' ? 'hvc1.1.6.L150.90' : 'hvc1.1.6.L150.B0', hevcMseVideo: hostPlatform === 'win32' });
      return;
    }
    if (req.method !== 'POST' || !sameOrigin(req)) { json(res, 403, { error: 'Forbidden' }); return; }
    if (pathname === '/api/login') {
      const now = Date.now();
      while (loginAttempts[0] && now - loginAttempts[0] > 5 * 60_000) loginAttempts.shift();
      if (loginAttempts.length >= 10) {
        const waitMinutes = Math.max(1, Math.ceil((loginAttempts[0] + 5 * 60_000 - now) / 60_000));
        json(res, 429, { error: `Too many failed attempts. Try again in ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.` });
        return;
      }
      // Reserve the slot before the slow hash so parallel guesses still count.
      loginAttempts.push(now);
      let body: unknown;
      try { body = await readJson(req); } catch { json(res, 400, { error: 'Invalid request' }); return; }
      const password = (body as { password?: unknown })?.password;
      if (typeof password !== 'string' || password.length > 256) { json(res, 400, { error: 'Invalid request' }); return; }
      const hash = ownerHash();
      if (!hash) { json(res, 409, { error: 'No owner password is set yet. Set one on the host computer first.' }); return; }
      if (!(await verify(hash, password))) { json(res, 401, { error: 'Incorrect password' }); return; }
      // Successful sign-ins must not lock the owner out (e.g. several devices or re-logins).
      const slot = loginAttempts.lastIndexOf(now);
      if (slot >= 0) loginAttempts.splice(slot, 1);
      const token = createSession();
      res.setHeader('Set-Cookie', setCookie(req, token, 7 * 24 * 60 * 60));
      json(res, 200, { authenticated: true });
      return;
    }
    if (pathname === '/api/logout') {
      const token = cookie(req);
      revokeSession(token);
      if (videoController && videoController.token === token) videoController.ws.close(4001, 'Signed out');
      res.setHeader('Set-Cookie', setCookie(req, '', 0));
      json(res, 200, { authenticated: false });
      return;
    }
    json(res, 404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safePath = path.resolve(staticRoot, asset);
  if (!safePath.startsWith(staticRoot + path.sep) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': `${types[path.extname(safePath)] || 'application/octet-stream'}; charset=utf-8` });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(safePath).pipe(res);
}

server.on('upgrade', (req, socket, head) => {
  const token = cookie(req);
  if (req.url !== '/stream' || !sameOrigin(req) || !validSession(token, true)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  videoWss.handleUpgrade(req, socket, head, (ws) => videoWss.emit('connection', ws, token));
});

videoWss.on('connection', (ws: WebSocket, token: string) => {
  if (!nativeVideoAvailable) {
    ws.close(1008, 'Native video is not supported on this platform');
    return;
  }
  if (videoController) videoController.ws.close(4000, 'Another session took control');
  videoController = { ws, token };
  attachVideo(ws);
  ws.on('close', () => { if (videoController?.ws === ws) videoController = undefined; });
  ws.on('message', () => { validSession(token, true); });
  const check = setInterval(() => { if (!validSession(token)) ws.close(4001, 'Session expired'); }, 30_000);
  ws.on('close', () => clearInterval(check));
});

server.on('error', (error: NodeJS.ErrnoException) => {
  // Keep the EADDRINUSE token: the desktop controller maps it to a localized hint.
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use (EADDRINUSE). Stop the other Remote Control instance or set REMOTECONTROL_PORT.`);
  else if (error.code === 'EACCES') console.error(`Permission denied while listening on ${gatewayHost}:${port} (EACCES). Choose a port above 1024 with REMOTECONTROL_PORT.`);
  else console.error(`Remote Control could not start: ${error.message}`);
  process.exit(1);
});

server.listen(port, gatewayHost, () => {
  const lan = gatewayHost === '0.0.0.0' ? lanUrls(port) : [];
  console.log(`Remote Control listening on http://${gatewayHost}:${port} (local: http://127.0.0.1:${port})`);
  if (gatewayHost === '0.0.0.0') {
    console.log(lan.length ? `Open from another device on this network: ${lan.join('  ')}` : 'No LAN IPv4 address detected; only http://127.0.0.1 is reachable right now.');
    console.warn('LAN HTTP is unencrypted. Use only on a trusted private network; use HTTPS or a trusted VPN on public networks.');
  }
  if (!fs.existsSync(path.join(staticRoot, 'index.html'))) console.warn('Web UI is not built: run `pnpm build` first.');
  if (!hasOwner()) console.log('No owner password yet: run `pnpm run setup` in a terminal on this computer, then sign in.');
});

// The desktop host owns this process; shutting it down must stop native capture too.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ws of videoWss.clients) ws.terminate();
  await stopAllCapture();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.env.REMOTECONTROL_DESKTOP_GATEWAY === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => { void shutdown(); });
}
