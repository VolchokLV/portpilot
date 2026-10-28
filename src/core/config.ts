import Conf from 'conf';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PortPilotConfig, Project, DEFAULT_CONFIG, CONFIG_SCHEMA_VERSION } from '../types/index.js';

// Where conf keeps config.json by default (env-paths with the "nodejs" suffix)
function defaultConfigDir(): string {
  const name = 'portpilot-nodejs';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name, 'Config');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Preferences', name);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

function createStore(): Conf<PortPilotConfig> {
  const options = {
    projectName: 'portpilot',
    defaults: DEFAULT_CONFIG,
    // PORTPILOT_CONFIG_DIR overrides the location (used by tests)
    ...(process.env.PORTPILOT_CONFIG_DIR ? { cwd: process.env.PORTPILOT_CONFIG_DIR } : {}),
  };

  try {
    return new Conf<PortPilotConfig>(options);
  } catch (error) {
    // Corrupt config.json: keep a backup and start fresh instead of crashing every command
    const dir = process.env.PORTPILOT_CONFIG_DIR || defaultConfigDir();
    const file = path.join(dir, 'config.json');
    if (fs.existsSync(file)) {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      console.error(`PortPilot config was unreadable (${(error as Error).message}).`);
      console.error(`Backed it up to ${backup} and started with a fresh config.`);
      return new Conf<PortPilotConfig>(options);
    }
    throw error;
  }
}

const config = createStore();

// ============ Locking ============
// The CLI and the background service both read-modify-write the projects array.
// A lock file serialises those writes so neither loses the other's update.

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(fn: () => T): T {
  const lockFile = `${config.path}.lock`;
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Break stale locks left by a crashed process
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 10000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Config is locked by another PortPilot process (${lockFile})`);
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Already gone
    }
  }
}

// ============ Migrations ============

function migrate(): void {
  const projects = config.get('projects') as Array<Project & { id?: number }>;
  if (projects.every((p) => typeof p.id === 'number') && config.get('schemaVersion') === CONFIG_SCHEMA_VERSION) {
    return;
  }

  withLock(() => {
    // v1 -> v2: stable IDs. Assign them in list order so existing IDs don't change.
    let nextId = Math.max(config.get('nextId') ?? 1, 1);
    const current = config.get('projects') as Array<Project & { id?: number }>;
    const used = new Set(current.filter((p) => typeof p.id === 'number').map((p) => p.id));
    const migrated = current.map((p, index) => {
      if (typeof p.id === 'number') return p as Project;
      const id = used.has(index + 1) ? nextId : index + 1;
      used.add(id);
      return { ...p, id } as Project;
    });
    nextId = Math.max(nextId, ...migrated.map((p) => p.id + 1));
    config.set('projects', migrated);
    config.set('nextId', nextId);
    config.set('schemaVersion', CONFIG_SCHEMA_VERSION);
  });
}

migrate();

// ============ Reads ============

export function getConfig(): PortPilotConfig {
  return {
    schemaVersion: config.get('schemaVersion'),
    projects: config.get('projects'),
    nextPort: config.get('nextPort'),
    nextId: config.get('nextId'),
    tld: config.get('tld'),
    proxyPort: config.get('proxyPort'),
    httpsPort: config.get('httpsPort') ?? 443,
    http2: config.get('http2') ?? false,
    autoStart: config.get('autoStart'),
    allowDotsInNames: config.get('allowDotsInNames'),
  };
}

export function getProjects(): Project[] {
  return config.get('projects');
}

export function getProjectByName(name: string): Project | undefined {
  const projects = getProjects();
  return projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

export function findProjectByNameOrId(projects: Project[], nameOrId: string): Project | undefined {
  // Names win, so a project called "2" or "3d-viewer" is still reachable by name
  const byName = projects.find((p) => p.name.toLowerCase() === nameOrId.toLowerCase());
  if (byName) return byName;

  if (/^\d+$/.test(nameOrId)) {
    const id = parseInt(nameOrId, 10);
    return projects.find((p) => p.id === id);
  }

  return undefined;
}

export function getProjectByNameOrId(nameOrId: string): { project: Project | undefined; id: number } {
  const project = findProjectByNameOrId(getProjects(), nameOrId);
  return { project, id: project?.id ?? 0 };
}

export function getProjectId(name: string): number {
  return getProjectByName(name)?.id ?? 0;
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isSamePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Find the project registered for a directory, or for the nearest parent
 * directory, so commands work from anywhere inside a project.
 */
export function getProjectByPath(dir: string): Project | undefined {
  const projects = getProjects();
  let current = path.resolve(dir);

  while (true) {
    const match = projects.find((p) => isSamePath(p.path, current));
    if (match) return match;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Match a Host header to a project. Case-insensitive, ignores a trailing dot,
 * and routes subdomains (api.myapp.test) to the closest registered project.
 */
export function matchProjectByHost(projects: Project[], tld: string, host: string): Project | undefined {
  const suffix = `.${tld.toLowerCase()}`;
  const hostname = host.toLowerCase().replace(/\.$/, '');
  if (!hostname.endsWith(suffix)) return undefined;

  let name = hostname.slice(0, -suffix.length);
  while (name) {
    const candidate = name;
    const match = projects.find((p) => p.name.toLowerCase() === candidate);
    if (match) return match;
    const dot = name.indexOf('.');
    if (dot === -1) break;
    name = name.slice(dot + 1);
  }

  return undefined;
}

export function getProjectByHost(host: string): Project | undefined {
  return matchProjectByHost(getProjects(), getTld(), host);
}

export function getProjectByPort(port: number): Project | undefined {
  const projects = getProjects();
  return projects.find((p) => p.port === port);
}

// ============ Writes ============

export function addProject(
  project: Omit<Project, 'id' | 'port' | 'createdAt'>,
  options: { port: number }
): Project {
  return withLock(() => {
    const projects = getProjects();

    if (projects.find((p) => p.name.toLowerCase() === project.name.toLowerCase())) {
      throw new Error(`Project "${project.name}" already exists`);
    }

    const samePath = projects.find((p) => isSamePath(p.path, project.path));
    if (samePath && !project.filter) {
      throw new Error(`Path "${project.path}" is already registered as "${samePath.name}"`);
    }

    if (projects.find((p) => p.port === options.port)) {
      throw new Error(`Port ${options.port} is already used by another project`);
    }

    const id = config.get('nextId') ?? 1;
    const newProject: Project = {
      ...project,
      id,
      port: options.port,
      createdAt: new Date().toISOString(),
    };

    config.set('projects', [...projects, newProject]);
    config.set('nextId', id + 1);
    if (options.port >= config.get('nextPort')) {
      config.set('nextPort', options.port + 1);
    }

    return newProject;
  });
}

export function removeProject(name: string): boolean {
  return withLock(() => {
    const projects = getProjects();
    const filtered = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());

    if (filtered.length === projects.length) {
      return false;
    }

    config.set('projects', filtered);
    return true;
  });
}

export function updateProject(name: string, updates: Partial<Project>): Project | undefined {
  return withLock(() => {
    const projects = getProjects();
    const index = projects.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());

    if (index === -1) return undefined;

    const updated = { ...projects[index], ...updates };
    // Remove keys explicitly set to undefined so the JSON stays tidy
    for (const key of Object.keys(updated) as (keyof Project)[]) {
      if (updated[key] === undefined) delete updated[key];
    }
    projects[index] = updated;
    config.set('projects', projects);

    return updated;
  });
}

export function setProjectPid(name: string, pid: number | undefined, extra: Partial<Project> = {}): void {
  updateProject(name, {
    pid,
    lastStarted: pid ? new Date().toISOString() : getProjectByName(name)?.lastStarted,
    ...extra,
  });
}

export function getNextPort(): number {
  return config.get('nextPort');
}

export function getTld(): string {
  return config.get('tld');
}

export function setTld(tld: string): void {
  config.set('tld', tld);
}

/** True when the TLD resolves to loopback without hosts file entries. */
export function isLocalhostTld(tld: string = getTld()): boolean {
  return tld.toLowerCase() === 'localhost';
}

export function isValidTld(tld: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(tld);
}

export function getAllowDots(): boolean {
  return config.get('allowDotsInNames') ?? false;
}

export function setAllowDots(allow: boolean): void {
  config.set('allowDotsInNames', allow);
}

export function getAutoStart(): boolean {
  return config.get('autoStart') ?? false;
}

export function setAutoStart(enabled: boolean): void {
  config.set('autoStart', enabled);
}

export function getHttp2(): boolean {
  return config.get('http2') ?? false;
}

export function setHttp2(enabled: boolean): void {
  config.set('http2', enabled);
}

export function getConfigPath(): string {
  return config.path;
}

/** Reset config to defaults (used by uninstall). */
export function resetConfig(): void {
  config.clear();
}
