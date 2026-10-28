import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempDir, writeJson } from './helpers.js';
import {
  detectPackageManager,
  detectPackageManagerWithSource,
  detectFramework,
  getDevCommand,
  sanitizeProjectName,
} from '../src/core/framework.js';

test('packageManager field wins over lockfiles', () => {
  const dir = tempDir();
  writeJson(path.join(dir, 'package.json'), { packageManager: 'pnpm@10.4.0+sha512.abc' });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  assert.equal(detectPackageManager(dir), 'pnpm');
});

test('pnpm-lock.yaml selects pnpm', () => {
  const dir = tempDir();
  writeJson(path.join(dir, 'package.json'), {});
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(detectPackageManager(dir), 'pnpm');
});

test('workspace child finds the lockfile at the pnpm workspace root', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  const app = path.join(root, 'apps', 'web');
  writeJson(path.join(app, 'package.json'), {});
  const result = detectPackageManagerWithSource(app);
  assert.equal(result.manager, 'pnpm');
  assert.match(result.source, /pnpm-lock\.yaml/);
});

test('lockfile search stops at the repo root', () => {
  const outer = tempDir();
  fs.writeFileSync(path.join(outer, 'bun.lockb'), '');
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  writeJson(path.join(repo, 'package.json'), {});
  assert.equal(detectPackageManager(repo), 'npm');
});

test('npm gets "--" before args, pnpm/yarn/bun do not', () => {
  assert.equal(getDevCommand('next', 3001, undefined, 'npm'), 'npm run dev -- -p 3001');
  assert.equal(getDevCommand('next', 3001, undefined, 'pnpm'), 'pnpm run dev -p 3001');
  assert.equal(getDevCommand('vite', 3002, undefined, 'yarn'), 'yarn run dev --port 3002 --strictPort');
  assert.equal(getDevCommand('vite', 3002, undefined, 'bun'), 'bun run dev --port 3002 --strictPort');
  assert.equal(getDevCommand('cra', 3003, undefined, 'npm'), 'npm run start');
});

test('workspace filter commands', () => {
  assert.equal(getDevCommand('next', 3001, undefined, 'pnpm', { filter: '@acme/web' }), 'pnpm --filter "@acme/web" run dev -p 3001');
  assert.equal(getDevCommand('next', 3001, undefined, 'yarn', { filter: 'web' }), 'yarn workspace "web" run dev -p 3001');
  assert.equal(getDevCommand('next', 3001, undefined, 'npm', { filter: 'web' }), 'npm run dev --workspace="web" -- -p 3001');
});

test('custom command placeholders', () => {
  assert.equal(
    getDevCommand('custom', 4000, '{pm} run serve --port {port} --host {host}', 'pnpm', { host: 'app.test' }),
    'pnpm run serve --port 4000 --host app.test'
  );
});

test('framework detection by config file and dependency', () => {
  const next = tempDir();
  writeJson(path.join(next, 'package.json'), {});
  fs.writeFileSync(path.join(next, 'next.config.cjs'), '');
  assert.equal(detectFramework(next), 'next');

  const kit = tempDir();
  writeJson(path.join(kit, 'package.json'), { devDependencies: { '@sveltejs/kit': '2' } });
  fs.writeFileSync(path.join(kit, 'vite.config.ts'), '');
  assert.equal(detectFramework(kit), 'sveltekit');

  const vite = tempDir();
  writeJson(path.join(vite, 'package.json'), {});
  fs.writeFileSync(path.join(vite, 'vite.config.mts'), '');
  assert.equal(detectFramework(vite), 'vite');

  const nuxt = tempDir();
  writeJson(path.join(nuxt, 'package.json'), {});
  fs.writeFileSync(path.join(nuxt, 'nuxt.config.ts'), '');
  assert.equal(detectFramework(nuxt), 'nuxt');

  const cra = tempDir();
  writeJson(path.join(cra, 'package.json'), { dependencies: { 'react-scripts': '5' } });
  assert.equal(detectFramework(cra), 'cra');
});

test('sanitizeProjectName', () => {
  assert.equal(sanitizeProjectName('My App.test', { tld: 'test' }), 'my-app');
  assert.equal(sanitizeProjectName('emojicopy.com', { allowDots: true }), 'emojicopy.com');
  assert.equal(sanitizeProjectName('--weird__name--'), 'weird-name');
});
