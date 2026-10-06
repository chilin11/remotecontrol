import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const mac = target === 'mac';
if ((!mac && target !== 'windows') || process.platform !== (mac ? 'darwin' : 'win32')) {
  throw new Error('Package mac on macOS, or windows on Windows (with built native artifacts and target dependencies).');
}
if (mac && process.arch !== 'arm64') throw new Error('The currently tested macOS package targets Apple Silicon only.');
if (!mac && process.arch !== 'x64') throw new Error('The Windows package targets x64.');
const version = '24.14.1';
const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir();
const cache = path.join(scratch, 'remotecontrol-node-' + version);
fs.mkdirSync(cache, { recursive: true });
const release = path.join(project, 'release');
fs.mkdirSync(release, { recursive: true });
const stage = fs.mkdtempSync(path.join(scratch, 'remotecontrol-package-'));
const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const require = createRequire(path.join(project, 'package.json'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
function download(name) {
  const file = path.join(cache, name);
  if (!fs.existsSync(file)) run(mac ? 'curl' : 'curl.exe', ['--fail', '--location', '--retry', '2', '--output', file + '.tmp', `https://nodejs.org/dist/v${version}/${name}`]);
  if (fs.existsSync(file + '.tmp')) fs.renameSync(file + '.tmp', file);
  return file;
}
const filename = mac ? `node-v${version}-darwin-arm64.tar.gz` : `node-v${version}-win-x64.zip`;
const sums = download('SHASUMS256.txt');
const expected = fs.readFileSync(sums, 'utf8').split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === filename)?.[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official Node checksum entry is missing.');
const archive = download(filename);
if (hashFile(archive) !== expected) { fs.rmSync(archive); throw new Error('Node SHA-256 mismatch; no package was produced.'); }
const extract = path.join(stage, 'node');
fs.mkdirSync(extract);
if (mac) run('tar', ['-xzf', archive, '-C', extract]);
else run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env.RC_ARCHIVE -DestinationPath $env.RC_EXTRACT'], { env: { ...process.env, RC_ARCHIVE: archive, RC_EXTRACT: extract } });
const nodeRoot = path.join(extract, `node-v${version}-${mac ? 'darwin-arm64' : 'win-x64'}`);
const product = path.join(stage, mac ? 'RemoteControlAgent.app' : 'RemoteControl');
let payload;
if (mac) {
  fs.cpSync(path.join(project, 'dist-native', 'RemoteControlAgent.app'), product, { recursive: true });
  payload = path.join(product, 'Contents', 'Resources', 'payload');
  fs.rmSync(payload, { recursive: true, force: true });
} else {
  fs.cpSync(path.join(project, 'dist-native', 'windows'), product, { recursive: true });
  fs.renameSync(path.join(product, 'RemoteControlAgent.exe'), path.join(product, 'RemoteControl.exe'));
  payload = product;
}
const gatewayApp = mac ? path.join(product, 'Contents', 'Helpers', 'RemoteControlGateway.app') : undefined;
const runtimeDir = mac ? path.join(gatewayApp, 'Contents', 'MacOS') : path.join(payload, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const nodeBinary = path.join(runtimeDir, mac ? 'RemoteControlGateway' : 'node.exe');
fs.copyFileSync(path.join(nodeRoot, mac ? 'bin/node' : 'node.exe'), nodeBinary);
if (mac) {
  fs.chmodSync(nodeBinary, 0o755);
  fs.copyFileSync(path.join(project, 'native', 'GatewayInfo.plist'), path.join(gatewayApp, 'Contents', 'Info.plist'));
}
const licenses = path.join(payload, 'licenses');
fs.mkdirSync(licenses, { recursive: true });
fs.copyFileSync(path.join(nodeRoot, 'LICENSE'), path.join(licenses, 'Node-LICENSE.txt'));
for (const dir of ['dist', 'dist-server']) {
  const from = path.join(project, dir);
  if (!fs.existsSync(from)) throw new Error(`Missing ${dir}; run pnpm build first.`);
  fs.cpSync(from, path.join(payload, dir), { recursive: true });
}
if (!fs.existsSync(path.join(payload, 'dist-server', 'desktop.js'))) throw new Error('Desktop controller is missing; rebuild.');
fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'remotecontrol-desktop', version: '0.1.0', private: true, type: 'module' }, null, 2) + '\n');
// Materialize only gateway runtime packages; no pnpm links or developer dependencies.
const packages = ['ws', '@node-rs/argon2', `@node-rs/argon2-${mac ? 'darwin-arm64' : 'win32-x64-msvc'}`];
const argonRequire = createRequire(require.resolve('@node-rs/argon2/package.json'));
const bundled = {};
for (const name of packages) {
  const manifest = (name.startsWith('@node-rs/argon2-') ? argonRequire : require).resolve(name + '/package.json');
  const source = path.dirname(fs.realpathSync(manifest));
  const destination = path.join(payload, 'node_modules', name);
  fs.cpSync(source, destination, { recursive: true, dereference: true, filter: (item) => item === source || !path.relative(source, item).split(path.sep).includes('node_modules') });
  bundled[name] = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
}
if (!mac) {
  let ffmpeg = process.env.REMOTECONTROL_FFMPEG_DIR;
  if (!ffmpeg) {
    const spec = JSON.parse(fs.readFileSync(path.join(project, 'native', 'windows', 'ffmpeg-distribution.json'), 'utf8'));
    ffmpeg = path.join(cache, 'ffmpeg-' + spec.version);
    const resultFile = path.join(stage, 'ffmpeg-install-result.json');
    console.log(`Checking FFmpeg ${spec.version}; downloading and installing automatically if missing…`);
    const result = spawnSync(path.join(product, 'RemoteControl.exe'), ['--install-ffmpeg', ffmpeg, resultFile], { windowsHide: true, timeout: 660000 });
    const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : undefined;
    if (result.error || result.status !== 0 || !report?.executable) throw new Error(`FFmpeg auto-install failed: ${report?.error || result.error?.message || result.status}. Check the network and retry package:windows.`);
  }
  if (!fs.existsSync(path.join(ffmpeg, 'ffmpeg.exe')) || !fs.existsSync(path.join(ffmpeg, 'THIRD-PARTY.txt'))) {
    throw new Error('Custom FFmpeg directory is incomplete: ffmpeg.exe and THIRD-PARTY.txt are required. Unset REMOTECONTROL_FFMPEG_DIR to use automatic installation.');
  }
  for (const [args, needed] of [[['-hide_banner', '-devices'], ['gdigrab']], [['-hide_banner', '-encoders'], ['libx264', 'libx265']]]) {
    const check = spawnSync(path.join(ffmpeg, 'ffmpeg.exe'), args, { encoding: 'utf8', windowsHide: true });
    const text = (check.stdout || '') + (check.stderr || '');
    if (check.status !== 0 || needed.some((name) => !text.includes(name))) throw new Error('FFmpeg must support gdigrab, libx264 and libx265.');
  }
  fs.cpSync(ffmpeg, path.join(payload, 'ffmpeg'), { recursive: true, dereference: true });
}
const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
run(nodeBinary, ['--input-type=module', '-e', "import {hash,verify} from '@node-rs/argon2'; import WebSocket from 'ws'; import {DatabaseSync} from 'node:sqlite'; const h=await hash('package-validation'); if(!await verify(h,'package-validation')) throw Error('argon2 failed'); new DatabaseSync(':memory:').close(); console.log('Bundled runtime OK',process.version,typeof WebSocket);"], { cwd: payload, env });
fs.writeFileSync(path.join(payload, 'BUILD-INFO.json'), JSON.stringify({ version: '0.1.0', platform: process.platform, arch: process.arch, node: { version, archive: filename, sha256: expected }, dependencies: bundled }, null, 2) + '\n');
fs.copyFileSync(path.join(project, 'DESKTOP-DEPLOY.md'), path.join(payload, 'DESKTOP-DEPLOY.md'));
if (!mac) fs.copyFileSync(path.join(project, 'WINDOWS-DEPLOY.md'), path.join(payload, 'WINDOWS-DEPLOY.md'));
if (mac) {
  const identity = process.env.REMOTECONTROL_SIGN_IDENTITY || '-';
  const sign = (file, node = false, identifier) => run('codesign', ['--force', ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']), ...(node ? ['--entitlements', path.join(project, 'native', 'Node.entitlements.plist')] : []), ...(identifier ? ['--identifier', identifier] : []), '--sign', identity, file]);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of walk(path.join(payload, 'node_modules')).filter((file) => file.endsWith('.node'))) sign(file);
  sign(nodeBinary, true, 'local.remotecontrol.gateway');
  sign(gatewayApp, true);
  sign(product);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', product]);
  run(nodeBinary, ['--input-type=module', '-e', "import {hash,verify} from '@node-rs/argon2'; import WebSocket from 'ws'; import {DatabaseSync} from 'node:sqlite'; const h=await hash('post-sign-validation'); if(!await verify(h,'post-sign-validation')) throw Error('signed addon failed'); new DatabaseSync(':memory:').close(); console.log('Signed bundled runtime OK',process.version,typeof WebSocket);"], { cwd: payload, env });
  if (identity === '-') console.warn('Development ad-hoc signature: updates may require permission reapproval; this is not notarized.');
  const profile = process.env.REMOTECONTROL_NOTARY_PROFILE;
  if (profile) {
    if (identity === '-') throw new Error('Notarization requires a Developer ID signature.');
    const submission = path.join(stage, 'notary.zip');
    run('ditto', ['-c', '-k', '--keepParent', product, submission]);
    run('xcrun', ['notarytool', 'submit', submission, '--keychain-profile', profile, '--wait']);
    run('xcrun', ['stapler', 'staple', product]);
  }
}
const destination = path.join(release, mac ? 'RemoteControlAgent.app' : 'RemoteControl-Windows');
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(product, destination, { recursive: true });
const zip = path.join(release, mac ? 'RemoteControl-mac-arm64.zip' : 'RemoteControl-windows-x64.zip');
fs.rmSync(zip, { force: true });
if (mac) run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', destination, zip]);
else run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env.RC_PRODUCT -DestinationPath $env.RC_ZIP'], { env: { ...process.env, RC_PRODUCT: destination, RC_ZIP: zip } });
fs.writeFileSync(zip + '.sha256', `${hashFile(zip)}  ${path.basename(zip)}\n`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Packaged ${destination}\nArchive: ${zip}`);
