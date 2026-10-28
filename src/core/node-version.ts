import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Per-project Node version pinning. Looks for installed versions from
 * nvm-windows, nvm, fnm and Volta and returns the directory that holds the
 * matching `node` binary, which is then put first on the dev server's PATH.
 */

interface InstalledNode {
  version: string; // "22.14.0"
  binDir: string;
  manager: string;
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

const nodeBinary = process.platform === 'win32' ? 'node.exe' : 'node';

function collect(root: string | undefined, manager: string, toBinDir: (versionDir: string) => string): InstalledNode[] {
  if (!root) return [];
  return listDirs(root)
    .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
    .map((name) => ({ version: name.replace(/^v/, ''), binDir: toBinDir(path.join(root, name)), manager }))
    .filter((n) => fs.existsSync(path.join(n.binDir, nodeBinary)));
}

export function listInstalledNodeVersions(): InstalledNode[] {
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const fnmRoot = process.env.FNM_DIR
    || (isWin ? path.join(process.env.APPDATA ?? '', 'fnm') : path.join(home, '.local', 'share', 'fnm'));
  const voltaRoot = process.env.VOLTA_HOME || path.join(home, isWin ? 'AppData\\Local\\Volta' : '.volta');

  return [
    // nvm-windows: %NVM_HOME%\v22.14.0\node.exe
    ...collect(process.env.NVM_HOME, 'nvm-windows', (d) => d),
    // nvm: $NVM_DIR/versions/node/v22.14.0/bin/node
    ...collect(path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), 'nvm', (d) => path.join(d, 'bin')),
    // fnm: node-versions/v22.14.0/installation[/bin]
    ...collect(path.join(fnmRoot, 'node-versions'), 'fnm', (d) => (isWin ? path.join(d, 'installation') : path.join(d, 'installation', 'bin'))),
    // Volta: tools/image/node/22.14.0[/bin]
    ...collect(path.join(voltaRoot, 'tools', 'image', 'node'), 'volta', (d) => (isWin ? d : path.join(d, 'bin'))),
  ];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Does "22" / "22.14" / "v22.14.0" match version "22.14.0"? */
export function versionMatches(spec: string, version: string): boolean {
  const wanted = spec.trim().replace(/^v/, '').split('.');
  const actual = version.split('.');
  return wanted.every((part, i) => part === 'x' || part === '*' || part === actual[i]);
}

/** Pick the highest installed version matching the spec. */
export function pickNodeVersion(spec: string, installed: InstalledNode[]): InstalledNode | undefined {
  return installed
    .filter((n) => versionMatches(spec, n.version))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** Read .nvmrc / .node-version from the project (used for `--node auto`). */
export function readProjectNodeVersion(projectPath: string): string | undefined {
  for (const file of ['.nvmrc', '.node-version']) {
    const full = path.join(projectPath, file);
    if (fs.existsSync(full)) {
      const value = fs.readFileSync(full, 'utf-8').trim().split(/\s/)[0];
      if (/^v?\d+(\.\d+){0,2}$/.test(value)) return value;
    }
  }
  return undefined;
}

export function resolveNodePin(
  pin: string,
  projectPath: string
): { binDir?: string; version?: string; error?: string } {
  const spec = pin === 'auto' ? readProjectNodeVersion(projectPath) : pin;
  if (!spec) {
    return pin === 'auto' ? {} : { error: `Invalid Node version "${pin}"` };
  }

  const match = pickNodeVersion(spec, listInstalledNodeVersions());
  if (!match) {
    return { error: `Node ${spec} is not installed (looked in nvm-windows, nvm, fnm and Volta)` };
  }
  return { binDir: match.binDir, version: match.version };
}

/** Return a copy of env with dir prepended to PATH, whatever the key's casing. */
export function prependToPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ''}` };
}
