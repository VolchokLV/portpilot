import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { findAvailablePort } from '../src/core/ports.js';
import { versionMatches, pickNodeVersion, prependToPath } from '../src/core/node-version.js';
import { branchToLabel } from '../src/core/git.js';
import { escapeHtml } from '../src/core/pages.js';

test('findAvailablePort skips registered and busy ports', async () => {
  const busy = new Set([3002]);
  const port = await findAvailablePort(3001, [3001, 3003], async (p) => busy.has(p));
  assert.equal(port, 3004);
});

test('Node version specs', () => {
  assert.equal(versionMatches('22', '22.14.0'), true);
  assert.equal(versionMatches('v22.14', '22.14.0'), true);
  assert.equal(versionMatches('22.15', '22.14.0'), false);
  const installed = ['20.18.0', '22.12.0', '22.14.0'].map((version) => ({ version, binDir: version, manager: 'test' }));
  assert.equal(pickNodeVersion('22', installed)?.version, '22.14.0');
  assert.equal(pickNodeVersion('24', installed), undefined);
});

test('prependToPath keeps the existing key casing', () => {
  const env = prependToPath({ Path: 'a' }, 'b');
  assert.equal(env.Path, `b${path.delimiter}a`);
  assert.equal(env.PATH, undefined);
});

test('branchToLabel', () => {
  assert.equal(branchToLabel('feature/Fix_UI'), 'feature-fix-ui');
});

test('escapeHtml', () => {
  assert.equal(escapeHtml(`<x a="1">&'`), '&lt;x a=&quot;1&quot;&gt;&amp;&#39;');
});
