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
  getAllProjectsWithStatus,
} from '../core/process.js';
import { startProxyServer } from '../core/proxy.js';

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

// ============ ADD COMMAND ============
program
  .command('add [name]')
  .description('Register current directory as a project')
  .option('-p, --path <path>', 'Path to project (defaults to current directory)')
  .option('-c, --command <command>', 'Custom dev command (use {port} placeholder)')
  .action(async (name: string | undefined, options: { path?: string; command?: string }) => {
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
    
    // Detect framework
    const framework = detectFramework(projectPath);
    const spinner = ora(`Adding project ${chalk.cyan(projectName)}...`).start();
    
    try {
      const project = addProject({
        name: projectName,
        path: projectPath,
        framework,
        command: options.command,
      });
      
      spinner.text = 'Updating hosts file...';
      const hostsResult = updateHostsFile();
      
      if (!hostsResult.success) {
        spinner.warn(`Project added but hosts file update failed: ${hostsResult.error}`);
        console.log(chalk.yellow('You may need to run as administrator to update hosts file.'));
      } else {
        spinner.succeed(`Project ${chalk.cyan(projectName)} registered!`);
      }
      
      const tld = getTld();
      console.log('');
      console.log(chalk.dim('  Framework:'), chalk.white(framework));
      console.log(chalk.dim('  URL:'), chalk.green(`http://${projectName}.${tld}`));
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
  .description('Unregister a project')
  .action(async (name: string) => {
    const spinner = ora(`Removing project ${chalk.cyan(name)}...`).start();
    
    // Stop the project if running
    await stopProject(name);
    
    const removed = removeProject(name);
    if (!removed) {
      spinner.fail(`Project "${name}" not found`);
      process.exit(1);
    }
    
    // Update hosts file
    updateHostsFile();
    
    spinner.succeed(`Project ${chalk.cyan(name)} removed`);
  });

// ============ LIST COMMAND ============
program
  .command('list')
  .alias('ls')
  .description('List all registered projects')
  .action(() => {
    const projects = getAllProjectsWithStatus();
    
    if (projects.length === 0) {
      console.log(chalk.yellow('No projects registered.'));
      console.log(`Add one with: ${chalk.cyan('portpilot add [name]')}`);
      return;
    }
    
    const tld = getTld();
    const table = new Table({
      head: [
        chalk.white('Name'),
        chalk.white('URL'),
        chalk.white('Port'),
        chalk.white('Status'),
        chalk.white('Framework'),
      ],
      style: { head: [], border: [] },
    });
    
    for (const project of projects) {
      const statusColor = project.status === 'running' ? chalk.green : chalk.gray;
      const statusIcon = project.status === 'running' ? '●' : '○';
      
      table.push([
        chalk.cyan(project.name),
        chalk.dim(`http://${project.name}.${tld}`),
        project.port.toString(),
        statusColor(`${statusIcon} ${project.status}`),
        project.framework,
      ]);
    }
    
    console.log(table.toString());
  });

// ============ START COMMAND ============
program
  .command('start [name]')
  .description('Start a project dev server')
  .action(async (name?: string) => {
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
      
      name = project.name;
    }
    
    const spinner = ora(`Starting ${chalk.cyan(name)}...`).start();
    
    const result = await startProject(name);
    
    if (!result.success) {
      spinner.fail(result.error);
      process.exit(1);
    }
    
    const project = getProjectByName(name);
    const tld = getTld();
    
    spinner.succeed(`${chalk.cyan(name)} is running!`);
    console.log('');
    console.log(chalk.dim('  URL:'), chalk.green(`http://${name}.${tld}`));
    console.log(chalk.dim('  PID:'), chalk.white(result.pid));
    console.log('');
  });

// ============ STOP COMMAND ============
program
  .command('stop [name]')
  .description('Stop a project dev server')
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
    
    if (!name) {
      // Try current directory
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);
      
      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }
      
      name = project.name;
    }
    
    const spinner = ora(`Stopping ${chalk.cyan(name)}...`).start();
    
    const result = await stopProject(name);
    
    if (!result.success) {
      spinner.fail(result.error);
      process.exit(1);
    }
    
    spinner.succeed(`${chalk.cyan(name)} stopped`);
  });

// ============ RESTART COMMAND ============
program
  .command('restart [name]')
  .description('Restart a project dev server')
  .action(async (name?: string) => {
    if (!name) {
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);
      
      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }
      
      name = project.name;
    }
    
    const spinner = ora(`Restarting ${chalk.cyan(name)}...`).start();
    
    const result = await restartProject(name);
    
    if (!result.success) {
      spinner.fail(result.error);
      process.exit(1);
    }
    
    spinner.succeed(`${chalk.cyan(name)} restarted (PID: ${result.pid})`);
  });

// ============ OPEN COMMAND ============
program
  .command('open [name]')
  .description('Open project in browser')
  .action(async (name?: string) => {
    if (!name) {
      const currentPath = process.cwd();
      const projects = getProjects();
      const project = projects.find((p) => p.path === currentPath);
      
      if (!project) {
        console.error(chalk.red('✗ No project specified and current directory is not registered.'));
        process.exit(1);
      }
      
      name = project.name;
    }
    
    const project = getProjectByName(name);
    if (!project) {
      console.error(chalk.red(`✗ Project "${name}" not found`));
      process.exit(1);
    }
    
    const tld = getTld();
    const url = `http://${project.name}.${tld}`;
    
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

// ============ PROXY COMMAND ============
program
  .command('proxy')
  .description('Start the proxy server (usually run as service)')
  .action(async () => {
    console.log(chalk.cyan('Starting PortPilot proxy server...'));
    
    const result = await startProxyServer();
    
    if (!result.success) {
      console.error(chalk.red(`✗ ${result.error}`));
      process.exit(1);
    }
    
    console.log(chalk.green(`✓ Proxy running on port ${result.port}`));
    console.log(chalk.dim('Press Ctrl+C to stop'));
    
    // Keep process running
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nShutting down proxy...'));
      process.exit(0);
    });
  });

// ============ STATUS COMMAND ============
program
  .command('status')
  .description('Show PortPilot status and configuration')
  .action(() => {
    const tld = getTld();
    const projects = getAllProjectsWithStatus();
    const running = projects.filter((p) => p.status === 'running');
    const hostsPerms = checkHostsPermissions();
    
    console.log(chalk.cyan.bold('\nPortPilot Status\n'));
    
    console.log(chalk.dim('Config file:'), getConfigPath());
    console.log(chalk.dim('TLD:'), `.${tld}`);
    console.log(chalk.dim('Projects:'), `${projects.length} registered, ${running.length} running`);
    console.log(chalk.dim('Hosts file:'), hostsPerms.canWrite 
      ? chalk.green('writable') 
      : chalk.yellow('requires elevation'));
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

program.parse();
