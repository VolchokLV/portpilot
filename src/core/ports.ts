import net from 'net';

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/** Resolve true if something accepts TCP connections on host:port. */
export function canConnect(port: number, host: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Which loopback address (if any) a dev server is listening on. */
export async function findListeningHost(port: number): Promise<string | undefined> {
  for (const host of LOOPBACK_HOSTS) {
    if (await canConnect(port, host)) return host;
  }
  return undefined;
}

export async function isPortInUse(port: number): Promise<boolean> {
  return (await findListeningHost(port)) !== undefined;
}

/**
 * First port >= start that no registered project uses and nothing is listening on.
 * `inUse` is injectable for tests.
 */
export async function findAvailablePort(
  start: number,
  taken: Iterable<number>,
  inUse: (port: number) => Promise<boolean> = isPortInUse
): Promise<number> {
  const reserved = new Set(taken);
  for (let port = Math.max(start, 1024); port <= 65535; port++) {
    if (reserved.has(port)) continue;
    if (await inUse(port)) continue;
    return port;
  }
  throw new Error('No free port available');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until a port accepts connections. Stops early when `shouldStop` returns a reason
 * (e.g. the child process exited).
 */
export async function waitForPort(
  port: number,
  options: { timeoutMs?: number; intervalMs?: number; shouldStop?: () => string | undefined } = {}
): Promise<{ ready: boolean; host?: string; stopped?: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    const stopped = options.shouldStop?.();
    if (stopped) return { ready: false, stopped };
    const host = await findListeningHost(port);
    if (host) return { ready: true, host };
    await delay(options.intervalMs ?? 300);
  }
  return { ready: false };
}

/** Poll until nothing listens on the port any more. */
export async function waitForPortFree(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await delay(200);
  }
  return false;
}
