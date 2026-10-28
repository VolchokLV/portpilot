#!/usr/bin/env node

import { Command, Argument, Option } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import {
  addProject,
  removeProject,
  updateProject,
  getProjects,
  getProjectByName,
  getProjectByNameOrId,
  getProjectByPath,
  isSamePath,
  getTld,
  setTld,
  isValidTld,
  isLocalhostTld,
  getAllowDots,
  setAllowDots,
  getAutoStart,
  setAutoStart,
  getHttp2,
  setHttp2,
  getConfig,
  getConfigPath,
  getNextPort,
  resetConfig,
} from '../core/config.js';
import {
  detectFramework,
  detectPackageManagerWithSource,
  isPackageManager,
  isFramework,
  validateProjectPath,
  sanitizeProjectName,
  suggestProjectName,
} from '../core/framework.js';
import { updateHostsFile, checkHostsPermissions, removeHostsEntries } from '../core/hosts.js';
import {
  startProject,
  stopProject,
  restartProject,
  stopAllProjects,
  startAllProjects,
  getAllProjectsWithStatus,
  getProjectStatus,
  tailLogs,
  clearLogs,
  getLogFilePath,
  resolveDevCommand,
  removeProjectFiles,
} from '../core/process.js';
import { startProxyServer } from '../core/proxy.js';
import {
  downloadMkcert,
  installCA,
  uninstallCA,
  generateCertificate,
  deleteCertificate,
  isMkcertInstalled,
  isCAInstalled,
  getSSLStatus,
} from '../core/ssl.js';
import {
  startProxyDaemon,
  stopProxyDaemon,
  isProxyDaemonRunning,
  waitForDaemon,
  getProxyLogs,
  getProxyLogFile,
} from '../core/daemon.js';
import { findAvailablePort, isPortInUse } from '../core/ports.js';
import { installAutostart, uninstallAutostart, isAutostartInstalled, getAutostartFile } from '../core/autostart.js';
import { runDoctor, DoctorCheck } from '../core/doctor.js';
import { isLinkedWorktree, getMainWorktreePath, getCurrentBranch, listWorktrees, branchToLabel } from '../core/git.js';
import { readProjectNodeVersion, resolveNodePin } from '../core/node-version.js';
import { PORTPILOT_DIR } from '../core/paths.js';
import { FRAMEWORKS, Project, ProjectWithStatus } from '../types/index.js';
import { getCompletionScript, SHELLS, Shell } from './completion.js';
import {
  parsePortOption,
  parsePositiveInt,
  parseOnOff,
  collect,
  parseEnvPairs,
  openInBrowser,
  confirm,
} from './util.js';

const program = new Command();

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
);

// ============ Helpers ============

function fail(message: string, hint?: string): never {
  console.error(chalk.red(`✗ ${message}`));
  if (hint) console.log(hint);
  process.exit(1);
}

/** Resolve a project by name/ID, or from the current directory (or a parent) when omitted. */
function resolveProject(nameOrId: string | undefined): Project {
  if (!nameOrId) {
    const project = getProjectByPath(process.cwd());
    if (!project) {
      fail('No project specified and the current directory is not registered.', `Register with: ${chalk.cyan('portpilot add [name]')}`);
    }
    return project;
  }

  const { project } = getProjectByNameOrId(nameOrId);
  if (!project) {
    fail(`Project "${nameOrId}" not found`, `List projects with: ${chalk.cyan('portpilot list')}`);
  }
  return project;
}

function sslReady(): boolean {
  const status = getSSLStatus();
  return status.mkcertInstalled && status.caInstalled;
}

function projectUrl(project: Project, secure = sslReady()): string {
  return `${secure ? 'https' : 'http'}://${project.name}.${getTld()}`;
}

function projectJson(project: ProjectWithStatus) {
  return {
    ...project,
    url: projectUrl(project),
    localUrl: `http://localhost:${project.port}`,
    devCommand: resolveDevCommand(project),
    logFile: getLogFilePath(project.name),
  };
}

function syncHostsWithMessage(spinner?: ReturnType<typeof ora>): boolean {
  if (isLocalhostTld()) return true;
  const result = updateHostsFile();
  if (!result.success) {
    const message = `Hosts file update failed: ${result.error}`;
    if (spinner) spinner.warn(message);
    else console.log(chalk.yellow(`⚠ ${message}`));
    console.log(chalk.yellow(`  Run "portpilot sync" as administrator, or switch to "portpilot config --tld localhost".`));
    return false;
  }
  return true;
}

function printNextHint(project: Project): void {
  if (project.framework !== 'next' || isLocalhostTld()) return;
  console.log('');
  console.log(chalk.yellow('  Next.js tip:'), chalk.dim('add this to next.config so dev requests from'), chalk.white(`${project.name}.${getTld()}`), chalk.dim('are allowed:'));
  console.log(chalk.white(`    allowedDevOrigins: ['*.${getTld()}'],`));
  console.log(chalk.dim('  PortPilot already rewrites the Origin of Next dev requests, but this is the supported fix.'));
}

function printStartResult(project: Project, result: { pid?: number; warning?: string; command?: string }): void {
  console.log('');
  console.log(chalk.dim('  Id:'), chalk.white(project.id));
  console.log(chalk.dim('  URL:'), chalk.green(projectUrl(project, false)));
  if (sslReady()) {
    console.log(chalk.dim('  SSL URL:'), chalk.green(projectUrl(project, true)));
  }
  console.log(chalk.dim('  PID:'), chalk.white(result.pid));
  if (result.command) console.log(chalk.dim('  Command:'), chalk.white(result.command));
  console.log(chalk.dim('  Logs:'), chalk.white(`portpilot logs ${project.name}`));
  if (result.warning) console.log(chalk.yellow(`  ⚠ ${result.warning}`));
  if (!isProxyDaemonRunning().running) {
    console.log(chalk.yellow('  ⚠ The proxy is not running, so the .%s URL will not load yet. Start it with: portpilot proxy -d').replace('%s', getTld()));
  }
  console.log('');
}

// ============ Program ============

program
  .name('portpilot')
  .description('Local development server manager - pretty URLs for your dev projects')
  .version(packageJson.version, '-v, --version')
  .addHelpText('after', `
Package managers:
  npm, pnpm, yarn and bun are auto-detected from package.json "packageManager"
  or lockfiles. Force one with: portpilot add --pm pnpm

Something not working? Run "portpilot doctor".
Tip: Run "portpilot <command> --help" for options on a specific command.`);

// ============ INIT COMMAND ============
program
  .command('init')
  .description('Initialize PortPilot with HTTPS support (downloads mkcert, installs CA)')
  .option('--tld <tld>', 'Set custom TLD (default: test; "localhost" needs no hosts file)')
  .option('--regen-certs', 'Regenerate certificates for all projects (adds *.name wildcards)')
  .action(async (options: { tld?: string; regenCerts?: boolean }) => {
    console.log(chalk.cyan.bold('\n✈️ PortPilot Setup\n'));

    if (options.tld) {
      const cleanTld = options.tld.replace(/^\./, '').toLowerCase();
      if (!isValidTld(cleanTld)) fail(`Invalid TLD ".${cleanTld}". Use letters, digits and hyphens.`);
      setTld(cleanTld);
      console.log(chalk.dim(`  TLD set to: .${cleanTld}\n`));
    }

    // Step 1: Download mkcert
    let spinner = ora('Checking mkcert...').start();

    if (isMkcertInstalled()) {
      spinner.succeed('mkcert already installed');
    } else {
      spinner.text = 'Downloading mkcert...';

      const downloadResult = await downloadMkcert((msg) => {
        spinner.text = msg;
      });

      if (!downloadResult.success) {
        spinner.fail(`Failed to download mkcert: ${downloadResult.error}`);
        process.exit(1);
      }

      spinner.succeed(downloadResult.verified ? 'mkcert downloaded (SHA-256 verified)' : 'mkcert downloaded (checksum not published, not verified)');
    }

    // Step 2: Install CA
    spinner = ora('Installing local Certificate Authority...').start();

    if (isCAInstalled()) {
      spinner.succeed('CA already installed');
    } else {
      // On macOS, stop spinner before sudo prompt to avoid UX confusion
      if (process.platform === 'darwin') {
        spinner.stop();
        console.log(chalk.yellow('\nAdmin password required for CA installation:'));
      } else {
        spinner.text = 'Installing CA (may require admin password)...';
      }

      const caResult = installCA();

      if (!caResult.success) {
        spinner.stop();
        if (caResult.requiresAdmin) {
          console.log(chalk.yellow('CA installation requires admin privileges'));
          console.log(chalk.yellow('\nPlease run as Administrator and try again:'));
          console.log(chalk.cyan('  portpilot init\n'));
        } else {
          console.log(chalk.red(`✗ Failed to install CA: ${caResult.error}`));
        }
        process.exit(1);
      }

      if (process.platform === 'darwin') {
        console.log(chalk.green('✓ CA installed and trusted'));
      } else {
        spinner.succeed('CA installed and trusted');
      }
    }

    // Step 3: Generate certs for all registered projects
    const tld = getTld();
    const projects = getProjects();

    if (projects.length > 0) {
      spinner = ora(`Generating certificates for ${projects.length} project(s)...`).start();

      const generated: string[] = [];
      const failed: string[] = [];

      for (const project of projects) {
        const certResult = generateCertificate(`${project.name}.${tld}`, { force: options.regenCerts });
        if (certResult.success) {
          generated.push(project.name);
        } else {
          failed.push(`${project.name}: ${certResult.error}`);
        }
      }

      if (failed.length > 0) {
        spinner.warn(`Generated ${generated.length}/${projects.length} certificates`);
        console.log(chalk.red('  Failed:'));
        failed.forEach((f) => console.log(chalk.red(`    ${f}`)));
      } else {
        spinner.succeed(`Certificates ready for: ${generated.join(', ')}`);
      }
    } else {
      console.log(chalk.dim('  No projects registered yet. Certificates will be generated when you add projects.'));
    }

    console.log('');
    console.log(chalk.green.bold('✓ PortPilot is ready for HTTPS!'));
    console.log('');
    console.log(chalk.dim('  Your projects will be available at:'));
    console.log(chalk.white(`  https://[project-name].${tld}`));
    console.log('');
    console.log(chalk.dim('  Start the proxy with:'));
    console.log(chalk.cyan('  portpilot proxy -d'));
    console.log(chalk.dim('  Start it automatically at login:'));
    console.log(chalk.cyan('  portpilot service install'));
    console.log('');
  });

// ============ ADD COMMAND ============
program
  .command('add [name]')
  .description('Register current directory as a project')
  .option('-p, --path <path>', 'Path to project (defaults to current directory)')
  .option('-c, --command <command>', 'Custom dev command (placeholders: {port}, {pm}, {host})')
  .option('--port <number>', 'Specify a custom port (default: next free port)', parsePortOption)
  .option('--pm <manager>', 'Package manager: npm, pnpm, yarn, bun (default: auto-detected)')
  .option('--filter <package>', 'Workspace package to run (pnpm --filter, yarn workspace, npm --workspace)')
  .addOption(new Option('--framework <framework>', 'Override framework detection').choices(FRAMEWORKS))
  .option('-e, --env <KEY=value>', 'Environment variable for the dev server (repeatable)', collect, [])
  .option('--node <version>', 'Node version to run with ("22", "22.14.0", or "auto" for .nvmrc)')
  .addHelpText('after', `
Examples:
  portpilot add                          Register current directory
  portpilot add myapp --port 4000        Use a specific port
  portpilot add myapp --pm pnpm          Force pnpm instead of auto-detecting
  portpilot add web --filter @acme/web   Run one package of a pnpm/yarn/npm workspace
  portpilot add myapp -e API_URL=http://api.test --node 22
  portpilot add myapp -c "{pm} run serve --port {port}"

Git worktrees: running "portpilot add" inside a linked worktree of a registered
project registers it as <branch>.<project>, e.g. https://fix-ui.myapp.test

Package manager detection (checked on every start):
  1. "packageManager" field in package.json (e.g. "pnpm@10.4.0")
  2. Lockfile in the project or a parent directory, up to the repo/workspace root
     (pnpm-lock.yaml, bun.lock, yarn.lock, package-lock.json)
  3. npm`)
  .action(async (name: string | undefined, options: {
    path?: string; command?: string; port?: number; pm?: string; filter?: string;
    framework?: string; env: string[]; node?: string;
  }) => {
    const projectPath = path.resolve(options.path || process.cwd());

    const validation = validateProjectPath(projectPath);
    if (!validation.valid) fail(validation.error!);

    if (options.pm && !isPackageManager(options.pm)) {
      fail('Invalid package manager. Must be one of: npm, pnpm, yarn, bun.');
    }

    const env = parseEnvPairs(options.env);
    if (options.node && options.node !== 'auto') {
      const resolved = resolveNodePin(options.node, projectPath);
      if (resolved.error) console.log(chalk.yellow(`⚠ ${resolved.error}. The project will fail to start until it is installed.`));
    }

    const tld = getTld();
    const allowDots = getAllowDots();

    // Linked git worktree of a registered project -> <branch>.<project>
    let inherited: Partial<Project> = {};
    let worktreeName: string | undefined;
    if (!name && isLinkedWorktree(projectPath)) {
      const mainPath = getMainWorktreePath(projectPath);
      const mainProject = mainPath ? getProjects().find((p) => isSamePath(p.path, mainPath)) : undefined;
      const branch = getCurrentBranch(projectPath);
      if (mainProject && branch) {
        worktreeName = `${branchToLabel(branch)}.${mainProject.name}`;
        inherited = {
          command: mainProject.command,
          packageManager: mainProject.packageManager,
          filter: mainProject.filter,
          env: mainProject.env,
          node: mainProject.node,
        };
      }
    }

    const projectName = name
      ? sanitizeProjectName(name, { tld, allowDots })
      : worktreeName ?? suggestProjectName(projectPath);

    if (!projectName) fail('Invalid project name');

    const framework = options.framework && isFramework(options.framework) ? options.framework : detectFramework(projectPath);
    const spinner = ora(`Adding project ${chalk.cyan(projectName)}...`).start();

    try {
      const registeredPorts = getProjects().map((p) => p.port);
      let port: number;
      if (options.port) {
        port = options.port;
        if (await isPortInUse(port)) {
          spinner.warn(`Port ${port} is in use by another process right now; "start" will fail until it is free.`);
          spinner.start();
        }
      } else {
        port = await findAvailablePort(getNextPort(), registeredPorts);
      }

      const project = addProject({
        ...inherited,
        name: projectName,
        path: projectPath,
        framework,
        ...(options.command ? { command: options.command } : {}),
        ...(options.pm && isPackageManager(options.pm) ? { packageManager: options.pm } : {}),
        ...(options.filter ? { filter: options.filter } : {}),
        ...(Object.keys(env).length > 0 ? { env: { ...inherited.env, ...env } } : {}),
        ...(options.node ? { node: options.node } : {}),
      }, { port });

      spinner.text = 'Updating hosts file...';
      if (syncHostsWithMessage(spinner)) {
        spinner.succeed(`Project ${chalk.cyan(projectName)} registered!`);
      }

      if (isCAInstalled()) {
        const domain = `${projectName}.${tld}`;
        if (generateCertificate(domain).success) {
          console.log(chalk.dim(`  SSL cert generated for ${domain}`));
        }
      }

      const pm = detectPackageManagerWithSource(projectPath);
      console.log('');
      console.log(chalk.dim('  Id:'), chalk.white(project.id));
      console.log(chalk.dim('  Framework:'), chalk.white(framework));
      console.log(
        chalk.dim('  Package manager:'),
        chalk.white(project.packageManager ?? `${pm.manager} (auto-detected from ${pm.source})`)
      );
      if (project.filter) console.log(chalk.dim('  Workspace package:'), chalk.white(project.filter));
      if (project.node) console.log(chalk.dim('  Node:'), chalk.white(project.node === 'auto' ? `auto (${readProjectNodeVersion(projectPath) ?? 'no .nvmrc found'})` : project.node));
      console.log(chalk.dim('  URL:'), chalk.green(projectUrl(project, false)));
      if (sslReady()) {
        console.log(chalk.dim('  SSL URL:'), chalk.green(projectUrl(project, true)));
      }
      console.log(chalk.dim('  Port:'), chalk.white(project.port));
      console.log(chalk.dim('  Command:'), chalk.white(resolveDevCommand(project)));
      if (framework === 'custom' && !project.command) {
        console.log(chalk.yellow('  ⚠ Framework not detected: the port is only passed as the PORT env var.'));
        console.log(chalk.dim('    Use --framework or -c "{pm} run dev --port {port}" if your dev server ignores PORT.'));
      }
      printNextHint(project);
      console.log('');
      console.log(`Start with: ${chalk.cyan(`portpilot start ${projectName} -d`)}`);
    } catch (error) {
      spinner.fail((error as Error).message);
      process.exit(1);
    }
  });

// ============ SET COMMAND ============
program
  .command('set <name|id>')
  .description('Change settings of a registered project')
  .option('--port <number>', 'Change the port', parsePortOption)
  .option('--pm <manager>', 'Package manager: npm, pnpm, yarn, bun, or "auto"')
  .option('-c, --command <command>', 'Custom dev command ("" to go back to the framework default)')
  .option('--filter <package>', 'Workspace package to run ("" to clear)')
  .addOption(new Option('--framework <framework>', 'Framework').choices(FRAMEWORKS))
  .option('-e, --env <KEY=value>', 'Set an environment variable (repeatable)', collect, [])
  .option('--unset-env <KEY>', 'Remove an environment variable (repeatable)', collect, [])
  .option('--node <version>', 'Node version ("22", "22.14.0", "auto", or "none" to clear)')
  .action(async (nameOrId: string, options: {
    port?: number; pm?: string; command?: string; filter?: string; framework?: string;
    env: string[]; unsetEnv: string[]; node?: string;
  }) => {
    const project = resolveProject(nameOrId);
    const updates: Partial<Project> = {};

    if (options.port !== undefined && options.port !== project.port) {
      const other = getProjects().find((p) => p.port === options.port && p.name !== project.name);
      if (other) fail(`Port ${options.port} is already used by ${other.name}`);
      if (getProjectStatus(project).status === 'running') {
        console.log(chalk.yellow('⚠ The project is running; restart it to use the new port.'));
      }
      updates.port = options.port;
    }
    if (options.pm !== undefined) {
      if (options.pm === 'auto') updates.packageManager = undefined;
      else if (isPackageManager(options.pm)) updates.packageManager = options.pm;
      else fail('Invalid package manager. Must be one of: npm, pnpm, yarn, bun, auto.');
    }
    if (options.command !== undefined) updates.command = options.command || undefined;
    if (options.filter !== undefined) updates.filter = options.filter || undefined;
    if (options.framework && isFramework(options.framework)) updates.framework = options.framework;
    if (options.node !== undefined) updates.node = options.node === 'none' || options.node === '' ? undefined : options.node;

    if (options.env.length > 0 || options.unsetEnv.length > 0) {
      const env = { ...project.env, ...parseEnvPairs(options.env) };
      for (const key of options.unsetEnv) delete env[key];
      updates.env = Object.keys(env).length > 0 ? env : undefined;
    }

    if (Object.keys(updates).length === 0) {
      fail('Nothing to change.', `See ${chalk.cyan('portpilot set --help')}`);
    }

    const updated = updateProject(project.name, updates)!;
    console.log(chalk.green(`✓ Updated ${updated.name}`));
    console.log(chalk.dim('  Command:'), chalk.white(resolveDevCommand(updated)));
  });

// ============ INFO COMMAND ============
program
  .command('info [name|id]')
  .description('Show everything about one project')
  .option('--json', 'Output JSON')
  .action((nameOrId: string | undefined, options: { json?: boolean }) => {
    const project = getProjectStatus(resolveProject(nameOrId));
    const data = projectJson(project);
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const pm = detectPackageManagerWithSource(project.path);
    console.log('');
    console.log(chalk.cyan.bold(`  ${project.name}`), chalk.dim(`#${project.id}`));
    console.log(chalk.dim('  Status:'), project.status === 'running' ? chalk.green(`running (PID ${project.pid})`) : project.status === 'error' ? chalk.red('error') : chalk.gray('stopped'));
    if (project.lastError) console.log(chalk.dim('  Last error:'), chalk.red(project.lastError.split('\n')[0]));
    console.log(chalk.dim('  URL:'), chalk.green(data.url));
    console.log(chalk.dim('  Local URL:'), chalk.white(data.localUrl));
    console.log(chalk.dim('  Path:'), chalk.white(project.path));
    console.log(chalk.dim('  Framework:'), chalk.white(project.framework));
    console.log(chalk.dim('  Package manager:'), chalk.white(project.packageManager ?? `${pm.manager} (${pm.source})`));
    if (project.filter) console.log(chalk.dim('  Workspace package:'), chalk.white(project.filter));
    if (project.node) console.log(chalk.dim('  Node:'), chalk.white(project.node));
    if (project.env) {
      console.log(chalk.dim('  Env:'));
      for (const [key, value] of Object.entries(project.env)) console.log(chalk.white(`    ${key}=${value}`));
    }
    console.log(chalk.dim('  Command:'), chalk.white(data.devCommand));
    console.log(chalk.dim('  Logs:'), chalk.white(data.logFile));
    console.log('');
  });

// ============ REMOVE COMMAND ============
program
  .command('remove <name|id>')
  .alias('rm')
  .description('Unregister a project (by name or ID)')
  .action(async (nameOrId: string) => {
    const project = resolveProject(nameOrId);
    const spinner = ora(`Removing project ${chalk.cyan(project.name)}...`).start();

    // Stop the project if running
    const stopResult = await stopProject(project.name);
    if (!stopResult.success && !stopResult.error?.includes('not running')) {
      spinner.fail(`Could not stop ${project.name}: ${stopResult.error}`);
      process.exit(1);
    }

    if (!removeProject(project.name)) {
      spinner.fail(`Project "${project.name}" not found`);
      process.exit(1);
    }

    deleteCertificate(`${project.name}.${getTld()}`);
    removeProjectFiles(project.name);

    if (syncHostsWithMessage(spinner)) {
      spinner.succeed(`Project ${chalk.cyan(project.name)} removed`);
    }
  });

// ============ LIST COMMAND ============
program
  .command('list')
  .alias('ls')
  .description('List all registered projects with IDs')
  .option('--json', 'Output JSON')
  .option('--names', 'Print only project names (for scripts and shell completion)')
  .action((options: { json?: boolean; names?: boolean }) => {
    if (options.names) {
      getProjects().forEach((p) => console.log(p.name));
      return;
    }

    const projects = getAllProjectsWithStatus();

    if (options.json) {
      console.log(JSON.stringify(projects.map(projectJson), null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log(chalk.yellow('No projects registered.'));
      console.log(`Add one with: ${chalk.cyan('portpilot add [name]')}`);
      return;
    }

    const secure = sslReady();
    const table = new Table({
      head: ['ID', 'Name', 'URL', 'Port', 'Status', 'Framework'].map((h) => chalk.white(h)),
      style: { head: [], border: [] },
    });

    for (const project of projects) {
      const statusColor = project.status === 'running' ? chalk.green : project.status === 'error' ? chalk.red : chalk.gray;
      const statusIcon = project.status === 'running' ? '●' : project.status === 'error' ? '✗' : '○';

      table.push([
        chalk.dim(project.id.toString()),
        chalk.cyan(project.name),
        chalk.dim(projectUrl(project, secure)),
        project.port.toString(),
        statusColor(`${statusIcon} ${project.status}`),
        project.framework,
      ]);
    }

    console.log(table.toString());

    if (projects.some((p) => p.status === 'error')) {
      console.log(chalk.dim('\nA project failed to start. See why with "portpilot info <name>" or "portpilot logs <name>".'));
    }
    if (!secure) {
      console.log(chalk.dim('\nTip: Run "portpilot init" to enable HTTPS'));
    }
  });

// ============ START COMMAND ============
program
  .command('start [name|id]')
  .description('Start a project dev server (by name or ID)')
  .option('-d, --detach', 'Run in background (detached mode)')
  .option('-a, --all', 'Start all registered projects')
  .action(async (nameOrId: string | undefined, options: { detach?: boolean; all?: boolean }) => {
    if (options.all) {
      if (!options.detach) {
        fail('--all requires --detach (-d) flag', `${chalk.dim('  Cannot run multiple projects in foreground mode')}\n  Use: ${chalk.cyan('portpilot start --all -d')}`);
      }

      const spinner = ora('Starting all projects...').start();
      const result = await startAllProjects({ detached: true });

      if (result.started.length > 0) {
        spinner.succeed(`Started: ${result.started.join(', ')}`);
      } else if (result.errors.length === 0) {
        spinner.info('No stopped projects to start');
      } else {
        spinner.fail('No projects started');
      }

      result.warnings.forEach((w) => console.log(chalk.yellow(`  ⚠ ${w}`)));
      if (result.errors.length > 0) {
        console.log(chalk.red('Errors:'));
        result.errors.forEach((e) => console.log(chalk.red(`  ${e.split('\n')[0]}`)));
        process.exitCode = 1;
      }
      return;
    }

    const project = resolveProject(nameOrId);

    if (options.detach) {
      const spinner = ora(`Starting ${chalk.cyan(project.name)} in background...`).start();
      const result = await startProject(project.name, { detached: true });

      if (!result.success) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.succeed(result.ready
        ? `${chalk.cyan(project.name)} is running in background!`
        : `${chalk.cyan(project.name)} started in background`);
      printStartResult(project, result);
      return;
    }

    // Foreground mode (default)
    console.log('');
    console.log(chalk.cyan.bold(`  PortPilot: ${project.name}`));
    console.log(chalk.dim('  Id: ') + chalk.white(project.id));
    console.log(chalk.dim('  URL: ') + chalk.green(projectUrl(project, false)));
    if (sslReady()) {
      console.log(chalk.dim('  SSL URL: ') + chalk.green(projectUrl(project, true)));
    }
    console.log(chalk.dim(`  Port: ${project.port}`));
    console.log(chalk.dim(`  Command: ${resolveDevCommand(project)}`));
    console.log(chalk.dim('  Press Ctrl+C to stop\n'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log('');

    // This blocks until Ctrl+C
    const result = await startProject(project.name, { detached: false });

    if (!result.success) fail(result.error ?? 'Failed to start');

    console.log(chalk.yellow(`\n${project.name} stopped.`));
  });

// ============ STOP COMMAND ============
program
  .command('stop [name|id]')
  .description('Stop a project dev server (by name or ID)')
  .option('-a, --all', 'Stop all running projects')
  .action(async (nameOrId: string | undefined, options: { all?: boolean }) => {
    if (options.all) {
      const spinner = ora('Stopping all projects...').start();
      const result = await stopAllProjects();

      if (result.stopped.length > 0) {
        spinner.succeed(`Stopped: ${result.stopped.join(', ')}`);
      } else {
        spinner.info('No running projects to stop');
      }

      if (result.errors.length > 0) {
        console.log(chalk.red('Errors:'));
        result.errors.forEach((e) => console.log(chalk.red(`  ${e}`)));
        process.exitCode = 1;
      }
      return;
    }

    const project = resolveProject(nameOrId);
    const spinner = ora(`Stopping ${chalk.cyan(project.name)}...`).start();
    const result = await stopProject(project.name);

    if (!result.success) {
      spinner.fail(result.error);
      process.exit(1);
    }

    spinner.succeed(`${chalk.cyan(project.name)} stopped`);
  });

// ============ RESTART COMMAND ============
program
  .command('restart [name|id]')
  .description('Restart a project dev server (keeps background/foreground mode from the last start)')
  .option('-d, --detach', 'Run in background')
  .option('--foreground', 'Run in the foreground')
  .action(async (nameOrId: string | undefined, options: { detach?: boolean; foreground?: boolean }) => {
    const project = resolveProject(nameOrId);
    const detached = options.detach ? true : options.foreground ? false : project.detached ?? false;

    if (!detached) {
      const stopResult = await stopProject(project.name);
      if (!stopResult.success && !stopResult.error?.includes('not running')) fail(stopResult.error!);
      console.log(chalk.cyan(`  Restarting ${project.name} in the foreground (Ctrl+C to stop)\n`));
      console.log(chalk.dim('─'.repeat(50)));
      const result = await startProject(project.name, { detached: false });
      if (!result.success) fail(result.error ?? 'Failed to start');
      console.log(chalk.yellow(`\n${project.name} stopped.`));
      return;
    }

    const spinner = ora(`Restarting ${chalk.cyan(project.name)}...`).start();
    const result = await restartProject(project.name, { detached: true });
    if (!result.success) {
      spinner.fail(result.error);
      process.exit(1);
    }
    spinner.succeed(`${chalk.cyan(project.name)} restarted in background (PID: ${result.pid})`);
    if (result.warning) console.log(chalk.yellow(`  ⚠ ${result.warning}`));
  });

// ============ OPEN COMMAND ============
program
  .command('open [name|id]')
  .description('Open project in browser (by name or ID)')
  .option('-s, --https', 'Open with HTTPS')
  .action(async (nameOrId: string | undefined, options: { https?: boolean }) => {
    const project = resolveProject(nameOrId);
    const url = projectUrl(project, options.https || sslReady());

    const result = await openInBrowser(url);
    if (!result.success) {
      fail(`Could not open browser: ${result.error}`, chalk.dim(`URL: ${url}`));
    }
    console.log(chalk.dim(`Opened ${url}`));
  });

// ============ LOGS COMMAND ============
program
  .command('logs [name|id]')
  .description('View logs for a project by name or ID (only for detached processes)')
  .option('-n, --lines <number>', 'Number of lines to show', parsePositiveInt, 50)
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .option('--clear', 'Clear the log file')
  .action((nameOrId: string | undefined, options: { lines: number; follow?: boolean; clear?: boolean }) => {
    const project = resolveProject(nameOrId);

    if (options.clear) {
      const result = clearLogs(project.name);
      if (!result.success) fail(result.error!);
      console.log(chalk.green(`✓ Logs cleared for ${project.name}`));
      return;
    }

    console.log(chalk.cyan(`Logs for ${project.name}`) + chalk.dim(` (${getLogFilePath(project.name)})`));
    console.log(chalk.dim('─'.repeat(50)));

    const result = tailLogs(project.name, { lines: options.lines, follow: options.follow });
    if (!result.success) fail(result.error!);
  });

// ============ PROXY COMMAND ============
async function startProxyDetached(httpsRedirect?: boolean): Promise<void> {
  const daemonStatus = isProxyDaemonRunning();
  if (daemonStatus.running) {
    console.log(chalk.yellow(`Proxy already running in background (PID: ${daemonStatus.pid})`));
    console.log(chalk.dim(`  Stop with: ${chalk.cyan('portpilot proxy stop')}`));
    return;
  }

  const spinner = ora('Starting proxy in background...').start();
  const result = startProxyDaemon({ httpsRedirect });

  if (!result.success) {
    spinner.fail(result.error);
    process.exit(1);
  }

  // Catch immediate failures such as port 80 being taken
  const health = await waitForDaemon(result.pid!);
  if (!health.alive) {
    spinner.fail('Proxy exited right after starting');
    if (health.log) console.log(chalk.dim(health.log));
    console.log(chalk.dim(`  Run ${chalk.cyan('portpilot doctor')} for details.`));
    process.exit(1);
  }

  spinner.succeed(`Proxy running in background (PID: ${result.pid})`);
  console.log('');
  console.log(chalk.dim('  Stop:'), chalk.cyan('portpilot proxy stop'));
  console.log(chalk.dim('  Status:'), chalk.cyan('portpilot proxy status'));
  console.log(chalk.dim('  Logs:'), chalk.cyan('portpilot proxy logs'));
  console.log('');
}

program
  .command('proxy')
  .description('Manage the proxy server (no action or "start" starts it)')
  .addArgument(new Argument('[action]', 'What to do').choices(['start', 'stop', 'restart', 'status', 'logs']))
  .option('-d, --detach', 'Run proxy in background')
  .option('--https-redirect', 'Redirect HTTP to HTTPS')
  .option('-n, --lines <number>', 'Number of log lines to show', parsePositiveInt, 50)
  .action(async (action: string | undefined, options: { detach?: boolean; httpsRedirect?: boolean; lines: number }) => {
    if (action === 'stop') {
      const spinner = ora('Stopping proxy...').start();
      const result = await stopProxyDaemon();

      if (!result.success) spinner.fail(`Failed to stop proxy: ${result.error}`);
      else if (result.wasRunning) spinner.succeed('Proxy stopped');
      else spinner.info('Proxy was not running');
      return;
    }

    if (action === 'restart') {
      await stopProxyDaemon();
      await startProxyDetached(options.httpsRedirect);
      return;
    }

    if (action === 'status') {
      const status = isProxyDaemonRunning();
      if (status.running) {
        console.log(chalk.green(`✓ Proxy is running (PID: ${status.pid})`));
      } else {
        console.log(chalk.yellow('○ Proxy is not running'));
        console.log(chalk.dim(`  Start with: ${chalk.cyan('portpilot proxy -d')}`));
      }
      return;
    }

    if (action === 'logs') {
      const logs = getProxyLogs(options.lines);
      if (logs) {
        console.log(chalk.dim(`Proxy logs (${getProxyLogFile()}):`));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(logs);
      } else {
        console.log(chalk.yellow('No proxy logs found'));
      }
      return;
    }

    if (options.detach) {
      await startProxyDetached(options.httpsRedirect);
      return;
    }

    // Foreground mode (default)
    const daemonStatus = isProxyDaemonRunning();
    if (daemonStatus.running) {
      fail(`Proxy already running in background (PID: ${daemonStatus.pid})`, chalk.dim(`  Stop it first with: ${chalk.cyan('portpilot proxy stop')}`));
    }

    console.log(chalk.cyan('Starting PortPilot proxy server...'));
    console.log(chalk.dim('(Run with -d to start in background)\n'));

    const result = await startProxyServer({ httpsRedirect: options.httpsRedirect });
    if (!result.success) fail(result.error ?? 'Failed to start proxy');

    console.log(chalk.green(`✓ HTTP proxy running on port ${result.httpPort}`));

    if (result.sslEnabled) {
      console.log(chalk.green(`✓ HTTPS proxy running on port ${result.httpsPort}${result.http2 ? ' (HTTP/2)' : ''}`));
      if (options.httpsRedirect) {
        console.log(chalk.dim('  HTTP → HTTPS redirect enabled'));
      }
    } else {
      console.log(chalk.yellow('  HTTPS not available - run "portpilot init" to enable'));
    }

    console.log('');
    console.log(chalk.dim('Press Ctrl+C to stop'));

    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nShutting down proxy...'));
      process.exit(0);
    });
  });

// ============ STATUS COMMAND ============
program
  .command('status')
  .description('Show PortPilot status and configuration')
  .option('--json', 'Output JSON')
  .action((options: { json?: boolean }) => {
    const config = getConfig();
    const projects = getAllProjectsWithStatus();
    const running = projects.filter((p) => p.status === 'running');
    const hostsPerms = checkHostsPermissions();
    const sslStatus = getSSLStatus();
    const proxyStatus = isProxyDaemonRunning();

    if (options.json) {
      console.log(JSON.stringify({
        version: packageJson.version,
        configFile: getConfigPath(),
        tld: config.tld,
        http2: config.http2,
        autoStart: config.autoStart,
        startsAtLogin: isAutostartInstalled(),
        proxy: proxyStatus,
        ssl: sslStatus,
        hostsWritable: hostsPerms.canWrite,
        projects: { registered: projects.length, running: running.length },
      }, null, 2));
      return;
    }

    console.log(chalk.cyan.bold('\n✈️ PortPilot Status\n'));

    console.log(chalk.dim('Config file:'), getConfigPath());
    console.log(chalk.dim('TLD:'), `.${config.tld}`, isLocalhostTld(config.tld) ? chalk.dim('(no hosts file needed)') : '');
    console.log(chalk.dim('Projects:'), `${projects.length} registered, ${running.length} running`);
    if (!isLocalhostTld(config.tld)) {
      console.log(chalk.dim('Hosts file:'), hostsPerms.canWrite
        ? chalk.green('writable')
        : chalk.yellow('requires elevation'));
    }

    console.log('');
    console.log(chalk.dim('Proxy:'), proxyStatus.running
      ? chalk.green(`running (PID: ${proxyStatus.pid})`)
      : chalk.yellow('not running'));
    console.log(chalk.dim('HTTP/2:'), config.http2 ? 'on' : 'off');
    console.log(chalk.dim('Starts at login:'), isAutostartInstalled() ? chalk.green('yes') : 'no', chalk.dim(`(auto-start projects: ${config.autoStart ? 'on' : 'off'})`));

    console.log('');
    console.log(chalk.dim('SSL Status:'));
    console.log(chalk.dim('  mkcert:'), sslStatus.mkcertInstalled
      ? chalk.green('installed')
      : chalk.yellow('not installed'));
    console.log(chalk.dim('  CA:'), sslStatus.caInstalled
      ? chalk.green('installed & trusted')
      : chalk.yellow('not installed'));

    if (!sslStatus.mkcertInstalled || !sslStatus.caInstalled) {
      console.log(chalk.dim('\n  Run'), chalk.cyan('portpilot init'), chalk.dim('to enable HTTPS'));
    }

    console.log('');
  });

// ============ CONFIG COMMAND ============
program
  .command('config')
  .description('View or modify PortPilot configuration')
  .option('--tld <tld>', 'Change the TLD ("localhost" needs no hosts file edits)')
  .option('--allow-dots', 'Allow dots in project names')
  .option('--no-allow-dots', 'Disallow dots in project names')
  .option('--auto-start <on|off>', 'Start all projects when the proxy service starts', parseOnOff)
  .option('--http2 <on|off>', 'Serve HTTPS over HTTP/2 (restart the proxy to apply)', parseOnOff)
  .action((options: { tld?: string; allowDots?: boolean; autoStart?: boolean; http2?: boolean }) => {
    const hasOptions = options.tld !== undefined || options.allowDots !== undefined
      || options.autoStart !== undefined || options.http2 !== undefined;

    if (options.tld !== undefined) {
      const cleanTld = options.tld.replace(/^\./, '').toLowerCase();
      if (!isValidTld(cleanTld)) fail(`Invalid TLD ".${cleanTld}". Use letters, digits and hyphens.`);
      const previous = getTld();
      setTld(cleanTld);
      console.log(chalk.green(`✓ TLD changed from .${previous} to .${cleanTld}`));
      if (isLocalhostTld(cleanTld)) {
        console.log(chalk.dim('  .localhost resolves to 127.0.0.1 in browsers, so no hosts file entries are needed.'));
        console.log(chalk.dim('  Run "portpilot sync" once to remove the old entries.'));
      } else {
        console.log(chalk.yellow('  Run "portpilot sync" to update the hosts file'));
      }
      if (isCAInstalled()) console.log(chalk.yellow('  Run "portpilot init" to create certificates for the new TLD'));
      if (isProxyDaemonRunning().running) console.log(chalk.yellow('  Run "portpilot proxy restart" to apply'));
    }

    if (options.allowDots !== undefined) {
      setAllowDots(options.allowDots);
      console.log(chalk.green(`✓ Dots in project names: ${options.allowDots ? 'enabled' : 'disabled'}`));
    }

    if (options.autoStart !== undefined) {
      setAutoStart(options.autoStart);
      console.log(chalk.green(`✓ Auto-start projects with the proxy service: ${options.autoStart ? 'on' : 'off'}`));
      if (options.autoStart && !isAutostartInstalled()) {
        console.log(chalk.dim('  To start the proxy itself at login, run "portpilot service install".'));
      }
    }

    if (options.http2 !== undefined) {
      setHttp2(options.http2);
      console.log(chalk.green(`✓ HTTP/2: ${options.http2 ? 'on' : 'off'}`));
      if (isProxyDaemonRunning().running) console.log(chalk.yellow('  Run "portpilot proxy restart" to apply'));
    }

    if (!hasOptions) {
      const config = getConfig();
      console.log(chalk.cyan.bold('\n✈️ PortPilot Configuration\n'));
      console.log(chalk.dim('Config file:'), getConfigPath());
      console.log(chalk.dim('Data directory:'), PORTPILOT_DIR);
      console.log(chalk.dim('TLD:'), `.${config.tld}`);
      console.log(chalk.dim('Allow dots in names:'), config.allowDotsInNames ? 'yes' : 'no');
      console.log(chalk.dim('Auto-start projects:'), getAutoStart() ? 'on' : 'off');
      console.log(chalk.dim('HTTP/2:'), getHttp2() ? 'on' : 'off');
      console.log(chalk.dim('Ports:'), `HTTP ${config.proxyPort}, HTTPS ${config.httpsPort}, next dev port ${config.nextPort}`);
      console.log(chalk.dim('Registered projects:'), config.projects.length);
      console.log('');
      console.log(chalk.dim('Options:'));
      console.log(chalk.dim('  --tld <value>          Change TLD (e.g., --tld localhost)'));
      console.log(chalk.dim('  --allow-dots           Enable dots in project names'));
      console.log(chalk.dim('  --no-allow-dots        Disable dots in project names'));
      console.log(chalk.dim('  --auto-start <on|off>  Start projects with the proxy service'));
      console.log(chalk.dim('  --http2 <on|off>       Serve HTTPS over HTTP/2'));
      console.log('');
    }
  });

// ============ HOSTS SYNC COMMAND ============
program
  .command('sync')
  .description('Sync hosts file with registered projects')
  .action(() => {
    const hostsPerms = checkHostsPermissions();
    let spinner: ReturnType<typeof ora> | null = null;

    // On macOS, if elevation required, show message before sudo prompt
    if (process.platform === 'darwin' && hostsPerms.requiresElevation) {
      console.log(chalk.yellow('\nAdmin password required for hosts file update:'));
    } else {
      spinner = ora('Syncing hosts file...').start();
    }

    const result = updateHostsFile();

    if (!result.success) {
      if (spinner) spinner.fail(`Failed to update hosts file: ${result.error}`);
      else console.log(chalk.red(`✗ Failed to update hosts file: ${result.error}`));
      console.log(chalk.yellow('Try running as administrator.'));
      process.exit(1);
    }

    const message = result.changed ? 'Hosts file synced' : 'Hosts file already up to date';
    if (spinner) spinner.succeed(message);
    else console.log(chalk.green(`✓ ${message}`));
  });

// ============ DOCTOR COMMAND ============
program
  .command('doctor')
  .description('Check proxy, hosts file, HTTPS, ports and framework settings')
  .option('--json', 'Output JSON')
  .action(async (options: { json?: boolean }) => {
    const spinner = options.json ? null : ora('Running checks...').start();
    const checks = await runDoctor();
    spinner?.stop();

    if (options.json) {
      console.log(JSON.stringify(checks, null, 2));
    } else {
      const icon = (c: DoctorCheck) => (c.status === 'ok' ? chalk.green('✓') : c.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗'));
      console.log(chalk.cyan.bold('\n✈️ PortPilot Doctor\n'));
      for (const check of checks) {
        console.log(`${icon(check)} ${check.title}`);
        if (check.detail) console.log(chalk.dim(`    ${check.detail}`));
        if (check.fix) console.log(chalk.dim('    Fix: ') + chalk.cyan(check.fix));
      }
      const failures = checks.filter((c) => c.status === 'fail').length;
      const warnings = checks.filter((c) => c.status === 'warn').length;
      console.log('');
      console.log(failures === 0 && warnings === 0
        ? chalk.green('All good.')
        : `${failures} problem(s), ${warnings} warning(s).`);
      console.log('');
    }

    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

// ============ SERVICE COMMAND ============
program
  .command('service')
  .description('Start the proxy automatically at login')
  .addArgument(new Argument('<action>', 'What to do').choices(['install', 'uninstall', 'status']))
  .option('--https-redirect', 'Redirect HTTP to HTTPS when started at login')
  .action((action: string, options: { httpsRedirect?: boolean }) => {
    if (action === 'status') {
      console.log(isAutostartInstalled()
        ? chalk.green(`✓ Proxy starts at login (${getAutostartFile()})`)
        : chalk.yellow('○ Proxy does not start at login. Install with: portpilot service install'));
      console.log(chalk.dim(`  Auto-start projects: ${getAutoStart() ? 'on' : 'off'} (portpilot config --auto-start on|off)`));
      return;
    }

    if (action === 'uninstall') {
      const result = uninstallAutostart();
      if (!result.success) fail(`Could not remove ${result.file}: ${result.error}`);
      console.log(chalk.green('✓ Proxy will no longer start at login'));
      return;
    }

    const result = installAutostart({ httpsRedirect: options.httpsRedirect });
    if (!result.success) fail(`Could not install: ${result.error}`);
    console.log(chalk.green('✓ Proxy will start at login'));
    console.log(chalk.dim(`  ${result.file}`));
    if (result.note) console.log(chalk.yellow(`  ${result.note}`));
    console.log(chalk.dim('  Also start every project at login: portpilot config --auto-start on'));
  });

// ============ WORKTREES COMMAND ============
program
  .command('worktrees [name|id]')
  .description('List git worktrees of a project; --add registers each as <branch>.<project>')
  .option('--add', 'Register worktrees that are not registered yet')
  .action(async (nameOrId: string | undefined, options: { add?: boolean }) => {
    const project = resolveProject(nameOrId);
    const worktrees = listWorktrees(project.path);
    if (worktrees.length === 0) fail(`${project.path} is not a git repository`);

    const tld = getTld();
    const projects = getProjects();
    let added = 0;

    for (const worktree of worktrees) {
      const registered = projects.find((p) => isSamePath(p.path, worktree.path));
      const label = worktree.branch ? branchToLabel(worktree.branch) : undefined;

      if (registered) {
        console.log(`${chalk.green('●')} ${chalk.cyan(registered.name)} ${chalk.dim(`${worktree.branch ?? '(detached)'}  ${worktree.path}`)}`);
        continue;
      }
      if (!options.add || !label) {
        console.log(`${chalk.gray('○')} ${chalk.dim(`${worktree.branch ?? '(detached)'}  ${worktree.path}  (not registered)`)}`);
        continue;
      }

      const name = `${label}.${project.name}`;
      try {
        const port = await findAvailablePort(getNextPort(), getProjects().map((p) => p.port));
        addProject({
          name,
          path: worktree.path,
          framework: detectFramework(worktree.path) === 'custom' ? project.framework : detectFramework(worktree.path),
          command: project.command,
          packageManager: project.packageManager,
          filter: project.filter,
          env: project.env,
          node: project.node,
        }, { port });
        if (isCAInstalled()) generateCertificate(`${name}.${tld}`);
        console.log(`${chalk.green('+')} ${chalk.cyan(name)} ${chalk.dim(`port ${port}  ${worktree.path}`)}`);
        added++;
      } catch (error) {
        console.log(chalk.red(`✗ ${name}: ${(error as Error).message}`));
      }
    }

    if (added > 0) {
      syncHostsWithMessage();
      console.log(chalk.green(`\n✓ Registered ${added} worktree(s). Start one with: portpilot start <name> -d`));
    } else if (!options.add && worktrees.some((w) => !projects.find((p) => isSamePath(p.path, w.path)))) {
      console.log(chalk.dim('\nRegister the missing ones with: portpilot worktrees --add'));
    }
  });

// ============ UI COMMAND ============
program
  .command('ui')
  .alias('dashboard')
  .description('Interactive dashboard with live status and logs')
  .action(async () => {
    const { runDashboard } = await import('./dashboard.js');
    await runDashboard();
  });

// ============ MCP COMMAND ============
program
  .command('mcp')
  .description('Run an MCP server on stdio so AI coding agents can manage your dev servers')
  .addHelpText('after', `
Register with Claude Code:
  claude mcp add portpilot -- portpilot mcp

Tools: list_projects, get_project, start_project, stop_project, restart_project,
       get_logs, proxy_status, start_proxy, doctor`)
  .action(async () => {
    const { runMcpServer } = await import('../mcp/server.js');
    runMcpServer(packageJson.version);
  });

// ============ COMPLETION COMMAND ============
program
  .command('completion')
  .description('Print a shell completion script')
  .addArgument(new Argument('[shell]', 'Shell').choices(SHELLS).default(process.platform === 'win32' ? 'powershell' : 'bash'))
  .addHelpText('after', `
Install:
  bash        echo 'eval "$(portpilot completion bash)"' >> ~/.bashrc
  zsh         echo 'eval "$(portpilot completion zsh)"' >> ~/.zshrc
  fish        portpilot completion fish > ~/.config/fish/completions/portpilot.fish
  PowerShell  portpilot completion powershell >> $PROFILE`)
  .action((shell: Shell) => {
    process.stdout.write(getCompletionScript(shell));
  });

// ============ UNINSTALL COMMAND ============
program
  .command('uninstall')
  .description('Stop everything and remove hosts entries, certificates, logs and config')
  .option('-y, --yes', 'Do not ask for confirmation')
  .option('--keep-ca', 'Keep the local certificate authority trusted')
  .action(async (options: { yes?: boolean; keepCa?: boolean }) => {
    console.log(chalk.yellow('This will stop all PortPilot projects and the proxy, remove the hosts file'));
    console.log(chalk.yellow(`entries and login item, delete ${PORTPILOT_DIR}, and reset the config.`));
    if (!options.yes && !(await confirm('Continue?'))) {
      console.log('Cancelled.');
      return;
    }

    const step = async (label: string, fn: () => Promise<{ success: boolean; error?: string } | void> | { success: boolean; error?: string } | void) => {
      const spinner = ora(label).start();
      try {
        const result = await fn();
        if (result && !result.success) spinner.warn(`${label}: ${result.error}`);
        else spinner.succeed(label);
      } catch (error) {
        spinner.warn(`${label}: ${(error as Error).message}`);
      }
    };

    await step('Stopping projects', async () => {
      const result = await stopAllProjects();
      return result.errors.length ? { success: false, error: result.errors.join('; ') } : undefined;
    });
    await step('Stopping proxy', () => stopProxyDaemon());
    await step('Removing login item', () => uninstallAutostart());
    await step('Removing hosts file entries', () => removeHostsEntries());
    if (!options.keepCa) await step('Removing local CA from trust stores', () => uninstallCA());
    await step(`Deleting ${PORTPILOT_DIR}`, () => fs.rmSync(PORTPILOT_DIR, { recursive: true, force: true }));
    await step('Resetting config', () => resetConfig());

    console.log('');
    console.log(chalk.green('✓ PortPilot data removed.'));
    console.log(chalk.dim('  Remove the CLI with: npm uninstall -g @volchoklv/portpilot'));
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(chalk.red(`✗ ${(error as Error).message}`));
  process.exitCode = 1;
}
