# Changelog

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
