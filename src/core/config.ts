import Conf from 'conf';
import { PortPilotConfig, Project, DEFAULT_CONFIG } from '../types/index.js';

const config = new Conf<PortPilotConfig>({
  projectName: 'portpilot',
  defaults: DEFAULT_CONFIG,
});

export function getConfig(): PortPilotConfig {
  return {
    projects: config.get('projects'),
    nextPort: config.get('nextPort'),
    tld: config.get('tld'),
    proxyPort: config.get('proxyPort'),
    autoStart: config.get('autoStart'),
  };
}

export function getProjects(): Project[] {
  return config.get('projects');
}

export function getProjectByName(name: string): Project | undefined {
  const projects = getProjects();
  return projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

export function getProjectByNameOrId(nameOrId: string): { project: Project | undefined; id: number } {
  const projects = getProjects();

  // Check if it's a numeric ID (1-based)
  const numId = parseInt(nameOrId, 10);
  if (!isNaN(numId) && numId > 0 && numId <= projects.length) {
    return { project: projects[numId - 1], id: numId };
  }

  // Otherwise treat as name
  const index = projects.findIndex((p) => p.name.toLowerCase() === nameOrId.toLowerCase());
  if (index !== -1) {
    return { project: projects[index], id: index + 1 };
  }

  return { project: undefined, id: 0 };
}

export function getProjectId(name: string): number {
  const projects = getProjects();
  const index = projects.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  return index + 1; // 1-based ID, returns 0 if not found
}

export function getProjectByHost(host: string): Project | undefined {
  const tld = config.get('tld');
  const projects = getProjects();
  
  // Extract project name from host (e.g., "my-project.test" -> "my-project")
  const match = host.match(new RegExp(`^(.+)\\.${tld}$`));
  if (!match) return undefined;
  
  const projectName = match[1];
  return projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
}

export function getProjectByPort(port: number): Project | undefined {
  const projects = getProjects();
  return projects.find((p) => p.port === port);
}

export function addProject(
  project: Omit<Project, 'port' | 'createdAt'>,
  options: { port?: number } = {}
): Project {
  const projects = getProjects();

  // Check if project with same name exists
  if (projects.find((p) => p.name.toLowerCase() === project.name.toLowerCase())) {
    throw new Error(`Project "${project.name}" already exists`);
  }

  // Check if path is already registered
  if (projects.find((p) => p.path === project.path)) {
    throw new Error(`Path "${project.path}" is already registered`);
  }

  // Use specified port or assign next available
  let port: number;
  if (options.port) {
    // Check if port is already in use
    if (projects.find((p) => p.port === options.port)) {
      throw new Error(`Port ${options.port} is already in use by another project`);
    }
    port = options.port;
  } else {
    port = config.get('nextPort');
    config.set('nextPort', port + 1);
  }

  const newProject: Project = {
    ...project,
    port,
    createdAt: new Date().toISOString(),
  };

  config.set('projects', [...projects, newProject]);

  return newProject;
}

export function removeProject(name: string): boolean {
  const projects = getProjects();
  const filtered = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  
  if (filtered.length === projects.length) {
    return false; // Project not found
  }
  
  config.set('projects', filtered);
  return true;
}

export function updateProject(name: string, updates: Partial<Project>): Project | undefined {
  const projects = getProjects();
  const index = projects.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  
  if (index === -1) return undefined;
  
  const updated = { ...projects[index], ...updates };
  projects[index] = updated;
  config.set('projects', projects);
  
  return updated;
}

export function setProjectPid(name: string, pid: number | undefined): void {
  updateProject(name, { pid, lastStarted: pid ? new Date().toISOString() : undefined });
}

export function getTld(): string {
  return config.get('tld');
}

export function setTld(tld: string): void {
  config.set('tld', tld);
}

export function getConfigPath(): string {
  return config.path;
}
