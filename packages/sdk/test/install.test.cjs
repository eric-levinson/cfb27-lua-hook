'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectInstallation, installHook, restoreMmcHook } = require('../src/install.cjs');

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfb27-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game');
  const mmcDir = path.join(root, 'mmc');
  const thirdParty = path.join(mmcDir, 'ThirdParty');
  await fs.mkdir(gameDir, { recursive: true });
  await fs.mkdir(thirdParty, { recursive: true });
  const mmc = Buffer.from('recognized-mmc');
  const proxy = Buffer.from('new-proxy');
  const host = Buffer.from('new-host');
  await fs.writeFile(path.join(gameDir, 'CryptBase.dll'), mmc);
  await fs.writeFile(path.join(thirdParty, 'CryptBase.dll'), mmc);
  await fs.writeFile(path.join(root, 'proxy.dll'), proxy);
  await fs.writeFile(path.join(root, 'host.dll'), host);
  return {
    root, gameDir, mmcDir, thirdParty, mmc, proxy, host,
    proxyDll: path.join(root, 'proxy.dll'),
    hostDll: path.join(root, 'host.dll'),
    expectedMmcSha256: sha(mmc),
    assertGameClosed: async () => {},
  };
}

test('install preserves both MMC proxies and restore reverses both', async (t) => {
  const setup = await fixture(t);
  assert.equal((await inspectInstallation(setup)).mode, 'restored');
  await installHook(setup);
  assert.equal((await inspectInstallation(setup)).mode, 'installed');
  assert.deepEqual(await fs.readFile(path.join(setup.gameDir, 'MMCBase.dll')), setup.mmc);
  assert.deepEqual(await fs.readFile(path.join(setup.thirdParty, 'MMCBase.dll')), setup.mmc);
  assert.deepEqual(await fs.readFile(path.join(setup.gameDir, 'CryptBase.dll')), setup.proxy);
  assert.deepEqual(await fs.readFile(path.join(setup.thirdParty, 'CryptBase.dll')), setup.proxy);
  assert.deepEqual(
    await fs.readFile(path.join(setup.gameDir, 'CFB27LiveEditor', 'cfb27_lua_host.dll')),
    setup.host,
  );

  await restoreMmcHook(setup);
  assert.deepEqual(await fs.readFile(path.join(setup.gameDir, 'CryptBase.dll')), setup.mmc);
  assert.deepEqual(await fs.readFile(path.join(setup.thirdParty, 'CryptBase.dll')), setup.mmc);
});

test('restore verifies every backup before changing either active proxy', async (t) => {
  const setup = await fixture(t);
  await installHook(setup);
  await fs.writeFile(path.join(setup.thirdParty, 'MMCBase.dll'), 'corrupt');

  await assert.rejects(
    restoreMmcHook(setup),
    (error) => error.code === 'BACKUP_VERIFICATION_FAILED',
  );
  assert.deepEqual(await fs.readFile(path.join(setup.gameDir, 'CryptBase.dll')), setup.proxy);
  assert.deepEqual(await fs.readFile(path.join(setup.thirdParty, 'CryptBase.dll')), setup.proxy);
});

test('install refuses unknown proxies and mismatched backups', async (t) => {
  const unknown = await fixture(t);
  await fs.writeFile(path.join(unknown.gameDir, 'CryptBase.dll'), 'unknown');
  await assert.rejects(installHook(unknown), (error) => error.code === 'INSTALLATION_CONFLICT');
  assert.equal(await fs.readFile(path.join(unknown.gameDir, 'CryptBase.dll'), 'utf8'), 'unknown');

  const badBackup = await fixture(t);
  await fs.writeFile(path.join(badBackup.gameDir, 'MMCBase.dll'), 'bad-backup');
  await assert.rejects(
    installHook(badBackup),
    (error) => error.code === 'BACKUP_VERIFICATION_FAILED',
  );
});

test('install rolls both active proxies back after a copy failure', async (t) => {
  const setup = await fixture(t);
  let failed = false;
  const copyFileImpl = async (source, destination) => {
    if (!failed && source === setup.proxyDll && destination.includes(`ThirdParty${path.sep}.CryptBase`)) {
      failed = true;
      throw new Error('simulated copy failure');
    }
    await fs.copyFile(source, destination);
  };

  await assert.rejects(
    installHook({ ...setup, copyFileImpl }),
    (error) => error.code === 'INSTALLATION_CONFLICT' &&
      error.details?.cause === 'simulated copy failure',
  );
  assert.deepEqual(await fs.readFile(path.join(setup.gameDir, 'CryptBase.dll')), setup.mmc);
  assert.deepEqual(await fs.readFile(path.join(setup.thirdParty, 'CryptBase.dll')), setup.mmc);
});

test('install requires artifacts and a closed game before mutation', async (t) => {
  const setup = await fixture(t);
  await fs.rm(setup.hostDll);
  await assert.rejects(installHook(setup), (error) => error.code === 'INSTALLATION_CONFLICT');

  const running = await fixture(t);
  await assert.rejects(
    installHook({ ...running, assertGameClosed: async () => { throw new Error('close the game'); } }),
    /close the game/,
  );
  assert.deepEqual(await fs.readFile(path.join(running.gameDir, 'CryptBase.dll')), running.mmc);
});
