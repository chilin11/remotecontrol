// Stable per-machine code-signing identity for development / self-use builds.
// Ad-hoc signatures change on every build, so macOS treats each build as a new program and
// re-asks for the firewall "accept incoming connections" decision (and may drop Screen Recording /
// Accessibility grants). A self-signed certificate kept outside the repository gives every build the
// same designated requirement, so those decisions survive updates. It is NOT a Developer ID
// signature: Gatekeeper, notarization and "automatically allow signed software" do not apply.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const localIdentityName = 'RemoteControl Local Signing';
const home = path.join(os.homedir(), 'Library', 'Application Support', 'RemoteControl-Signing');
const keychain = path.join(home, 'signing.keychain-db');
const secretFile = path.join(home, 'keychain-password');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
}

function hasIdentity() {
  const out = spawnSync('security', ['find-identity', '-p', 'codesigning', keychain], { encoding: 'utf8' }).stdout || '';
  return out.includes(`"${localIdentityName}"`);
}

function create(password) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'remotecontrol-signing-'));
  try {
    const config = path.join(work, 'cert.cnf');
    fs.writeFileSync(config, [
      '[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no',
      '[dn]', `CN=${localIdentityName}`,
      '[ext]', 'basicConstraints=critical,CA:false', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=critical,codeSigning', '',
    ].join('\n'));
    const key = path.join(work, 'key.pem'), cert = path.join(work, 'cert.pem'), p12 = path.join(work, 'identity.p12');
    const transfer = randomBytes(12).toString('hex');
    // /usr/bin/openssl (LibreSSL) writes PKCS#12 that `security import` accepts.
    run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7300', '-keyout', key, '-out', cert, '-config', config]);
    run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', `pass:${transfer}`, '-name', localIdentityName]);
    fs.rmSync(keychain, { force: true });
    run('security', ['create-keychain', '-p', password, keychain]);
    run('security', ['set-keychain-settings', keychain]); // no auto-lock timeout
    run('security', ['unlock-keychain', '-p', password, keychain]);
    run('security', ['import', p12, '-k', keychain, '-P', transfer, '-T', '/usr/bin/codesign']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Returns { identity, keychain } for codesign, creating the identity on first use. */
export function ensureLocalIdentity() {
  if (process.platform !== 'darwin') throw new Error('Local signing identity is macOS only.');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let password;
  if (fs.existsSync(secretFile) && fs.existsSync(keychain)) password = fs.readFileSync(secretFile, 'utf8').trim();
  else {
    password = randomBytes(24).toString('hex');
    fs.writeFileSync(secretFile, password + '\n', { mode: 0o600 });
    create(password);
    console.log(`Created stable local signing identity "${localIdentityName}" in ${keychain}`);
  }
  run('security', ['unlock-keychain', '-p', password, keychain]);
  if (!hasIdentity()) {
    create(password);
    run('security', ['unlock-keychain', '-p', password, keychain]);
    if (!hasIdentity()) throw new Error('Local signing identity could not be created.');
  }
  return { identity: localIdentityName, keychain };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { identity, keychain: file } = ensureLocalIdentity();
  console.log(`${identity}\n${file}`);
}
