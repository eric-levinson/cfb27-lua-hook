'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseProcessJson, discoverGame } = require('../src/process.cjs');

test('normalizes one PowerShell process object', () => {
  assert.deepEqual(parseProcessJson('{"ProcessId":42,"ExecutablePath":"F:\\\\CollegeFB27.exe"}'), [
    { pid: 42, path: 'F:\\CollegeFB27.exe' },
  ]);
});

test('normalizes empty and multiple process results', () => {
  assert.deepEqual(parseProcessJson(''), []);
  assert.deepEqual(parseProcessJson('[]'), []);
  assert.deepEqual(parseProcessJson('[{"ProcessId":7,"ExecutablePath":"D:\\\\CollegeFB27.exe"}]'), [
    { pid: 7, path: 'D:\\CollegeFB27.exe' },
  ]);
});

test('reports GAME_NOT_RUNNING for an empty process result', async () => {
  const execFileImpl = (_file, _args, _opts, callback) => callback(null, '', '');
  await assert.rejects(
    discoverGame({ execFileImpl }),
    (error) => error.code === 'GAME_NOT_RUNNING',
  );
});

test('discovery runs a constant non-interactive process query', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfb27-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'CollegeFB27.exe');
  await fs.writeFile(executable, 'test executable');

  const execFileImpl = (file, args, options, callback) => {
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(options.windowsHide, true);
    assert.match(args[3], /\| Select-Object/);
    assert.doesNotMatch(args[3], /\|;/);
    callback(null, JSON.stringify({ ProcessId: 99, ExecutablePath: executable }), '');
  };

  assert.deepEqual(await discoverGame({ execFileImpl }), { pid: 99, path: executable });
});
