import fs from 'fs';
import path from 'path';
import { Project } from '../types/index.js';
import { getConfig, getConfigPath, isLocalhostTld } from './config.js';
import { detectPackageManagerWithSource } from './framework.js';
import { getDesiredHostnames, getHostsEntries, checkHostsPermissions } from './hosts.js';
import { getAllProjectsWithStatus, preflightProject } from './process.js';
import { isProxyDaemonRunning } from './daemon.js';
import { getSSLStatus, getCertificatePaths } from './ssl.js';
import { canConnect, isPortInUse } from './ports.js';
import { isAutostartInstalled } from './autostart.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  status: CheckStatus;
  title: string;
  detail?: string;
  fix?: string;
}

function nodeVersionOk(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

function readNextConfig(projectPath: string): string | undefined {
  for (const file of ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs', 'next.config.mts']) {
    const full = path.join(projectPath, file);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf-8');
  }
  return undefined;
}

async function checkProject(project: Project & { status: string }, tld: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const label = `${project.name}`;

  if (!fs.existsSync(project.path)) {
    return [{ status: 'fail', title: `${label}: path is missing`, detail: project.path, fix: `portpilot remove ${project.name}` }];
  }

  const preflight = preflightProject(project);
  if (preflight.error) {
    checks.push({ status: 'fail', title: `${label}: cannot start`, detail: preflight.error });
  }

  const pm = detectPackageManagerWithSource(project.path);
  const pmDetail = project.packageManager ? `${project.packageManager} (set with --pm)` : `${pm.manager} (${pm.source})`;

  if (project.status === 'error' && project.lastError) {
    checks.push({ status: 'warn', title: `${label}: last start failed`, detail: project.lastError.split('\n')[0], fix: `portpilot logs ${project.name}` });
  }

  const listening = await isPortInUse(project.port);
  if (project.status !== 'running' && listening) {
    checks.push({
      status: 'warn',
      title: `${label}: port ${project.port} is used by another process`,
      detail: 'Starting this project will fail until the port is free.',
      fix: `portpilot set ${project.name} --port <free port>`,
    });
  }
  if (project.status === 'running' && !listening) {
    checks.push({ status: 'warn', title: `${label}: running but nothing listens on port ${project.port}`, fix: `portpilot logs ${project.name}` });
  }

  if (project.framework === 'angular') {
    checks.push({
      status: 'warn',
      title: `${label}: Angular checks the Host header`,
      detail: 'Allow the PortPilot hostname in angular.json (serve.options.allowedHosts).',
      fix: `"allowedHosts": ["${project.name}.${tld}"]`,
    });
  }

  if (checks.length === 0) {
    checks.push({ status: 'ok', title: `${label}: ${project.framework}, port ${project.port}, ${project.status}`, detail: pmDetail });
  }
  return checks;
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const config = getConfig();
  const tld = config.tld;

  // Runtime
  checks.push(nodeVersionOk(process.versions.node)
    ? { status: 'ok', title: `Node.js ${process.versions.node}` }
    : { status: 'warn', title: `Node.js ${process.versions.node} is older than 22.12`, fix: 'Upgrade to an active Node.js LTS release' });

  checks.push({ status: 'ok', title: 'Config file', detail: getConfigPath() });

  // Proxy
  const daemon = isProxyDaemonRunning();
  if (daemon.running) {
    checks.push({ status: 'ok', title: `Proxy running (PID ${daemon.pid})` });
  } else if (await canConnect(config.proxyPort, '127.0.0.1')) {
    checks.push({
      status: 'fail',
      title: `Port ${config.proxyPort} is used by another program`,
      detail: 'The PortPilot proxy cannot start while something else holds it (IIS, Skype, another proxy, a foreground "portpilot proxy").',
      fix: process.platform === 'win32' ? `netstat -ano | findstr :${config.proxyPort}` : `lsof -i :${config.proxyPort}`,
    });
  } else {
    checks.push({ status: 'warn', title: 'Proxy is not running', fix: 'portpilot proxy -d' });
  }

  checks.push(isAutostartInstalled()
    ? { status: 'ok', title: 'Proxy starts at login' }
    : { status: 'warn', title: 'Proxy does not start at login', fix: 'portpilot service install' });

  // Name resolution
  if (isLocalhostTld(tld)) {
    checks.push({ status: 'ok', title: 'TLD .localhost resolves without hosts file entries' });
  } else {
    try {
      const present = new Set(getHostsEntries());
      const missing = getDesiredHostnames().filter((h) => !present.has(h.toLowerCase()));
      checks.push(missing.length === 0
        ? { status: 'ok', title: `Hosts file has all ${present.size} entries` }
        : { status: 'fail', title: `Hosts file is missing ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'}`, detail: missing.join(', '), fix: 'portpilot sync' });
    } catch (error) {
      checks.push({ status: 'fail', title: 'Cannot read the hosts file', detail: (error as Error).message });
    }
    if (checkHostsPermissions().requiresElevation) {
      checks.push({ status: 'ok', title: 'Hosts file needs elevation to change (normal)', detail: 'Consider "portpilot config --tld localhost" to avoid hosts file edits entirely.' });
    }
  }

  // HTTPS
  const ssl = getSSLStatus();
  if (!ssl.mkcertInstalled || !ssl.caInstalled) {
    checks.push({ status: 'warn', title: 'HTTPS is not set up', fix: 'portpilot init' });
  } else {
    checks.push({ status: 'ok', title: 'Local CA installed', detail: ssl.caDir ?? undefined });
    const missingCerts = config.projects.filter((p) => !getCertificatePaths(`${p.name}.${tld}`));
    if (missingCerts.length > 0) {
      checks.push({ status: 'warn', title: `${missingCerts.length} project(s) have no certificate yet`, detail: missingCerts.map((p) => p.name).join(', '), fix: 'portpilot init' });
    }
    if (daemon.running && !(await canConnect(config.httpsPort, '127.0.0.1'))) {
      checks.push({ status: 'warn', title: `Nothing listens on HTTPS port ${config.httpsPort}`, fix: 'portpilot proxy restart' });
    }
  }

  // Duplicate ports
  const byPort = new Map<number, string[]>();
  for (const p of config.projects) byPort.set(p.port, [...(byPort.get(p.port) ?? []), p.name]);
  for (const [port, names] of byPort) {
    if (names.length > 1) {
      checks.push({ status: 'fail', title: `Port ${port} is assigned to ${names.join(' and ')}`, fix: `portpilot set ${names[1]} --port <free port>` });
    }
  }

  // Projects
  const projects = getAllProjectsWithStatus();
  for (const project of projects) {
    checks.push(...(await checkProject(project, tld)));
  }

  // One summary line for Next apps without allowedDevOrigins
  if (!isLocalhostTld(tld)) {
    const missing = projects.filter((p) => {
      if (p.framework !== 'next') return false;
      const nextConfig = readNextConfig(p.path);
      return nextConfig !== undefined && !nextConfig.includes('allowedDevOrigins');
    });
    if (missing.length > 0) {
      checks.push({
        status: 'warn',
        title: `${missing.length} Next.js project(s) have no allowedDevOrigins in next.config`,
        detail: `${missing.map((p) => p.name).join(', ')}. PortPilot rewrites the Origin of Next dev requests so HMR works through the proxy, but adding it is the supported fix.`,
        fix: `allowedDevOrigins: ['*.${tld}'],`,
      });
    }
  }

  return checks;
}
