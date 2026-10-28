import readline from 'readline';
import { getProjects, getTld, getProjectByNameOrId } from '../core/config.js';
import {
  getAllProjectsWithStatus,
  getProjectStatus,
  startProject,
  stopProject,
  restartProject,
  getLogTail,
  resolveDevCommand,
} from '../core/process.js';
import { isProxyDaemonRunning, startProxyDaemon, getProxyLogs } from '../core/daemon.js';
import { getSSLStatus } from '../core/ssl.js';
import { runDoctor } from '../core/doctor.js';
import { Project } from '../types/index.js';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) so coding
 * agents can see which dev servers exist, where they live, and start/stop them.
 * Register it with:  claude mcp add portpilot -- portpilot mcp
 */

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => Promise<unknown>;
}

const nameArg = {
  type: 'object',
  properties: { name: { type: 'string', description: 'Project name or ID' } },
  required: ['name'],
};

function describe(project: Project & { status?: string }) {
  const tld = getTld();
  const ssl = getSSLStatus();
  const protocol = ssl.mkcertInstalled && ssl.caInstalled ? 'https' : 'http';
  return {
    id: project.id,
    name: project.name,
    status: project.status ?? getProjectStatus(project).status,
    url: `${protocol}://${project.name}.${tld}`,
    localUrl: `http://localhost:${project.port}`,
    port: project.port,
    framework: project.framework,
    path: project.path,
    command: resolveDevCommand(project),
    pid: project.pid,
    lastError: project.lastError,
  };
}

function requireProject(args: Json): Project {
  const name = String(args.name ?? '');
  const { project } = getProjectByNameOrId(name);
  if (!project) {
    throw new Error(`Project "${name}" not found. Known projects: ${getProjects().map((p) => p.name).join(', ') || 'none'}`);
  }
  return project;
}

const tools: Tool[] = [
  {
    name: 'list_projects',
    description: 'List all PortPilot projects with status, URL, port, framework and path.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => getAllProjectsWithStatus().map(describe),
  },
  {
    name: 'get_project',
    description: 'Get details for one project, including the exact dev command and its status.',
    inputSchema: nameArg,
    run: async (args) => describe(getProjectStatus(requireProject(args))),
  },
  {
    name: 'start_project',
    description: 'Start a project dev server in the background and wait until its port is listening.',
    inputSchema: nameArg,
    run: async (args) => {
      const project = requireProject(args);
      const result = await startProject(project.name, { detached: true });
      return { ...result, project: describe(getProjectStatus(requireProject(args))) };
    },
  },
  {
    name: 'stop_project',
    description: 'Stop a running project dev server.',
    inputSchema: nameArg,
    run: async (args) => stopProject(requireProject(args).name),
  },
  {
    name: 'restart_project',
    description: 'Restart a project dev server in the background.',
    inputSchema: nameArg,
    run: async (args) => restartProject(requireProject(args).name, { detached: true }),
  },
  {
    name: 'get_logs',
    description: 'Read the last lines of a project dev server log (background starts only).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name or ID' },
        lines: { type: 'number', description: 'Number of lines (default 100)' },
      },
      required: ['name'],
    },
    run: async (args) => {
      const project = requireProject(args);
      const lines = typeof args.lines === 'number' && args.lines > 0 ? Math.min(args.lines, 2000) : 100;
      return getLogTail(project.name, lines) ?? `No logs for ${project.name}. Logs exist only for background starts.`;
    },
  },
  {
    name: 'proxy_status',
    description: 'Check whether the PortPilot proxy is running, with its recent log lines.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ ...isProxyDaemonRunning(), recentLogs: getProxyLogs(20) }),
  },
  {
    name: 'start_proxy',
    description: 'Start the PortPilot proxy in the background if it is not running.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => startProxyDaemon(),
  },
  {
    name: 'doctor',
    description: 'Run PortPilot health checks (proxy, hosts file, HTTPS, ports, framework config).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => runDoctor(),
  },
];

function send(message: Json): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message: Json, version: string): Promise<void> {
  const id = message.id as string | number | undefined;
  const method = message.method as string | undefined;
  const params = (message.params ?? {}) as Json;
  const isRequest = id !== undefined && id !== null;

  const reply = (result: unknown) => isRequest && send({ jsonrpc: '2.0', id, result });
  const fail = (code: number, msg: string) => isRequest && send({ jsonrpc: '2.0', id, error: { code, message: msg } });

  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'portpilot', version },
        instructions: 'PortPilot manages local dev servers. Use list_projects to find a project URL and port before opening or testing it.',
      });
      return;
    }
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        fail(-32602, `Unknown tool: ${String(params.name)}`);
        return;
      }
      try {
        const result = await tool.run((params.arguments ?? {}) as Json);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const isError = typeof result === 'object' && result !== null && (result as Json).success === false;
        reply({ content: [{ type: 'text', text }], isError });
      } catch (error) {
        reply({ content: [{ type: 'text', text: (error as Error).message }], isError: true });
      }
      return;
    }
    default:
      if (method?.startsWith('notifications/')) return; // No response to notifications
      fail(-32601, `Method not found: ${method}`);
  }
}

export function runMcpServer(version: string): void {
  // stdout carries protocol messages only; send any stray logging to stderr
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(message, version).catch((error) => {
      console.error(`MCP handler error: ${(error as Error).message}`);
    });
  });
  rl.on('close', () => process.exit(0));
}
