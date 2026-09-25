import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, type Socket } from 'node:net';
import { verify } from '@node-rs/argon2';
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';
import { hasOwner, ownerHash, createSession, validSession, revokeSession } from './store.js';
import { gatewayHost, hostPlatform, nativeVideoAvailable, port, vncHost, vncPort } from './config.js';
import { attachVideo } from './video.js';

const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const server = http.createServer((req, res) => {
  void handleHttp(req, res).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    else res.destroy();
  });
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
const videoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2048 });
let controller: { ws: WebSocket; tcp: Socket; token: string } | undefined;
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
      json(res, 200, { authenticated: validSession(cookie(req), true), configured: hasOwner(), controlling: !!controller || !!videoController, nativeVideo: nativeVideoAvailable, hevcVideo: nativeVideoAvailable && (hostPlatform === 'darwin' || hostPlatform === 'win32'), hevcCodecString: hostPlatform === 'win32' ? 'hvc1.1.6.L150.90' : 'hvc1.1.6.L150.B0', hevcMseVideo: hostPlatform === 'win32' });
      return;
    }
    if (req.method !== 'POST' || !sameOrigin(req)) { json(res, 403, { error: 'Forbidden' }); return; }
    if (pathname === '/api/login') {
      const now = Date.now();
      while (loginAttempts[0] && now - loginAttempts[0] > 5 * 60_000) loginAttempts.shift();
      if (loginAttempts.length >= 10) { json(res, 429, { error: 'Too many attempts. Try again later.' }); return; }
      loginAttempts.push(now);
      let body: unknown;
      try { body = await readJson(req); } catch { json(res, 400, { error: 'Invalid request' }); return; }
      const password = (body as { password?: unknown })?.password;
      if (typeof password !== 'string' || password.length > 256) { json(res, 400, { error: 'Invalid request' }); return; }
      const hash = ownerHash();
      if (!hash || !(await verify(hash, password))) { json(res, 401, { error: 'Incorrect password' }); return; }
      const token = createSession();
      res.setHeader('Set-Cookie', setCookie(req, token, 7 * 24 * 60 * 60));
      json(res, 200, { authenticated: true });
      return;
    }
    if (pathname === '/api/logout') {
      const token = cookie(req);
      revokeSession(token);
      if (controller && controller.token === token) { controller.tcp.destroy(); controller.ws.close(4001, 'Signed out'); }
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
  if ((req.url !== '/ws' && req.url !== '/stream') || !sameOrigin(req) || !validSession(token, true)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const target = req.url === '/stream' ? videoWss : wss;
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, token));
});

wss.on('connection', (ws: WebSocket, token: string) => {
  if (controller) { controller.tcp.destroy(); controller.ws.close(4000, 'Another session took control'); }
  if (videoController) videoController.ws.close(4000, 'Another session took control');
  const tcp = createConnection({ host: vncHost, port: vncPort });
  controller = { ws, tcp, token };
  const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (controller?.ws === ws) controller = undefined;
    tcp.destroy();
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };
  tcp.on('connect', () => {
    stream.pipe(tcp);
    tcp.pipe(stream);
  });
  tcp.on('error', close);
  tcp.on('close', close);
  stream.on('error', close);
  ws.on('close', close);
  ws.on('message', () => { validSession(token, true); });
  const check = setInterval(() => {
    if (!validSession(token)) ws.close(4001, 'Session expired');
  }, 30_000);
  ws.on('close', () => clearInterval(check));
});

videoWss.on('connection', (ws: WebSocket, token: string) => {
  if (!nativeVideoAvailable) {
    ws.close(1008, 'Native video is not supported on this platform');
    return;
  }
  if (controller) { controller.tcp.destroy(); controller.ws.close(4000, 'Another session took control'); }
  if (videoController) videoController.ws.close(4000, 'Another session took control');
  videoController = { ws, token };
  attachVideo(ws);
  ws.on('close', () => { if (videoController?.ws === ws) videoController = undefined; });
  ws.on('message', () => { validSession(token, true); });
  const check = setInterval(() => { if (!validSession(token)) ws.close(4001, 'Session expired'); }, 30_000);
  ws.on('close', () => clearInterval(check));
});

server.listen(port, gatewayHost, () => {
  console.log(`Remote Control listening on http://${gatewayHost === '0.0.0.0' ? '<this-computer-LAN-IP>' : gatewayHost}:${port} (local: http://127.0.0.1:${port})`);
  if (gatewayHost === '0.0.0.0') console.warn('LAN HTTP is unencrypted. Use only on a trusted private network; use HTTPS or a trusted VPN on public networks.');
  if (!hasOwner()) console.log('Run `pnpm setup` before signing in.');
});
