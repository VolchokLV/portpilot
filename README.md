# PortPilot

**_ Put your local dev servers on autopilot — clean .test domains with HTTPS, zero port management for Next.js, Vite, React, and any Node.js project. _**

## The Problem

Every dev server defaults to its own port (Next.js: 3000, Vite: 5173, etc.). You end up:

- Manually changing ports to avoid conflicts
- Forgetting which port maps to which project
- Accidentally killing the wrong dev server
- Never having a clean URL for local development

## The Solution

```bash
# Register your project
cd ~/projects/my-store
portpilot add my-store

# Now accessible at https://my-store.test
# PortPilot handles port assignment, hosts file, and routing automatically

portpilot start my-store -d
# ✓ my-store is running in background!
#   URL: https://my-store.test
```

## Installation

Requires Node.js 22.12 or newer.

```bash
npm install -g @volchoklv/portpilot
# or
pnpm add -g @volchoklv/portpilot
```

> **Tip:** Use `pp` as a shorthand for `portpilot` — e.g., `pp ls`, `pp start myapp -d`

### First Time Setup

```bash
# 1. Initialize HTTPS support (downloads mkcert, installs CA)
portpilot init

# 2. Start the proxy (port 80/443)
portpilot proxy -d

# 3. Start the proxy automatically at login (no admin needed)
portpilot service install

# 4. Check everything
portpilot doctor
```

**Skip the hosts file entirely:** `portpilot config --tld localhost` gives you `https://my-store.localhost`. Browsers resolve `*.localhost` to 127.0.0.1 on their own, so no hosts file edits or admin prompts are needed, and Next.js and Vite allow it without extra config.

## Commands

### Setup & Status

```bash
portpilot init                # Download mkcert, install CA, generate SSL certs
portpilot init --tld dev      # Initialize with custom TLD (e.g., .dev instead of .test)
portpilot init --regen-certs  # Regenerate all certificates (adds *.name wildcards)
portpilot status              # Show config, SSL status, proxy status (--json)
portpilot doctor              # Check proxy, hosts file, HTTPS, ports, framework config (--json)
portpilot sync                # Sync hosts file with registered projects
```

### Help

```bash
portpilot --help              # Show all available commands
portpilot <command> --help    # Show options for a specific command
```

### Configuration

```bash
portpilot config                    # View current configuration
portpilot config --tld localhost    # Use *.localhost (no hosts file needed)
portpilot config --tld dev          # Change TLD to .dev (run sync afterward)
portpilot config --allow-dots       # Allow dots in project names (e.g., emojicopy.com)
portpilot config --auto-start on    # Start all projects when the proxy service starts
portpilot config --http2 on         # Serve HTTPS over HTTP/2 (restart the proxy)
```

### Project Management

```bash
portpilot add [name]                    # Register current directory
portpilot add myapp -p /path/to/project # Register specific path
portpilot add myapp --port 4000         # Use a specific port
portpilot add myapp -c "custom command" # Custom dev command ({port}, {pm}, {host})
portpilot add myapp --pm pnpm           # Force a package manager (npm, pnpm, yarn, bun)
portpilot add web --filter @acme/web    # Run one package of a workspace (monorepo)
portpilot add myapp -e API_URL=http://api.test   # Per-project env vars (repeatable)
portpilot add myapp --node 22           # Pin a Node version ("auto" reads .nvmrc)
portpilot add myapp --framework vite    # Override framework detection

portpilot set <name|id> --port 4001     # Change any setting later
portpilot set myapp --pm auto           # Back to auto-detection
portpilot set myapp -e DEBUG=1 --unset-env OLD_VAR
portpilot info [name|id]                # Everything about one project (--json)
portpilot remove <name|id>              # Unregister project, cert, logs (alias: rm)
portpilot list                          # All projects with ID and status (alias: ls, --json, --names)
```

Project IDs are stable: removing a project never renumbers the others. A project's name always wins over an ID, so a project called `2` is still reachable by name.

### Server Control

All commands accept either project name or ID (shown in `portpilot list`):

```bash
portpilot start [name|id]      # Run dev server (foreground, shows logs)
portpilot start [name|id] -d   # Run in background; waits until the port is listening
portpilot start --all -d       # Start all projects in background
portpilot stop [name|id]       # Stop server
portpilot stop --all           # Stop all servers
portpilot restart [name|id]    # Restart in the same mode it last ran in
portpilot restart [name|id] -d # Restart in background
```

Background starts check that the dev server actually comes up. If it exits first (missing package manager, a script error), the project is marked `error` and the last log lines are shown. PortPilot also refuses to start a project whose port is already taken by something else.

### Logs

```bash
portpilot logs [name|id]        # View logs (background processes)
portpilot logs [name|id] -f     # Follow logs live (like tail -f)
portpilot logs [name|id] -n 100 # Show last 100 lines
portpilot logs [name|id] --clear # Clear log file
```

Logs rotate at 10 MB (one previous file is kept as `.log.1`).

### Dashboard

```bash
portpilot ui      # Live status + log streaming (alias: dashboard)
```

Keys: `↑/↓` select, `s` start, `x` stop, `r` restart, `o` open, `l` toggle logs, `q` quit.

### Proxy Control

```bash
portpilot proxy             # Run proxy in foreground
portpilot proxy -d          # Run proxy in background (daemon)
portpilot proxy stop        # Stop background proxy
portpilot proxy restart     # Restart background proxy
portpilot proxy status      # Check if proxy is running
portpilot proxy logs        # View proxy logs
portpilot proxy -d --https-redirect  # Force HTTP to HTTPS redirect
```

### Start at Login

```bash
portpilot service install    # Start the proxy at login (no admin needed)
portpilot service status
portpilot service uninstall
```

Windows uses a hidden launcher in your Startup folder, macOS a LaunchAgent, Linux a systemd user unit. On Linux, binding port 80 as a normal user needs `sudo sysctl net.ipv4.ip_unprivileged_port_start=80`.

### Git Worktrees

```bash
cd ../myapp-fix-ui            # a linked worktree of the registered "myapp"
portpilot add                 # registers fix-ui.myapp -> https://fix-ui.myapp.test
portpilot worktrees myapp     # list worktrees and which are registered
portpilot worktrees myapp --add   # register all of them as <branch>.myapp
```

Worktree projects inherit the main project's command, package manager, env vars and Node pin. Subdomains such as `api.myapp.test` route to `myapp`.

### AI Coding Agents (MCP)

PortPilot includes an MCP server so agents can find, start and stop your dev servers:

```bash
claude mcp add portpilot -- portpilot mcp
```

Tools: `list_projects`, `get_project`, `start_project`, `stop_project`, `restart_project`, `get_logs`, `proxy_status`, `start_proxy`, `doctor`.

### Shell Completion

```bash
portpilot completion bash >> ~/.bashrc     # or: eval "$(portpilot completion bash)"
portpilot completion zsh >> ~/.zshrc
portpilot completion fish > ~/.config/fish/completions/portpilot.fish
portpilot completion powershell >> $PROFILE
```

### Utilities

```bash
portpilot open [name|id]       # Open in browser (uses HTTPS if available)
portpilot open [name|id] -s    # Force HTTPS
portpilot uninstall            # Stop everything, remove hosts entries, certs, logs, config
portpilot uninstall --keep-ca  # Same, but keep the local CA trusted
```

### Quick Commands

From within a registered project directory (or any folder inside it), these work without a name:

```bash
portpilot start
portpilot stop
portpilot restart
portpilot logs
portpilot open
portpilot info
```

## How It Works

```
┌─────────────────────────────────────────┐
│            Browser Request              │
│       https://my-store.test             │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│     PortPilot Proxy (:80 / :443)        │
│   Routes based on Host header           │
│   SNI for per-domain SSL certs          │
│   HTTP/1.1 + WebSockets (+ HTTP/2)      │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│   Dev Server (127.0.0.1 or ::1 :3001)   │
│            Next.js / Vite / etc         │
└─────────────────────────────────────────┘
```

1. **Hosts File**: Adds entries like `127.0.0.1 my-store.test` (skipped for `.localhost`). Keeps the file's encoding and line endings and backs it up to `~/.portpilot/hosts.backup` first
2. **Port Assignment**: Picks the next port from 3001 that no project uses and nothing is listening on
3. **Reverse Proxy**: Routes requests based on hostname, to whichever of 127.0.0.1 / ::1 the dev server listens on
4. **SSL/HTTPS**: Per-domain certificates (with a `*.name` wildcard) via mkcert with SNI
5. **Process Manager**: Starts/stops dev servers, verifies PIDs before killing, waits for ports to be released

### Dev server host checks

Modern dev servers reject requests for hostnames they don't know. PortPilot handles this for you:

- **Vite** (and SvelteKit, Nuxt, Astro, React Router, TanStack Start, Remix): PortPilot sets `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` to the project's hostname when starting the dev server.
- **Next.js 15+**: dev-only endpoints (HMR websocket, dev overlay) are blocked for origins other than localhost. The proxy rewrites the Origin header for Next's internal `/_next/*` and `/__nextjs*` requests so hot reload keeps working, which prevents the stale-client hydration errors this used to cause. Adding `allowedDevOrigins: ['*.test']` to `next.config` is still recommended; `portpilot doctor` lists projects without it.
- **Angular**: add the hostname to `allowedHosts` in `angular.json` (`doctor` shows the exact value).

## Supported Frameworks

PortPilot auto-detects and configures:

| Framework        | Detection                                   | Dev Command (npm)                            |
| ---------------- | ------------------------------------------- | -------------------------------------------- |
| Next.js          | `next.config.*`                             | `npm run dev -- -p {port}`                   |
| SvelteKit        | `svelte.config.*` or `@sveltejs/kit`        | `npm run dev -- --port {port} --strictPort`  |
| React Router v7+ | `react-router.config.*` or `@react-router/dev` | `npm run dev -- --port {port} --strictPort` |
| TanStack Start   | `@tanstack/react-start` / `solid-start`     | `npm run dev -- --port {port} --strictPort`  |
| Nuxt             | `nuxt.config.*`                             | `npm run dev -- --port {port}`               |
| Angular          | `angular.json`                              | `npm run start -- --port {port}`             |
| Astro            | `astro.config.*`                            | `npm run dev -- --port {port}`               |
| Remix (classic)  | `remix.config.*`                            | `npm run dev -- --port {port}`               |
| Vite             | `vite.config.*` (js/ts/mjs/mts/cjs/cts)     | `npm run dev -- --port {port} --strictPort`  |
| Create React App | `react-scripts` in deps                     | `npm run start` (`PORT` env)                 |

`--strictPort` makes Vite fail instead of quietly moving to another port the proxy doesn't know about. Every dev server also gets `PORT` in its environment.

### Package Managers

PortPilot runs the dev script with the package manager your project uses (npm, pnpm, yarn or bun), detected each time the project starts:

1. The `packageManager` field in `package.json` (e.g. `"pnpm@10.4.0"`)
2. A lockfile in the project or a parent directory (`pnpm-lock.yaml`, `bun.lock`/`bun.lockb`, `yarn.lock`, `package-lock.json`). The search stops at the repo or workspace root (`.git`, `pnpm-workspace.yaml`, a `workspaces` field) and never looks in your home folder, so a stray lockfile there can't change every project
3. Falls back to npm

With pnpm, yarn or bun the port args are passed without `--`, e.g. `pnpm run dev -p {port}`. If the package manager isn't installed (Node 25+ no longer ships Corepack), `start` says so instead of reporting success.

```bash
portpilot add my-app --pm pnpm                    # force a manager
portpilot add web --filter @acme/web              # pnpm --filter "@acme/web" run dev -p {port}
portpilot add my-app --command "{pm} run serve --port {port}"
```

### Node Versions

`--node 22` (or `22.14.0`, or `auto` to read `.nvmrc` / `.node-version`) runs the dev server with that Node version. PortPilot looks for installed versions from nvm-windows, nvm, fnm and Volta and puts the matching one first on the dev server's PATH.

## Configuration

Run `portpilot config` to see the exact config path. Defaults:

- Windows: `%APPDATA%\portpilot-nodejs\Config\config.json`
- macOS: `~/Library/Preferences/portpilot-nodejs/config.json`
- Linux: `~/.config/portpilot-nodejs/config.json`

Certificates, logs, PID files and the mkcert binary live in `~/.portpilot/`. A corrupt config file is backed up as `config.json.corrupt-<timestamp>` and replaced with a fresh one.

## Troubleshooting

Start with `portpilot doctor`. It checks the proxy, ports 80/443, hosts entries, HTTPS, every project's port and package manager, and framework host settings, and prints a fix for each problem.

### Hydration errors or HMR not working through the proxy (Next.js)

Upgrade to PortPilot 0.4+ and restart the proxy (`portpilot proxy restart`). Earlier versions could append an error page to a page that was still streaming, and didn't account for Next's dev origin checks. Also add `allowedDevOrigins: ['*.test']` to `next.config`, or switch to `--tld localhost`.

### "Blocked request. This host is not allowed" (Vite)

Restart the project with PortPilot 0.4+ (`portpilot restart <name>`), which sets the allowed host automatically. With a custom `--command` that doesn't go through Vite's CLI, add the hostname to `server.allowedHosts`.

### "Permission denied" on port 80/443

**Windows**: ports 80/443 normally need no admin rights; if `doctor` says another program holds port 80, stop it (IIS, another proxy).
**macOS/Linux**: run with sudo, or on Linux allow low ports: `sudo sysctl net.ipv4.ip_unprivileged_port_start=80`

### Hosts file not updating

```bash
# Windows: Run terminal as Administrator
portpilot sync

# macOS/Linux:
sudo portpilot sync
```

Or avoid the hosts file: `portpilot config --tld localhost`.

### Dev server not accessible

1. `portpilot doctor`
2. `portpilot info <name>` shows the status, last error and exact command
3. `portpilot logs <name>`
4. `portpilot restart <name> -d`

### SSL certificate issues

```bash
portpilot init --regen-certs   # Regenerate certificates
portpilot proxy restart        # Pick up new certs
```

## Development

```bash
git clone https://github.com/volchoklv/portpilot
cd portpilot
npm install
npm run build
npm test      # builds, then runs node:test suites in test/
npm link      # Makes 'portpilot' command available globally
```

Tests use `PORTPILOT_CONFIG_DIR`, `PORTPILOT_HOME` and `PORTPILOT_HOSTS_FILE` to work on temporary copies, so they never touch your real config or hosts file.

## Author

**Volchok** - [volchok.dev](https://volchok.dev)

## License

MIT

## Links

- [PortPilot](https://portpilot.dev)
- [Documentation](https://portpilot.dev/docs)
- [GitHub Repository](https://github.com/VolchokLV/portpilot)
- [NPM Package](https://www.npmjs.com/package/@volchoklv/portpilot)
