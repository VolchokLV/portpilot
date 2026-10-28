import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Start the proxy at login. No admin rights needed on any platform:
 * - Windows: a hidden .vbs launcher in the user's Startup folder
 * - macOS: a LaunchAgent
 * - Linux: a systemd user unit
 * Each one runs "portpilot proxy -d", which writes the normal PID file, so
 * "portpilot proxy status/stop" keep working.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.join(__dirname, '..', 'cli', 'index.js');
const LABEL = 'dev.portpilot.proxy';

function windowsStartupFile(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'PortPilot.vbs');
}

function macPlistFile(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function linuxUnitFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'systemd', 'user', 'portpilot.service');
}

export function getAutostartFile(): string {
  if (process.platform === 'win32') return windowsStartupFile();
  if (process.platform === 'darwin') return macPlistFile();
  return linuxUnitFile();
}

export function isAutostartInstalled(): boolean {
  return fs.existsSync(getAutostartFile());
}

function proxyArgs(httpsRedirect: boolean): string[] {
  return [CLI_SCRIPT, 'proxy', 'start', '-d', ...(httpsRedirect ? ['--https-redirect'] : [])];
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function installAutostart(options: { httpsRedirect?: boolean } = {}): { success: boolean; file: string; error?: string; note?: string } {
  const file = getAutostartFile();
  const args = proxyArgs(options.httpsRedirect ?? false);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    if (process.platform === 'win32') {
      // VBScript doubles quotes inside strings; window style 0 = hidden
      const commandLine = [process.execPath, ...args].map((a) => `""${a}""`).join(' ');
      fs.writeFileSync(file, `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${commandLine}", 0, False\r\n`);
      return { success: true, file };
    }

    if (process.platform === 'darwin') {
      const programArgs = [process.execPath, ...args].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
      fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- proxy -d forks the daemon and exits; keep the daemon alive -->
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
`);
      try {
        execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' });
      } catch {
        // Loads at next login anyway
      }
      return { success: true, file };
    }

    const execStart = [process.execPath, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
    fs.writeFileSync(file, `[Unit]
Description=PortPilot proxy
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${execStart}

[Install]
WantedBy=default.target
`);
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', 'portpilot.service'], { stdio: 'ignore' });
    } catch {
      return { success: true, file, note: 'Could not enable the unit automatically. Run: systemctl --user enable portpilot.service' };
    }
    return {
      success: true,
      file,
      note: 'Binding port 80 as a normal user needs: sudo sysctl net.ipv4.ip_unprivileged_port_start=80',
    };
  } catch (error) {
    return { success: false, file, error: (error as Error).message };
  }
}

export function uninstallAutostart(): { success: boolean; file: string; error?: string } {
  const file = getAutostartFile();
  try {
    if (process.platform === 'darwin' && fs.existsSync(file)) {
      try {
        execFileSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' });
      } catch {
        // Not loaded
      }
    }
    if (process.platform === 'linux' && fs.existsSync(file)) {
      try {
        execFileSync('systemctl', ['--user', 'disable', 'portpilot.service'], { stdio: 'ignore' });
      } catch {
        // Not enabled
      }
    }
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { success: true, file };
  } catch (error) {
    return { success: false, file, error: (error as Error).message };
  }
}
