import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.REMOTECONTROL_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'RemoteControl');
const dbPath = path.join(dataDir, 'remotecontrol.db');
if (!fs.existsSync(dbPath)) process.exit(2);

// Inspect only: an existing or damaged DB must never be overwritten by the installer.
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const owner = db.prepare('SELECT 1 FROM owner WHERE id = 1').get();
  // A failed first password prompt leaves a valid ownerless database; setup may safely resume.
  if (!owner) {
    db.prepare('SELECT 1 FROM sessions LIMIT 1').get(); // required schema; damaged databases still fail closed
    process.exitCode = 3;
  } else process.exitCode = 0;
} finally {
  db.close();
}
