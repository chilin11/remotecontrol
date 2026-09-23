import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const label = 'com.local.remotecontrol';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launchDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchDir, `${label}.plist`);
const dataDir = process.env.REMOTECONTROL_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'RemoteControl');
const service = path.join(project, 'dist-server', 'index.js');
const agent = path.join(project, 'dist-native', 'RemoteControlAgent.app', 'Contents', 'MacOS', 'RemoteControlAgent');
const domain = `gui/${process.getuid()}`;
const xml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function run(...args) {
  const result = spawnSync('/bin/launchctl', args, { stdio: 'inherit' });
  return result.status === 0;
}

if (process.platform !== 'darwin') throw new Error('This command is for macOS.');
const action = process.argv[2];
if (action === 'install') {
  if (!fs.existsSync(service)) throw new Error('Build the project first with `pnpm build`.');
  if (!fs.existsSync(agent)) throw new Error('Build the native video agent first with `pnpm build:native`.');
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const vars = {
    REMOTECONTROL_PORT: process.env.REMOTECONTROL_PORT || '8787',
    REMOTECONTROL_VNC_PORT: process.env.REMOTECONTROL_VNC_PORT || '5900',
    REMOTECONTROL_DATA_DIR: dataDir,
  };
  const env = Object.entries(vars).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(service)}</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>EnvironmentVariables</key><dict>${env}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(dataDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(dataDir, 'service-error.log'))}</string>
</dict></plist>\n`;
  if (fs.existsSync(plistPath)) run('bootout', domain, plistPath);
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  if (!run('bootstrap', domain, plistPath)) throw new Error('Could not load the LaunchAgent. Run from a logged-in macOS user session.');
  console.log(`Installed and started ${label}. Logs: ${dataDir}`);
} else if (action === 'uninstall') {
  if (fs.existsSync(plistPath)) {
    run('bootout', domain, plistPath);
    fs.unlinkSync(plistPath);
  }
  console.log('LaunchAgent removed. Owner data was retained.');
} else {
  throw new Error('Usage: node scripts/launchd.mjs install|uninstall');
}
