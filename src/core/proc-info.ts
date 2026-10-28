import { execFileSync } from 'child_process';

/**
 * Process start times, used to make sure a stored PID still belongs to the
 * process PortPilot started. PIDs are reused quickly (especially on Windows),
 * and killing a reused PID with tree-kill would take down an unrelated process tree.
 */

const cache = new Map<number, { start: number | null; at: number }>();
const CACHE_MS = 2000;

function powershellStartTimes(pids: number[]): Map<number, number> {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 10000,
  });
  const result = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const [pid, start] = line.trim().split(' ');
    if (pid && start) result.set(Number(pid), Number(start));
  }
  return result;
}

function psStartTimes(pids: number[]): Map<number, number> {
  const output = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 10000,
  });
  const result = new Map<number, number>();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const start = Date.parse(match[2]);
    if (!isNaN(start)) result.set(Number(match[1]), start);
  }
  return result;
}

/**
 * Look up start times (ms since epoch) for several PIDs in one call.
 * Returns undefined when the lookup itself fails, so callers can fall back
 * to a plain liveness check instead of treating every process as foreign.
 */
export function getProcessStartTimes(pids: number[]): Map<number, number | null> | undefined {
  const now = Date.now();
  const missing = pids.filter((pid) => {
    const cached = cache.get(pid);
    return !cached || now - cached.at > CACHE_MS;
  });

  if (missing.length > 0) {
    let found: Map<number, number>;
    try {
      found = process.platform === 'win32' ? powershellStartTimes(missing) : psStartTimes(missing);
    } catch {
      return undefined;
    }
    for (const pid of missing) {
      cache.set(pid, { start: found.get(pid) ?? null, at: now });
    }
  }

  return new Map(pids.map((pid) => [pid, cache.get(pid)?.start ?? null]));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const START_TOLERANCE_MS = 15000;

/**
 * True when `pid` is alive and was started within a few seconds of `startedAt`
 * (the time PortPilot recorded when it spawned it).
 */
export function isSameProcess(pid: number, startedAt: string | number | undefined, startTimes?: Map<number, number | null>): boolean {
  if (!isProcessAlive(pid)) return false;
  if (startedAt === undefined) return true; // Nothing to compare against

  const expected = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  if (isNaN(expected)) return true;

  const times = startTimes ?? getProcessStartTimes([pid]);
  if (!times) return true; // Lookup unavailable: fall back to liveness only
  const actual = times.get(pid);
  if (actual === null || actual === undefined) return false;
  return Math.abs(actual - expected) <= START_TOLERANCE_MS;
}

export function clearProcessCache(pid?: number): void {
  if (pid === undefined) cache.clear();
  else cache.delete(pid);
}
