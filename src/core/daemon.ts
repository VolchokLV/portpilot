import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORTPILOT_DIR = path.join(os.homedir(), '.portpilot');
const PROXY_PID_FILE = path.join(PORTPILOT_DIR, 'proxy.pid');
const PROXY_LOG_FILE = path.join(PORTPILOT_DIR, 'proxy.log');

function ensureDir(): void {
  if (!fs.existsSync(PORTPILOT_DIR)) {
    fs.mkdirSync(PORTPILOT_DIR, { recursive: true });
  }
}

export function getProxyPidFile(): string {
  return PROXY_PID_FILE;
}

export function getProxyLogFile(): string {
  return PROXY_LOG_FILE;
}

export function isProxyDaemonRunning(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PROXY_PID_FILE)) {
    return { running: false };
  }
  
  try {
    const pid = parseInt(fs.readFileSync(PROXY_PID_FILE, 'utf-8').trim(), 10);
    
    if (isNaN(pid)) {
      return { running: false };
    }
    
    // Check if process is actually running
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      return { running: true, pid };
    } catch {
      // Process not running, clean up stale PID file
      fs.unlinkSync(PROXY_PID_FILE);
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

export function startProxyDaemon(options: { httpsRedirect?: boolean } = {}): { 
  success: boolean; 
  pid?: number; 
  error?: string;
  alreadyRunning?: boolean;
} {
  // Check if already running
  const status = isProxyDaemonRunning();
  if (status.running) {
    return { success: false, alreadyRunning: true, pid: status.pid, error: `Proxy already running (PID: ${status.pid})` };
  }
  
  ensureDir();
  
  // Get path to service script
  const serviceScript = path.join(__dirname, '..', 'service', 'index.js');
  
  // On Windows, we need to use a different approach for detached processes
  const isWindows = process.platform === 'win32';
  
  try {
    const logStream = fs.openSync(PROXY_LOG_FILE, 'a');
    
    const args = [serviceScript];
    if (options.httpsRedirect) {
      args.push('--https-redirect');
    }
    
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logStream, logStream],
      windowsHide: true, // Hide console window on Windows
      env: {
        ...process.env,
        PORTPILOT_DAEMON: '1',
      },
    });
    
    if (!child.pid) {
      return { success: false, error: 'Failed to start proxy daemon' };
    }
    
    // Save PID
    fs.writeFileSync(PROXY_PID_FILE, child.pid.toString());
    
    // Detach from parent
    child.unref();
    
    return { success: true, pid: child.pid };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export function stopProxyDaemon(): { success: boolean; error?: string; wasRunning: boolean } {
  const status = isProxyDaemonRunning();
  
  if (!status.running || !status.pid) {
    return { success: true, wasRunning: false };
  }
  
  try {
    // Try graceful shutdown first
    process.kill(status.pid, 'SIGTERM');
    
    // Give it a moment to stop
    const startTime = Date.now();
    const timeout = 5000; // 5 seconds
    
    while (Date.now() - startTime < timeout) {
      try {
        process.kill(status.pid, 0);
        // Still running, busy wait briefly
        const waitUntil = Date.now() + 100;
        while (Date.now() < waitUntil) { /* busy wait */ }
      } catch {
        // Process stopped
        break;
      }
    }
    
    // Force kill if still running
    try {
      process.kill(status.pid, 0);
      // Still running after timeout, force kill
      process.kill(status.pid, 'SIGKILL');
    } catch {
      // Already dead, good
    }
    
    // Clean up PID file
    if (fs.existsSync(PROXY_PID_FILE)) {
      fs.unlinkSync(PROXY_PID_FILE);
    }
    
    return { success: true, wasRunning: true };
  } catch (error) {
    // Clean up PID file even on error
    if (fs.existsSync(PROXY_PID_FILE)) {
      fs.unlinkSync(PROXY_PID_FILE);
    }
    
    return { success: false, error: (error as Error).message, wasRunning: true };
  }
}

export function getProxyLogs(lines: number = 50): string | null {
  if (!fs.existsSync(PROXY_LOG_FILE)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(PROXY_LOG_FILE, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return null;
  }
}

export function clearProxyLogs(): void {
  if (fs.existsSync(PROXY_LOG_FILE)) {
    fs.writeFileSync(PROXY_LOG_FILE, '');
  }
}
