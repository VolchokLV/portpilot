import { spawn } from 'child_process';
import readline from 'readline';
import { InvalidArgumentError } from 'commander';

export function parsePortOption(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Port must be a number.');
  const port = parseInt(value, 10);
  if (port < 1 || port > 65535) throw new InvalidArgumentError('Port must be between 1 and 65535.');
  return port;
}

export function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value) || parseInt(value, 10) < 1) {
    throw new InvalidArgumentError('Must be a positive whole number.');
  }
  return parseInt(value, 10);
}

export function parseOnOff(value: string): boolean {
  const v = value.toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  throw new InvalidArgumentError('Use "on" or "off".');
}

/** Repeatable option collector: --env A=1 --env B=2 */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parseEnvPairs(pairs: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) throw new Error(`Invalid --env "${pair}". Use KEY=value.`);
    env[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return env;
}

/** Open a URL in the default browser. URLs with & or spaces are passed safely. */
export function openInBrowser(url: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const [command, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', (err) => resolve({ success: false, error: err.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ success: true });
    });
  });
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
