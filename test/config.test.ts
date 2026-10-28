import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { isolate, writeJson } from './helpers.js';

const env = isolate();

// A v0.3 config: projects without IDs
writeJson(path.join(env.configDir, 'config.json'), {
  projects: [
    { name: 'alpha', path: '/a', port: 3001, framework: 'next', createdAt: '2026-01-01T00:00:00.000Z' },
    { name: '2', path: '/b', port: 3002, framework: 'vite', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
  nextPort: 3003,
  tld: 'test',
  proxyPort: 80,
  autoStart: false,
});

const config = await import('../src/core/config.js');

test('migration assigns stable IDs in list order', () => {
  const projects = config.getProjects();
  assert.deepEqual(projects.map((p) => p.id), [1, 2]);
  assert.equal(config.getConfig().nextId, 3);
});

test('names win over numeric IDs', () => {
  const projects = config.getProjects();
  assert.equal(config.findProjectByNameOrId(projects, '2')?.name, '2');
  assert.equal(config.findProjectByNameOrId(projects, '1')?.name, 'alpha');
  assert.equal(config.findProjectByNameOrId(projects, '3d-viewer'), undefined);
});

test('IDs stay stable after removal', () => {
  const added = config.addProject({ name: 'gamma', path: '/c', framework: 'vite' }, { port: 3005 });
  assert.equal(added.id, 3);
  config.removeProject('alpha');
  assert.equal(config.getProjectByNameOrId('3').project?.name, 'gamma');
  assert.equal(config.getNextPort(), 3006);
});

test('duplicate ports are rejected', () => {
  assert.throws(() => config.addProject({ name: 'delta', path: '/d', framework: 'vite' }, { port: 3005 }), /Port 3005/);
});

test('host matching: case, trailing dot, subdomains, longest match', () => {
  const projects = [
    { id: 1, name: 'app', path: '/a', port: 1, framework: 'next' as const, createdAt: '' },
    { id: 2, name: 'fix-ui.app', path: '/b', port: 2, framework: 'next' as const, createdAt: '' },
  ];
  assert.equal(config.matchProjectByHost(projects, 'test', 'APP.TEST')?.id, 1);
  assert.equal(config.matchProjectByHost(projects, 'test', 'app.test.')?.id, 1);
  assert.equal(config.matchProjectByHost(projects, 'test', 'api.app.test')?.id, 1);
  assert.equal(config.matchProjectByHost(projects, 'test', 'fix-ui.app.test')?.id, 2);
  assert.equal(config.matchProjectByHost(projects, 'test', 'other.test'), undefined);
});

test('TLD validation', () => {
  assert.equal(config.isValidTld('test'), true);
  assert.equal(config.isValidTld('localhost'), true);
  assert.equal(config.isValidTld(''), false);
  assert.equal(config.isValidTld('a.b'), false);
  assert.equal(config.isValidTld('-x'), false);
});

test('corrupt config is backed up instead of crashing', () => {
  fs.writeFileSync(path.join(env.configDir, 'config.json'), '{ not json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/core/config.ts')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: process.env,
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.readdirSync(env.configDir).some((f) => f.startsWith('config.json.corrupt-')));
});
