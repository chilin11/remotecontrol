import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('DMG packaging requires macOS.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'release', 'RemoteControlAgent.app');
const destination = path.join(root, 'release', 'RemoteControl-mac-arm64.dmg');
if (!fs.existsSync(app)) throw new Error('Build the desktop app first with pnpm package:mac.');
const stage = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'remotecontrol-dmg-'));
const source = path.join(stage, 'contents');
const mount = path.join(stage, 'mounted');
const image = path.join(stage, 'RemoteControl.dmg');
let attached = false;
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
try {
  run('codesign', ['--verify', '--deep', '--strict', app]);
  fs.mkdirSync(source);
  run('ditto', [app, path.join(source, 'RemoteControlAgent.app')]);
  fs.symlinkSync('/Applications', path.join(source, 'Applications'));
  fs.copyFileSync(path.join(root, 'native', 'assets', 'DmgLayout.dsstore'), path.join(source, '.DS_Store'));
  run('hdiutil', ['create', '-volname', 'Remote Control — Drag to Applications', '-srcfolder', source, '-format', 'UDZO', '-fs', 'HFS+', image]);
  run('hdiutil', ['verify', image]);
  fs.mkdirSync(mount);
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image]);
  attached = true;
  if (fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications') throw new Error('Applications shortcut is invalid.');
  if (!fs.existsSync(path.join(mount, '.DS_Store'))) throw new Error('Installer window layout is missing.');
  run('codesign', ['--verify', '--deep', '--strict', path.join(mount, 'RemoteControlAgent.app')]);
  run('hdiutil', ['detach', mount]);
  attached = false;
  fs.copyFileSync(image, destination);
  const digest = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  fs.writeFileSync(destination + '.sha256', `${digest}  ${path.basename(destination)}\n`);
  console.log(`DMG ready: ${destination}\nOpen it and drag RemoteControlAgent.app onto Applications.\nNo running application or session data was changed.`);
} finally {
  if (attached) spawnSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true, force: true });
}
