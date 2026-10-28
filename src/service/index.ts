#!/usr/bin/env node
/**
 * PortPilot Service
 *
 * This runs as a background service to handle:
 * 1. Reverse proxy (routes *.test domains to correct ports)
 * 2. Auto-start projects when autoStart is enabled (portpilot config --auto-start)
 *
 * Installed to run at login with "portpilot service install".
 */

import { startProxyServer, stopProxyServer } from '../core/proxy.js';
import { getAllProjectsWithStatus, startProject } from '../core/process.js';
import { getConfig } from '../core/config.js';

// Parse command line args
const args = process.argv.slice(2);
const httpsRedirect = args.includes('--https-redirect');

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function startService() {
  log('PortPilot Service starting...');

  const proxyResult = await startProxyServer({ httpsRedirect });
  if (!proxyResult.success) {
    log(`Failed to start proxy: ${proxyResult.error}`);
    process.exit(1);
  }

  log(`HTTP proxy running on port ${proxyResult.httpPort}`);
  if (proxyResult.sslEnabled) {
    log(`HTTPS proxy running on port ${proxyResult.httpsPort}${proxyResult.http2 ? ' (HTTP/2)' : ''}`);
  }

  // Signal readiness before auto-start, which can take a while per project
  log('PortPilot Service ready');

  const config = getConfig();
  if (config.autoStart) {
    log('Auto-starting projects...');
    const projects = getAllProjectsWithStatus();

    for (const project of projects) {
      if (project.status !== 'running') {
        log(`  Starting ${project.name}...`);
        const result = await startProject(project.name, { detached: true });
        if (result.success) {
          log(`  ✓ ${project.name} started (PID: ${result.pid})${result.warning ? ` - ${result.warning}` : ''}`);
        } else {
          log(`  ✗ ${project.name} failed: ${result.error}`);
        }
      }
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...');
  stopProxyServer();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down...');
  stopProxyServer();
  process.exit(0);
});

// One bad upstream connection must not take every .test site down: log and keep serving
process.on('uncaughtException', (error) => {
  log(`Uncaught exception (proxy keeps running): ${error.stack ?? error.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection (proxy keeps running): ${String(reason)}`);
});

startService().catch((error) => {
  log(`Service failed to start: ${error}`);
  process.exit(1);
});
