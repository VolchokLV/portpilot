import fs from 'fs';
import path from 'path';
import { Framework, FRAMEWORK_PATTERNS, PackageManager, PACKAGE_MANAGERS } from '../types/index.js';

export function detectFramework(projectPath: string): Framework {
  // Check for framework-specific config files
  for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (framework === 'custom' || framework === 'cra') continue;
    
    for (const file of pattern.files) {
      if (fs.existsSync(path.join(projectPath, file))) {
        return framework as Framework;
      }
    }
  }
  
  // Check for Create React App (react-scripts in package.json)
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      if (deps['react-scripts']) {
        return 'cra';
      }
    } catch {
      // Ignore parse errors
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

export function detectPackageManager(projectPath: string): PackageManager {
  // 1. Corepack "packageManager" field, e.g. "pnpm@9.1.0"
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const name = typeof packageJson.packageManager === 'string'
        ? packageJson.packageManager.split('@')[0]
        : '';
      if (isPackageManager(name)) {
        return name;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 2. Lockfile in the project or a parent directory (monorepo workspaces)
  let dir = path.resolve(projectPath);
  while (true) {
    for (const [file, manager] of LOCKFILES) {
      if (fs.existsSync(path.join(dir, file))) {
        return manager;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return 'npm';
}

export function getDevCommand(
  framework: Framework,
  port: number,
  customCommand?: string,
  packageManager: PackageManager = 'npm'
): string {
  if (customCommand) {
    return customCommand
      .replace(/\{port\}/g, port.toString())
      .replace(/\{pm\}/g, packageManager);
  }

  const pattern = FRAMEWORK_PATTERNS[framework];
  const args = pattern.args.replace('{port}', port.toString());
  if (!args) {
    return `${packageManager} run ${pattern.script}`;
  }

  // npm needs "--" to forward args to the script; pnpm, yarn and bun forward them
  // directly (pnpm would pass a literal "--" through to the dev server)
  const separator = packageManager === 'npm' ? '-- ' : '';
  return `${packageManager} run ${pattern.script} ${separator}${args}`;
}

export function validateProjectPath(projectPath: string): { valid: boolean; error?: string } {
  if (!fs.existsSync(projectPath)) {
    return { valid: false, error: 'Path does not exist' };
  }
  
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { valid: false, error: 'No package.json found - is this a Node.js project?' };
  }
  
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!packageJson.scripts?.dev && !packageJson.scripts?.start) {
      return { valid: false, error: 'No "dev" or "start" script found in package.json' };
    }
  } catch {
    return { valid: false, error: 'Invalid package.json' };
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
    .replace(/^-|-$/g, '');
}

export function suggestProjectName(projectPath: string): string {
  const dirName = path.basename(projectPath);
  return sanitizeProjectName(dirName);
}
