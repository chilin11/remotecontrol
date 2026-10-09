import { stdin, stdout } from 'node:process';
import { hash, Algorithm } from '@node-rs/argon2';
import { hasOwner, setOwner } from './store.js';

if (!stdin.isTTY) {
  console.error('Run setup in an interactive terminal: pnpm run setup');
  process.exit(1);
}

function applyKeys(value: string, input: string): { value: string; done: boolean; cancelled: boolean } {
  // Skip terminal escape sequences (arrow keys etc.) so they never become password characters.
  const text = input.replace(/\u001b\[[0-9;]*[A-Za-z~]|\u001b./g, '');
  for (const char of text) {
    if (char === '\u0003') return { value, done: false, cancelled: true };
    if (char === '\r' || char === '\n') return { value, done: true, cancelled: false };
    // Backspace is DEL (0x7f) on macOS/Linux terminals and BS (0x08) on Windows consoles.
    if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
    else if (char >= ' ') value += char;
  }
  return { value, done: false, cancelled: false };
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    let value = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      const result = applyKeys(value, chunk.toString('utf8'));
      value = result.value;
      if (result.cancelled) { stdin.setRawMode(false); stdout.write('\nCancelled.\n'); process.exit(130); }
      if (!result.done) return;
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    stdin.on('data', onData);
  });
}

if (hasOwner() && process.argv.includes('--if-missing')) {
  stdout.write('Existing owner password preserved.\n');
  process.exit(0);
}
if (hasOwner()) {
  const answer = await prompt('An owner password already exists. Type YES to replace it and sign out all devices: ');
  if (answer.trim() !== 'YES') { stdout.write('Kept the existing password.\n'); process.exit(0); }
}
for (let attempt = 1; ; attempt++) {
  const first = await prompt('New owner password (12–256 characters, hidden): ');
  const second = first.length < 12 || first.length > 256 ? undefined : await prompt('Confirm password (hidden): ');
  const problem = second === undefined ? 'Password must have 12–256 characters.' : first !== second ? 'Passwords did not match.' : '';
  if (!problem) {
    setOwner(await hash(first, { algorithm: Algorithm.Argon2id }));
    stdout.write('Owner password saved. All old sessions were revoked.\n');
    break;
  }
  if (attempt >= 3) { console.error(`${problem} No password was saved.`); process.exit(1); }
  stdout.write(`${problem} Try again.\n`);
}
