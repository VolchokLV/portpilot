import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CERTS_DIR, BIN_DIR } from './paths.js';

const execFileAsync = promisify(execFile);

const MKCERT_VERSION = 'v1.4.4';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getMkcertPath(): string {
  return path.join(BIN_DIR, process.platform === 'win32' ? 'mkcert.exe' : 'mkcert');
}

export function isMkcertInstalled(): boolean {
  return fs.existsSync(getMkcertPath());
}

let caRootCache: string | null | undefined;

function getCARoot(): string | null {
  if (caRootCache !== undefined) return caRootCache;
  try {
    const mkcertPath = getMkcertPath();
    if (!fs.existsSync(mkcertPath)) return null;
    caRootCache = execFileSync(mkcertPath, ['-CAROOT'], { encoding: 'utf-8', windowsHide: true }).trim();
    return caRootCache;
  } catch {
    return null;
  }
}

export function isCAInstalled(): boolean {
  const caRoot = getCARoot();
  return caRoot ? fs.existsSync(path.join(caRoot, 'rootCA.pem')) : false;
}

function assetName(): string {
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return `mkcert-${MKCERT_VERSION}-${os}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
}

/** SHA-256 digest GitHub publishes for a release asset, if available. */
async function getPublishedDigest(name: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.github.com/repos/FiloSottile/mkcert/releases/tags/${MKCERT_VERSION}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'portpilot' },
    });
    if (!response.ok) return undefined;
    const release = (await response.json()) as { assets?: { name: string; digest?: string }[] };
    const digest = release.assets?.find((a) => a.name === name)?.digest;
    return digest?.startsWith('sha256:') ? digest.slice('sha256:'.length) : undefined;
  } catch {
    return undefined;
  }
}

export async function downloadMkcert(
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string; verified?: boolean }> {
  ensureDir(BIN_DIR);

  const name = assetName();
  const url = `https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/${name}`;
  const destPath = getMkcertPath();

  onProgress?.(`Downloading mkcert from ${url}...`);

  try {
    // fetch follows GitHub's redirect chain to the CDN
    const response = await fetch(url, { headers: { 'User-Agent': 'portpilot' } });
    if (!response.ok) {
      return { success: false, error: `Download failed: HTTP ${response.status}` };
    }
    const data = Buffer.from(await response.arrayBuffer());

    onProgress?.('Verifying mkcert checksum...');
    const expected = await getPublishedDigest(name);
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (expected && expected !== actual) {
      return { success: false, error: `Checksum mismatch for ${name} (expected ${expected}, got ${actual})` };
    }

    const tempPath = `${destPath}.download`;
    fs.writeFileSync(tempPath, data);
    if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, destPath);
    caRootCache = undefined;

    return { success: true, verified: Boolean(expected) };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export function installCA(): { success: boolean; error?: string; requiresAdmin?: boolean } {
  const mkcertPath = getMkcertPath();

  if (!fs.existsSync(mkcertPath)) {
    return { success: false, error: 'mkcert not installed. Run portpilot init first.' };
  }

  try {
    // Let mkcert use its default CAROOT location
    execFileSync(mkcertPath, ['-install'], { stdio: 'inherit' });
    caRootCache = undefined;
    return { success: true };
  } catch (error) {
    const message = (error as Error).message;

    if (message.includes('Access is denied') || message.includes('permission')) {
      return {
        success: false,
        error: 'Admin privileges required to install CA',
        requiresAdmin: true,
      };
    }

    return { success: false, error: message };
  }
}

export function uninstallCA(): { success: boolean; error?: string } {
  const mkcertPath = getMkcertPath();
  if (!fs.existsSync(mkcertPath)) return { success: true };
  try {
    execFileSync(mkcertPath, ['-uninstall'], { stdio: 'inherit' });
    caRootCache = undefined;
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

function certFiles(domain: string): { certPath: string; keyPath: string } {
  return {
    certPath: path.join(CERTS_DIR, `${domain}.pem`),
    keyPath: path.join(CERTS_DIR, `${domain}-key.pem`),
  };
}

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function mkcertArgs(domain: string): string[] {
  const { certPath, keyPath } = certFiles(domain);
  // The wildcard covers subdomains such as api.myapp.test
  return ['-cert-file', certPath, '-key-file', keyPath, domain, `*.${domain}`];
}

type CertResult = { success: boolean; certPath?: string; keyPath?: string; error?: string };

function precheck(domain: string, force: boolean): CertResult | undefined {
  if (!DOMAIN_PATTERN.test(domain)) {
    return { success: false, error: `Invalid domain "${domain}"` };
  }
  if (!fs.existsSync(getMkcertPath())) {
    return { success: false, error: 'mkcert not installed. Run portpilot init first.' };
  }
  if (!isCAInstalled()) {
    return { success: false, error: 'CA not installed. Run portpilot init first.' };
  }
  ensureDir(CERTS_DIR);
  const files = certFiles(domain);
  if (!force && fs.existsSync(files.certPath) && fs.existsSync(files.keyPath)) {
    return { success: true, ...files };
  }
  return undefined;
}

export function generateCertificate(domain: string, options: { force?: boolean } = {}): CertResult {
  const early = precheck(domain, options.force ?? false);
  if (early) return early;

  try {
    execFileSync(getMkcertPath(), mkcertArgs(domain), { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
    return { success: true, ...certFiles(domain) };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/** Non-blocking variant for use inside the running proxy (SNI callback). */
export async function generateCertificateAsync(domain: string): Promise<CertResult> {
  const early = precheck(domain, false);
  if (early) return early;

  try {
    await execFileAsync(getMkcertPath(), mkcertArgs(domain), { windowsHide: true });
    return { success: true, ...certFiles(domain) };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Generate certificates for all registered projects
 */
export function generateAllProjectCertificates(
  projects: { name: string }[],
  tld: string,
  options: { force?: boolean } = {}
): { success: string[]; failed: string[] } {
  const success: string[] = [];
  const failed: string[] = [];

  for (const project of projects) {
    const domain = `${project.name}.${tld}`;
    const result = generateCertificate(domain, options);

    if (result.success) {
      success.push(domain);
    } else {
      failed.push(`${domain}: ${result.error}`);
    }
  }

  return { success, failed };
}

export function getCertificatePaths(domain: string): { certPath: string; keyPath: string } | null {
  const files = certFiles(domain);
  if (fs.existsSync(files.certPath) && fs.existsSync(files.keyPath)) {
    return files;
  }
  return null;
}

export function deleteCertificate(domain: string): void {
  const { certPath, keyPath } = certFiles(domain);
  if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
  if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
}

export function getSSLStatus(): {
  mkcertInstalled: boolean;
  caInstalled: boolean;
  mkcertPath: string;
  certsDir: string;
  caDir: string | null;
} {
  return {
    mkcertInstalled: isMkcertInstalled(),
    caInstalled: isCAInstalled(),
    mkcertPath: getMkcertPath(),
    certsDir: CERTS_DIR,
    caDir: getCARoot(),
  };
}
