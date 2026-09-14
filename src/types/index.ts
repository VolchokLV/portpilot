export type ProjectStatus = 'running' | 'stopped' | 'error';

export type Framework = 'next' | 'vite' | 'cra' | 'remix' | 'astro' | 'custom';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

export interface Project {
  name: string;
  path: string;
  port: number;
  framework: Framework;
  command?: string; // Custom start command override
  packageManager?: PackageManager; // Override auto-detected package manager
  pid?: number; // Process ID when running
  createdAt: string;
  lastStarted?: string;
}

export interface PortPilotConfig {
  projects: Project[];
  nextPort: number;
  tld: string; // Default: 'test'
  proxyPort: number; // Default: 80
  autoStart: boolean; // Start projects on service boot
  allowDotsInNames?: boolean; // Allow dots in project names (default: false)
}

export interface ProjectWithStatus extends Project {
  status: ProjectStatus;
}

export const DEFAULT_CONFIG: PortPilotConfig = {
  projects: [],
  nextPort: 3001,
  tld: 'test',
  proxyPort: 80,
  autoStart: false,
  allowDotsInNames: false,
};

// Framework detection patterns
// `script` is run with the project's package manager (npm/pnpm/yarn/bun) and
// `args` are forwarded to it. PORT is also passed via env, which CRA reads.
export const FRAMEWORK_PATTERNS: Record<Framework, { files: string[]; script: string; args: string }> = {
  next: {
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    script: 'dev',
    args: '-p {port}',
  },
  vite: {
    files: ['vite.config.js', 'vite.config.ts'],
    script: 'dev',
    args: '--port {port}',
  },
  cra: {
    files: [], // Detected by react-scripts in package.json
    script: 'start',
    args: '',
  },
  remix: {
    files: ['remix.config.js'],
    script: 'dev',
    args: '--port {port}',
  },
  astro: {
    files: ['astro.config.mjs', 'astro.config.ts'],
    script: 'dev',
    args: '--port {port}',
  },
  custom: {
    files: [],
    script: 'dev',
    args: '',
  },
};
