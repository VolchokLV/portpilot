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

export function addProject(project: Omit<Project, 'port' | 'createdAt'>): Project {
  const projects = getProjects();
  
  // Check if project with same name exists
  if (projects.find((p) => p.name.toLowerCase() === project.name.toLowerCase())) {
    throw new Error(`Project "${project.name}" already exists`);
  }
  
  // Check if path is already registered
  if (projects.find((p) => p.path === project.path)) {
    throw new Error(`Path "${project.path}" is already registered`);
  }
  
  // Assign next available port
  const port = config.get('nextPort');
  
  const newProject: Project = {
    ...project,
    port,
    createdAt: new Date().toISOString(),
  };
  
  config.set('projects', [...projects, newProject]);
  config.set('nextPort', port + 1);
  
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
