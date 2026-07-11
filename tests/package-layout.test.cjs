'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('root identifies the developer-preview Lua hook workspaces', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, 'cfb27-lua-hook-workspace');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.workspaces, ['packages/sdk', 'packages/cli']);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.license, 'MIT');
});

test('SDK and CLI package identities are stable', () => {
  const sdk = readJson('packages/sdk/package.json');
  const cli = readJson('packages/cli/package.json');
  assert.equal(sdk.name, '@cfb27/lua-hook');
  assert.equal(sdk.version, '0.1.0-dev.1');
  assert.equal(cli.name, 'cfb27-lua-hook');
  assert.equal(cli.bin.cfb27lua, 'bin/cfb27lua.cjs');
});

test('repository is MIT licensed', () => {
  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Eric Levinson/);
});
