export type ProjectStatus = 'running' | 'stopped' | 'error';

export type Framework = 'next' | 'vite' | 'cra' | 'remix' | 'astro' | 'custom';

export interface Project {
  name: string;
  path: string;
  port: number;
  framework: Framework;
  command?: string; // Custom start command override
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
};

// Framework detection patterns
export const FRAMEWORK_PATTERNS: Record<Framework, { files: string[]; devCommand: string }> = {
  next: {
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    devCommand: 'npm run dev -- -p {port}',
  },
  vite: {
    files: ['vite.config.js', 'vite.config.ts'],
    devCommand: 'npm run dev -- --port {port}',
  },
  cra: {
    files: [], // Detected by react-scripts in package.json
    devCommand: 'PORT={port} npm start',
  },
  remix: {
    files: ['remix.config.js'],
    devCommand: 'npm run dev -- --port {port}',
  },
  astro: {
    files: ['astro.config.mjs', 'astro.config.ts'],
    devCommand: 'npm run dev -- --port {port}',
  },
  custom: {
    files: [],
    devCommand: 'npm run dev',
  },
};
