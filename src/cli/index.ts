#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import {
  addProject,
  removeProject,
  getProjects,
  getProjectByName,
  getProjectByNameOrId,
  getProjectId,
  getTld,
  setTld,
  getAllowDots,
  setAllowDots,
  getConfigPath,
} from '../core/config.js';
import {
  detectFramework,
  validateProjectPath,
  sanitizeProjectName,
  suggestProjectName,
} from '../core/framework.js';
import { updateHostsFile, checkHostsPermissions } from '../core/hosts.js';
import {
  startProject,
  stopProject,
  restartProject,
  stopAllProjects,
  startAllProjects,
  getAllProjectsWithStatus,
  tailLogs,
  clearLogs,
  getLogFilePath,
} from '../core/process.js';
import { startProxyServer } from '../core/proxy.js';
import {
  downloadMkcert,
  installCA,
  generateCertificate,
  isMkcertInstalled,
  isCAInstalled,
  getSSLStatus,
} from '../core/ssl.js';

const program = new Command();

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')
);

program
  .name('portpilot')
  .description('Local development server manager - pretty URLs for your dev projects')
  .version(packageJson.version, '-v, --version')
  .addHelpText('after', '\nTip: Run "portpilot <command> --help" for options on a specific command.');

// ============ INIT COMMAND ============
program
  .command('init')
  .description('Initialize PortPilot with HTTPS support (downloads mkcert, installs CA)')
  .option('--tld <tld>', 'Set custom TLD (default: test)')
  .action(async (options: { tld?: string }) => {
    console.log(chalk.cyan.bold('\n✈️ PortPilot Setup\n'));

    // Set custom TLD if provided
    if (options.tld) {
      const cleanTld = options.tld.replace(/^\./, ''); // Remove leading dot if present
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
      
      spinner.succeed('mkcert downloaded');
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
        const domain = `${project.name}.${tld}`;
        const certResult = generateCertificate(domain);
        
        if (certResult.success) {
          generated.push(project.name);
        } else {
          failed.push(`${project.name}: ${certResult.error}`);
        }
      }
      
      if (failed.length > 0) {
        spinner.warn(`Generated ${generated.length}/${projects.length} certificates`);
        console.log(chalk.red('  Failed:'));
        failed.forEach(f => console.log(chalk.red(`    ${f}`)));
      } else {
        spinner.succeed(`Generated certificates for: ${generated.join(', ')}`);
      }
    } else {
      console.log(chalk.dim('  No projects registered yet. Certificates will be generated when you add projects.'));
    }
    
    // Done!
    console.log('');
    console.log(chalk.green.bold('✓ PortPilot is ready for HTTPS!'));
    console.log('');
    console.log(chalk.dim('  Your projects will be available at:'));
    console.log(chalk.white(`  https://[project-name].${tld}`));
    console.log('');
    console.log(chalk.dim('  Start the proxy with:'));
    console.log(chalk.cyan('  portpilot proxy -d'));
    console.log('');
  });

// ============ ADD COMMAND ============
program
  .command('add [name]')
  .description('Register current directory as a project')
  .option('-p, --path <path>', 'Path to project (defaults to current directory)')
  .option('-c, --command <command>', 'Custom dev command (use {port} placeholder)')
  .option('--port <number>', 'Specify a custom port (default: auto-assigned)')
  .action(async (name: string | undefined, options: { path?: string; command?: string; port?: string }) => {
    const projectPath = path.resolve(options.path || process.cwd());

    // Validate project path
    const validation = validateProjectPath(projectPath);
    if (!validation.valid) {
      console.error(chalk.red(`✗ ${validation.error}`));
      process.exit(1);
    }

    // Generate or sanitize name
    const tld = getTld();
    const allowDots = getAllowDots();
    const projectName = name
      ? sanitizeProjectName(name, { tld, allowDots })
      : suggestProjectName(projectPath);

    if (!projectName) {
      console.error(chalk.red('✗ Invalid project name'));
      process.exit(1);
    }

    // Parse port if specified
    const customPort = options.port ? parseInt(options.port, 10) : undefined;
    if (options.port && (isNaN(customPort!) || customPort! < 1 || customPort! > 65535)) {
      console.error(chalk.red('✗ Invalid port number. Must be between 1 and 65535.'));
      process.exit(1);
    }

    // Detect framework
    const framework = detectFramework(projectPath);
    const spinner = ora(`Adding project ${chalk.cyan(projectName)}...`).start();

    try {
      const project = addProject({
        name: projectName,
        path: projectPath,
        framework,
        command: options.command,
      }, { port: customPort });
      
      spinner.text = 'Updating hosts file...';
      const hostsResult = updateHostsFile();
      
      if (!hostsResult.success) {
        spinner.warn(`Project added but hosts file update failed: ${hostsResult.error}`);
        console.log(chalk.yellow('You may need to run as administrator to update hosts file.'));
      } else {
        spinner.succeed(`Project ${chalk.cyan(projectName)} registered!`);
      }

      // Generate SSL cert if CA is installed
      if (isCAInstalled()) {
        const domain = `${projectName}.${tld}`;
        const certResult = generateCertificate(domain);
        if (certResult.success) {
          console.log(chalk.dim(`  SSL cert generated for ${domain}`));
        }
      }
      
      const sslReady = isCAInstalled();
      const projectId = getProjectId(projectName);

      console.log('');
      console.log(chalk.dim('  Id:'), chalk.white(projectId));
      console.log(chalk.dim('  Framework:'), chalk.white(framework));
      console.log(chalk.dim('  URL:'), chalk.green(`http://${projectName}.${tld}`));
      if (sslReady) {
        console.log(chalk.dim('  SSL URL:'), chalk.green(`https://${projectName}.${tld}`));
      }
      console.log(chalk.dim('  Port:'), chalk.white(project.port));
      console.log('');
      console.log(`Start with: ${chalk.cyan(`portpilot start ${projectName}`)}`);
    } catch (error) {
      spinner.fail((error as Error).message);
      process.exit(1);
    }
  });

// ============ REMOVE COMMAND ============
program
  .command('remove <name>')
  .alias('rm')
  .description('Unregister a project (by name or ID)')
  .action(async (name: string) => {
    // Resolve by name or ID
    const resolved = getProjectByNameOrId(name);
    if (!resolved.project) {
      console.error(chalk.red(`✗ Project "${name}" not found`));
      console.log(`List projects with: ${chalk.cyan('portpilot list')}`);
      process.exit(1);
    }

    const projectName = resolved.project.name;
    const spinner = ora(`Removing project ${chalk.cyan(projectName)}...`).start();

    // Stop the project if running
    await stopProject(projectName);

    const removed = removeProject(projectName);
    if (!removed) {
      spinner.fail(`Project "${projectName}" not found`);
      process.exit(1);
    }

    // Update hosts file
    updateHostsFile();

    spinner.succeed(`Project ${chalk.cyan(projectName)} removed`);
  });

// ============ LIST COMMAND ============
program
  .command('list')
  .alias('ls')
  .description('List all registered projects with IDs')
  .action(() => {
    const projects = getAllProjectsWithStatus();
    
    if (projects.length === 0) {
      console.log(chalk.yellow('No projects registered.'));
      console.log(`Add one with: ${chalk.cyan('portpilot add [name]')}`);
      return;
    }
    
    const tld = getTld();
    const sslStatus = getSSLStatus();
    const sslReady = sslStatus.mkcertInstalled && sslStatus.caInstalled;
    
    const table = new Table({
      head: [
        chalk.white('ID'),
        chalk.white('Name'),
        chalk.white('URL'),
        chalk.white('Port'),
        chalk.white('Status'),
        chalk.white('Framework'),
      ],
      style: { head: [], border: [] },
    });

    projects.forEach((project, index) => {
      const statusColor = project.status === 'running' ? chalk.green : chalk.gray;
      const statusIcon = project.status === 'running' ? '●' : '○';
      const protocol = sslReady ? 'https' : 'http';

      table.push([
        chalk.dim((index + 1).toString()),
        chalk.cyan(project.name),
        chalk.dim(`${protocol}://${project.name}.${tld}`),
        project.port.toString(),
        statusColor(`${statusIcon} ${project.status}`),
        project.framework,
      ]);
    });
    
    console.log(table.toString());
    
    if (!sslReady) {
      console.log(chalk.dim('\nTip: Run "portpilot init" to enable HTTPS'));
    }
  });

// ============ START COMMAND ============
program
  .command('start [name|id]')
  .description('Start a project dev server (by name or ID)')
  .option('-d, --detach', 'Run in background (detached mode)')
  .option('-a, --all', 'Start all registered projects')
  .action(async (name: string | undefined, options: { detach?: boolean; all?: boolean }) => {
    // Handle --all flag
    if (options.all) {
      if (!options.detach) {
        console.error(chalk.red('✗ --all requires --detach (-d) flag'));
        console.log(chalk.dim('  Cannot run multiple projects in foreground mode'));
        console.log(`  Use: ${chalk.cyan('portpilot start --all -d')}`);
        process.exit(1);
      }

      const spinner = ora('Starting all projects...').start();
      const result = await startAllProjects({ detached: true });

      if (result.started.length > 0) {
        spinner.succeed(`Started: ${result.started.join(', ')}`);
      } else {
        spinner.info('No stopped projects to start');
      }

      if (result.errors.length > 0) {
        console.log(chalk.red('Errors:'));
        result.errors.forEach((e) => console.log(chalk.red(`  ${e}`)));
      }
      return;
    }

    let projectId: number;
    let projectName: string;

    if (!name) {
      // Try to start project in current directory
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);

      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        console.log(`Register with: ${chalk.cyan('portpilot add [name]')}`);
        process.exit(1);
      }

      projectName = project.name;
      projectId = getProjectId(project.name);
    } else {
      // Resolve by name or ID
      const resolved = getProjectByNameOrId(name);
      if (!resolved.project) {
        console.error(chalk.red(`✗ Project "${name}" not found`));
        console.log(`List projects with: ${chalk.cyan('portpilot list')}`);
        process.exit(1);
      }
      projectName = resolved.project.name;
      projectId = resolved.id;
    }

    const project = getProjectByName(projectName);
    const tld = getTld();
    const sslStatus = getSSLStatus();
    const sslReady = sslStatus.mkcertInstalled && sslStatus.caInstalled;

    if (options.detach) {
      // Background mode
      const spinner = ora(`Starting ${chalk.cyan(projectName)} in background...`).start();

      const result = await startProject(projectName, { detached: true });

      if (!result.success) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.succeed(`${chalk.cyan(projectName)} is running in background!`);
      console.log('');
      console.log(chalk.dim('  Id:'), chalk.white(projectId));
      console.log(chalk.dim('  URL:'), chalk.green(`http://${projectName}.${tld}`));
      if (sslReady) {
        console.log(chalk.dim('  SSL URL:'), chalk.green(`https://${projectName}.${tld}`));
      }
      console.log(chalk.dim('  PID:'), chalk.white(result.pid));
      console.log(chalk.dim('  Logs:'), chalk.white(`portpilot logs ${projectName}`));
      console.log('');
    } else {
      // Foreground mode (default)
      console.log('');
      console.log(chalk.cyan.bold(`  PortPilot: ${projectName}`));
      console.log(chalk.dim(`  Id: `) + chalk.white(projectId));
      console.log(chalk.dim(`  URL: `) + chalk.green(`http://${projectName}.${tld}`));
      if (sslReady) {
        console.log(chalk.dim(`  SSL URL: `) + chalk.green(`https://${projectName}.${tld}`));
      }
      console.log(chalk.dim(`  Port: ${project?.port}`));
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));
      console.log(chalk.dim('─'.repeat(50)));
      console.log('');

      // This blocks until Ctrl+C
      const result = await startProject(projectName, { detached: false });

      if (!result.success) {
        console.error(chalk.red(`\n✗ ${result.error}`));
        process.exit(1);
      }

      console.log(chalk.yellow(`\n${projectName} stopped.`));
    }
  });

// ============ STOP COMMAND ============
program
  .command('stop [name|id]')
  .description('Stop a project dev server (by name or ID)')
  .option('-a, --all', 'Stop all running projects')
  .action(async (name: string | undefined, options: { all?: boolean }) => {
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
      }
      return;
    }
    
    let projectName: string;

    if (!name) {
      // Try current directory
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);

      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }

      projectName = project.name;
    } else {
      // Resolve by name or ID
      const resolved = getProjectByNameOrId(name);
      if (!resolved.project) {
        console.error(chalk.red(`✗ Project "${name}" not found`));
        console.log(`List projects with: ${chalk.cyan('portpilot list')}`);
        process.exit(1);
      }
      projectName = resolved.project.name;
    }

    const spinner = ora(`Stopping ${chalk.cyan(projectName)}...`).start();

    const result = await stopProject(projectName);

    if (!result.success) {
      spinner.fail(result.error);
      process.exit(1);
    }

    spinner.succeed(`${chalk.cyan(projectName)} stopped`);
  });

// ============ RESTART COMMAND ============
program
  .command('restart [name|id]')
  .description('Restart a project dev server (by name or ID)')
  .option('-d, --detach', 'Run in background (detached mode)')
  .action(async (name: string | undefined, options: { detach?: boolean }) => {
    let projectName: string;

    if (!name) {
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);

      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }

      projectName = project.name;
    } else {
      // Resolve by name or ID
      const resolved = getProjectByNameOrId(name);
      if (!resolved.project) {
        console.error(chalk.red(`✗ Project "${name}" not found`));
        console.log(`List projects with: ${chalk.cyan('portpilot list')}`);
        process.exit(1);
      }
      projectName = resolved.project.name;
    }

    const spinner = ora(`Stopping ${chalk.cyan(projectName)}...`).start();

    await stopProject(projectName);

    spinner.text = `Starting ${chalk.cyan(projectName)}...`;

    // Brief delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (options.detach) {
      const result = await startProject(projectName, { detached: true });

      if (!result.success) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.succeed(`${chalk.cyan(projectName)} restarted in background (PID: ${result.pid})`);
    } else {
      spinner.succeed(`${chalk.cyan(projectName)} restarting...`);
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));
      console.log(chalk.dim('─'.repeat(50)));
      console.log('');

      const result = await startProject(projectName, { detached: false });

      if (!result.success) {
        console.error(chalk.red(`\n✗ ${result.error}`));
        process.exit(1);
      }

      console.log(chalk.yellow(`\n${projectName} stopped.`));
    }
  });

// ============ OPEN COMMAND ============
program
  .command('open [name|id]')
  .description('Open project in browser (by name or ID)')
  .option('-s, --https', 'Open with HTTPS')
  .action(async (name: string | undefined, options: { https?: boolean }) => {
    let projectName: string;

    if (!name) {
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);

      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }

      projectName = project.name;
    } else {
      // Resolve by name or ID
      const resolved = getProjectByNameOrId(name);
      if (!resolved.project) {
        console.error(chalk.red(`✗ Project "${name}" not found`));
        console.log(`List projects with: ${chalk.cyan('portpilot list')}`);
        process.exit(1);
      }
      projectName = resolved.project.name;
    }

    const project = getProjectByName(projectName);
    if (!project) {
      console.error(chalk.red(`✗ Project "${projectName}" not found`));
      process.exit(1);
    }
    
    const tld = getTld();
    const sslStatus = getSSLStatus();
    const useHttps = options.https || (sslStatus.mkcertInstalled && sslStatus.caInstalled);
    const protocol = useHttps ? 'https' : 'http';
    const url = `${protocol}://${project.name}.${tld}`;
    
    // Cross-platform open
    const { exec } = await import('child_process');
    const command = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    
    exec(`${command} ${url}`, (error) => {
      if (error) {
        console.error(chalk.red(`✗ Could not open browser: ${error.message}`));
        console.log(chalk.dim(`URL: ${url}`));
      }
    });
  });

// ============ LOGS COMMAND ============
program
  .command('logs [name|id]')
  .description('View logs for a project by name or ID (only for detached processes)')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .option('--clear', 'Clear the log file')
  .action(async (name: string | undefined, options: { lines: string; follow?: boolean; clear?: boolean }) => {
    let projectName: string;

    if (!name) {
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);

      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }

      projectName = project.name;
    } else {
      // Resolve by name or ID
      const resolved = getProjectByNameOrId(name);
      if (!resolved.project) {
        console.error(chalk.red(`✗ Project "${name}" not found`));
        console.log(`List projects with: ${chalk.cyan('portpilot list')}`);
        process.exit(1);
      }
      projectName = resolved.project.name;
    }

    if (options.clear) {
      const result = clearLogs(projectName);
      if (result.success) {
        console.log(chalk.green(`✓ Logs cleared for ${projectName}`));
      } else {
        console.error(chalk.red(`✗ ${result.error}`));
        process.exit(1);
      }
      return;
    }

    console.log(chalk.cyan(`Logs for ${projectName}`) + chalk.dim(` (${getLogFilePath(projectName)})`));
    console.log(chalk.dim('─'.repeat(50)));

    const result = tailLogs(projectName, {
      lines: parseInt(options.lines, 10),
      follow: options.follow
    });
    
    if (!result.success) {
      console.error(chalk.red(`✗ ${result.error}`));
      process.exit(1);
    }
  });

// ============ PROXY COMMAND ============
program
  .command('proxy [action]')
  .description('Manage the proxy server (actions: stop, status, logs)')
  .option('-d, --detach', 'Run proxy in background')
  .option('--https-redirect', 'Redirect HTTP to HTTPS')
  .option('-n, --lines <number>', 'Number of log lines to show', '50')
  .action(async (action: string | undefined, options: { detach?: boolean; httpsRedirect?: boolean; lines?: string }) => {
    // Import daemon functions
    const { 
      startProxyDaemon, 
      stopProxyDaemon, 
      isProxyDaemonRunning,
      getProxyLogs,
      getProxyLogFile
    } = await import('../core/daemon.js');
    
    // Handle subcommands
    if (action === 'stop') {
      const spinner = ora('Stopping proxy...').start();
      const result = stopProxyDaemon();
      
      if (result.wasRunning) {
        spinner.succeed('Proxy stopped');
      } else {
        spinner.info('Proxy was not running');
      }
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
      const logs = getProxyLogs(parseInt(options.lines || '50', 10));
      if (logs) {
        console.log(chalk.dim(`Proxy logs (${getProxyLogFile()}):`));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(logs);
      } else {
        console.log(chalk.yellow('No proxy logs found'));
      }
      return;
    }
    
    // Check if daemon is already running
    const daemonStatus = isProxyDaemonRunning();
    
    if (options.detach) {
      // Background mode
      if (daemonStatus.running) {
        console.log(chalk.yellow(`Proxy already running in background (PID: ${daemonStatus.pid})`));
        console.log(chalk.dim(`  Stop with: ${chalk.cyan('portpilot proxy stop')}`));
        return;
      }
      
      const spinner = ora('Starting proxy in background...').start();
      const result = startProxyDaemon({ httpsRedirect: options.httpsRedirect });
      
      if (!result.success) {
        spinner.fail(result.error);
        process.exit(1);
      }
      
      spinner.succeed(`Proxy running in background (PID: ${result.pid})`);
      console.log('');
      console.log(chalk.dim('  Stop:'), chalk.cyan('portpilot proxy stop'));
      console.log(chalk.dim('  Status:'), chalk.cyan('portpilot proxy status'));
      console.log(chalk.dim('  Logs:'), chalk.cyan('portpilot proxy logs'));
      console.log('');
      return;
    }
    
    // Foreground mode (default)
    if (daemonStatus.running) {
      console.log(chalk.yellow(`Proxy already running in background (PID: ${daemonStatus.pid})`));
      console.log(chalk.dim(`  Stop it first with: ${chalk.cyan('portpilot proxy stop')}`));
      process.exit(1);
    }
    
    console.log(chalk.cyan('Starting PortPilot proxy server...'));
    console.log(chalk.dim('(Run with -d to start in background)\n'));
    
    const result = await startProxyServer({ httpsRedirect: options.httpsRedirect });
    
    if (!result.success) {
      console.error(chalk.red(`✗ ${result.error}`));
      process.exit(1);
    }
    
    console.log(chalk.green(`✓ HTTP proxy running on port ${result.httpPort}`));
    
    if (result.sslEnabled) {
      console.log(chalk.green(`✓ HTTPS proxy running on port ${result.httpsPort}`));
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
  .action(async () => {
    const { isProxyDaemonRunning } = await import('../core/daemon.js');
    
    const tld = getTld();
    const projects = getAllProjectsWithStatus();
    const running = projects.filter((p) => p.status === 'running');
    const hostsPerms = checkHostsPermissions();
    const sslStatus = getSSLStatus();
    const proxyStatus = isProxyDaemonRunning();
    
    console.log(chalk.cyan.bold('\n✈️ PortPilot Status\n'));
    
    console.log(chalk.dim('Config file:'), getConfigPath());
    console.log(chalk.dim('TLD:'), `.${tld}`);
    console.log(chalk.dim('Projects:'), `${projects.length} registered, ${running.length} running`);
    console.log(chalk.dim('Hosts file:'), hostsPerms.canWrite 
      ? chalk.green('writable') 
      : chalk.yellow('requires elevation'));
    
    console.log('');
    console.log(chalk.dim('Proxy:'), proxyStatus.running
      ? chalk.green(`running (PID: ${proxyStatus.pid})`)
      : chalk.yellow('not running'));
    
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
  .option('--tld <tld>', 'Change the TLD (requires hosts sync)')
  .option('--allow-dots', 'Allow dots in project names')
  .option('--no-allow-dots', 'Disallow dots in project names')
  .action((options: { tld?: string; allowDots?: boolean }) => {
    const hasOptions = options.tld !== undefined || options.allowDots !== undefined;

    // If --tld is provided, update TLD
    if (options.tld) {
      const cleanTld = options.tld.replace(/^\./, '');
      setTld(cleanTld);
      console.log(chalk.green(`✓ TLD changed to .${cleanTld}`));
      console.log(chalk.yellow('  Run "portpilot sync" to update hosts file'));
    }

    // Handle --allow-dots / --no-allow-dots
    if (options.allowDots !== undefined) {
      setAllowDots(options.allowDots);
      if (options.allowDots) {
        console.log(chalk.green('✓ Dots in project names: enabled'));
      } else {
        console.log(chalk.green('✓ Dots in project names: disabled'));
      }
    }

    // If no options provided, display current config
    if (!hasOptions) {
      const tld = getTld();
      const allowDots = getAllowDots();
      const projects = getProjects();

      console.log(chalk.cyan.bold('\n✈️ PortPilot Configuration\n'));
      console.log(chalk.dim('Config file:'), getConfigPath());
      console.log(chalk.dim('TLD:'), `.${tld}`);
      console.log(chalk.dim('Allow dots in names:'), allowDots ? 'yes' : 'no');
      console.log(chalk.dim('Registered projects:'), projects.length);
      console.log('');
      console.log(chalk.dim('Options:'));
      console.log(chalk.dim('  --tld <value>      Change TLD (e.g., --tld dev)'));
      console.log(chalk.dim('  --allow-dots       Enable dots in project names'));
      console.log(chalk.dim('  --no-allow-dots    Disable dots in project names'));
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
      if (spinner) {
        spinner.fail(`Failed to update hosts file: ${result.error}`);
      } else {
        console.log(chalk.red(`✗ Failed to update hosts file: ${result.error}`));
      }
      console.log(chalk.yellow('Try running as administrator.'));
      process.exit(1);
    }

    if (spinner) {
      spinner.succeed('Hosts file synced');
    } else {
      console.log(chalk.green('✓ Hosts file synced'));
    }
  });

program.parse();
