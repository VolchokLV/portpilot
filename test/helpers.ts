import fs from 'fs';
import os from 'os';
import path from 'path';

/** Point PortPilot at throwaway config/data/hosts locations before importing core modules. */
export function isolate(): { root: string; configDir: string; home: string; hostsFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-test-'));
  const configDir = path.join(root, 'config');
  const home = path.join(root, 'home');
  const hostsFile = path.join(root, 'hosts');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n');
  process.env.PORTPILOT_CONFIG_DIR = configDir;
  process.env.PORTPILOT_HOME = home;
  process.env.PORTPILOT_HOSTS_FILE = hostsFile;
  return { root, configDir, home, hostsFile };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-proj-'));
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
