import os from 'node:os';
import path from 'node:path';

export const port = Number(process.env.REMOTECONTROL_PORT || 8787);
export const dataDir = process.env.REMOTECONTROL_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'RemoteControl');
export const vncHost = '127.0.0.1';
export const vncPort = Number(process.env.REMOTECONTROL_VNC_PORT || 5900);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid REMOTECONTROL_PORT');
if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535) throw new Error('Invalid REMOTECONTROL_VNC_PORT');
