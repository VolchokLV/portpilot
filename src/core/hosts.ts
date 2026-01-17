import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { getProjects, getTld } from './config.js';

const MARKER_START = '# PortPilot Start - DO NOT EDIT';
const MARKER_END = '# PortPilot End';

function getHostsPath(): string {
  if (process.platform === 'win32') {
    return 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  }
  return '/etc/hosts';
}

function generateHostsEntries(): string {
  const projects = getProjects();
  const tld = getTld();
  
  if (projects.length === 0) return '';
  
  const entries = projects
    .map((p) => `127.0.0.1    ${p.name}.${tld}`)
    .join('\n');
  
  return `${MARKER_START}\n${entries}\n${MARKER_END}`;
}

function getExistingHostsContent(): string {
  const hostsPath = getHostsPath();
  try {
    return fs.readFileSync(hostsPath, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read hosts file: ${(error as Error).message}`);
  }
}

function stripPortPilotSection(content: string): string {
  const regex = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}\\n?`, 'g');
  return content.replace(regex, '').trim();
}

export function updateHostsFile(): { success: boolean; error?: string } {
  try {
    const hostsPath = getHostsPath();
    const currentContent = getExistingHostsContent();
    const cleanContent = stripPortPilotSection(currentContent);
    const newEntries = generateHostsEntries();
    
    const newContent = newEntries
      ? `${cleanContent}\n\n${newEntries}\n`
      : `${cleanContent}\n`;
    
    if (process.platform === 'win32') {
      // Windows: Write to temp file and copy with elevated permissions
      const tempFile = path.join(os.tmpdir(), 'portpilot-hosts-update.txt');
      fs.writeFileSync(tempFile, newContent, 'utf-8');
      
      try {
        // Try direct write first (if running as admin)
        fs.writeFileSync(hostsPath, newContent, 'utf-8');
      } catch {
        // Fall back to PowerShell elevation
        const escapedTempFile = tempFile.replace(/\\/g, '\\\\');
        const escapedHostsPath = hostsPath.replace(/\\/g, '\\\\');
        
        const psCommand = `
          Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'Copy-Item -Path "${escapedTempFile}" -Destination "${escapedHostsPath}" -Force'
        `.trim();
        
        execSync(`powershell -Command "${psCommand}"`, { stdio: 'inherit' });
      }
      
      // Cleanup temp file
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    } else {
      // Unix: Try direct write, fall back to sudo
      try {
        fs.writeFileSync(hostsPath, newContent, 'utf-8');
      } catch {
        const tempFile = path.join(os.tmpdir(), 'portpilot-hosts-update.txt');
        fs.writeFileSync(tempFile, newContent, 'utf-8');
        execSync(`sudo cp "${tempFile}" "${hostsPath}"`, { stdio: 'inherit' });
        fs.unlinkSync(tempFile);
      }
    }
    
    // Flush DNS cache
    flushDnsCache();
    
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

function flushDnsCache(): void {
  try {
    if (process.platform === 'win32') {
      execSync('ipconfig /flushdns', { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execSync('sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder', { stdio: 'ignore' });
    } else {
      // Linux - varies by distro, try common approaches
      try {
        execSync('sudo systemctl restart systemd-resolved', { stdio: 'ignore' });
      } catch {
        try {
          execSync('sudo /etc/init.d/nscd restart', { stdio: 'ignore' });
        } catch {
          // Ignore - DNS cache flush is best effort
        }
      }
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

export function getHostsEntries(): string[] {
  const content = getExistingHostsContent();
  const tld = getTld();
  const regex = new RegExp(`127\\.0\\.0\\.1\\s+([\\w-]+)\\.${tld}`, 'g');
  
  const entries: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push(match[1]);
  }
  
  return entries;
}
