export type ProjectStatus = 'running' | 'stopped' | 'error';

export type Framework =
  | 'next'
  | 'vite'
  | 'sveltekit'
  | 'react-router'
  | 'tanstack-start'
  | 'remix'
  | 'astro'
  | 'nuxt'
  | 'angular'
  | 'cra'
  | 'custom';

export const FRAMEWORKS: Framework[] = [
  'next', 'vite', 'sveltekit', 'react-router', 'tanstack-start', 'remix',
  'astro', 'nuxt', 'angular', 'cra', 'custom',
];

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

export interface Project {
  id: number; // Stable ID, never reused after removal
  name: string;
  path: string;
  port: number;
  framework: Framework;
  command?: string; // Custom start command override
  packageManager?: PackageManager; // Override auto-detected package manager
  filter?: string; // Workspace package to run (pnpm --filter, yarn workspace, ...)
  env?: Record<string, string>; // Extra environment variables for the dev server
  node?: string; // Node version pin ("22", "22.14.0" or "auto" for .nvmrc/.node-version)
  pid?: number; // Process ID when running
  detached?: boolean; // Whether the last start was detached (used by restart)
  lastError?: string; // Why the last start failed
  createdAt: string;
  lastStarted?: string; // Also used to verify the PID still belongs to this project
}

export interface PortPilotConfig {
  schemaVersion: number;
  projects: Project[];
  nextPort: number;
  nextId: number;
  tld: string; // Default: 'test'
  proxyPort: number; // Default: 80
  httpsPort: number; // Default: 443
  http2: boolean; // Serve HTTPS over HTTP/2 (falls back to HTTP/1.1)
  autoStart: boolean; // Start projects on service boot
  allowDotsInNames?: boolean; // Allow dots in project names (default: false)
}

export interface ProjectWithStatus extends Project {
  status: ProjectStatus;
}

export const CONFIG_SCHEMA_VERSION = 2;

export const DEFAULT_CONFIG: PortPilotConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  projects: [],
  nextPort: 3001,
  nextId: 1,
  tld: 'test',
  proxyPort: 80,
  httpsPort: 443,
  http2: false,
  autoStart: false,
  allowDotsInNames: false,
};

export interface FrameworkPattern {
  files: string[]; // Any of these files in the project root
  deps?: string[]; // Or any of these dependencies in package.json
  script: string;
  args: string;
}

// Framework detection patterns, checked in order (more specific first).
// `script` is run with the project's package manager (npm/pnpm/yarn/bun) and
// `args` are forwarded to it. PORT is also passed via env, which CRA and Nuxt read.
// Vite-based dev servers get --strictPort so they fail instead of silently
// moving to another port that the proxy doesn't know about.
export const FRAMEWORK_PATTERNS: Record<Framework, FrameworkPattern> = {
  next: {
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs', 'next.config.mts'],
    script: 'dev',
    args: '-p {port}',
  },
  sveltekit: {
    files: ['svelte.config.js', 'svelte.config.ts'],
    deps: ['@sveltejs/kit'],
    script: 'dev',
    args: '--port {port} --strictPort',
  },
  'react-router': {
    files: ['react-router.config.ts', 'react-router.config.js'],
    deps: ['@react-router/dev'],
    script: 'dev',
    args: '--port {port} --strictPort',
  },
  'tanstack-start': {
    files: [],
    deps: ['@tanstack/react-start', '@tanstack/solid-start'],
    script: 'dev',
    args: '--port {port} --strictPort',
  },
  nuxt: {
    files: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'],
    script: 'dev',
    args: '--port {port}',
  },
  angular: {
    files: ['angular.json'],
    script: 'start',
    args: '--port {port}',
  },
  astro: {
    files: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts'],
    script: 'dev',
    args: '--port {port}',
  },
  remix: {
    files: ['remix.config.js', 'remix.config.mjs'],
    script: 'dev',
    args: '--port {port}',
  },
  vite: {
    files: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs', 'vite.config.cts'],
    script: 'dev',
    args: '--port {port} --strictPort',
  },
  cra: {
    files: [],
    deps: ['react-scripts'],
    script: 'start',
    args: '',
  },
  custom: {
    files: [],
    script: 'dev',
    args: '',
  },
};

// Frameworks whose dev server is Vite and honours __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
export const VITE_BASED: Framework[] = ['vite', 'sveltekit', 'react-router', 'tanstack-start', 'remix', 'astro', 'nuxt'];
