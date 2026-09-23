import { stdin, stdout } from 'node:process';
import { hash, Algorithm } from '@node-rs/argon2';
import { hasOwner, setOwner } from './store.js';

if (!stdin.isTTY) throw new Error('Run setup in an interactive terminal.');
function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    let value = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') process.exit(130);
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

if (hasOwner()) {
  const answer = await prompt('Replace owner password and revoke all sessions? Type YES (hidden): ');
  if (answer !== 'YES') process.exit(0);
}
const first = await prompt('New owner password (at least 12 characters, hidden): ');
if (first.length < 12 || first.length > 256) throw new Error('Password must have 12–256 characters.');
const second = await prompt('Confirm password (hidden): ');
if (first !== second) throw new Error('Passwords did not match.');
setOwner(await hash(first, { algorithm: Algorithm.Argon2id }));
stdout.write('Owner password saved. All old sessions were revoked.\n');
