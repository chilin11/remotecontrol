import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = new URL('../scripts/windows-owner.mjs', import.meta.url);
const invoke = (dataDir) => spawnSync(process.execPath, [fileURLToPath(helper)], {
  env: { ...process.env, REMOTECONTROL_DATA_DIR: dataDir }, encoding: 'utf8',
});

test('Windows first-run detection resumes ownerless setup without replacing existing owner data', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'rc-windows-setup-'));
  try {
    assert.equal(invoke(temp).status, 2, 'missing DB needs initial setup');
    const db = new DatabaseSync(path.join(temp, 'remotecontrol.db'));
    db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL); CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)');
    db.close();
    const empty = invoke(temp);
    assert.equal(empty.status, 3, 'valid ownerless database left by interrupted setup can resume');
    assert.equal(empty.stderr.includes('Error:'), false);
    const existing = new DatabaseSync(path.join(temp, 'remotecontrol.db'));
    existing.prepare('INSERT INTO owner (id, password_hash) VALUES (1, ?)').run('existing-owner-hash');
    existing.close();
    assert.equal(invoke(temp).status, 0, 'existing password should be preserved');
    const verify = new DatabaseSync(path.join(temp, 'remotecontrol.db'), { readOnly: true });
    assert.equal(verify.prepare('SELECT password_hash FROM owner WHERE id = 1').get().password_hash, 'existing-owner-hash');
    verify.close();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('damaged owner database fails closed instead of running setup', () => {
  const broken = mkdtempSync(path.join(os.tmpdir(), 'rc-windows-broken-'));
  try {
    const db = new DatabaseSync(path.join(broken, 'remotecontrol.db'));
    db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY, password_hash TEXT NOT NULL)');
    db.close();
    const result = invoke(broken);
    assert.notEqual(result.status, 2, 'damaged schema cannot silently enter setup');
    assert.notEqual(result.status, 3, 'damaged schema cannot resume setup');
  } finally { rmSync(broken, { recursive: true, force: true }); }
});

test('Windows quick start enables LAN by default and offers explicit local-only mode', () => {
  const source = readFileSync(new URL('../scripts/windows.ps1', import.meta.url), 'utf8');
  assert.match(source, /param\(\[switch\]\$Local\)/);
  assert.match(source, /if \(\$Local\) \{\s*\$env:REMOTECONTROL_HOST = '127\.0\.0\.1'/);
  assert.match(source, /else \{\s*\$env:REMOTECONTROL_HOST = '0\.0\.0\.0'/);
  assert.match(source, /scripts\/windows-owner\.mjs/);
  assert.doesNotMatch(source, /Set-ExecutionPolicy|New-NetFirewallRule|netsh|winget install\s*$/im);
  const publish = readFileSync(new URL('../scripts/build-windows.mjs', import.meta.url), 'utf8');
  assert.match(publish, /'--self-contained', 'true'/);
});
