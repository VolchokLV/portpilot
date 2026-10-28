import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { isolate } from './helpers.js';

// Runs the built CLI (npm test builds first) against throwaway config/data/hosts paths
isolate();
const cli = path.resolve(import.meta.dirname, '..', 'dist', 'cli', 'index.js');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf-8' });

test('--help exits 0', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /doctor/);
});

test('unknown proxy action fails instead of starting the proxy', () => {
  const result = run('proxy', 'stauts');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Allowed choices/);
});

test('invalid port is rejected', () => {
  const result = run('add', 'x', '--port', '3000abc');
  assert.notEqual(result.status, 0);
});

test('list --json on an empty config', () => {
  const result = run('list', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('completion scripts render', () => {
  for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
    const result = run('completion', shell);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /portpilot/);
  }
});

test('mcp server answers initialize, tools/list and tools/call', async () => {
  const child = spawn(process.execPath, [cli, 'mcp'], { env: process.env });
  const responses: any[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      responses.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });

  const deadline = Date.now() + 10000;
  while (responses.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  child.kill();

  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.ok(responses[1].result.tools.some((t: any) => t.name === 'start_project'));
  assert.equal(responses[2].result.content[0].text, '[]');
});
