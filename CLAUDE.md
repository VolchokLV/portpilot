# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PortPilot is a local development server manager for Node.js projects that provides pretty URLs (`.test` domains) for local development, similar to Laravel Herd/Valet. It eliminates manual port management by automatically assigning ports to projects and routing traffic through a reverse proxy.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Watch mode compilation
npm start            # Run CLI (node dist/cli/index.js)
npm run service      # Run background proxy service
npm link             # Make 'portpilot' and 'pp' available globally
```

There are no tests or linting configured in this project currently.

## Architecture

```
CLI (src/cli/index.ts)
    ↓
Core Modules (src/core/)
├── config.ts      → Config persistence via 'conf' package
├── framework.ts   → Framework detection (Next.js, Vite, CRA, Remix, Astro)
├── hosts.ts       → System hosts file manipulation
├── process.ts     → Dev server process lifecycle (spawn/kill)
└── proxy.ts       → HTTP reverse proxy with WebSocket support
    ↓
Service (src/service/index.ts) → Background daemon for proxy
```

### Key Data Flow

1. **Project Registration**: User adds project → Framework auto-detected → Port assigned (from 3001+) → Config saved
2. **Starting Projects**: CLI spawns detached process → PID tracked in config + `~/.portpilot/pids/` → Hosts file updated
3. **Request Routing**: Browser hits `project.test:80` → Proxy extracts hostname → Routes to correct `localhost:PORT`

### Type System

Core types are in `src/types/index.ts`:
- `Project` - registered project with name, path, port, framework
- `PortPilotConfig` - app config (projects array, nextPort, tld, proxyPort, autoStart)
- `ProjectStatus` - 'running' | 'stopped' | 'error'
- `Framework` - 'next' | 'vite' | 'cra' | 'remix' | 'astro' | 'custom'

## Important Implementation Details

- **Detached Processes**: Dev servers spawn with `{ detached: true, stdio: 'ignore' }` to run independently of CLI
- **Process Tree Killing**: Uses `tree-kill` package to properly terminate npm script chains (parent + children)
- **PID Persistence**: PIDs stored both in config and as files in `~/.portpilot/pids/` for recovery
- **Hosts File Isolation**: Uses marker comments (`# PortPilot Start/End`) to isolate managed entries
- **Cross-Platform Elevation**: Windows uses PowerShell elevation, macOS/Linux use sudo for hosts file
- **WebSocket Proxying**: Proxy includes upgrade handlers to support HMR connections

## Configuration Storage

Config location varies by platform:
- Windows: `%APPDATA%/portpilot/config.json`
- macOS: `~/Library/Application Support/portpilot/config.json`
- Linux: `~/.config/portpilot/config.json`

## Tech Stack

- Node.js ≥18.0.0, TypeScript 5.3, ES Modules
- CLI: commander, chalk, ora, cli-table3
- Proxy: http-proxy (with WebSocket support)
- Config: conf (cross-platform persistence)
- Process: tree-kill, detect-port
