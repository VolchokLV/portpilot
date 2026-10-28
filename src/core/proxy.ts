import http from 'http';
import https from 'https';
import http2 from 'http2';
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyServer } from 'http-proxy-3';
import { Project } from '../types/index.js';
import { getProjectByHost, getConfig, getTld, getProjects } from './config.js';
import { getCertificatePaths, isCAInstalled, generateCertificate, generateCertificateAsync } from './ssl.js';
import { findListeningHost } from './ports.js';
import { getErrorPage, getNotFoundPage, LOGO_PATH } from './pages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logoPath = path.join(__dirname, '../../logo.png');

// The compat HTTP/2 response has the same writeHead/end API; treat both alike
type AnyResponse = http.ServerResponse | http2.Http2ServerResponse;
const asH1 = (res: AnyResponse) => res as http.ServerResponse;

let httpServer: http.Server | null = null;
let httpsServer: net.Server | null = null; // https.Server, or tls.Server when HTTP/2 is on
let proxy: ReturnType<typeof createProxy> | null = null;
let httpsPortInUse = 443;

// ============ Target resolution ============
// Dev servers bind 127.0.0.1, ::1 or both depending on framework and OS
// (Vite on Windows often binds only ::1). Remember which one answers per port.

const targetHostCache = new Map<number, { host: string; at: number }>();
const TARGET_CACHE_MS = 30000;

async function resolveTarget(port: number): Promise<string | undefined> {
  const cached = targetHostCache.get(port);
  if (cached && Date.now() - cached.at < TARGET_CACHE_MS) {
    return cached.host;
  }
  const host = await findListeningHost(port);
  if (host) {
    targetHostCache.set(port, { host, at: Date.now() });
  } else {
    targetHostCache.delete(port);
  }
  return host;
}

function targetUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

// ============ Helpers ============

function hostnameOf(req: http.IncomingMessage | http2.Http2ServerRequest): string {
  const raw = (req.headers[':authority'] as string | undefined) ?? req.headers.host ?? '';
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.split(':')[0];
}

/**
 * Next.js 15+ blocks dev-only endpoints (HMR websocket, dev overlay) for origins
 * other than localhost unless they are listed in allowedDevOrigins. Through the
 * proxy the origin is name.test, so HMR silently fails and the client drifts out
 * of sync with server-rendered HTML (hydration errors). Rewriting Origin only for
 * those internal paths keeps Server Actions' own origin check untouched.
 */
function rewriteNextDevOrigin(req: { url?: string; headers: http.IncomingHttpHeaders }, project: Project): void {
  if (project.framework !== 'next' || !req.headers.origin) return;
  const url = req.url ?? '';
  if (url.startsWith('/_next/') || url.startsWith('/__nextjs')) {
    req.headers.origin = `http://localhost:${project.port}`;
  }
}

function serveLogo(res: AnyResponse): void {
  if (fs.existsSync(logoPath)) {
    asH1(res).writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    res.end(fs.readFileSync(logoPath));
  } else {
    asH1(res).writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Logo not found');
  }
}

function sendHtml(res: AnyResponse, status: number, html: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  asH1(res).writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function notRunningPage(project: Project, reason: string): string {
  return getErrorPage(project.name, project.port, project.path, reason);
}

// ============ Proxy ============

function createProxy() {
  const proxyInstance = createProxyServer({
    ws: true,
    xfwd: true,
  });

  proxyInstance.on('error', (err: Error, req: http.IncomingMessage, res: unknown) => {
    const project = getProjectByHost(hostnameOf(req));
    console.error(`Proxy error for ${project?.name ?? hostnameOf(req)}: ${err.message}`);
    if (project) targetHostCache.delete(project.port);

    // WebSocket errors hand us the raw socket: close it so HMR clients reconnect
    if (!(res instanceof http.ServerResponse)) {
      (res as net.Socket | undefined)?.destroy?.();
      return;
    }

    // Never append an error page to a response that is already streaming:
    // that splices foreign HTML into Next's streamed document (hydration errors)
    if (res.headersSent) {
      res.destroy(err);
      return;
    }

    sendHtml(res, 502, project
      ? notRunningPage(project, err.message)
      : getNotFoundPage(hostnameOf(req)));
  });

  // Errors on the upstream response stream must not become uncaught exceptions
  proxyInstance.on('proxyRes', (proxyRes: http.IncomingMessage) => {
    proxyRes.on('error', () => {});
  });

  return proxyInstance;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { secure: boolean; httpsRedirect?: boolean }
): Promise<void> {
  req.on('error', () => {});
  const host = hostnameOf(req);

  if (req.url === LOGO_PATH) {
    serveLogo(res);
    return;
  }

  const project = getProjectByHost(host);
  if (!project) {
    // Only claim /logo.png when no project would answer it
    if (req.url === '/logo.png') {
      serveLogo(res);
      return;
    }
    sendHtml(res, 404, getNotFoundPage(host));
    return;
  }

  // Redirect HTTP to HTTPS if enabled and SSL is up
  if (options.httpsRedirect && !options.secure && httpsServer) {
    const portSuffix = httpsPortInUse === 443 ? '' : `:${httpsPortInUse}`;
    res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url ?? '/'}` });
    res.end();
    return;
  }

  const targetHost = await resolveTarget(project.port);
  if (!targetHost) {
    sendHtml(res, 502, notRunningPage(project, `connect ECONNREFUSED 127.0.0.1:${project.port}`));
    return;
  }

  rewriteNextDevOrigin(req, project);
  proxy!.web(req, res, { target: targetUrl(targetHost, project.port) });
}

async function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
  socket.on('error', () => socket.destroy());
  const project = getProjectByHost(hostnameOf(req));
  if (!project) {
    socket.destroy();
    return;
  }

  const targetHost = await resolveTarget(project.port);
  if (!targetHost) {
    socket.destroy();
    return;
  }

  rewriteNextDevOrigin(req, project);
  proxy!.ws(req, socket, head, { target: targetUrl(targetHost, project.port) });
}

// ============ HTTP/2 ============
// http-proxy only speaks HTTP/1.1 on the incoming side, so HTTP/2 requests are
// forwarded by hand. WebSockets still arrive over HTTP/1.1 (browsers open a
// separate connection for them), which goes through the regular handler.

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'http2-settings', 'host',
]);

async function handleHttp2Request(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse): Promise<void> {
  req.on('error', () => {});
  res.stream.on('error', () => {});
  const host = hostnameOf(req);

  if (req.url === LOGO_PATH) {
    serveLogo(res);
    return;
  }

  const project = getProjectByHost(host);
  if (!project) {
    if (req.url === '/logo.png') serveLogo(res);
    else sendHtml(res, 404, getNotFoundPage(host));
    return;
  }

  const targetHost = await resolveTarget(project.port);
  if (!targetHost) {
    sendHtml(res, 502, notRunningPage(project, `connect ECONNREFUSED 127.0.0.1:${project.port}`));
    return;
  }

  const authority = (req.headers[':authority'] as string | undefined) ?? req.headers.host ?? host;
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(':') || HOP_BY_HOP.has(key) || value === undefined) continue;
    headers[key] = value;
  }
  headers.host = authority;
  const remote = req.socket?.remoteAddress ?? '';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${remote}` : remote;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = authority;
  headers['x-forwarded-port'] = String(httpsPortInUse);

  const forwarded = { url: req.url, headers: headers as http.IncomingHttpHeaders };
  rewriteNextDevOrigin(forwarded, project);

  const upstream = http.request(
    { host: targetHost, port: project.port, method: req.method, path: req.url, headers: forwarded.headers },
    (upRes) => {
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(key) || value === undefined) continue;
        outHeaders[key] = value;
      }
      upRes.on('error', () => res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    targetHostCache.delete(project.port);
    console.error(`Proxy error for ${project.name}: ${err.message}`);
    if (res.headersSent) {
      res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    } else {
      sendHtml(res, 502, notRunningPage(project, err.message));
    }
  });

  // Client went away: stop the upstream request too
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
}

// ============ Certificates ============

function projectDomain(project: Project): string {
  return `${project.name}.${getTld()}`;
}

function loadContext(certPath: string, keyPath: string): tls.SecureContext {
  return tls.createSecureContext({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  });
}

function createSniCallback(certCache: Map<string, tls.SecureContext>, fallback: tls.SecureContext) {
  return (servername: string, callback: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    // Subdomains (api.myapp.test) use the project's wildcard certificate
    const project = getProjectByHost(servername);
    if (!project) {
      // Not ours: don't mint certificates for arbitrary names
      callback(null, fallback);
      return;
    }

    const domain = projectDomain(project).toLowerCase();
    const cached = certCache.get(domain);
    if (cached) {
      callback(null, cached);
      return;
    }

    const existing = getCertificatePaths(domain);
    if (existing) {
      try {
        const ctx = loadContext(existing.certPath, existing.keyPath);
        certCache.set(domain, ctx);
        callback(null, ctx);
        return;
      } catch {
        // Fall through and regenerate
      }
    }

    // New project since the proxy started: generate without blocking other requests
    generateCertificateAsync(domain)
      .then((result) => {
        if (result.success && result.certPath && result.keyPath) {
          const ctx = loadContext(result.certPath, result.keyPath);
          certCache.set(domain, ctx);
          console.log(`Generated SSL certificate for ${domain}`);
          callback(null, ctx);
        } else {
          callback(null, fallback);
        }
      })
      .catch(() => callback(null, fallback));
  };
}

// ============ Servers ============

export interface ProxyStartResult {
  success: boolean;
  httpPort?: number;
  httpsPort?: number;
  error?: string;
  sslEnabled?: boolean;
  http2?: boolean;
}

function listen(server: net.Server, port: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES') {
        resolve({ success: false, error: `Permission denied for port ${port}. Run with admin privileges.` });
      } else if (err.code === 'EADDRINUSE') {
        resolve({ success: false, error: `Port ${port} is already in use.` });
      } else {
        resolve({ success: false, error: err.message });
      }
    });
    server.listen(port, '127.0.0.1', () => {
      // After startup, log errors instead of letting them crash the process
      server.on('error', (err) => console.error(`Server error: ${err.message}`));
      resolve({ success: true });
    });
  });
}

export async function startProxyServer(options: { httpsRedirect?: boolean } = {}): Promise<ProxyStartResult> {
  if (httpServer) {
    return { success: false, error: 'Proxy server is already running' };
  }

  const config = getConfig();
  const httpPort = config.proxyPort;
  const httpsPort = config.httpsPort ?? 443;
  httpsPortInUse = httpsPort;

  proxy = createProxy();

  httpServer = http.createServer((req, res) => {
    handleRequest(req, res, { secure: false, httpsRedirect: options.httpsRedirect }).catch((err) => {
      console.error(`Request failed: ${err.message}`);
      sendHtml(res, 500, getNotFoundPage(hostnameOf(req)));
    });
  });
  httpServer.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket as net.Socket, head).catch(() => socket.destroy());
  });
  httpServer.on('clientError', (_err, socket) => socket.destroy());

  const httpResult = await listen(httpServer, httpPort);
  if (!httpResult.success) {
    httpServer = null;
    return { success: false, error: httpResult.error };
  }

  console.log(`PortPilot HTTP proxy running on http://127.0.0.1:${httpPort}`);

  const tld = getTld();
  const projects = getProjects();

  if (!isCAInstalled() || projects.length === 0) {
    console.log('HTTPS not configured. Run "portpilot init" to enable SSL.');
    return { success: true, httpPort, sslEnabled: false };
  }

  // Load (or generate) certificates for all projects up front
  const certsGenerated: string[] = [];
  const certCache = new Map<string, tls.SecureContext>();

  for (const project of projects) {
    const domain = `${project.name}.${tld}`.toLowerCase();
    let certPaths = getCertificatePaths(domain);

    if (!certPaths) {
      const result = generateCertificate(domain);
      if (result.success) {
        certPaths = { certPath: result.certPath!, keyPath: result.keyPath! };
        certsGenerated.push(domain);
      }
    }

    if (certPaths) {
      try {
        certCache.set(domain, loadContext(certPaths.certPath, certPaths.keyPath));
      } catch (err) {
        console.error(`Failed to load cert for ${domain}: ${(err as Error).message}`);
      }
    }
  }

  if (certsGenerated.length > 0) {
    console.log(`Generated SSL certificates for: ${certsGenerated.join(', ')}`);
  }

  const fallback = certCache.values().next().value;
  if (!fallback) {
    console.log('No SSL certificates available. Run "portpilot init" and add projects.');
    return { success: true, httpPort, sslEnabled: false };
  }

  const SNICallback = createSniCallback(certCache, fallback);
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handleRequest(req, res, { secure: true }).catch((err) => {
      console.error(`Request failed: ${err.message}`);
      sendHtml(res, 500, getNotFoundPage(hostnameOf(req)));
    });
  };
  const onUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    handleUpgrade(req, socket, head).catch(() => socket.destroy());
  };

  let server: net.Server;
  if (config.http2) {
    // One TLS listener; ALPN picks HTTP/2 or HTTP/1.1 per connection. HTTP/1.1
    // connections (including WebSocket upgrades) go to a plain http.Server.
    const h1 = http.createServer(onRequest);
    h1.on('upgrade', onUpgrade);
    h1.on('clientError', (_err, socket) => socket.destroy());

    const h2 = http2.createServer();
    h2.on('request', (req, res) => {
      handleHttp2Request(req, res).catch((err) => {
        console.error(`Request failed: ${err.message}`);
        sendHtml(res, 500, getNotFoundPage(hostnameOf(req)));
      });
    });
    h2.on('sessionError', () => {});

    const tlsServer = tls.createServer({ SNICallback, ALPNProtocols: ['h2', 'http/1.1'] });
    tlsServer.on('secureConnection', (socket) => {
      socket.on('error', () => socket.destroy());
      if (socket.alpnProtocol === 'h2') h2.emit('connection', socket);
      else h1.emit('connection', socket);
    });
    tlsServer.on('tlsClientError', () => {});
    server = tlsServer;
  } else {
    const httpsSrv = https.createServer({ SNICallback }, onRequest);
    httpsSrv.on('upgrade', onUpgrade);
    httpsSrv.on('tlsClientError', () => {});
    httpsSrv.on('clientError', (_err, socket) => socket.destroy());
    server = httpsSrv;
  }

  const httpsResult = await listen(server, httpsPort);
  if (!httpsResult.success) {
    console.log(`HTTPS not available: ${httpsResult.error}`);
    return { success: true, httpPort, sslEnabled: false };
  }

  httpsServer = server;
  console.log(`PortPilot HTTPS proxy running on https://127.0.0.1:${httpsPort}${config.http2 ? ' (HTTP/2)' : ''}`);
  return { success: true, httpPort, httpsPort, sslEnabled: true, http2: config.http2 };
}

export function stopProxyServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (httpsServer) {
    httpsServer.close();
    httpsServer = null;
  }
  if (proxy) {
    proxy.close();
    proxy = null;
  }
}

export function isProxyRunning(): boolean {
  return httpServer !== null;
}

export function isHttpsEnabled(): boolean {
  return httpsServer !== null;
}
