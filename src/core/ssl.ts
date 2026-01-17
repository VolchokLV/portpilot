import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';

const PORTPILOT_DIR = path.join(os.homedir(), '.portpilot');
const CERTS_DIR = path.join(PORTPILOT_DIR, 'certs');
const CA_DIR = path.join(PORTPILOT_DIR, 'ca');
const MKCERT_DIR = path.join(PORTPILOT_DIR, 'bin');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getMkcertPath(): string {
  if (process.platform === 'win32') {
    return path.join(MKCERT_DIR, 'mkcert.exe');
  }
  return path.join(MKCERT_DIR, 'mkcert');
}

export function isMkcertInstalled(): boolean {
  return fs.existsSync(getMkcertPath());
}

export function isCAInstalled(): boolean {
  try {
    const mkcertPath = getMkcertPath();
    if (!fs.existsSync(mkcertPath)) return false;
    
    // Get mkcert's actual CAROOT (may be default or custom)
    const caRoot = execSync(`"${mkcertPath}" -CAROOT`, { encoding: 'utf-8' }).trim();
    const rootCA = path.join(caRoot, 'rootCA.pem');
    
    return fs.existsSync(rootCA);
  } catch {
    return false;
  }
}

function getCARoot(): string | null {
  try {
    const mkcertPath = getMkcertPath();
    if (!fs.existsSync(mkcertPath)) return null;
    
    return execSync(`"${mkcertPath}" -CAROOT`, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

export async function downloadMkcert(
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  ensureDir(MKCERT_DIR);
  
  const version = 'v1.4.4';
  let filename: string;
  let url: string;
  
  if (process.platform === 'win32') {
    filename = 'mkcert.exe';
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
    url = `https://github.com/FiloSottile/mkcert/releases/download/${version}/mkcert-${version}-windows-${arch}.exe`;
  } else if (process.platform === 'darwin') {
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
    filename = 'mkcert';
    url = `https://github.com/FiloSottile/mkcert/releases/download/${version}/mkcert-${version}-darwin-${arch}`;
  } else {
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
    filename = 'mkcert';
    url = `https://github.com/FiloSottile/mkcert/releases/download/${version}/mkcert-${version}-linux-${arch}`;
  }
  
  const destPath = path.join(MKCERT_DIR, filename);
  
  onProgress?.(`Downloading mkcert from ${url}...`);
  
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    
    const request = https.get(url, (response) => {
      // Handle redirect
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          resolve({ success: false, error: 'Redirect without location header' });
          return;
        }
        
        https.get(redirectUrl, (redirectResponse) => {
          redirectResponse.pipe(file);
          
          file.on('finish', () => {
            file.close();
            
            // Make executable on Unix
            if (process.platform !== 'win32') {
              fs.chmodSync(destPath, '755');
            }
            
            resolve({ success: true });
          });
        }).on('error', (err) => {
          fs.unlinkSync(destPath);
          resolve({ success: false, error: err.message });
        });
        return;
      }
      
      if (response.statusCode !== 200) {
        resolve({ success: false, error: `HTTP ${response.statusCode}` });
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        
        if (process.platform !== 'win32') {
          fs.chmodSync(destPath, '755');
        }
        
        resolve({ success: true });
      });
    });
    
    request.on('error', (err) => {
      fs.unlinkSync(destPath);
      resolve({ success: false, error: err.message });
    });
  });
}

export function installCA(): { success: boolean; error?: string; requiresAdmin?: boolean } {
  const mkcertPath = getMkcertPath();
  
  if (!fs.existsSync(mkcertPath)) {
    return { success: false, error: 'mkcert not installed. Run portpilot init first.' };
  }
  
  try {
    // Let mkcert use its default CAROOT location
    execSync(`"${mkcertPath}" -install`, { 
      encoding: 'utf-8',
      stdio: 'inherit'
    });
    
    return { success: true };
  } catch (error) {
    const message = (error as Error).message;
    
    if (message.includes('Access is denied') || message.includes('permission')) {
      return { 
        success: false, 
        error: 'Admin privileges required to install CA',
        requiresAdmin: true
      };
    }
    
    return { success: false, error: message };
  }
}

export function generateCertificate(
  domain: string
): { success: boolean; certPath?: string; keyPath?: string; error?: string } {
  const mkcertPath = getMkcertPath();
  
  if (!fs.existsSync(mkcertPath)) {
    return { success: false, error: 'mkcert not installed. Run portpilot init first.' };
  }
  
  if (!isCAInstalled()) {
    return { success: false, error: 'CA not installed. Run portpilot init first.' };
  }
  
  ensureDir(CERTS_DIR);
  
  const certPath = path.join(CERTS_DIR, `${domain}.pem`);
  const keyPath = path.join(CERTS_DIR, `${domain}-key.pem`);
  
  // Skip if cert already exists
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { success: true, certPath, keyPath };
  }
  
  try {
    execSync(
      `"${mkcertPath}" -cert-file "${certPath}" -key-file "${keyPath}" "${domain}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    
    return { success: true, certPath, keyPath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Generate certificates for all registered projects
 */
export function generateAllProjectCertificates(
  projects: { name: string }[],
  tld: string
): { success: string[]; failed: string[] } {
  const success: string[] = [];
  const failed: string[] = [];
  
  for (const project of projects) {
    const domain = `${project.name}.${tld}`;
    const result = generateCertificate(domain);
    
    if (result.success) {
      success.push(domain);
    } else {
      failed.push(`${domain}: ${result.error}`);
    }
  }
  
  return { success, failed };
}

export function getCertificatePaths(domain: string): { certPath: string; keyPath: string } | null {
  const certPath = path.join(CERTS_DIR, `${domain}.pem`);
  const keyPath = path.join(CERTS_DIR, `${domain}-key.pem`);
  
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath };
  }
  
  return null;
}

export function deleteCertificate(domain: string): void {
  const certPath = path.join(CERTS_DIR, `${domain}.pem`);
  const keyPath = path.join(CERTS_DIR, `${domain}-key.pem`);
  
  if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
  if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
}

export function getSSLStatus(): {
  mkcertInstalled: boolean;
  caInstalled: boolean;
  mkcertPath: string;
  certsDir: string;
  caDir: string;
} {
  return {
    mkcertInstalled: isMkcertInstalled(),
    caInstalled: isCAInstalled(),
    mkcertPath: getMkcertPath(),
    certsDir: CERTS_DIR,
    caDir: CA_DIR,
  };
}
