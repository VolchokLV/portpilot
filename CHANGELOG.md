# Changelog

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
