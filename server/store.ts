import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './config.js';

export const idleMs = 30 * 60 * 1000;
export const absoluteMs = 7 * 24 * 60 * 60 * 1000;

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
const dbPath = path.join(dataDir, 'remotecontrol.db');
export const db = new DatabaseSync(dbPath);
if (fs.existsSync(dbPath)) fs.chmodSync(dbPath, 0o600);
db.exec(`
  CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
`);

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function hasOwner(): boolean {
  return !!db.prepare('SELECT 1 FROM owner WHERE id = 1').get();
}

export function ownerHash(): string | null {
  const row = db.prepare('SELECT password_hash FROM owner WHERE id = 1').get() as { password_hash: string } | undefined;
  return row?.password_hash ?? null;
}

export function setOwner(hash: string): void {
  db.prepare('INSERT INTO owner (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash').run(hash);
  db.prepare('DELETE FROM sessions').run();
}

export function createSession(): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)').run(digest(token), now, now);
  return token;
}

export function validSession(token: string | undefined, touch = false): boolean {
  if (!token || token.length > 128) return false;
  const hash = digest(token);
  const row = db.prepare('SELECT created_at, last_seen FROM sessions WHERE token_hash = ?').get(hash) as { created_at: number; last_seen: number } | undefined;
  if (!row) return false;
  const now = Date.now();
  if (now - row.last_seen > idleMs || now - row.created_at > absoluteMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return false;
  }
  if (touch && now - row.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
  return true;
}

export function revokeSession(token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
}

export function revokeAllSessions(): void {
  db.prepare('DELETE FROM sessions').run();
}
