import readline from 'readline';
import chalk from 'chalk';
import { getTld } from '../core/config.js';
import {
  getAllProjectsWithStatus,
  startProject,
  stopProject,
  restartProject,
  getLogTail,
} from '../core/process.js';
import { isProxyDaemonRunning } from '../core/daemon.js';
import { ProjectWithStatus } from '../types/index.js';
import { openInBrowser } from './util.js';

/**
 * Full-screen terminal dashboard: project list with live status and the
 * selected project's log streaming underneath.
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function fit(text: string, width: number): string {
  const plain = text.replace(ANSI, '').replace(/\t/g, '  ');
  return plain.length > width ? plain.slice(0, Math.max(0, width - 1)) + '…' : plain;
}

function pad(text: string, width: number): string {
  const visible = text.replace(ANSI, '').length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
}

export async function runDashboard(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The dashboard needs an interactive terminal.');
  }

  let projects: ProjectWithStatus[] = getAllProjectsWithStatus();
  let selected = 0;
  let showLogs = true;
  let message = '';
  let busy = false;
  const tld = getTld();

  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l'); // Alternate screen, hide cursor

  const render = () => {
    const width = out.columns || 100;
    const height = out.rows || 30;
    const lines: string[] = [];
    const proxy = isProxyDaemonRunning();

    lines.push(chalk.cyan.bold(' PortPilot ') + chalk.dim(` proxy: `) + (proxy.running ? chalk.green('running') : chalk.yellow('stopped')) +
      chalk.dim(`   ${projects.filter((p) => p.status === 'running').length}/${projects.length} running`));
    lines.push('');

    if (projects.length === 0) {
      lines.push(chalk.yellow('  No projects registered. Quit and run "portpilot add".'));
    }

    const nameWidth = Math.min(28, Math.max(8, ...projects.map((p) => p.name.length)));
    projects.forEach((p, index) => {
      const icon = p.status === 'running' ? chalk.green('●') : p.status === 'error' ? chalk.red('✗') : chalk.gray('○');
      const status = p.status === 'running' ? chalk.green(p.status) : p.status === 'error' ? chalk.red(p.status) : chalk.gray(p.status);
      const row = ` ${icon} ${pad(chalk.cyan(fit(p.name, nameWidth)), nameWidth)}  ${pad(String(p.port), 6)}${pad(status, 9)} ${chalk.dim(fit(`${p.name}.${tld}  ${p.framework}`, Math.max(0, width - nameWidth - 24)))}`;
      lines.push(index === selected ? chalk.inverse(pad(row.replace(ANSI, ''), width - 1)) : row);
    });

    lines.push('');
    lines.push(chalk.dim(' ↑/↓ select  s start  x stop  r restart  o open  l logs  q quit') + (message ? `   ${chalk.yellow(fit(message, width - 70))}` : ''));

    const current = projects[selected];
    if (showLogs && current) {
      lines.push(chalk.dim('─'.repeat(Math.max(0, width - 1))));
      const room = Math.max(0, height - lines.length - 1);
      const tail = getLogTail(current.name, room);
      const logLines = tail ? tail.split('\n') : [chalk.dim(`  No logs for ${current.name} (only background starts write logs).`)];
      for (const line of logLines.slice(-room)) lines.push(fit(line, width - 1));
    }

    out.write('\x1b[H\x1b[2J' + lines.slice(0, height).join('\n'));
  };

  const refresh = () => {
    projects = getAllProjectsWithStatus();
    if (selected >= projects.length) selected = Math.max(0, projects.length - 1);
    render();
  };

  const act = async (label: string, fn: () => Promise<{ success: boolean; error?: string; warning?: string }>) => {
    if (busy) return;
    busy = true;
    message = `${label}...`;
    render();
    try {
      const result = await fn();
      message = result.success ? `${label}: done${result.warning ? ` (${result.warning})` : ''}` : `${label}: ${result.error?.split('\n')[0]}`;
    } catch (error) {
      message = `${label}: ${(error as Error).message}`;
    }
    busy = false;
    refresh();
  };

  const statusTimer = setInterval(refresh, 3000);
  const logTimer = setInterval(render, 1000);

  return new Promise((resolve) => {
    const quit = () => {
      clearInterval(statusTimer);
      clearInterval(logTimer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write('\x1b[?25h\x1b[?1049l'); // Restore cursor and screen
      resolve();
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (_str, key: { name?: string; ctrl?: boolean }) => {
      const current = projects[selected];
      if (key.ctrl && key.name === 'c') return quit();
      switch (key.name) {
        case 'q':
        case 'escape':
          return quit();
        case 'up':
        case 'k':
          selected = Math.max(0, selected - 1);
          return render();
        case 'down':
        case 'j':
          selected = Math.min(projects.length - 1, selected + 1);
          return render();
        case 'l':
          showLogs = !showLogs;
          return render();
        case 's':
          if (current) void act(`Start ${current.name}`, () => startProject(current.name, { detached: true }));
          return;
        case 'x':
          if (current) void act(`Stop ${current.name}`, () => stopProject(current.name));
          return;
        case 'r':
          if (current) void act(`Restart ${current.name}`, () => restartProject(current.name, { detached: true }));
          return;
        case 'o':
          if (current) void act(`Open ${current.name}`, () => openInBrowser(`http://${current.name}.${tld}`));
          return;
      }
    });

    out.on('resize', render);
    render();
  });
}
