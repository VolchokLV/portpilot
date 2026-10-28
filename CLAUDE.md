# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PortPilot is a local development server manager for Node.js projects that provides pretty URLs (`.test` or `.localhost` domains) for local development, similar to Laravel Herd/Valet. It eliminates manual port management by automatically assigning ports to projects and routing traffic through a reverse proxy.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Watch mode compilation
npm run typecheck    # tsc --noEmit
npm test             # Build, then run node:test suites in test/ (via tsx)
npm start            # Run CLI (node dist/cli/index.js)
npm run service      # Run background proxy service
npm link             # Make 'portpilot' and 'pp' available globally
```

Tests set `PORTPILOT_CONFIG_DIR`, `PORTPILOT_HOME` and `PORTPILOT_HOSTS_FILE` (see `test/helpers.ts`) so they never touch the real config, `~/.portpilot` or the hosts file. Import core modules dynamically after calling `isolate()`, because config is created at import time.

## Architecture

```
CLI (src/cli/index.ts)          commander commands; dashboard.ts (TUI), completion.ts, util.ts
MCP (src/mcp/server.ts)         stdio JSON-RPC MCP server ("portpilot mcp")
    ↓
Core Modules (src/core/)
├── config.ts      → Config via 'conf' (lock file for writes, ID migration, corrupt-file recovery, host matching)
├── framework.ts   → Framework + package manager detection, dev command building, findExecutable
├── process.ts     → Dev server lifecycle (spawn, readiness wait, stop with PID verification, logs)
├── proc-info.ts   → Process start-time lookup (PowerShell CIM / ps) to verify PIDs
├── ports.ts       → TCP probes: free port search, wait for listen/free, IPv4/IPv6 host detection
├── proxy.ts       → HTTP/HTTPS reverse proxy (http-proxy-3), WebSockets, optional HTTP/2, SNI certs
├── pages.ts       → Error/404 HTML (all values escaped)
├── hosts.ts       → Hosts file block rendering/writing (encoding/EOL aware, backups, elevation)
├── ssl.ts         → mkcert download (sha256 verified), CA install, cert generation (sync + async)
├── daemon.ts      → Background proxy process (PID file is JSON with start time)
├── autostart.ts   → Login item: Windows Startup .vbs, macOS LaunchAgent, Linux systemd user unit
├── doctor.ts      → Health checks
├── node-version.ts→ Node version pinning (nvm-windows, nvm, fnm, Volta)
├── git.ts         → Worktree detection
└── paths.ts       → ~/.portpilot paths (PORTPILOT_HOME override)
    ↓
Service (src/service/index.ts) → Background daemon for proxy (+ autoStart of projects)
```

### Key Data Flow

1. **Project Registration**: `add` → framework detected → port from `findAvailablePort` (skips registered ports and listening ports) → stable `id` from `nextId` → config saved → hosts synced (skipped for `.localhost`) → cert generated
2. **Starting Projects**: preflight (path, Node pin, executable on PATH, port free) → spawn with `shell: true`, whole command as one string, `windowsHide` → PID + `lastStarted` saved → detached starts wait for the port to listen; early exit sets `lastError` (status `error`)
3. **Request Routing**: Browser hits `project.test:80/443` → `matchProjectByHost` (case-insensitive, trailing dot, subdomains → closest project) → target host resolved per port (127.0.0.1 or ::1, cached 30s) → `proxy.web`

### Type System

Core types are in `src/types/index.ts`:
- `Project` - id, name, path, port, framework, optional command/packageManager/filter/env/node, pid, detached, lastError, lastStarted
- `PortPilotConfig` - schemaVersion, projects, nextPort, nextId, tld, proxyPort, httpsPort, http2, autoStart, allowDotsInNames
- `ProjectStatus` - 'running' | 'stopped' | 'error'
- `Framework` - next, vite, sveltekit, react-router, tanstack-start, remix, astro, nuxt, angular, cra, custom (`FRAMEWORK_PATTERNS` is ordered most specific first)
- `PackageManager` - 'npm' | 'pnpm' | 'yarn' | 'bun'

## Important Implementation Details

- **PID verification**: a stored PID counts as the project's process only if its OS start time is within 15s of `lastStarted` (`isSameProcess`). Never kill a PID that fails this check; just clear it. If the lookup itself fails, it falls back to a liveness check
- **Detached Processes**: spawn `{ detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd] }`; logs in `~/.portpilot/logs/<name>.log`, rotated at 10 MB
- **Process Tree Killing**: `tree-kill` SIGTERM, wait up to 5s, then SIGKILL; then wait for the port to be released
- **Proxy error handling**: never write a body after `res.headersSent` (destroy instead); destroy sockets on WebSocket errors; the service logs uncaught errors and keeps running
- **Dev server host checks**: Vite-based frameworks get `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<name>.<tld>`; for Next, the proxy rewrites `Origin` to `http://localhost:<port>` only for `/_next/*` and `/__nextjs*` (not page routes, so Server Actions' origin check is untouched)
- **HTTP/2**: when `config.http2`, a `tls.Server` with ALPN hands `h2` sockets to a plain `http2` server (manual forwarding, hop-by-hop headers stripped) and `http/1.1` sockets to an `http.Server` (http-proxy + WebSocket upgrades)
- **Hosts File**: block between `# PortPilot Start - DO NOT EDIT` and `# PortPilot End`; `renderHostsContent` is pure and throws on unbalanced markers. Windows elevation uses PowerShell `-EncodedCommand`; the written file is re-read to verify
- **Package Managers**: detected at start time via `packageManager` field, then lockfiles walking up to the repo/workspace root (stops at `.git`, `pnpm-workspace.yaml`, `workspaces`; never checks the home dir). Only npm gets `--` before forwarded args. `--filter` builds `pnpm --filter`, `yarn workspace`, `npm --workspace`, `bun run --filter`
- **Config writes**: `addProject`/`removeProject`/`updateProject` run inside `withLock` (lock file next to config.json)
- **Certificates**: generated for `<domain>` and `*.<domain>`; the SNI callback only issues certs for registered projects and does it asynchronously

## Configuration Storage

Config location (conf with projectName 'portpilot', suffix 'nodejs'); `portpilot config` prints the real path:
- Windows: `%APPDATA%\portpilot-nodejs\Config\config.json`
- macOS: `~/Library/Preferences/portpilot-nodejs/config.json`
- Linux: `~/.config/portpilot-nodejs/config.json`

## Tech Stack

- Node.js ≥22.12.0, TypeScript 6, ES Modules
- CLI: commander 15, chalk 6, ora 9, cli-table3
- Proxy: http-proxy-3 (WebSocket support), node:http2
- Config: conf 16
- Process: tree-kill
- Tests: node:test + tsx
