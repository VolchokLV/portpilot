import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { getProjects, getTld, isLocalhostTld } from './config.js';
import { PORTPILOT_DIR } from './paths.js';

const MARKER_START = '# PortPilot Start - DO NOT EDIT';
const MARKER_END = '# PortPilot End';

export function getHostsPath(): string {
  if (process.env.PORTPILOT_HOSTS_FILE) return process.env.PORTPILOT_HOSTS_FILE; // tests
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

type HostsEncoding = 'utf8' | 'utf8-bom' | 'utf16le';

interface HostsFile {
  text: string;
  encoding: HostsEncoding;
  eol: '\n' | '\r\n';
}

export function decodeHosts(buffer: Buffer): HostsFile {
  let encoding: HostsEncoding = 'utf8';
  let text: string;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf16le';
    text = buffer.subarray(2).toString('utf16le');
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    encoding = 'utf8-bom';
    text = buffer.subarray(3).toString('utf-8');
  } else {
    text = buffer.toString('utf-8');
  }
  return { text, encoding, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export function encodeHosts(file: HostsFile): Buffer {
  switch (file.encoding) {
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.text, 'utf16le')]);
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(file.text, 'utf-8')]);
    default:
      return Buffer.from(file.text, 'utf-8');
  }
}

/** Hostnames PortPilot should map to 127.0.0.1. */
export function getDesiredHostnames(): string[] {
  const tld = getTld();
  if (isLocalhostTld(tld)) return []; // *.localhost resolves without hosts entries
  return getProjects().map((p) => `${p.name}.${tld}`);
}

/**
 * Replace PortPilot's marked block in `text` with entries for `hostnames`.
 * Throws if the markers are unbalanced, rather than guessing and deleting user lines.
 */
export function renderHostsContent(text: string, hostnames: string[], eol: '\n' | '\r\n' = '\n'): string {
  const lines = text.split(/\r?\n/);
  const starts = lines.filter((l) => l.trim() === MARKER_START).length;
  const ends = lines.filter((l) => l.trim() === MARKER_END).length;
  if (starts !== ends) {
    throw new Error(
      `The hosts file has ${starts} "${MARKER_START}" and ${ends} "${MARKER_END}" lines. ` +
      `Fix it by hand (${getHostsPath()}) so each start marker has an end marker, then run "portpilot sync".`
    );
  }

  // No block and nothing to add: leave the file byte-for-byte alone
  if (starts === 0 && hostnames.length === 0) return text;

  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === MARKER_START) {
      inside = true;
      continue;
    }
    if (trimmed === MARKER_END) {
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  if (hostnames.length > 0) {
    kept.push('', MARKER_START, ...hostnames.map((h) => `127.0.0.1    ${h}`), MARKER_END);
  }

  return kept.join(eol) + eol;
}

function readHostsFile(): HostsFile {
  try {
    return decodeHosts(fs.readFileSync(getHostsPath()));
  } catch (error) {
    throw new Error(`Cannot read hosts file: ${(error as Error).message}`);
  }
}

function writeElevatedWindows(source: string, destination: string): void {
  // -EncodedCommand avoids cmd/PowerShell quoting problems with spaces in paths
  const inner = `Copy-Item -LiteralPath '${source.replace(/'/g, "''")}' -Destination '${destination.replace(/'/g, "''")}' -Force`;
  const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${innerEncoded}'; exit $p.ExitCode`;
  const outerEncoded = Buffer.from(outer, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', outerEncoded], {
    stdio: 'inherit',
    windowsHide: true,
  });
}

export function updateHostsFile(): { success: boolean; error?: string; changed?: boolean } {
  try {
    const hostsPath = getHostsPath();
    const current = readHostsFile();
    const newText = renderHostsContent(current.text, getDesiredHostnames(), current.eol);

    // Nothing to do: avoids an elevation prompt when the entries are already right
    if (newText === current.text) {
      return { success: true, changed: false };
    }

    const newBuffer = encodeHosts({ ...current, text: newText });

    // Keep a copy of the last good file before every write
    if (!fs.existsSync(PORTPILOT_DIR)) fs.mkdirSync(PORTPILOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(PORTPILOT_DIR, 'hosts.backup'), encodeHosts(current));

    try {
      fs.writeFileSync(hostsPath, newBuffer);
    } catch {
      const tempFile = path.join(os.tmpdir(), `portpilot-hosts-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(tempFile, newBuffer);
      try {
        if (process.platform === 'win32') {
          writeElevatedWindows(tempFile, hostsPath);
        } else {
          execFileSync('sudo', ['cp', tempFile, hostsPath], { stdio: 'inherit' });
        }
      } finally {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // The elevated copy can fail silently (UAC declined, antivirus lock), so check the result
    const written = fs.readFileSync(hostsPath);
    if (!written.equals(newBuffer)) {
      return { success: false, error: 'The hosts file was not updated (elevation declined or the file is locked).' };
    }

    flushDnsCache();
    return { success: true, changed: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/** Remove PortPilot's block entirely (used by uninstall). */
export function removeHostsEntries(): { success: boolean; error?: string } {
  try {
    const current = readHostsFile();
    const newText = renderHostsContent(current.text, [], current.eol);
    if (newText === current.text) return { success: true };
    const buffer = encodeHosts({ ...current, text: newText });
    try {
      fs.writeFileSync(getHostsPath(), buffer);
    } catch {
      const tempFile = path.join(os.tmpdir(), `portpilot-hosts-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(tempFile, buffer);
      if (process.platform === 'win32') writeElevatedWindows(tempFile, getHostsPath());
      else execFileSync('sudo', ['cp', tempFile, getHostsPath()], { stdio: 'inherit' });
      fs.unlinkSync(tempFile);
    }
    flushDnsCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

function flushDnsCache(): void {
  try {
    if (process.platform === 'win32') {
      execSync('ipconfig /flushdns', { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      // -n: never block on a password prompt; sudo is usually still cached from the hosts write
      execSync('sudo -n dscacheutil -flushcache && sudo -n killall -HUP mDNSResponder', { stdio: 'ignore' });
    } else {
      // systemd-resolved reads /etc/hosts live; flushing its cache is enough
      execSync('resolvectl flush-caches', { stdio: 'ignore' });
    }
  } catch {
    // DNS flush is best effort, don't fail the operation
  }
}

export function checkHostsPermissions(): { canWrite: boolean; requiresElevation: boolean } {
  const hostsPath = getHostsPath();

  try {
    fs.accessSync(hostsPath, fs.constants.W_OK);
    return { canWrite: true, requiresElevation: false };
  } catch {
    return { canWrite: false, requiresElevation: true };
  }
}

/** Hostnames currently inside PortPilot's block. */
export function getHostsEntries(): string[] {
  const { text } = readHostsFile();
  const entries: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === MARKER_START) inside = true;
    else if (trimmed === MARKER_END) inside = false;
    else if (inside) {
      const match = trimmed.match(/^127\.0\.0\.1\s+(\S+)/);
      if (match) entries.push(match[1].toLowerCase());
    }
  }
  return entries;
}
