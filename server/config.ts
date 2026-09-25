import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export function defaultDataDir(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.REMOTECONTROL_DATA_DIR) return env.REMOTECONTROL_DATA_DIR;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    return platformPath.join(env.LOCALAPPDATA || platformPath.join(home, 'AppData', 'Local'), 'RemoteControl');
  }
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'RemoteControl');
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'RemoteControl');
}

export function agentExecutable(platform: NodeJS.Platform, serverModule = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  if (env.REMOTECONTROL_AGENT_PATH) return env.REMOTECONTROL_AGENT_PATH;
  const root = path.resolve(path.dirname(fileURLToPath(serverModule)), '..');
  return platform === 'win32'
    ? path.join(root, 'dist-native', 'windows', 'RemoteControlAgent.exe')
    : path.join(root, 'dist-native', 'RemoteControlAgent.app', 'Contents', 'MacOS', 'RemoteControlAgent');
}

export function supportsNativeVideo(platform: NodeJS.Platform, executable?: string): boolean {
  return (platform === 'darwin' || platform === 'win32') && (executable === undefined || fs.existsSync(executable));
}

export function supportsPosixPermissions(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

export const port = Number(process.env.REMOTECONTROL_PORT || 8787);
export const dataDir = defaultDataDir(process.platform, os.homedir());
// LAN by default; set REMOTECONTROL_HOST=127.0.0.1 for loopback-only access.
export const gatewayHost = process.env.REMOTECONTROL_HOST || '0.0.0.0';
export const vncHost = '127.0.0.1';
export const vncPort = Number(process.env.REMOTECONTROL_VNC_PORT || 5900);
export const hostPlatform = process.platform;
export const nativeAgentPath = agentExecutable(hostPlatform);
export const nativeVideoAvailable = supportsNativeVideo(hostPlatform, nativeAgentPath);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid REMOTECONTROL_PORT');
if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535) throw new Error('Invalid REMOTECONTROL_VNC_PORT');
if (gatewayHost !== '127.0.0.1' && gatewayHost !== '0.0.0.0') throw new Error('REMOTECONTROL_HOST must be 127.0.0.1 or 0.0.0.0');
