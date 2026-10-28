import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate();
const { renderHostsContent, decodeHosts, encodeHosts } = await import('../src/core/hosts.js');

const START = '# PortPilot Start - DO NOT EDIT';
const END = '# PortPilot End';

test('adds a block and is idempotent', () => {
  const once = renderHostsContent('127.0.0.1 localhost\n', ['a.test', 'b.test']);
  assert.equal(once, `127.0.0.1 localhost\n\n${START}\n127.0.0.1    a.test\n127.0.0.1    b.test\n${END}\n`);
  assert.equal(renderHostsContent(once, ['a.test', 'b.test']), once);
});

test('keeps CRLF line endings', () => {
  const result = renderHostsContent('127.0.0.1 localhost\r\n', ['a.test'], '\r\n');
  assert.ok(!/[^\r]\n/.test(result), 'every newline should be CRLF');
});

test('removes the block when there are no hosts', () => {
  const withBlock = `127.0.0.1 localhost\n\n${START}\n127.0.0.1    a.test\n${END}\n`;
  assert.equal(renderHostsContent(withBlock, []), '127.0.0.1 localhost\n');
});

test('leaves files without a block untouched when nothing is needed', () => {
  assert.equal(renderHostsContent('no newline at end', []), 'no newline at end');
});

test('refuses unbalanced markers instead of deleting user lines', () => {
  const broken = `${START}\n127.0.0.1 a.test\n10.0.0.1 my-own-entry\n`;
  assert.throws(() => renderHostsContent(broken, ['a.test']), /start marker/);
});

test('UTF-16 hosts files round-trip', () => {
  const original = encodeHosts({ text: '127.0.0.1 localhost\r\n', encoding: 'utf16le', eol: '\r\n' });
  const decoded = decodeHosts(original);
  assert.equal(decoded.encoding, 'utf16le');
  assert.equal(decoded.eol, '\r\n');
  assert.equal(decoded.text, '127.0.0.1 localhost\r\n');
  assert.ok(encodeHosts(decoded).equals(original));
});
