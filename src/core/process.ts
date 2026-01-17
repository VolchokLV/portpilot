import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Project, ProjectWithStatus } from '../types/index.js';
import { getProjects, setProjectPid, getProjectByName } from './config.js';
import { getDevCommand } from './framework.js';

// In-memory tracking for current session
const runningProcesses = new Map<string, ChildProcess>();

// PID file location for persistence
const PID_DIR = path.join(os.homedir(), '.portpilot', 'pids');
const LOG_DIR = path.join(os.homedir(), '.portpilot', 'logs');

function ensurePidDir(): void {
  if (!fs.existsSync(PID_DIR)) {
    fs.mkdirSync(PID_DIR, { recursive: true });
  }
}

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getPidFilePath(projectName: string): string {
  return path.join(PID_DIR, `${projectName}.pid`);
}

export function getLogFilePath(projectName: string): string {
  return path.join(LOG_DIR, `${projectName}.log`);
}

function savePid(projectName: string, pid: number): void {
  ensurePidDir();
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

export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getProjectStatus(project: Project): ProjectWithStatus {
  // Check in-memory first
  const memProcess = runningProcesses.get(project.name);
  if (memProcess && !memProcess.killed) {
    return { ...project, status: 'running' };
  }
  
  // Check persisted PID
  const pid = project.pid || loadPid(project.name);
  if (pid && isProcessRunning(pid)) {
    return { ...project, status: 'running', pid };
  }
  
  return { ...project, status: 'stopped' };
}

export function getAllProjectsWithStatus(): ProjectWithStatus[] {
  const projects = getProjects();
  return projects.map(getProjectStatus);
}

export async function startProject(
  projectName: string, 
  options: { detached?: boolean } = {}
): Promise<{ success: boolean; error?: string; pid?: number }> {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }
  
  // Check if already running
  const status = getProjectStatus(project);
  if (status.status === 'running') {
    return { success: false, error: `Project "${projectName}" is already running (PID: ${status.pid})` };
  }
  
  // Validate project path still exists
  if (!fs.existsSync(project.path)) {
    return { success: false, error: `Project path no longer exists: ${project.path}` };
  }
  
  const command = getDevCommand(project.framework, project.port, project.command);
  const [cmd, ...args] = command.split(' ');
  
  try {
    if (options.detached) {
      // Background mode: detach process and log to file
      ensureLogDir();
      const logFile = getLogFilePath(project.name);
      const logStream = fs.openSync(logFile, 'a');
      
      const child = spawn(cmd, args, {
        cwd: project.path,
        shell: true,
        detached: true,
        stdio: ['ignore', logStream, logStream],
        env: {
          ...process.env,
          PORT: project.port.toString(),
          BROWSER: 'none',
          FORCE_COLOR: '1', // Preserve colors in logs
        },
      });
      
      child.unref();
      
      if (!child.pid) {
        return { success: false, error: 'Failed to get process ID' };
      }
      
      runningProcesses.set(project.name, child);
      savePid(project.name, child.pid);
      setProjectPid(project.name, child.pid);
      
      return { success: true, pid: child.pid };
    } else {
      // Foreground mode: inherit stdio for live output
      const child = spawn(cmd, args, {
        cwd: project.path,
        shell: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          PORT: project.port.toString(),
          BROWSER: 'none',
          FORCE_COLOR: '1',
        },
      });
      
      if (!child.pid) {
        return { success: false, error: 'Failed to get process ID' };
      }
      
      runningProcesses.set(project.name, child);
      savePid(project.name, child.pid);
      setProjectPid(project.name, child.pid);
      
      // Handle process exit
      child.on('close', (code) => {
        runningProcesses.delete(project.name);
        clearPid(project.name);
        setProjectPid(project.name, undefined);
        
        if (code !== null && code !== 0) {
          console.log(`\nProcess exited with code ${code}`);
        }
      });
      
      // Handle Ctrl+C gracefully
      const cleanup = () => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      };
      
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      
      // Wait for process to exit
      return new Promise((resolve) => {
        child.on('close', () => {
          resolve({ success: true, pid: child.pid });
        });
        
        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      });
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export async function stopProject(projectName: string): Promise<{ success: boolean; error?: string }> {
  const project = getProjectByName(projectName);
  if (!project) {
    return { success: false, error: `Project "${projectName}" not found` };
  }
  
  const status = getProjectStatus(project);
  if (status.status !== 'running' || !status.pid) {
    return { success: false, error: `Project "${projectName}" is not running` };
  }
  
  try {
    // Use tree-kill to kill the process tree (important for npm scripts)
    const treeKill = (await import('tree-kill')).default;
    
    await new Promise<void>((resolve, reject) => {
      treeKill(status.pid!, 'SIGTERM', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Cleanup
    runningProcesses.delete(project.name);
    clearPid(project.name);
    setProjectPid(project.name, undefined);
    
    return { success: true };
  } catch (error) {
    // Force kill if graceful shutdown fails
    try {
      const treeKill = (await import('tree-kill')).default;
      await new Promise<void>((resolve) => {
        treeKill(status.pid!, 'SIGKILL', () => resolve());
      });
      
      runningProcesses.delete(project.name);
      clearPid(project.name);
      setProjectPid(project.name, undefined);
      
      return { success: true };
    } catch {
      return { success: false, error: (error as Error).message };
    }
  }
}

export async function restartProject(
  projectName: string,
  options: { detached?: boolean } = {}
): Promise<{ success: boolean; error?: string; pid?: number }> {
  const stopResult = await stopProject(projectName);
  if (!stopResult.success && !stopResult.error?.includes('not running')) {
    return stopResult;
  }
  
  // Brief delay to ensure port is released
  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  return startProject(projectName, options);
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
): Promise<{ started: string[]; errors: string[] }> {
  const projects = getAllProjectsWithStatus();
  const stopped = projects.filter((p) => p.status === 'stopped');

  const started: string[] = [];
  const errors: string[] = [];

  for (const project of stopped) {
    const result = await startProject(project.name, options);
    if (result.success) {
      started.push(project.name);
    } else {
      errors.push(`${project.name}: ${result.error}`);
    }
  }

  return { started, errors };
}

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
    return { success: false, error: `No logs found for "${projectName}". Start with --detach to generate logs.` };
  }
  
  const lines = options.lines || 50;
  
  if (options.follow) {
    // Use tail -f equivalent
    const tailProcess = spawn(
      process.platform === 'win32' ? 'powershell' : 'tail',
      process.platform === 'win32' 
        ? ['-Command', `Get-Content "${logFile}" -Tail ${lines} -Wait`]
        : ['-f', '-n', lines.toString(), logFile],
      { stdio: 'inherit', shell: false }
    );
    
    process.on('SIGINT', () => {
      tailProcess.kill();
      process.exit(0);
    });
    
    tailProcess.on('close', () => {
      process.exit(0);
    });
  } else {
    // Just read last N lines
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      const allLines = content.split('\n');
      const lastLines = allLines.slice(-lines).join('\n');
      console.log(lastLines);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
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
