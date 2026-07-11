'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { Cfb27HookError } = require('./errors.cjs');

const PROCESS_QUERY = "$ErrorActionPreference = 'Stop'; " +
  "@(Get-CimInstance Win32_Process -Filter \"Name = 'CollegeFB27.exe'\" | " +
  'Select-Object ProcessId, ExecutablePath) | ConvertTo-Json -Compress';

function parseProcessJson(output) {
  const text = String(output || '').trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Cfb27HookError('INVALID_RESPONSE', 'Could not parse the process query', {
      cause: error.message,
    });
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((record) => record && Number.isInteger(record.ProcessId) && record.ProcessId > 0 &&
      typeof record.ExecutablePath === 'string' &&
      path.win32.basename(record.ExecutablePath).toLowerCase() === 'collegefb27.exe')
    .map((record) => ({ pid: record.ProcessId, path: record.ExecutablePath }));
}

function runProcessQuery(execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY],
      { windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Cfb27HookError('GAME_NOT_RUNNING', 'Could not query College Football 27', {
            cause: error.message,
            stderr: String(stderr || '').trim(),
          }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
    stream.on('error', reject);
  });
}

async function discoverGame({
  execFileImpl = childProcess.execFile,
  expectedSha256,
  expectedSize,
} = {}) {
  const processes = parseProcessJson(await runProcessQuery(execFileImpl));
  if (!processes.length) {
    throw new Cfb27HookError('GAME_NOT_RUNNING', 'College Football 27 is not running');
  }

  const game = processes[0];
  try {
    const stats = await fsPromises.stat(game.path);
    if (!stats.isFile() || (expectedSize !== undefined && stats.size !== expectedSize)) {
      throw new Cfb27HookError('GAME_PATH_MISMATCH', 'The running game executable does not match', {
        path: game.path,
        actualSize: stats.size,
        expectedSize,
      });
    }
    if (expectedSha256 !== undefined) {
      const actualSha256 = await sha256File(game.path);
      if (actualSha256 !== String(expectedSha256).toUpperCase()) {
        throw new Cfb27HookError('GAME_PATH_MISMATCH', 'The running game executable does not match', {
          path: game.path,
          actualSha256,
          expectedSha256: String(expectedSha256).toUpperCase(),
        });
      }
    }
  } catch (error) {
    if (error instanceof Cfb27HookError) throw error;
    throw new Cfb27HookError('GAME_PATH_MISMATCH', 'The game executable path is not accessible', {
      path: game.path,
      cause: error.message,
    });
  }
  return game;
}

module.exports = { parseProcessJson, discoverGame };
