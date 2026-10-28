import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Project, ProjectWithStatus, VITE_BASED } from '../types/index.js';
import { getProjects, setProjectPid, getProjectByName, updateProject, getTld } from './config.js';
import { getDevCommand, detectPackageManager, findExecutable } from './framework.js';
import { PID_DIR, LOG_DIR } from './paths.js';
import { getProcessStartTimes, isProcessAlive, isSameProcess, clearProcessCache } from './proc-info.js';
import { isPortInUse, waitForPort, waitForPortFree } from './ports.js';
import { resolveNodePin, prependToPath } from './node-version.js';

// In-memory tracking for current session
const runningProcesses = new Map<string, ChildProcess>();

const MAX_LOG_BYTES = 10 * 1024 * 1024;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getPidFilePath(projectName: string): string {
  return path.join(PID_DIR, `${projectName}.pid`);
}

export function getLogFilePath(projectName: string): string {
  return path.join(LOG_DIR, `${projectName}.log`);
}

function savePid(projectName: string, pid: number): void {
  ensureDir(PID_DIR);
  fs.writeFileSync(getPidFilePath(projectName), pid.toString());
}

function loadPid(projectName: string): number | undefined {
  const pidFile = getPidFilePath(projectName);
  if (!fs.existsSync(pidFile)) return undefined;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function clearPid(projectName: string): void {
  const pidFile = getPidFilePath(projectName);
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

/** Delete pid and log files for a removed project. */
export function removeProjectFiles(projectName: string): void {
  clearPid(projectName);
  for (const file of [getLogFilePath(projectName), `${getLogFilePath(projectName)}.1`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

/** Keep one previous log around once the current one passes 10 MB. */
function rotateLog(logFile: string): void {
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // No log yet
  }
}

export function isProcessRunning(pid: number): boolean {
  return isProcessAlive(pid);
}

function statusFor(project: Project, startTimes?: Map<number, number | null>): ProjectWithStatus {
  // Check in-memory first (exitCode stays null while the child is alive)
  const memProcess = runningProcesses.get(project.name);
  if (memProcess && memProcess.exitCode === null && memProcess.signalCode === null) {
    return { ...project, status: 'running', pid: memProcess.pid };
  }

  // Check persisted PID, and make sure it is still the process we started
  const pid = project.pid || loadPid(project.name);
  if (pid && isSameProcess(pid, project.lastStarted, startTimes)) {
    return { ...project, status: 'running', pid };
  }

  const { pid: _stale, ...rest } = project;
  return { ...rest, status: project.lastError ? 'error' : 'stopped' };
}

export function getProjectStatus(project: Project): ProjectWithStatus {
  return statusFor(project);
}

export function getAllProjectsWithStatus(): ProjectWithStatus[] {
  const projects = getProjects();
  // One process lookup for every live PID instead of one per project
  const pids = projects
    .map((p) => p.pid || loadPid(p.name))
    .filter((pid): pid is number => typeof pid === 'number' && isProcessAlive(pid));
  const startTimes = pids.length > 0 ? getProcessStartTimes(pids) : undefined;
  return projects.map((p) => statusFor(p, startTimes));
}

export function getProjectHost(project: Project): string {
  return `${project.name}.${getTld()}`;
}

export function resolveDevCommand(project: Project): string {
  const packageManager = project.packageManager ?? detectPackageManager(project.path);
  return getDevCommand(project.framework, project.port, project.command, packageManager, {
    filter: project.filter,
    host: getProjectHost(project),
  });
}

/** Environment for a project's dev server. */
export function buildProjectEnv(project: Project): { env?: NodeJS.ProcessEnv; nodeVersion?: string; error?: string } {
  const host = getProjectHost(project);
  let env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: project.port.toString(),
    BROWSER: 'none',
    FORCE_COLOR: '1', // Preserve colors in logs
  };

  // Vite 6+ rejects unknown Host headers (CVE-2025-24010). This env var is Vite's
  // documented way to allow extra hosts without editing vite.config.
  if (VITE_BASED.includes(project.framework) || project.framework === 'custom') {
    const existing = process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS;
    env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = existing ? `${existing},${host}` : host;
  }

  if (project.env) {
    env = { ...env, ...project.env };
  }

  let nodeVersion: string | undefined;
  if (project.node) {
    const resolved = resolveNodePin(project.node, project.path);
    if (resolved.error) return { error: resolved.error };
    if (resolved.binDir) {
      env = prependToPath(env, resolved.binDir);
      nodeVersion = resolved.version;
    }
  }

  return { env, nodeVersion };
}

function pathOf(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  return key ? env[key] ?? '' : '';
}

/** Checks that don't need the network: path, executable on PATH, Node pin. */
export function preflightProject(project: Project): { command: string; env: NodeJS.ProcessEnv; error?: string } {
  const command = resolveDevCommand(project);
  if (!fs.existsSync(project.path)) {
    return { command, env: process.env, error: `Project path no longer exists: ${project.path}` };
  }

  const built = buildProjectEnv(project);
  if (built.error || !built.env) {
    return { command, env: process.env, error: built.error };
  }

  // Make sure the program the command starts with exists (pnpm missing after
  // Node dropped Corepack is the common case)
  const program = command.trim().split(/\s+/)[0];
  if (program && !program.includes('/') && !program.includes('\\') && !findExecutable(program, pathOf(built.env))) {
    const hint = ['pnpm', 'yarn'].includes(program)
      ? ` Install it with "npm install -g ${program}" or run "corepack enable".`
      : program === 'bun'
        ? ' Install it from https://bun.sh.'
        : '';
    return { command, env: built.env, error: `"${program}" was not found on PATH.${hint}` };
  }

  return { command, env: built.env };
}

/** Last N lines of a project's log file (reads only the tail of large files). */
export function getLogTail(projectName: string, lines = 50): string | undefined {
  const logFile = getLogFilePath(projectName);
  if (!fs.existsSync(logFile)) return undefined;

  const fd = fs.openSync(logFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const all = buffer.toString('utf-8').split(/\r?\n/);
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

export interface StartResult {
  success: boolean;
  error?: string;
  pid?: number;
  ready?: boolean; // Port accepted connections before we returned
  warning?: string;
  command?: string;
}

export async function startProject(
  projectName: string,
  options: { detached?: boolean; readyTimeoutMs?: number } = {}
): Promise<StartResult> {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }

  const status = getProjectStatus(project);
  if (status.status === 'running') {
    return { success: false, error: `Project "${project.name}" is already running (PID: ${status.pid})` };
  }

  const preflight = preflightProject(project);
  if (preflight.error) {
    updateProject(project.name, { lastError: preflight.error, pid: undefined });
    return { success: false, error: preflight.error, command: preflight.command };
  }
  const { command, env } = preflight;

  // Something else holding the port would make the proxy route to the wrong app
  if (await isPortInUse(project.port)) {
    const error = `Port ${project.port} is already in use by another process. Free it or change the port with "portpilot set ${project.name} --port <n>".`;
    updateProject(project.name, { lastError: error, pid: undefined });
    return { success: false, error, command };
  }

  try {
    if (options.detached) {
      ensureDir(LOG_DIR);
      const logFile = getLogFilePath(project.name);
      rotateLog(logFile);
      const logFd = fs.openSync(logFile, 'a');
      fs.writeSync(logFd, `\n[portpilot] ${new Date().toISOString()} starting: ${command}\n`);

      // Passing the whole command as one string with shell: true avoids
      // Node's DEP0190 warning about shell + args arrays
      const child = spawn(command, {
        cwd: project.path,
        shell: true,
        detached: true,
        windowsHide: true, // No console window per dev server on Windows
        stdio: ['ignore', logFd, logFd],
        env,
      });
      // The child has its own copy of the descriptor
      fs.closeSync(logFd);

      if (!child.pid) {
        return { success: false, error: 'Failed to get process ID', command };
      }

      let exited: string | undefined;
      child.on('exit', (code, signal) => {
        exited = signal ? `exited (${signal})` : `exited with code ${code}`;
      });
      child.on('error', (err) => {
        exited = err.message;
      });
      child.unref();

      runningProcesses.set(project.name, child);
      savePid(project.name, child.pid);
      setProjectPid(project.name, child.pid, { detached: true, lastError: undefined });

      // Wait until the dev server is actually listening
      const wait = await waitForPort(project.port, {
        timeoutMs: options.readyTimeoutMs ?? 30000,
        shouldStop: () => exited,
      });

      if (wait.stopped) {
        runningProcesses.delete(project.name);
        clearPid(project.name);
        const tail = getLogTail(project.name, 15);
        const error = `Dev server ${wait.stopped} before listening on port ${project.port}.`;
        setProjectPid(project.name, undefined, { lastError: error });
        return { success: false, error: tail ? `${error}\n\nLast log lines:\n${tail}` : error, pid: child.pid, command };
      }

      if (!wait.ready) {
        return {
          success: true,
          pid: child.pid,
          ready: false,
          command,
          warning: `Started, but nothing is listening on port ${project.port} yet. Check "portpilot logs ${project.name}".`,
        };
      }

      return { success: true, pid: child.pid, ready: true, command };
    }

    // Foreground mode: inherit stdio for live output
    const child = spawn(command, {
      cwd: project.path,
      shell: true,
      stdio: 'inherit',
      env,
    });

    if (!child.pid) {
      return { success: false, error: 'Failed to get process ID', command };
    }

    runningProcesses.set(project.name, child);
    savePid(project.name, child.pid);
    setProjectPid(project.name, child.pid, { detached: false, lastError: undefined });

    // Ctrl+C reaches the child directly through the shared console; this
    // covers SIGTERM sent to the CLI itself
    const cleanup = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    return await new Promise<StartResult>((resolve) => {
      child.on('close', (code) => {
        process.off('SIGINT', cleanup);
        process.off('SIGTERM', cleanup);
        runningProcesses.delete(project.name);
        clearPid(project.name);
        setProjectPid(project.name, undefined);

        if (code !== null && code !== 0) {
          console.log(`\nProcess exited with code ${code}`);
        }
        resolve({ success: true, pid: child.pid, command });
      });

      child.on('error', (err) => {
        resolve({ success: false, error: err.message, command });
      });
    });
  } catch (error) {
    return { success: false, error: (error as Error).message, command };
  }
}

async function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const treeKill = (await import('tree-kill')).default;
  await new Promise<void>((resolve) => {
    treeKill(pid, signal, () => resolve());
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isProcessAlive(pid);
}

export async function stopProject(projectName: string): Promise<{ success: boolean; error?: string }> {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }

  const status = getProjectStatus(project);
  if (status.status !== 'running' || !status.pid) {
    // Forget a stale or reused PID without touching whatever process owns it now
    if (project.pid || loadPid(project.name)) {
      clearPid(project.name);
      setProjectPid(project.name, undefined);
    }
    return { success: false, error: `Project "${project.name}" is not running` };
  }

  const pid = status.pid;
  await killTree(pid, 'SIGTERM');
  if (!(await waitForExit(pid, 5000))) {
    await killTree(pid, 'SIGKILL');
    if (!(await waitForExit(pid, 3000))) {
      return { success: false, error: `Could not stop PID ${pid} (access denied?)` };
    }
  }

  runningProcesses.delete(project.name);
  clearPid(project.name);
  clearProcessCache(pid);
  setProjectPid(project.name, undefined);

  // Child processes can hold the port for a moment after the shell exits
  await waitForPortFree(project.port, 5000);

  return { success: true };
}

export async function restartProject(
  projectName: string,
  options: { detached?: boolean } = {}
): Promise<StartResult> {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }

  const stopResult = await stopProject(project.name);
  if (!stopResult.success && !stopResult.error?.includes('not running')) {
    return stopResult;
  }

  if (!(await waitForPortFree(project.port, 10000))) {
    return { success: false, error: `Port ${project.port} is still in use after stopping ${project.name}` };
  }

  // Default to however the project was started last time
  const detached = options.detached ?? project.detached ?? false;
  return startProject(project.name, { detached });
}

export async function stopAllProjects(): Promise<{ stopped: string[]; errors: string[] }> {
  const projects = getAllProjectsWithStatus();
  const running = projects.filter((p) => p.status === 'running');

  const stopped: string[] = [];
  const errors: string[] = [];

  for (const project of running) {
    const result = await stopProject(project.name);
    if (result.success) {
      stopped.push(project.name);
    } else {
      errors.push(`${project.name}: ${result.error}`);
    }
  }

  return { stopped, errors };
}

export async function startAllProjects(
  options: { detached?: boolean } = {}
): Promise<{ started: string[]; errors: string[]; warnings: string[] }> {
  const projects = getAllProjectsWithStatus();
  const stopped = projects.filter((p) => p.status !== 'running');

  const started: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const project of stopped) {
    const result = await startProject(project.name, options);
    if (result.success) {
      started.push(project.name);
      if (result.warning) warnings.push(`${project.name}: ${result.warning}`);
    } else {
      errors.push(`${project.name}: ${result.error}`);
    }
  }

  return { started, errors, warnings };
}

/** Print the last lines of a log and optionally keep printing new output. */
export function tailLogs(
  projectName: string,
  options: { lines?: number; follow?: boolean } = {}
): { success: boolean; error?: string } {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }

  const logFile = getLogFilePath(project.name);
  if (!fs.existsSync(logFile)) {
    return { success: false, error: `No logs found for "${project.name}". Start with --detach to generate logs.` };
  }

  const tail = getLogTail(project.name, options.lines || 50);
  if (tail) console.log(tail);

  if (options.follow) {
    // Poll the file instead of shelling out to tail/PowerShell, so it behaves the same everywhere
    let position = fs.statSync(logFile).size;
    const timer = setInterval(() => {
      let size: number;
      try {
        size = fs.statSync(logFile).size;
      } catch {
        return;
      }
      if (size < position) position = 0; // Rotated or cleared
      if (size === position) return;

      const fd = fs.openSync(logFile, 'r');
      const buffer = Buffer.alloc(size - position);
      fs.readSync(fd, buffer, 0, buffer.length, position);
      fs.closeSync(fd);
      position = size;
      process.stdout.write(buffer.toString('utf-8'));
    }, 500);

    process.on('SIGINT', () => {
      clearInterval(timer);
      process.exit(0);
    });
  }

  return { success: true };
}

export function clearLogs(projectName: string): { success: boolean; error?: string } {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }

  const logFile = getLogFilePath(project.name);

  if (fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, '');
  }

  return { success: true };
}
