import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultDataDir, agentExecutable, gatewayHost, hostPlatform, nativeAgentPath, nativeVideoAvailable, supportsNativeVideo, supportsPosixPermissions, vncHost } from '../dist-server/config.js';

test('platform defaults are safe and use platform-appropriate data locations', () => {
  assert.equal(defaultDataDir('win32', 'C:\\Users\\alice', { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }), 'C:\\Users\\alice\\AppData\\Local\\RemoteControl');
  assert.equal(defaultDataDir('win32', 'C:\\Users\\alice', {}), 'C:\\Users\\alice\\AppData\\Local\\RemoteControl');
  assert.equal(defaultDataDir('darwin', '/Users/alice', {}), '/Users/alice/Library/Application Support/RemoteControl');
  assert.equal(defaultDataDir('linux', '/home/alice', { XDG_DATA_HOME: '/var/lib/alice' }), '/var/lib/alice/RemoteControl');
  assert.equal(defaultDataDir('win32', 'C:\\Users\\alice', { REMOTECONTROL_DATA_DIR: 'D:\\rc-data' }), 'D:\\rc-data');
});

test('video capability requires an agent executable; gateway defaults to LAN while VNC stays loopback-only', () => {
  assert.equal(supportsNativeVideo('darwin', '/not/a/real/agent'), false);
  assert.equal(supportsNativeVideo('win32', '/not/a/real/agent.exe'), false);
  assert.equal(supportsNativeVideo('linux', '/not/a/real/agent'), false);
  assert.equal(supportsNativeVideo('win32', process.execPath), true);
  assert.equal(supportsNativeVideo('darwin', process.execPath), true);
  assert.match(agentExecutable('win32').replaceAll('\\', '/'), /dist-native\/windows\/RemoteControlAgent\.exe$/);
  assert.equal(agentExecutable('win32', import.meta.url, { REMOTECONTROL_AGENT_PATH: 'C:\\custom\\agent.exe' }), 'C:\\custom\\agent.exe');
  assert.equal(supportsPosixPermissions('win32'), false);
  assert.equal(supportsPosixPermissions('darwin'), true);
  assert.equal(gatewayHost, process.env.REMOTECONTROL_HOST || '0.0.0.0');
  assert.equal(vncHost, '127.0.0.1');
  assert.equal(nativeVideoAvailable, supportsNativeVideo(hostPlatform, nativeAgentPath));
});
