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
  .version(packageJson.version);

// ============ INIT COMMAND ============
program
  .command('init')
  .description('Initialize PortPilot with HTTPS support (downloads mkcert, installs CA)')
  .action(async () => {
    console.log(chalk.cyan.bold('\n🚢 PortPilot Setup\n'));
    
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
      spinner.text = 'Installing CA (may require admin password)...';
      
      const caResult = installCA();
      
      if (!caResult.success) {
        if (caResult.requiresAdmin) {
          spinner.warn('CA installation requires admin privileges');
          console.log(chalk.yellow('\nPlease run as Administrator and try again:'));
          console.log(chalk.cyan('  portpilot init\n'));
        } else {
          spinner.fail(`Failed to install CA: ${caResult.error}`);
        }
        process.exit(1);
      }
      
      spinner.succeed('CA installed and trusted');
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
    const projectName = name
      ? sanitizeProjectName(name)
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
      
      const tld = getTld();
      
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
    
    console.log(chalk.cyan.bold('\n🚢 PortPilot Status\n'));
    
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

// ============ HOSTS SYNC COMMAND ============
program
  .command('sync')
  .description('Sync hosts file with registered projects')
  .action(() => {
    const spinner = ora('Syncing hosts file...').start();
    
    const result = updateHostsFile();
    
    if (!result.success) {
      spinner.fail(`Failed to update hosts file: ${result.error}`);
      console.log(chalk.yellow('Try running as administrator.'));
      process.exit(1);
    }
    
    spinner.succeed('Hosts file synced');
  });

// ============ PM2 COMMAND (OPTIONAL) ============
program
  .command('pm2 [action]')
  .description('Manage proxy with PM2 (optional - for auto-restart & boot startup)')
  .action(async (action: string | undefined) => {
    const { execSync, spawn } = await import('child_process');

    const PM2_NAME = 'portpilot-proxy';
    const SERVICE_SCRIPT = path.join(__dirname, '../service/index.js');
    const PROJECT_DIR = path.join(__dirname, '../..');

    // Check if PM2 is installed
    const isPm2Installed = (): boolean => {
      try {
        execSync('pm2 --version', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };

    // Check if process is running in PM2
    const isRunningInPm2 = (): boolean => {
      try {
        const output = execSync(`pm2 jlist`, { encoding: 'utf-8' });
        const processes = JSON.parse(output);
        return processes.some((p: { name: string; pm2_env?: { status?: string } }) =>
          p.name === PM2_NAME && p.pm2_env?.status === 'online'
        );
      } catch {
        return false;
      }
    };

    if (!action) {
      console.log(chalk.cyan.bold('\nPortPilot PM2 Integration\n'));
      console.log('Manage the proxy with PM2 for auto-restart and boot startup.\n');
      console.log(chalk.dim('Commands:'));
      console.log(`  ${chalk.cyan('portpilot pm2 setup')}     Check PM2 installation`);
      console.log(`  ${chalk.cyan('portpilot pm2 start')}     Start proxy via PM2`);
      console.log(`  ${chalk.cyan('portpilot pm2 stop')}      Stop PM2-managed proxy`);
      console.log(`  ${chalk.cyan('portpilot pm2 restart')}   Restart the proxy`);
      console.log(`  ${chalk.cyan('portpilot pm2 status')}    Show PM2 process status`);
      console.log(`  ${chalk.cyan('portpilot pm2 logs')}      View logs (live)`);
      console.log(`  ${chalk.cyan('portpilot pm2 startup')}   Enable auto-start on boot`);
      console.log('');
      return;
    }

    switch (action) {
      case 'setup': {
        console.log(chalk.cyan.bold('\nPM2 Setup\n'));

        if (isPm2Installed()) {
          const version = execSync('pm2 --version', { encoding: 'utf-8' }).trim();
          console.log(chalk.green(`✓ PM2 is installed (v${version})`));
          console.log('');
          console.log(chalk.dim('Next steps:'));
          console.log(`  1. ${chalk.cyan('portpilot pm2 start')}    Start the proxy`);
          console.log(`  2. ${chalk.cyan('portpilot pm2 startup')}  Enable auto-start on boot`);
        } else {
          console.log(chalk.yellow('○ PM2 is not installed'));
          console.log('');
          console.log('Install PM2 globally:');
          console.log(chalk.cyan('  npm install -g pm2'));
          console.log('');
          console.log('Then run:');
          console.log(chalk.cyan('  portpilot pm2 start'));
        }
        console.log('');
        break;
      }

      case 'start': {
        if (!isPm2Installed()) {
          console.error(chalk.red('✗ PM2 is not installed'));
          console.log(`Install with: ${chalk.cyan('npm install -g pm2')}`);
          process.exit(1);
        }

        if (isRunningInPm2()) {
          console.log(chalk.yellow(`${PM2_NAME} is already running in PM2`));
          console.log(`Use ${chalk.cyan('portpilot pm2 restart')} to restart`);
          return;
        }

        const spinner = ora('Starting proxy with PM2...').start();

        try {
          // Stop any existing daemon first
          const { stopProxyDaemon } = await import('../core/daemon.js');
          stopProxyDaemon();

          execSync(
            `pm2 start "${SERVICE_SCRIPT}" --name ${PM2_NAME} --cwd "${PROJECT_DIR}"`,
            { stdio: 'ignore' }
          );

          spinner.succeed(`Proxy started with PM2`);
          console.log('');
          console.log(chalk.dim('  Status:'), chalk.cyan('portpilot pm2 status'));
          console.log(chalk.dim('  Logs:'), chalk.cyan('portpilot pm2 logs'));
          console.log(chalk.dim('  Stop:'), chalk.cyan('portpilot pm2 stop'));
          console.log('');
        } catch (err) {
          spinner.fail(`Failed to start: ${(err as Error).message}`);
          process.exit(1);
        }
        break;
      }

      case 'stop': {
        if (!isPm2Installed()) {
          console.error(chalk.red('✗ PM2 is not installed'));
          process.exit(1);
        }

        const spinner = ora('Stopping proxy...').start();

        try {
          execSync(`pm2 stop ${PM2_NAME}`, { stdio: 'ignore' });
          spinner.succeed('Proxy stopped');
        } catch {
          spinner.info('Proxy was not running in PM2');
        }
        break;
      }

      case 'restart': {
        if (!isPm2Installed()) {
          console.error(chalk.red('✗ PM2 is not installed'));
          process.exit(1);
        }

        const spinner = ora('Restarting proxy...').start();

        try {
          execSync(`pm2 restart ${PM2_NAME}`, { stdio: 'ignore' });
          spinner.succeed('Proxy restarted');
        } catch {
          spinner.fail('Failed to restart - proxy may not be running');
          console.log(`Start with: ${chalk.cyan('portpilot pm2 start')}`);
        }
        break;
      }

      case 'status': {
        if (!isPm2Installed()) {
          console.error(chalk.red('✗ PM2 is not installed'));
          process.exit(1);
        }

        try {
          execSync(`pm2 show ${PM2_NAME}`, { stdio: 'inherit' });
        } catch {
          console.log(chalk.yellow(`${PM2_NAME} is not running in PM2`));
          console.log(`Start with: ${chalk.cyan('portpilot pm2 start')}`);
        }
        break;
      }

      case 'logs': {
        if (!isPm2Installed()) {
          console.error(chalk.red('✗ PM2 is not installed'));
          process.exit(1);
        }

        console.log(chalk.dim('Press Ctrl+C to exit\n'));

        // Spawn pm2 logs with inherited stdio for live output
        const child = spawn('pm2', ['logs', PM2_NAME], {
          stdio: 'inherit',
          shell: true,
        });

        child.on('error', (err) => {
          console.error(chalk.red(`Failed to show logs: ${err.message}`));
        });
        break;
      }

      case 'startup': {
        if (!isPm2Installed()) {
          console.error(chalk.red('✗ PM2 is not installed'));
          process.exit(1);
        }

        console.log(chalk.cyan.bold('\nEnable Auto-Start on Boot\n'));
        console.log('Run these commands (may require admin privileges):\n');
        console.log(chalk.cyan('  pm2 startup'));
        console.log(chalk.dim('  (Follow the instructions it provides)\n'));
        console.log(chalk.cyan('  pm2 save'));
        console.log(chalk.dim('  (Saves current PM2 process list)\n'));

        console.log(chalk.dim('This will:'));
        console.log('  - Configure PM2 to start on system boot');
        console.log('  - Automatically restart portpilot-proxy after reboot');
        console.log('');
        break;
      }

      default:
        console.error(chalk.red(`Unknown action: ${action}`));
        console.log(`Run ${chalk.cyan('portpilot pm2')} to see available commands`);
        process.exit(1);
    }
  });

program.parse();
