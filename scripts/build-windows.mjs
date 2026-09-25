import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Run build:windows on a Windows machine with the .NET 8 SDK installed.');

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(project, 'native', 'windows', 'RemoteControl.Windows.csproj');
const destination = path.join(project, 'dist-native', 'windows');
if (!fs.existsSync(source)) throw new Error(`Windows agent source is missing: ${source}`);
fs.mkdirSync(destination, { recursive: true });
const result = spawnSync('dotnet', [
  'publish', source, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
  '-p:PublishSingleFile=true', '-p:AssemblyName=RemoteControlAgent', '-o', destination,
], { stdio: 'inherit', shell: false });
if (result.error) throw new Error(`Could not launch dotnet: ${result.error.message}. Install the .NET 8 SDK first.`);
if (result.status !== 0) process.exit(result.status || 1);
const binary = path.join(destination, 'RemoteControlAgent.exe');
if (!fs.existsSync(binary)) throw new Error(`dotnet publish did not produce ${binary}`);
console.log(`Built ${binary}`);
