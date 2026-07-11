'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Cfb27HookError } = require('./errors.cjs');
const { discoverGame } = require('./process.cjs');

const KNOWN_MMC_SHA256 = '3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454';

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
    stream.on('error', reject);
  });
}

async function hashOrNull(filePath) {
  try {
    return await sha256File(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicCopy(source, destination, copyFileImpl = fs.copyFile) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await copyFileImpl(source, temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function pathsFor({ gameDir, mmcDir }) {
  if (typeof gameDir !== 'string' || typeof mmcDir !== 'string') {
    throw new Cfb27HookError('INVALID_REQUEST', 'gameDir and mmcDir are required');
  }
  const game = path.resolve(gameDir);
  const thirdParty = path.join(path.resolve(mmcDir), 'ThirdParty');
  return {
    gameActive: path.join(game, 'CryptBase.dll'),
    gameBackup: path.join(game, 'MMCBase.dll'),
    managerActive: path.join(thirdParty, 'CryptBase.dll'),
    managerBackup: path.join(thirdParty, 'MMCBase.dll'),
    host: path.join(game, 'CFB27LiveEditor', 'cfb27_lua_host.dll'),
    autorun: path.join(game, 'CFB27LiveEditor', 'scripts', 'autorun.lua'),
  };
}

async function defaultAssertGameClosed() {
  try {
    const game = await discoverGame();
    throw new Cfb27HookError('INSTALLATION_CONFLICT', 'Close College Football 27 before changing the hook', {
      pid: game.pid,
      path: game.path,
    });
  } catch (error) {
    if (error instanceof Cfb27HookError && error.code === 'GAME_NOT_RUNNING') return;
    throw error;
  }
}

async function requireArtifact(filePath, label) {
  if (typeof filePath !== 'string') {
    throw new Cfb27HookError('INSTALLATION_CONFLICT', `${label} was not provided`);
  }
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('not a file');
    return sha256File(filePath);
  } catch (error) {
    throw new Cfb27HookError('INSTALLATION_CONFLICT', `${label} was not found`, {
      path: filePath,
      cause: error.message,
    });
  }
}

async function ensureBackup(active, backup, expectedMmcSha256, copyFileImpl) {
  const backupHash = await hashOrNull(backup);
  if (backupHash !== null) {
    if (backupHash !== expectedMmcSha256) {
      throw new Cfb27HookError('BACKUP_VERIFICATION_FAILED', 'MMCBase.dll is not the recognized MMC proxy', {
        path: backup,
        actualSha256: backupHash,
        expectedSha256: expectedMmcSha256,
      });
    }
    return backupHash;
  }

  const activeHash = await hashOrNull(active);
  if (activeHash !== expectedMmcSha256) {
    throw new Cfb27HookError('INSTALLATION_CONFLICT', 'CryptBase.dll is not the recognized MMC proxy', {
      path: active,
      actualSha256: activeHash,
      expectedSha256: expectedMmcSha256,
    });
  }
  await atomicCopy(active, backup, copyFileImpl);
  const createdHash = await hashOrNull(backup);
  if (createdHash !== expectedMmcSha256) {
    throw new Cfb27HookError('BACKUP_VERIFICATION_FAILED', 'MMC proxy backup verification failed', {
      path: backup,
      actualSha256: createdHash,
      expectedSha256: expectedMmcSha256,
    });
  }
  return createdHash;
}

async function verifyHash(filePath, expectedSha256, code = 'INSTALLATION_CONFLICT') {
  const actualSha256 = await hashOrNull(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Cfb27HookError(code, 'Installed file failed checksum verification', {
      path: filePath,
      actualSha256,
      expectedSha256,
    });
  }
  return actualSha256;
}

async function inspectInstallation(options = {}) {
  const paths = pathsFor(options);
  const expectedMmcSha256 = String(options.expectedMmcSha256 || KNOWN_MMC_SHA256).toUpperCase();
  const hashes = {
    gameActive: await hashOrNull(paths.gameActive),
    gameBackup: await hashOrNull(paths.gameBackup),
    managerActive: await hashOrNull(paths.managerActive),
    managerBackup: await hashOrNull(paths.managerBackup),
    host: await hashOrNull(paths.host),
  };
  const proxySha256 = options.proxyDll ? await hashOrNull(path.resolve(options.proxyDll)) : null;
  const hostSha256 = options.hostDll ? await hashOrNull(path.resolve(options.hostDll)) : null;
  const backupConflict = [hashes.gameBackup, hashes.managerBackup]
    .some((hash) => hash !== null && hash !== expectedMmcSha256);
  const activeConflict = [hashes.gameActive, hashes.managerActive]
    .some((hash) => hash !== null && hash !== expectedMmcSha256 && hash !== proxySha256);

  let mode = 'partial';
  if (backupConflict || activeConflict) mode = 'conflict';
  else if (proxySha256 && hostSha256 &&
      hashes.gameActive === proxySha256 && hashes.managerActive === proxySha256 &&
      hashes.gameBackup === expectedMmcSha256 && hashes.managerBackup === expectedMmcSha256 &&
      hashes.host === hostSha256) mode = 'installed';
  else if (hashes.gameActive === expectedMmcSha256 &&
      hashes.managerActive === expectedMmcSha256) mode = 'restored';

  return { mode, paths, hashes, expectedMmcSha256, proxySha256, hostSha256 };
}

async function installHook(options = {}) {
  const assertGameClosed = options.assertGameClosed || defaultAssertGameClosed;
  await assertGameClosed();

  const paths = pathsFor(options);
  const proxyDll = path.resolve(options.proxyDll || '');
  const hostDll = path.resolve(options.hostDll || '');
  const autorunScript = options.autorunScript ? path.resolve(options.autorunScript) : null;
  const expectedMmcSha256 = String(options.expectedMmcSha256 || KNOWN_MMC_SHA256).toUpperCase();
  const copyFileImpl = options.copyFileImpl || fs.copyFile;
  const proxySha256 = await requireArtifact(proxyDll, 'Startup proxy DLL');
  const hostSha256 = await requireArtifact(hostDll, 'Lua host DLL');
  const autorunSha256 = autorunScript ? await requireArtifact(autorunScript, 'Autorun Lua script') : null;

  await ensureBackup(paths.gameActive, paths.gameBackup, expectedMmcSha256, copyFileImpl);
  await ensureBackup(paths.managerActive, paths.managerBackup, expectedMmcSha256, copyFileImpl);

  const previousProxySha256 = {
    game: await hashOrNull(paths.gameActive),
    manager: await hashOrNull(paths.managerActive),
  };
  for (const [location, hash] of Object.entries(previousProxySha256)) {
    if (hash !== expectedMmcSha256 && hash !== proxySha256) {
      throw new Cfb27HookError('INSTALLATION_CONFLICT', 'Refusing to replace an unknown active proxy', {
        location,
        actualSha256: hash,
        recognizedSha256: [expectedMmcSha256, proxySha256],
      });
    }
  }

  try {
    await atomicCopy(proxyDll, paths.gameActive, copyFileImpl);
    await atomicCopy(proxyDll, paths.managerActive, copyFileImpl);
    await atomicCopy(hostDll, paths.host, copyFileImpl);
    if (autorunScript) await atomicCopy(autorunScript, paths.autorun, copyFileImpl);
    await verifyHash(paths.gameActive, proxySha256);
    await verifyHash(paths.managerActive, proxySha256);
    await verifyHash(paths.host, hostSha256);
    if (autorunScript) await verifyHash(paths.autorun, autorunSha256);
  } catch (error) {
    const rollbackErrors = [];
    for (const [backup, active] of [
      [paths.gameBackup, paths.gameActive],
      [paths.managerBackup, paths.managerActive],
    ]) {
      try {
        await atomicCopy(backup, active, copyFileImpl);
        await verifyHash(active, expectedMmcSha256);
      } catch (rollbackError) {
        rollbackErrors.push({ path: active, cause: rollbackError.message });
      }
    }
    throw new Cfb27HookError('INSTALLATION_CONFLICT', 'Hook installation failed and was rolled back', {
      cause: error.message,
      rollbackErrors,
    });
  }

  return {
    installed: true,
    paths,
    hashes: { mmc: expectedMmcSha256, proxy: proxySha256, host: hostSha256, autorun: autorunSha256 },
    previousProxySha256,
  };
}

async function restoreMmcHook(options = {}) {
  const assertGameClosed = options.assertGameClosed || defaultAssertGameClosed;
  await assertGameClosed();
  const paths = pathsFor(options);
  const expectedMmcSha256 = String(options.expectedMmcSha256 || KNOWN_MMC_SHA256).toUpperCase();
  const copyFileImpl = options.copyFileImpl || fs.copyFile;

  await verifyHash(paths.gameBackup, expectedMmcSha256, 'BACKUP_VERIFICATION_FAILED');
  await verifyHash(paths.managerBackup, expectedMmcSha256, 'BACKUP_VERIFICATION_FAILED');
  await atomicCopy(paths.gameBackup, paths.gameActive, copyFileImpl);
  await atomicCopy(paths.managerBackup, paths.managerActive, copyFileImpl);
  await verifyHash(paths.gameActive, expectedMmcSha256, 'BACKUP_VERIFICATION_FAILED');
  await verifyHash(paths.managerActive, expectedMmcSha256, 'BACKUP_VERIFICATION_FAILED');
  return {
    restored: true,
    paths: [paths.gameActive, paths.managerActive],
    hashes: { game: expectedMmcSha256, manager: expectedMmcSha256 },
  };
}

module.exports = {
  KNOWN_MMC_SHA256,
  inspectInstallation,
  installHook,
  restoreMmcHook,
};
