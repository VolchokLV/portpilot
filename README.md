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

portpilot start my-store
# ✓ my-store is running!
#   URL: https://my-store.test
```

## Installation

```bash
npm install -g @volchoklv/portpilot
```

> **Tip:** Use `pp` as a shorthand for `portpilot` — e.g., `pp ls`, `pp start myapp -d`

### First Time Setup

```bash
# 1. Initialize HTTPS support (downloads mkcert, installs CA)
portpilot init

# 2. Start the proxy (requires admin for port 80/443)
portpilot proxy -d

# 3. Sync hosts file (requires admin)
portpilot sync
```

## Commands

### Setup & Status

```bash
portpilot init              # Download mkcert, install CA, generate SSL certs
portpilot init --tld dev    # Initialize with custom TLD (e.g., .dev instead of .test)
portpilot status            # Show config, SSL status, proxy status
portpilot sync              # Sync hosts file with registered projects
```

### Help

```bash
portpilot --help              # Show all available commands
portpilot <command> --help    # Show options for a specific command

# Examples
portpilot add --help          # Show options for 'add' command
portpilot start --help        # Show options for 'start' command
portpilot proxy --help        # Show options for 'proxy' command
```

### Configuration

```bash
portpilot config              # View current configuration
portpilot config --tld dev    # Change TLD to .dev (run sync afterward)
portpilot config --allow-dots # Allow dots in project names (e.g., emojicopy.com)
portpilot config --no-allow-dots  # Disallow dots in project names (default)
```

### Project Management

```bash
portpilot add [name]                    # Register current directory
portpilot add myapp -p /path/to/project # Register specific path
portpilot add myapp --port 4000         # Use a specific port
portpilot add myapp -c "custom command" # Use custom dev command
portpilot remove <name|id>              # Unregister project (alias: rm)
portpilot list                          # Show all projects with ID and status (alias: ls)
```

### Server Control

All commands accept either project name or ID (shown in `portpilot list`):

```bash
portpilot start [name|id]      # Run dev server (foreground, shows logs)
portpilot start [name|id] -d   # Run in background (detached)
portpilot start --all -d       # Start all projects in background
portpilot stop [name|id]       # Stop server
portpilot stop --all           # Stop all servers
portpilot restart [name|id]    # Restart server
portpilot restart [name|id] -d # Restart in background

# Examples
portpilot start 4              # Start project with ID 4
portpilot stop triton          # Stop project named "triton"
```

### Logs

```bash
portpilot logs [name|id]       # View logs (background processes)
portpilot logs [name|id] -f    # Follow logs live (like tail -f)
portpilot logs [name|id] -n 100 # Show last 100 lines
portpilot logs [name|id] --clear # Clear log file
```

### Proxy Control

```bash
portpilot proxy             # Run proxy in foreground
portpilot proxy -d          # Run proxy in background (daemon)
portpilot proxy stop        # Stop background proxy
portpilot proxy status      # Check if proxy is running
portpilot proxy logs        # View proxy logs
portpilot proxy --https-redirect  # Force HTTP to HTTPS redirect
```

### Utilities

```bash
portpilot open [name|id]       # Open in browser (uses HTTPS if available)
portpilot open [name|id] -s    # Force HTTPS
```

### Quick Commands

From within a registered project directory, these work without specifying name:

```bash
portpilot start
portpilot stop
portpilot restart
portpilot logs
portpilot open
portpilot help
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
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│       Dev Server (localhost:3001)       │
│            Next.js / Vite / etc         │
└─────────────────────────────────────────┘
```

1. **Hosts File**: Adds entries like `127.0.0.1 my-store.test`
2. **Port Assignment**: Auto-assigns ports starting at 3001
3. **Reverse Proxy**: Routes requests based on hostname
4. **SSL/HTTPS**: Per-domain certificates via mkcert with SNI
5. **Process Manager**: Starts/stops dev servers with proper cleanup

## Supported Frameworks

PortPilot auto-detects and configures:

| Framework        | Detection               | Dev Command                    |
| ---------------- | ----------------------- | ------------------------------ |
| Next.js          | `next.config.*`         | `npm run dev -- -p {port}`     |
| Vite             | `vite.config.*`         | `npm run dev -- --port {port}` |
| Create React App | `react-scripts` in deps | `PORT={port} npm start`        |
| Remix            | `remix.config.js`       | `npm run dev -- --port {port}` |
| Astro            | `astro.config.*`        | `npm run dev -- --port {port}` |

For other setups, use a custom command:

```bash
portpilot add my-app --command "npm run serve -- --port {port}"
```

## Configuration

pp ls
Config is stored at:

- Windows: `%APPDATA%/Roaming/portpilot-nodejs/Config/config.json`
- macOS: `~/Library/Preferences/portpilot-nodejs/config.json`
- Linux: `~/user/.config/portpilot-nodejs/config.json`

SSL certificates are stored in `~/.portpilot/certs/`.

## Troubleshooting

### "Permission denied" on port 80/443

The proxy needs to run on port 80/443 to intercept `.test` requests.

**Windows**: Run terminal as Administrator
**macOS/Linux**: Run with sudo: `sudo portpilot proxy -d`

### Hosts file not updating

Run the sync command with elevated privileges:

```bash
# Windows: Run terminal as Administrator
portpilot sync

# macOS/Linux:
sudo portpilot sync
```

### Dev server not accessible

1. Check the project is running: `portpilot list`
2. Check the proxy is running: `portpilot proxy status`
3. Verify hosts entry exists in your hosts file
4. Try restarting: `portpilot restart [name] -d`

### SSL certificate issues

```bash
# Regenerate certificates
portpilot init

# Restart proxy to pick up new certs
portpilot proxy stop
portpilot proxy -d
```

## Development

```bash
git clone https://github.com/volchoklv/portpilot
cd portpilot
npm install
npm run build
npm link  # Makes 'portpilot' command available globally
```

## Author

**Volchok** - [volchok.dev](https://volchok.dev)

## License

MIT

## Links

- [PortPilot](https://portpilot.dev) - Create and manage Instagram feeds
- [Documentation](https://portpilot.dev/docs)
- [GitHub Repository](https://github.com/VolchokLV/portpilot)
- [NPM Package](https://www.npmjs.com/package/@volchoklv/portpilot)
