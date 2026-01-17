import http from 'http';
import httpProxy from 'http-proxy';
import { getProjectByHost, getConfig } from './config.js';

let proxyServer: http.Server | null = null;
let proxy: httpProxy | null = null;

export function createProxyServer(): http.Server {
  proxy = httpProxy.createProxyServer({
    ws: true, // Enable WebSocket proxying for HMR
    xfwd: true, // Add X-Forwarded headers
  });
  
  // Handle proxy errors gracefully
  proxy.on('error', (err, req, res) => {
    console.error(`Proxy error: ${err.message}`);
    
    if (res instanceof http.ServerResponse) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
      }
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>PortPilot - Connection Error</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                     padding: 40px; background: #1a1a2e; color: #eee; }
              .container { max-width: 600px; margin: 0 auto; text-align: center; }
              h1 { color: #ff6b6b; }
              code { background: #16213e; padding: 2px 8px; border-radius: 4px; }
              .hint { color: #888; margin-top: 20px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>⚠️ Connection Error</h1>
              <p>Could not connect to the dev server.</p>
              <p>Make sure the project is running:</p>
              <code>portpilot start [project-name]</code>
              <p class="hint">Error: ${err.message}</p>
            </div>
          </body>
        </html>
      `);
    }
  });
  
  const server = http.createServer((req, res) => {
    const host = req.headers.host?.split(':')[0] || '';
    const project = getProjectByHost(host);
    
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>PortPilot - Not Found</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                     padding: 40px; background: #1a1a2e; color: #eee; }
              .container { max-width: 600px; margin: 0 auto; text-align: center; }
              h1 { color: #ffd93d; }
              code { background: #16213e; padding: 2px 8px; border-radius: 4px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>🔍 Project Not Found</h1>
              <p>No project registered for <code>${host}</code></p>
              <p>Register a project with:</p>
              <code>portpilot add [name]</code>
            </div>
          </body>
        </html>
      `);
      return;
    }
    
    proxy!.web(req, res, { target: `http://127.0.0.1:${project.port}` });
  });
  
  // Handle WebSocket upgrade for HMR (Hot Module Replacement)
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host?.split(':')[0] || '';
    const project = getProjectByHost(host);
    
    if (project) {
      proxy!.ws(req, socket, head, { target: `http://127.0.0.1:${project.port}` });
    } else {
      socket.destroy();
    }
  });
  
  return server;
}

export async function startProxyServer(): Promise<{ success: boolean; port: number; error?: string }> {
  if (proxyServer) {
    return { success: false, port: 0, error: 'Proxy server is already running' };
  }
  
  const config = getConfig();
  const port = config.proxyPort;
  
  return new Promise((resolve) => {
    proxyServer = createProxyServer();
    
    proxyServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES') {
        resolve({ 
          success: false, 
          port, 
          error: `Permission denied for port ${port}. Run with admin privileges or use a port > 1024.` 
        });
      } else if (err.code === 'EADDRINUSE') {
        resolve({ 
          success: false, 
          port, 
          error: `Port ${port} is already in use. Stop the conflicting service or use a different port.` 
        });
      } else {
        resolve({ success: false, port, error: err.message });
      }
    });
    
    proxyServer.listen(port, '127.0.0.1', () => {
      console.log(`PortPilot proxy running on http://127.0.0.1:${port}`);
      resolve({ success: true, port });
    });
  });
}

export function stopProxyServer(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
  if (proxy) {
    proxy.close();
    proxy = null;
  }
}

export function isProxyRunning(): boolean {
  return proxyServer !== null;
}
