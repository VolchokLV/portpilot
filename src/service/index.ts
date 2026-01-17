#!/usr/bin/env node
/**
 * PortPilot Service
 * 
 * This runs as a background service to handle:
 * 1. Reverse proxy (routes *.test domains to correct ports)
 * 2. Auto-start projects marked for autostart
 * 
 * On Windows, this can be installed as a Windows Service.
 * On Linux/macOS, this can be managed via systemd/launchd.
 */

import { startProxyServer, stopProxyServer } from '../core/proxy.js';
import { getAllProjectsWithStatus, startProject } from '../core/process.js';
import { getConfig } from '../core/config.js';

// Parse command line args
const args = process.argv.slice(2);
const httpsRedirect = args.includes('--https-redirect');

async function startService() {
  console.log('PortPilot Service starting...');
  
  // Start the proxy server
  const proxyResult = await startProxyServer({ httpsRedirect });
  if (!proxyResult.success) {
    console.error(`Failed to start proxy: ${proxyResult.error}`);
    process.exit(1);
  }
  
  console.log(`HTTP proxy running on port ${proxyResult.httpPort}`);
  if (proxyResult.sslEnabled) {
    console.log(`HTTPS proxy running on port ${proxyResult.httpsPort}`);
  }
  
  // Auto-start projects if enabled
  const config = getConfig();
  if (config.autoStart) {
    console.log('Auto-starting projects...');
    const projects = getAllProjectsWithStatus();
    
    for (const project of projects) {
      if (project.status !== 'running') {
        console.log(`  Starting ${project.name}...`);
        const result = await startProject(project.name, { detached: true });
        if (result.success) {
          console.log(`  ✓ ${project.name} started (PID: ${result.pid})`);
        } else {
          console.log(`  ✗ ${project.name} failed: ${result.error}`);
        }
      }
    }
  }
  
  console.log('PortPilot Service ready');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  stopProxyServer();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  stopProxyServer();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Start the service
startService().catch((error) => {
  console.error('Service failed to start:', error);
  process.exit(1);
});
