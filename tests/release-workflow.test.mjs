import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/windows-package.yml', import.meta.url), 'utf8');

test('desktop release requires successful macOS and Windows builds from the same checkout', () => {
  assert.match(workflow, /name: Build and publish macOS \+ Windows/);
  assert.match(workflow, /windows:\n\s+runs-on: windows-2022/);
  assert.match(workflow, /macos:\n\s+runs-on: macos-15/);
  assert.match(workflow, /publish:\n\s+needs: \[windows, macos\]/);
  assert.match(workflow, /pnpm package:windows/);
  assert.match(workflow, /pnpm package:mac/);
  assert.match(workflow, /--target "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow, /if: always\(\)/);
});

test('only publish can write releases, and all three packages are uploaded before publishing', () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /permissions:\n\s+contents: write/);
  const upload = publish.split('\n').find((line) => line.includes('gh release upload'));
  for (const name of ['RemoteControl-mac-arm64.dmg', 'RemoteControl-mac-arm64.zip', 'RemoteControl-windows-x64.zip']) {
    assert.ok(upload.includes('release/' + name), name);
    assert.ok(upload.includes('release/' + name + '.sha256'), name + '.sha256');
  }
  assert.ok(publish.indexOf('gh release upload') < publish.indexOf('gh release edit'));
  assert.match(publish, /--draft=false --latest/);
  assert.match(workflow, /REMOTECONTROL_SIGN_IDENTITY: '-'/);
});
