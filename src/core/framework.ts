import fs from 'fs';
import os from 'os';
import path from 'path';
import { Framework, FRAMEWORKS, FRAMEWORK_PATTERNS, PackageManager, PACKAGE_MANAGERS } from '../types/index.js';

function readPackageJson(dir: string): Record<string, any> | undefined {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

export function isFramework(value: string): value is Framework {
  return (FRAMEWORKS as string[]).includes(value);
}

export function detectFramework(projectPath: string): Framework {
  const packageJson = readPackageJson(projectPath);
  const deps: Record<string, string> = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };

  // FRAMEWORK_PATTERNS is ordered from most to least specific
  for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (framework === 'custom') continue;

    if (pattern.files.some((file) => fs.existsSync(path.join(projectPath, file)))) {
      return framework as Framework;
    }
    if (pattern.deps?.some((dep) => dep in deps)) {
      return framework as Framework;
    }
  }

  return 'custom';
}

// Lockfiles checked in order; the first match wins
const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as string[]).includes(value);
}

/** A directory that ends the upward lockfile search: repo or workspace root. */
function isSearchBoundary(dir: string): boolean {
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return true;
  return Boolean(readPackageJson(dir)?.workspaces);
}

/** True when `dir` is `target` or one of its ancestors. */
function isAtOrAbove(dir: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const d = norm(dir);
  const t = norm(target);
  if (d === t) return true;
  return t.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

export interface PackageManagerDetection {
  manager: PackageManager;
  source: string; // Human-readable reason, e.g. "pnpm-lock.yaml in /repo"
}

export function detectPackageManagerWithSource(projectPath: string): PackageManagerDetection {
  // 1. Corepack "packageManager" field, e.g. "pnpm@10.4.0+sha512..."
  const packageJson = readPackageJson(projectPath);
  const name = typeof packageJson?.packageManager === 'string'
    ? packageJson.packageManager.split('@')[0]
    : '';
  if (isPackageManager(name)) {
    return { manager: name, source: 'packageManager field in package.json' };
  }

  // 2. Lockfile in the project or a parent directory (monorepo workspaces).
  // Stops at the repo/workspace root and never looks in the home directory or above,
  // so a stray lockfile in ~ doesn't decide the package manager for every project.
  const home = path.resolve(os.homedir());
  let dir = path.resolve(projectPath);
  while (true) {
    if (isAtOrAbove(dir, home) && dir !== path.resolve(projectPath)) break;

    for (const [file, manager] of LOCKFILES) {
      if (fs.existsSync(path.join(dir, file))) {
        return { manager, source: `${file} in ${dir}` };
      }
    }
    if (isSearchBoundary(dir)) break;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { manager: 'npm', source: 'default (no lockfile found)' };
}

export function detectPackageManager(projectPath: string): PackageManager {
  return detectPackageManagerWithSource(projectPath).manager;
}

export interface DevCommandOptions {
  filter?: string; // Workspace package to run
  host?: string; // Full hostname, e.g. myapp.test
}

export function getDevCommand(
  framework: Framework,
  port: number,
  customCommand?: string,
  packageManager: PackageManager = 'npm',
  options: DevCommandOptions = {}
): string {
  if (customCommand) {
    return customCommand
      .replace(/\{port\}/g, port.toString())
      .replace(/\{pm\}/g, packageManager)
      .replace(/\{host\}/g, options.host ?? 'localhost');
  }

  const pattern = FRAMEWORK_PATTERNS[framework];
  const args = pattern.args.replace(/\{port\}/g, port.toString());
  const script = pattern.script;
  const filter = options.filter ? `"${options.filter}"` : undefined;

  // npm needs "--" to forward args to the script; pnpm, yarn and bun forward them
  // directly (pnpm would pass a literal "--" through to the dev server)
  const npmArgs = args ? ` -- ${args}` : '';
  const directArgs = args ? ` ${args}` : '';

  if (filter) {
    switch (packageManager) {
      case 'pnpm':
        return `pnpm --filter ${filter} run ${script}${directArgs}`;
      case 'yarn':
        return `yarn workspace ${filter} run ${script}${directArgs}`;
      case 'bun':
        return `bun run --filter ${filter} ${script}${directArgs}`;
      default:
        return `npm run ${script} --workspace=${filter}${npmArgs}`;
    }
  }

  return packageManager === 'npm'
    ? `npm run ${script}${npmArgs}`
    : `${packageManager} run ${script}${directArgs}`;
}

/** Locate an executable on PATH (handles PATHEXT on Windows). */
export function findExecutable(name: string, envPath = process.env.PATH ?? process.env.Path ?? ''): string | undefined {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)]
    : [''];

  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here
      }
    }
  }
  return undefined;
}

export function validateProjectPath(projectPath: string): { valid: boolean; error?: string } {
  if (!fs.existsSync(projectPath)) {
    return { valid: false, error: 'Path does not exist' };
  }

  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { valid: false, error: 'No package.json found - is this a Node.js project?' };
  }

  const packageJson = readPackageJson(projectPath);
  if (!packageJson) {
    return { valid: false, error: 'Invalid package.json' };
  }
  if (!packageJson.scripts?.dev && !packageJson.scripts?.start) {
    return { valid: false, error: 'No "dev" or "start" script found in package.json' };
  }

  return { valid: true };
}

export function sanitizeProjectName(name: string, options?: { tld?: string; allowDots?: boolean }): string {
  let cleanName = name;

  // Strip TLD suffix if present (e.g., "myapp.test" -> "myapp")
  if (options?.tld) {
    const tldSuffix = `.${options.tld}`;
    if (cleanName.toLowerCase().endsWith(tldSuffix)) {
      cleanName = cleanName.slice(0, -tldSuffix.length);
    }
  }

  // Define invalid characters based on allowDots setting
  const invalidChars = options?.allowDots ? /[^a-z0-9.-]/g : /[^a-z0-9-]/g;

  return cleanName
    .toLowerCase()
    .replace(invalidChars, '-')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
}

export function suggestProjectName(projectPath: string): string {
  const dirName = path.basename(projectPath);
  return sanitizeProjectName(dirName);
}
