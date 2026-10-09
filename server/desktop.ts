// Private JSON-lines IPC for the native desktop host. Never exposed over HTTP.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, Algorithm } from '@node-rs/argon2';
import { hasOwner, createOwnerIfAbsent } from './store.js';
import { dataDir, lanUrls, port } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let gateway: ChildProcess | undefined;
let running = false;
let lan = false;
let closing = false;
const logPath = path.join(dataDir, 'desktop.log');
const reply = (error?: string) => {
  const addresses = lan ? lanUrls(port) : [];
  process.stdout.write(JSON.stringify({ configured: hasOwner(), running, lan, url: `http://127.0.0.1:${port}`, addresses, logPath, ...(error ? { error } : {}) }) + '\n');
};

async function stop(): Promise<void> {
  const child = gateway;
  if (!child) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2500);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.stdin?.end();
  });
}

async function start(allowLan: boolean): Promise<void> {
  if (!hasOwner()) throw new Error('请先设置访问密码。');
  if (gateway) throw new Error('服务已启动，请先停止后再切换网络。');
  lan = allowLan;
  const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  log.on('error', () => undefined);
  const child = spawn(process.execPath, [path.join(root, 'dist-server', 'index.js')], {
    cwd: root,
    env: { ...process.env, REMOTECONTROL_HOST: lan ? '0.0.0.0' : '127.0.0.1', REMOTECONTROL_PORT: String(port), REMOTECONTROL_DESKTOP_GATEWAY: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  gateway = child;
  let output = '';
  let errorOutput = '';
  const timeout = setTimeout(() => { errorOutput = '服务启动超时，请查看日志。'; child.kill(); }, 15000);
  child.stdout!.on('data', (chunk: Buffer) => {
    log.write(chunk);
    output = (output + chunk.toString()).slice(-4096);
    if (!running && output.includes('Remote Control listening on')) {
      clearTimeout(timeout);
      running = true;
      reply();
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => { log.write(chunk); errorOutput = (errorOutput + chunk.toString()).slice(-4096); });
  child.on('error', (error) => { errorOutput = error.message; });
  child.once('close', (code) => {
    clearTimeout(timeout);
    gateway = undefined;
    running = false;
    log.end();
    if (!closing) reply(code ? (errorOutput.includes('EADDRINUSE') ? `${port} 端口已被占用。请先停止旧版服务；不会接管其它进程。` : `服务退出 (${code})，请查看日志。${errorOutput.slice(-500)}`) : undefined);
  });
}

async function command(line: string): Promise<void> {
  if (closing) return;
  if (line.length > 4096) throw new Error('请求过大。');
  const message = JSON.parse(line) as { action?: string; password?: unknown; confirmation?: unknown; lan?: unknown };
  switch (message.action) {
    case 'status': reply(); break;
    case 'setup': {
      if (hasOwner()) throw new Error('已有访问密码，已保留；请用原有密码登录。');
      const password = message.password;
      if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('密码必须为 12–256 个字符。');
      if (password !== message.confirmation) throw new Error('两次密码不一致。');
      const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id });
      if (!createOwnerIfAbsent(passwordHash)) throw new Error('已有访问密码，已保留；请用原有密码登录。');
      reply();
      break;
    }
    case 'start': await start(message.lan === true); break;
    case 'stop': await stop(); if (!gateway) reply(); break;
    default: throw new Error('未知操作。');
  }
}

let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => { queue = queue.then(() => command(line)).catch((error: Error) => reply(error.message)); });
async function shutdown() {
  if (closing) return;
  closing = true;
  await stop();
  process.exit(0);
}
input.on('close', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
reply();
