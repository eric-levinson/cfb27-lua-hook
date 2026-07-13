'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const {
  releaseEntries, assertAllowedEntry, assertAllowedContent, assertPackageTextEntries,
  assertNpmArchivePayload, assertReleaseZipPayload, assertStagedPackage, main,
} = require('../scripts/package-release.cjs');

test('release allowlist contains only supported product areas', () => {
  assert.deepEqual(releaseEntries(), [
    'native',
    'packages',
    'examples',
    'docs',
    'README.md',
    'LICENSE',
  ]);
});

test('release rejects archive and generated/private material', () => {
  for (const value of [
    'archive/a',
    'node_modules/a',
    'schema/a.gz',
    'save/DYNASTY-X',
    'host.log',
    'docs/research/runtime-verification.md',
    'docs/superpowers/specs/internal.md',
    'docs/development/restructure-pr-body.md',
    'docs/.frtk/private.txt',
    'docs/dynasty.sav',
    'docs/memory.dmp',
    'docs/memory.dump',
    'docs/record.raw',
    'docs/schema.json',
    'docs/profile.json',
  ]) {
    assert.throws(() => assertAllowedEntry(value), /not allowed/i, value);
  }
  assert.doesNotThrow(() => assertAllowedEntry(path.join('examples', 'lua', 'autorun.lua')));
});

test('actual TGZ and ZIP validation reject every raw save, dump, schema, and profile path',
  async (t) => {
    const privatePaths = [
      ['nested', '.frtk', 'private.txt'],
      ['nested', 'dynasty.sav'],
      ['nested', 'memory.dmp'],
      ['nested', 'memory.dump'],
      ['nested', 'record.raw'],
      ['nested', 'schema.json'],
      ['nested', 'profile.json'],
    ];
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
      'WindowsPowerShell', 'v1.0', 'powershell.exe');
    for (const [index, segments] of privatePaths.entries()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cfb27-private-path-${index}-`));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const packageRoot = path.join(root, 'package');
      const releaseRoot = path.join(root, 'cfb27-lua-hook-test');
      for (const container of [packageRoot, releaseRoot]) {
        const file = path.join(container, ...segments);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'private', 'utf8');
      }
      const tgz = path.join(root, 'tampered.tgz');
      childProcess.execFileSync('tar.exe', ['-czf', tgz, '-C', root, 'package']);
      await assert.rejects(assertNpmArchivePayload(tgz), /archive entry.*not allowed/i,
        segments.join('/'));
      const zip = path.join(root, 'tampered.zip');
      childProcess.execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -LiteralPath $env:SOURCE -DestinationPath $env:ARCHIVE'], {
        env: { ...process.env, SOURCE: releaseRoot, ARCHIVE: zip }, windowsHide: true,
      });
      await assert.rejects(assertReleaseZipPayload(zip), /not allowed/i, segments.join('/'));
    }
  });

test('release content gate requires an adjacent explicit marker for synthetic addresses', () => {
  assert.equal(typeof assertAllowedContent, 'function');
  const research = fs.readFileSync(path.join(__dirname, '..', 'docs', 'research',
    'runtime-verification.md'), 'utf8');
  for (const token of ['0x25DDC14D0', '0x273FEB930', '0x34CC50048']) {
    assert.match(research, new RegExp(token, 'i'));
    assert.throws(() => assertAllowedContent('docs/leak.md', `historical ${token}`),
      /process address/i, token);
  }
  assert.throws(() => assertAllowedContent('docs/protocol.md',
    'historical live address 0x7FF612340080'), /process address/i);
  assert.doesNotThrow(() => assertAllowedContent('docs/protocol.md',
    'SYNTHETIC_ADDRESS:0x7FF612340080'));
  assert.doesNotThrow(() => assertAllowedContent('packages/sdk/src/client.cjs',
    'const maximum = 0xFFFFFFFFFFFFFFFFn;'));
  assert.throws(() => assertAllowedContent('docs/leak.md', 'address 0xFFFFFFFFF'),
    /process address/i);
  assert.throws(() => assertAllowedContent('docs/leak.md', 'address 0xFFFFFFFFFFFFFFFF0'),
    /process address/i);
});

test('staged-package validation scans packaged text for private process addresses', async (t) => {
  assert.equal(typeof assertStagedPackage, 'function');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-release-stage-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stage, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'docs', 'protocol.md'),
    'SYNTHETIC_ADDRESS:0x7FF612340080', 'utf8');
  await assert.doesNotReject(assertStagedPackage(stage));
  fs.writeFileSync(path.join(stage, 'docs', 'leak.md'), 'historical 0x25DDC14D0', 'utf8');
  await assert.rejects(assertStagedPackage(stage), /process address/i);
});

test('npm package text-entry validation rejects private process addresses inside tarballs', () => {
  assert.equal(typeof assertPackageTextEntries, 'function');
  assert.doesNotThrow(() => assertPackageTextEntries([
    { path: 'src/client.cjs', content: 'const address = "SYNTHETIC_ADDRESS:0x7FF612340080";' },
  ]));
  assert.throws(() => assertPackageTextEntries([
    { path: 'src/leak.cjs', content: 'const address = "0x25DDC14D0";' },
  ]), /process address/i);
});

test('actual npm tgz payload validation rejects an unmarked address in archived text', async (t) => {
  assert.equal(typeof assertNpmArchivePayload, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-tgz-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'package');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'src', 'leak.cjs'),
    'const address = "0x7FF612340080";', 'utf8');
  const archive = path.join(root, 'tampered.tgz');
  childProcess.execFileSync('tar.exe', ['-czf', archive, '-C', root, 'package']);
  await assert.rejects(assertNpmArchivePayload(archive), /process address/i);
});

test('actual release ZIP payload validation rejects an unmarked address in archived text', async (t) => {
  assert.equal(typeof assertReleaseZipPayload, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-zip-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, 'cfb27-lua-hook-test');
  fs.mkdirSync(path.join(release, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(release, 'docs', 'leak.md'),
    '{"address":"0x7FF612340080"}', 'utf8');
  const archive = path.join(root, 'tampered.zip');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  childProcess.execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:SOURCE -DestinationPath $env:ARCHIVE'], {
    env: { ...process.env, SOURCE: release, ARCHIVE: archive }, windowsHide: true,
  });
  await assert.rejects(assertReleaseZipPayload(archive), /process address/i);
});

test('actual TGZ and ZIP validation reject forbidden private archive paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-archive-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(path.join(packageRoot, 'saves'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'saves', 'private.md'), 'private', 'utf8');
  const tgz = path.join(root, 'private.tgz');
  childProcess.execFileSync('tar.exe', ['-czf', tgz, '-C', root, 'package']);
  await assert.rejects(assertNpmArchivePayload(tgz), /archive entry.*not allowed/i);

  const release = path.join(root, 'cfb27-lua-hook-test');
  fs.mkdirSync(path.join(release, 'docs', 'research'), { recursive: true });
  fs.writeFileSync(path.join(release, 'docs', 'research', 'private.md'), 'private', 'utf8');
  const zip = path.join(root, 'private.zip');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  childProcess.execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -LiteralPath $env:SOURCE -DestinationPath $env:ARCHIVE'], {
    env: { ...process.env, SOURCE: release, ARCHIVE: zip }, windowsHide: true,
  });
  await assert.rejects(assertReleaseZipPayload(zip), /not allowed/i);
});

test('actual TGZ validation rejects the internal restructure PR document path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-tgz-internal-doc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  const internal = path.join(packageRoot, 'docs', 'development');
  fs.mkdirSync(internal, { recursive: true });
  fs.writeFileSync(path.join(internal, 'restructure-pr-body.md'), 'private', 'utf8');
  const archive = path.join(root, 'internal-doc.tgz');
  childProcess.execFileSync('tar.exe', ['-czf', archive, '-C', root, 'package']);
  await assert.rejects(assertNpmArchivePayload(archive), /archive entry.*not allowed/i);
});

test('preview packaging requires an explicit native artifact directory', async () => {
  const previous = process.env.CFB27_NATIVE_ARTIFACTS;
  delete process.env.CFB27_NATIVE_ARTIFACTS;
  try {
    await assert.rejects(
      main(),
      /Provide artifactsDir or set CFB27_NATIVE_ARTIFACTS/,
    );
  } finally {
    if (previous === undefined) delete process.env.CFB27_NATIVE_ARTIFACTS;
    else process.env.CFB27_NATIVE_ARTIFACTS = previous;
  }
});
