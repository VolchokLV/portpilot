import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORTPILOT_DIR } from './paths.js';
import { isProcessAlive, isSameProcess, clearProcessCache } from './proc-info.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROXY_PID_FILE = path.join(PORTPILOT_DIR, 'proxy.pid');
const PROXY_LOG_FILE = path.join(PORTPILOT_DIR, 'proxy.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024;

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

/** PID file holds {"pid":123,"startedAt":"..."}; older versions wrote just the number. */
function readPidFile(): { pid: number; startedAt?: string } | undefined {
  try {
    const raw = fs.readFileSync(PROXY_PID_FILE, 'utf-8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      return typeof parsed.pid === 'number' ? parsed : undefined;
    }
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? undefined : { pid };
  } catch {
    return undefined;
  }
}

function removePidFile(): void {
  try {
    fs.unlinkSync(PROXY_PID_FILE);
  } catch {
    // Already gone
  }
}

export function isProxyDaemonRunning(): { running: boolean; pid?: number } {
  const info = readPidFile();
  if (!info) {
    return { running: false };
  }

  // Make sure the PID wasn't reused by some other process since
  if (isSameProcess(info.pid, info.startedAt)) {
    return { running: true, pid: info.pid };
  }

  removePidFile();
  return { running: false };
}

export function startProxyDaemon(options: { httpsRedirect?: boolean } = {}): {
  success: boolean;
  pid?: number;
  error?: string;
  alreadyRunning?: boolean;
} {
  const status = isProxyDaemonRunning();
  if (status.running) {
    return { success: false, alreadyRunning: true, pid: status.pid, error: `Proxy already running (PID: ${status.pid})` };
  }

  ensureDir();

  const serviceScript = path.join(__dirname, '..', 'service', 'index.js');

  try {
    try {
      if (fs.statSync(PROXY_LOG_FILE).size > MAX_LOG_BYTES) {
        fs.renameSync(PROXY_LOG_FILE, `${PROXY_LOG_FILE}.1`);
      }
    } catch {
      // No log yet
    }
    const logFd = fs.openSync(PROXY_LOG_FILE, 'a');

    const args = [serviceScript];
    if (options.httpsRedirect) {
      args.push('--https-redirect');
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true, // Hide console window on Windows
      env: {
        ...process.env,
        PORTPILOT_DAEMON: '1',
      },
    });
    fs.closeSync(logFd);

    if (!child.pid) {
      return { success: false, error: 'Failed to start proxy daemon' };
    }

    fs.writeFileSync(PROXY_PID_FILE, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    child.unref();

    return { success: true, pid: child.pid };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Wait briefly for the daemon to either bind its ports or exit.
 * Returns the tail of the log when it exited, so the CLI can say why.
 */
export async function waitForDaemon(pid: number, timeoutMs = 4000): Promise<{ alive: boolean; log?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFile();
      return { alive: false, log: getProxyLogs(15) ?? undefined };
    }
    const log = getProxyLogs(5) ?? '';
    if (log.includes('PortPilot Service ready')) return { alive: true };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { alive: isProcessAlive(pid) };
}

export async function stopProxyDaemon(): Promise<{ success: boolean; error?: string; wasRunning: boolean }> {
  const status = isProxyDaemonRunning();

  if (!status.running || !status.pid) {
    return { success: true, wasRunning: false };
  }

  const pid = status.pid;
  try {
    // On Windows this terminates immediately; elsewhere the service shuts down gracefully
    process.kill(pid, 'SIGTERM');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }

    removePidFile();
    clearProcessCache(pid);
    return { success: true, wasRunning: true };
  } catch (error) {
    removePidFile();
    return { success: false, error: (error as Error).message, wasRunning: true };
  }
}

export function getProxyLogs(lines: number = 50): string | null {
  if (!fs.existsSync(PROXY_LOG_FILE)) {
    return null;
  }

  try {
    const content = fs.readFileSync(PROXY_LOG_FILE, 'utf-8');
    const allLines = content.split(/\r?\n/);
    if (allLines[allLines.length - 1] === '') allLines.pop();
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
