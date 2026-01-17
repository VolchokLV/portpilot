# PortPilot - Development Handoff Document

## Project Overview

**PortPilot** is a local development server manager for Node.js projects that provides clean URLs (e.g., `https://my-app.test`) instead of `localhost:3000`. Think of it as Laravel Herd/Valet but for the Next.js/Vite/React ecosystem on Windows.

**Repository Location:** `D:\projects\port-pilot`

## Problem Solved

- **Port collision**: Multiple projects fighting for ports
- **Cognitive overhead**: Remembering which project runs on which port
- **URL ugliness**: `localhost:3000` vs `my-app.test`
- **HTTPS for local dev**: Required for OAuth, WebAuthn, Service Workers, Geolocation APIs

## Architecture

```
Browser → https://triton.test
              ↓
    PortPilot Proxy (ports 80/443)
    Routes based on Host header
    Uses SNI for per-domain SSL certs
              ↓
    localhost:3003 (Next.js dev server)
```

### Core Components

| File | Purpose |
|------|---------|
| `src/cli/index.ts` | Commander.js CLI - all user commands |
| `src/core/config.ts` | Project registry, persistent storage via `conf` package |
| `src/core/proxy.ts` | HTTP/HTTPS reverse proxy with SNI, styled error pages |
| `src/core/ssl.ts` | mkcert download, CA install, per-domain cert generation |
| `src/core/daemon.ts` | Background proxy process management |
| `src/core/hosts.ts` | Windows/Mac/Linux hosts file management |
| `src/core/process.ts` | Dev server start/stop, process lifecycle |
| `src/core/framework.ts` | Auto-detect Next.js, Vite, CRA, Remix, Astro |
| `src/service/index.ts` | Background service entry point |

### Data Storage

- **Config:** `%APPDATA%/portpilot-nodejs/config.json`
- **SSL Certs:** `~/.portpilot/certs/[domain].pem`
- **mkcert binary:** `~/.portpilot/bin/mkcert.exe`
- **Proxy PID:** `~/.portpilot/proxy.pid`
- **Proxy logs:** `~/.portpilot/proxy.log`

## Tech Stack

- **TypeScript** with ESM modules
- **Commander.js** - CLI framework
- **http-proxy** - Reverse proxy with WebSocket support (HMR)
- **mkcert** - Local CA and certificate generation
- **conf** - Persistent config storage
- **chalk, ora, cli-table3** - CLI UI
- **tree-kill** - Process cleanup on Windows

## CLI Commands

### Setup & Status
```bash
portpilot init              # Download mkcert, install CA, generate certs
portpilot status            # Show config, SSL status, proxy status
```

### Project Management
```bash
portpilot add [name]        # Register current directory
portpilot add myapp -p /path/to/project
portpilot remove <name>     # Unregister project
portpilot list              # Show all projects with status
```

### Server Control
```bash
portpilot start [name]      # Run dev server (foreground, shows logs)
portpilot start [name] -d   # Run in background (detached)
portpilot stop [name]       # Stop server
portpilot stop --all        # Stop all servers
portpilot restart [name]    # Restart server
portpilot logs [name]       # View logs (background processes)
portpilot logs [name] -f    # Follow logs live
```

### Proxy Control
```bash
portpilot proxy             # Run proxy in foreground
portpilot proxy -d          # Run proxy in background
portpilot proxy stop        # Stop background proxy
portpilot proxy status      # Check if proxy is running
portpilot proxy logs        # View proxy logs
portpilot proxy --https-redirect  # Force HTTP→HTTPS
```

### Utilities
```bash
portpilot open [name]       # Open in browser (prefers HTTPS)
portpilot open [name] --https
portpilot sync              # Sync hosts file with projects
```

## Key Implementation Details

### SSL/HTTPS (Important!)

Browsers don't trust wildcard certs for TLDs like `.test`. The solution:
- **Generate individual certs per project domain** (e.g., `triton.test.pem`)
- **Use SNI (Server Name Indication)** to serve the correct cert per domain
- **On-the-fly cert generation** when proxy encounters new domains

```typescript
// SNI callback in proxy.ts
SNICallback: (servername, callback) => {
  const ctx = certCache.get(servername);
  if (ctx) {
    callback(null, ctx);
  } else {
    // Generate cert on-the-fly
    const result = generateCertificate(servername);
    // ... cache and return
  }
}
```

### Process Management

- Default: **Foreground mode** - inherits stdio, shows live console output
- `-d` flag: **Detached mode** - runs in background, logs to file
- Uses `tree-kill` on Windows to kill entire process tree (npm spawns child processes)

### Hosts File

Windows: `C:\Windows\System32\drivers\etc\hosts`
- Requires Administrator privileges
- Uses PowerShell elevation when needed
- Adds entries like: `127.0.0.1 myapp.test`

### Framework Detection

Checks `package.json` for:
- `next` → Next.js
- `vite` → Vite
- `react-scripts` → Create React App
- `@remix-run` → Remix
- `astro` → Astro

Sets appropriate dev command with port placeholder:
```typescript
'next': 'npm run dev -- -p {port}'
'vite': 'npm run dev -- --port {port}'
```

## Styling

Error pages use a consistent dark theme matching the landing page:
- **Tailwind CSS** via CDN
- **Inter font** for display
- **Fira Code** for monospace
- **Grid background pattern** with radial mask
- **Material Icons** for icons

Colors:
```javascript
"background-dark": "#050505"
"surface-dark": "#0F0F0F"
"border-dark": "#27272a"
"text-secondary": "#A1A1AA"
```

## Known Issues / TODOs

1. **Windows Service installer** - Currently proxy runs as background process, not Windows Service
2. **System tray GUI** - No GUI yet, CLI only
3. **Auto-start on boot** - Need Windows Service or Task Scheduler integration
4. **Firefox SSL** - mkcert warns Firefox doesn't support the CA on Windows
5. **Deprecation warning** - `util._extend` in http-proxy dependency

## Development Workflow

```bash
cd D:\projects\port-pilot
npm install
npm run build           # Compile TypeScript
npm link                # Make `portpilot` command available globally

# Test changes
portpilot proxy stop
npm run build
portpilot proxy -d
portpilot start myproject
```

## Testing HTTPS

```bash
# Clean slate
portpilot proxy stop
del %USERPROFILE%\.portpilot\certs\*

# Regenerate
portpilot init          # Generates certs for all registered projects

# Start
portpilot proxy -d
portpilot proxy logs    # Should show HTTP :80 and HTTPS :443

# Verify
curl -I https://myapp.test  # Or open in browser
```

## File Structure

```
portpilot/
├── src/
│   ├── cli/
│   │   └── index.ts        # All CLI commands
│   ├── core/
│   │   ├── config.ts       # Project registry
│   │   ├── daemon.ts       # Background process mgmt
│   │   ├── framework.ts    # Framework detection
│   │   ├── hosts.ts        # Hosts file management
│   │   ├── index.ts        # Barrel exports
│   │   ├── process.ts      # Dev server lifecycle
│   │   ├── proxy.ts        # HTTP/HTTPS proxy + error pages
│   │   └── ssl.ts          # Certificate management
│   ├── service/
│   │   └── index.ts        # Background service entry
│   └── types/
│       └── index.ts        # TypeScript interfaces
├── dist/                   # Compiled JS (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration Schema

```typescript
interface PortPilotConfig {
  tld: string;              // Default: 'test'
  proxyPort: number;        // Default: 80
  basePort: number;         // Default: 3001 (auto-increment)
  autoStart: boolean;       // Default: false
  projects: Project[];
}

interface Project {
  name: string;             // e.g., 'triton'
  path: string;             // e.g., 'D:\projects\triton'
  port: number;             // e.g., 3003
  framework: string;        // e.g., 'nextjs'
  command?: string;         // Custom dev command
  pid?: number;             // Running process ID
}
```

## Potential Enhancements

1. **`portpilot park`** - Like Valet, register entire directory of projects
2. **`portpilot share`** - Expose via ngrok/cloudflare tunnel
3. **`portpilot secure`** - Per-project HTTPS toggle
4. **GUI** - Electron/Tauri system tray app
5. **Docker support** - Proxy to container ports
6. **Multi-machine** - Proxy to remote dev servers

## Contact / Context

This project was built for managing multiple Next.js projects (Vapetasia, Triton Distribution, Vegas Drop Top, etc.) with clean local URLs. The user (Volchok) is a mid-level programmer comfortable with TypeScript, Next.js, and system administration.
