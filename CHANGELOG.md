# Changelog

## [0.4.0] - 2026-10-28

### Breaking
- Requires Node.js 22.12 or newer (Node 18 and 20 are end-of-life)
- `portpilot proxy <action>` rejects unknown actions instead of starting the proxy
- `/logo.png` is only served by the proxy for unknown hosts; PortPilot pages use `/__portpilot/logo.png`

### Fixed
- **Next.js hydration errors through the proxy**: the error handler no longer appends an HTML error page to a response that is already streaming; it closes the connection instead
- **Next.js HMR through the proxy**: the Origin header is rewritten for Next's dev-only `/_next/*` and `/__nextjs*` requests, which Next 15+ blocks for non-localhost origins
- **Vite "host not allowed"**: Vite-based dev servers get `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` set to the project hostname
- The proxy service no longer exits on an uncaught error, which took down every `.test` site
- WebSocket proxy errors close the client socket instead of leaking it
- Dev servers listening only on `::1` (common for Vite on Windows) are reached automatically
- Reused PIDs: a stored PID is only treated as the project's process if its start time matches, so `stop`/`remove` can no longer kill an unrelated process tree
- Auto-assigned ports skip ports used by other projects or by running processes
- Vite-family dev servers use `--strictPort` so they can't silently move to another port
- `start -d` waits for the port to listen; if the dev server exits first the project is marked `error` and the last log lines are shown
- `start` refuses to run when the project's port is taken by another process
- `start` reports a missing package manager (e.g. pnpm without Corepack) instead of claiming success
- The lockfile search stops at the repo/workspace root and never reads the home folder (a stray `~/bun.lockb` made projects run with bun)
- No console window per background dev server on Windows (`windowsHide`)
- Hosts file: keeps UTF-16/BOM encoding and CRLF line endings, refuses unbalanced PortPilot markers instead of deleting user lines, backs up before writing, verifies elevated writes, quotes paths safely, skips writing when nothing changed
- Linux DNS flush no longer restarts `systemd-resolved`; macOS flush never blocks on a sudo prompt
- Concurrent CLI/service config writes are serialised with a lock file
- A corrupt `config.json` is backed up and replaced instead of crashing every command
- `parseInt("3d-viewer")` no longer resolves to project #3; names always win over IDs
- Current-directory project lookup is case-insensitive on Windows and works from subfolders
- `remove` deletes the project's certificate, logs and PID file and reports hosts file failures
- `restart` keeps the background/foreground mode of the last start
- `open` exits non-zero on failure and handles URLs with `&`
- `--port`, `-n` and `--tld` are validated
- Unknown SNI names no longer trigger certificate generation; generation inside the proxy is async
- mkcert download follows redirects with `fetch` and verifies the SHA-256 digest GitHub publishes
- Error and 404 pages escape the Host header and project values
- `stopProxyDaemon` no longer busy-waits
- `package.json` `main` pointed at a file that doesn't exist

### Added
- `.localhost` TLD support (`portpilot config --tld localhost`): no hosts file entries needed
- `portpilot doctor` health checks with fixes (`--json`)
- HTTP/2 on the HTTPS listener (`portpilot config --http2 on`), with HTTP/1.1 fallback for WebSockets
- `portpilot mcp`: MCP server for AI coding agents
- `portpilot service install|uninstall|status`: start the proxy at login without admin rights
- `portpilot config --auto-start on|off`
- `portpilot ui` dashboard with live status and log streaming
- `portpilot set` to change a project's port, package manager, command, filter, framework, env vars or Node pin
- `portpilot info` and `--json` on `list`, `status`, `info` and `doctor`; `list --names`
- Per-project environment variables (`--env KEY=value`)
- Per-project Node version pin (`--node 22`, `--node auto`) using nvm-windows, nvm, fnm or Volta installs
- Workspace support: `--filter <package>` for pnpm, yarn, npm and bun workspaces
- Git worktrees: `portpilot add` in a linked worktree registers `<branch>.<project>`; `portpilot worktrees --add`
- Subdomain routing (`api.myapp.test` -> `myapp`) and wildcard certificates; `init --regen-certs`
- `portpilot completion bash|zsh|fish|powershell`
- `portpilot uninstall` (`--keep-ca`, `--yes`)
- `portpilot proxy restart`; `proxy -d` reports when the daemon exits right after starting
- Framework detection for SvelteKit, React Router v7+, TanStack Start, Nuxt and Angular, and more config file extensions
- `{host}` placeholder for custom commands; `--framework` override
- Stable project IDs that survive removals (existing configs are migrated in place)
- Log rotation at 10 MB
- Test suite (`npm test`, node:test + tsx)

### Changed
- `http-proxy` (unmaintained since 2020) replaced with `http-proxy-3`
- Upgraded commander 15, chalk 6, ora 9, conf 16, TypeScript 6; dropped unused `detect-port`
- `logs -f` is implemented in Node instead of shelling out to `tail`/PowerShell
- Removed stale root-level copies of `config.ts`, `index.ts` and `proxy.ts`

### Improved
- Main `--help` explains package manager auto-detection and the `--pm` override
- `portpilot add --help` shows examples and the detection order; `-c` lists the `{pm}` placeholder
- `portpilot start` shows the exact command being run (e.g. `pnpm run dev -p 3001`)
- `proxy` description notes that running it with no action starts the proxy

## [0.3.0] - 2026-09-14

### Added
- pnpm, yarn and bun support: the package manager is auto-detected from the `packageManager` field in `package.json` or a lockfile (including parent directories for monorepos), falling back to npm
- `--pm <manager>` flag on `portpilot add` to force a package manager
- `{pm}` placeholder for custom commands
- `portpilot add` output shows the package manager

### Fixed
- Create React App projects no longer use a `PORT={port}` shell prefix, which failed on Windows; the port is passed via the `PORT` env var
- All `{port}` placeholders in custom commands are replaced, not just the first

## [0.2.1] - 2025-02-03

### Improved
- Added help tip to main `--help` output showing how to get command-specific help

## [0.2.0] - 2025-01-21

### Added
- `portpilot config` command to view/modify configuration
- `--tld` flag on `portpilot init` to set custom TLD
- `--allow-dots` / `--no-allow-dots` config options for project names
- `-v` and `--version` flags for version display

### Improved
- Mac password prompt UX - clearer messaging before sudo prompts
- Auto-strip TLD suffix from project names (e.g., `myapp.test` -> `myapp`)

### Fixed
- README.md port default description

## [0.1.0] - 2025-01-15

### Added
- Initial release
- Project registration and management
- Automatic framework detection (Next.js, Vite, CRA, Remix, Astro)
- Port auto-assignment from 3001+
- HTTP reverse proxy with WebSocket support for HMR
- `.test` domain routing via hosts file
- Cross-platform support (Windows, macOS, Linux)
- CLI commands: `init`, `add`, `start`, `stop`, `list`, `remove`, `open`, `logs`, `service`
