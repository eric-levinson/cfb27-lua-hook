'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/main.cjs');

function memoryIo(env = {}) {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    io: {
      env,
      out: (value) => { output.stdout += `${value}\n`; },
      err: (value) => { output.stderr += `${value}\n`; },
    },
  };
}

function memoryFileSystem(readFile) {
  return {
    readFile,
    realpath: async (value) => path.resolve(value),
  };
}

test('status --json prints one stable JSON object', async () => {
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 42, path: 'F:\\CollegeFB27.exe' }),
    createClient: () => ({ status: async () => ({ ready: true, protocolVersion: 1 }) }),
  };
  assert.equal(await main(['status', '--json'], { sdk, io }), 0);
  assert.deepEqual(JSON.parse(output.stdout), {
    ok: true,
    command: 'status',
    result: { ready: true, protocolVersion: 1 },
  });
});

test('SDK errors map to stable nonzero exit families', async () => {
  const { io, output } = memoryIo();
  const error = Object.assign(new Error('not running'), { code: 'GAME_NOT_RUNNING' });
  assert.equal(await main(['status'], {
    sdk: { discoverGame: async () => { throw error; } },
    io,
  }), 20);
  assert.match(output.stderr, /GAME_NOT_RUNNING/);
});

test('help succeeds and unknown commands are usage errors', async () => {
  const help = memoryIo();
  assert.equal(await main(['--help'], { sdk: {}, io: help.io }), 0);
  assert.match(help.output.stdout, /install/);
  assert.match(help.output.stdout, /doctor/);

  const unknown = memoryIo();
  assert.equal(await main(['nope'], { sdk: {}, io: unknown.io }), 2);
  assert.match(unknown.output.stderr, /Unknown command/);
});

test('duplicate scalar flags and missing values are usage errors', async () => {
  const duplicate = memoryIo();
  assert.equal(await main(['doctor', '--game-dir', 'a', '--game-dir', 'b'], {
    sdk: {}, io: duplicate.io,
  }), 2);
  assert.match(duplicate.output.stderr, /Duplicate option/);

  const missing = memoryIo();
  assert.equal(await main(['doctor', '--mmc-dir'], { sdk: {}, io: missing.io }), 2);
  assert.match(missing.output.stderr, /Missing value/);
});

test('install requires explicit directories and resolves artifact paths', async () => {
  const missing = memoryIo();
  assert.equal(await main(['install'], { sdk: {}, io: missing.io }), 2);

  const called = [];
  const configured = memoryIo({
    CFB27_GAME_DIR: 'F:\\game',
    CFB27_MMC_DIR: 'F:\\mmc',
    CFB27_HOOK_ARTIFACTS: 'F:\\artifacts',
  });
  assert.equal(await main(['install'], {
    sdk: { installHook: async (options) => { called.push(options); return { installed: true }; } },
    io: configured.io,
  }), 0);
  assert.equal(called[0].proxyDll, path.resolve('F:\\artifacts', 'cfb27_cryptbase_proxy.dll'));
  assert.equal(called[0].hostDll, path.resolve('F:\\artifacts', 'cfb27_lua_host.dll'));
});

test('run delegates the complete file and eval preserves separate source tokens', async () => {
  const run = memoryIo();
  let file;
  assert.equal(await main(['run', 'scripts\\recruit.lua'], {
    sdk: { runScriptFile: async (value) => { file = value; return { status: 'ok' }; } },
    io: run.io,
  }), 0);
  assert.equal(file, 'scripts\\recruit.lua');

  const evaluated = [];
  const evaluate = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 9, path: 'F:\\CollegeFB27.exe' }),
    createClient: () => ({ evaluateLua: async (source) => { evaluated.push(source); return { status: 'ok' }; } }),
  };
  assert.equal(await main(['eval', 'local x=1', 'x=x+1'], { sdk, io: evaluate.io }), 0);
  assert.deepEqual(evaluated, ['local x=1 x=x+1']);
});

test('doctor dispatch performs no installation writes', async () => {
  const { io } = memoryIo({ CFB27_GAME_DIR: 'F:\\game', CFB27_MMC_DIR: 'F:\\mmc' });
  let installs = 0;
  const sdk = {
    doctor: async () => ({ checks: [] }),
    installHook: async () => { installs += 1; },
    restoreMmcHook: async () => { installs += 1; },
  };
  assert.equal(await main(['doctor'], { sdk, io }), 0);
  assert.equal(installs, 0);
});

test('logs and events dispatch through cursor-aware SDK methods', async () => {
  const calls = [];
  const sdk = {
    discoverGame: async () => ({ pid: 12, path: 'F:\\CollegeFB27.exe' }),
    createClient: () => ({
      getLogs: async (options) => { calls.push(['logs', options]); return { logs: [] }; },
      getEvents: async (options) => { calls.push(['events', options]); return { events: [], nextCursor: 7 }; },
    }),
  };
  assert.equal(await main(['logs'], { sdk, io: memoryIo().io }), 0);
  assert.equal(await main(['events', '--after', '7'], { sdk, io: memoryIo().io }), 0);
  assert.deepEqual(calls, [['logs', { limit: 100 }], ['events', { after: 7, limit: 256 }]]);
});

test('logs --follow emits JSONL log events without a summary object', async () => {
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 12, path: 'F:\\CollegeFB27.exe' }),
    createClient: () => ({}),
    followEvents: async function* () {
      yield { cursor: 1, type: 'log', payload: { message: 'ready' } };
      yield { cursor: 2, type: 'tick', payload: {} };
    },
  };
  assert.equal(await main(['logs', '--follow', '--json'], { sdk, io }), 0);
  assert.equal(output.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(output.stdout).event.payload.message, 'ready');
});

test('--json errors emit exactly one object to stdout', async () => {
  const { io, output } = memoryIo();
  const error = Object.assign(new Error('host missing'), { code: 'HOST_NOT_READY' });
  assert.equal(await main(['status', '--json'], {
    sdk: { discoverGame: async () => { throw error; } },
    io,
  }), 20);
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(output.stdout).error.code, 'HOST_NOT_READY');
});

test('memory scan parses diagnostic options and preserves the validated SDK result in JSON', async () => {
  const result = {
    supportedBuild: false,
    complete: true,
    scannedBytes: 65536,
    matches: [{
      address: '0x7FF612340080',
      regionBase: '0x7FF612340000',
      regionSize: 65536,
      protection: 4,
      contextAddress: '0x7FF612340060',
      contextHex: `${'00'.repeat(32)}CFB27A1100A1B2C3D4E5F60718293A4B${'00'.repeat(32)}`,
      allocationBase: '0x7FF612300000',
      allocationSize: 4194304,
      allocationProtect: 4,
      offsetInAllocation: 262272,
    }],
  };
  const calls = [];
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: (options) => {
      calls.push(['createClient', options]);
      return {
        scanMemory: async (options) => { calls.push(['scanMemory', options]); return result; },
      };
    },
  };

  assert.equal(await main([
    'memory', 'scan',
    '--pattern', 'CFB27A1100A1B2C3D4E5F60718293A4B',
    '--mask', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    '--max-matches', '8',
    '--context', '32',
    '--max-pages', '3',
    '--allow-unsupported-build',
    '--include-allocation-metadata',
    '--json',
  ], { sdk, io }), 0);
  assert.deepEqual(calls, [
    ['createClient', { pid: 27, timeoutMs: 10_000 }],
    ['scanMemory', {
      patternHex: 'CFB27A1100A1B2C3D4E5F60718293A4B',
      maskHex: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
      maxMatches: 8,
      contextBefore: 32,
      contextAfter: 32,
      maxPages: 3,
      allowUnsupportedBuild: true,
      includeAllocationMetadata: true,
    }],
  ]);
  assert.deepEqual(JSON.parse(output.stdout), {
    ok: true,
    command: 'memory scan',
    result,
  });
});

test('memory scan defaults to 4096 pages and only scan selects the ten-second timeout', async () => {
  const calls = [];
  const sdk = {
    discoverGame: async () => ({ pid: 42 }),
    createClient: (options) => {
      calls.push(['createClient', options]);
      return {
        scanMemory: async (options) => {
          calls.push(['scanMemory', options]);
          return { supportedBuild: true, complete: true, scannedBytes: 96, matches: [] };
        },
        readMemory: async (options) => {
          calls.push(['readMemory', options]);
          return { supportedBuild: true, ranges: [] };
        },
      };
    },
  };

  assert.equal(await main([
    'memory', 'scan', '--pattern', '0011223344556677',
    '--mask', 'FFFFFFFFFFFFFFFF', '--max-matches', '8', '--context', '32', '--json',
  ], { sdk, io: memoryIo().io }), 0);
  assert.equal(await main([
    'memory', 'read', '--range', '0x1000:8', '--json',
  ], { sdk, io: memoryIo().io }), 0);

  assert.deepEqual(calls, [
    ['createClient', { pid: 42, timeoutMs: 10_000 }],
    ['scanMemory', {
      patternHex: '0011223344556677',
      maskHex: 'FFFFFFFFFFFFFFFF',
      maxMatches: 8,
      contextBefore: 32,
      contextAfter: 32,
      maxPages: 4096,
    }],
    ['createClient', { pid: 42 }],
    ['readMemory', { ranges: [{ address: '0x1000', length: 8 }] }],
  ]);
});

test('memory scan rejects invalid max-pages and caller-owned continuation or range controls', async () => {
  const base = [
    'memory', 'scan', '--pattern', '0011223344556677',
    '--mask', 'FFFFFFFFFFFFFFFF', '--max-matches', '8', '--context', '32',
  ];
  const cases = [
    [[...base, '--max-pages', '0'], /--max-pages/],
    [[...base, '--max-pages', '4097'], /--max-pages/],
    [[...base, '--max-pages', '9007199254740992'], /--max-pages/],
    [[...base, '--max-pages', '2', '--max-pages', '3'], /Duplicate option/],
    [[...base, '--cursor', '0x1000'], /Unknown option/],
    [[...base, '--start', '0x1000'], /Unknown option/],
    [[...base, '--stop', '0x2000'], /Unknown option/],
    [[...base, '--write', '00'], /Unknown option/],
  ];
  for (const [argv, pattern] of cases) {
    const { io, output } = memoryIo();
    assert.equal(await main(argv, { sdk: {}, io }), 2, argv.join(' '));
    assert.match(output.stderr, pattern, argv.join(' '));
  }
});

test('memory read parses repeated canonical ranges and reports canonical addresses', async () => {
  const calls = [];
  const result = {
    supportedBuild: true,
    ranges: [
      { address: '0x7FF612340000', length: 192, bytesHex: '00'.repeat(192) },
      { address: '0x7FF612350000', length: 16, bytesHex: 'FF'.repeat(16) },
    ],
  };
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      readMemory: async (options) => { calls.push(options); return result; },
    }),
  };

  assert.equal(await main([
    'memory', 'read',
    '--range', '0x7FF612340000:192',
    '--range', '0x7FF612350000:16',
  ], { sdk, io }), 0);
  assert.deepEqual(calls, [{ ranges: [
    { address: '0x7FF612340000', length: 192 },
    { address: '0x7FF612350000', length: 16 },
  ] }]);
  assert.match(output.stdout, /2 ranges, 208 bytes/);
  assert.match(output.stdout, /0x7FF612340000/);
  assert.match(output.stdout, /0x7FF612350000/);
});

test('memory read JSON preserves the validated SDK result', async () => {
  const result = {
    supportedBuild: true,
    ranges: [{
      address: '0xFFFFFFFFFFFFFFFF',
      length: 1,
      bytesHex: 'CF',
    }],
  };
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({ readMemory: async () => result }),
  };
  assert.equal(await main([
    'memory', 'read', '--range', '0xFFFFFFFFFFFFFFFF:1', '--json',
  ], { sdk, io }), 0);
  assert.deepEqual(JSON.parse(output.stdout), {
    ok: true,
    command: 'memory read',
    result,
  });
});

test('memory scan human output reports match count and canonical addresses', async () => {
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      scanMemory: async () => ({
        supportedBuild: true,
        complete: true,
        scannedBytes: 4096,
        matches: [{
          address: '0x7FF612340080',
          regionBase: '0x7FF612340000',
          regionSize: 65536,
          protection: 4,
          contextAddress: '0x7FF612340060',
          contextHex: '00'.repeat(80),
        }],
      }),
    }),
  };
  assert.equal(await main([
    'memory', 'scan',
    '--pattern', 'CFB27A1100A1B2C3D4E5F60718293A4B',
    '--mask', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    '--max-matches', '8',
    '--context', '32',
  ], { sdk, io }), 0);
  assert.match(output.stdout, /1 match, 4096 bytes scanned/);
  assert.match(output.stdout, /0x7FF612340080/);
  assert.match(output.stdout, /region 0x7FF612340000/);
});

test('telemetry register delegates exact type names and preserves JSON result', async () => {
  const calls = [];
  const result = { types: ['recruiting.snapshot', 'recruiting.stability'] };
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      registerTelemetryTypes: async (types) => { calls.push(types); return result; },
    }),
  };
  assert.equal(await main([
    'telemetry', 'register', 'recruiting.snapshot', 'recruiting.stability', '--json',
  ], { sdk, io }), 0);
  assert.deepEqual(calls, [['recruiting.snapshot', 'recruiting.stability']]);
  assert.deepEqual(JSON.parse(output.stdout), {
    ok: true,
    command: 'telemetry register',
    result,
  });
});

test('developer commands reject missing gates, write-like arguments, and malformed ranges', async () => {
  const cases = [
    [['memory', 'scan', '--pattern', 'CFB27A1100A1B2C3D4E5F60718293A4B'], /--mask/],
    [['memory', 'scan', '--pattern', 'CFB27A1100A1B2C3D4E5F60718293A4B', '--mask', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', '--max-matches', '8', '--context', '32', '--write', '00'], /Unknown option/],
    [['memory', 'read', '--range', '0x7ff612340000:192'], /canonical/],
    [['memory', 'read', '--range', '0x00007FF612340000:192'], /canonical/],
    [['memory', 'read', '--range', '0x10000000000000000:1'], /canonical/],
    [['memory', 'read', '--range', '0x7FF612340000:0'], /length/],
    [['memory', 'read', '--address', '0x7FF612340000', '--value', '00'], /Unknown option/],
    [['telemetry', 'register'], /type name/],
  ];
  for (const [argv, pattern] of cases) {
    const { io, output } = memoryIo();
    assert.equal(await main(argv, { sdk: {}, io }), 2, argv.join(' '));
    assert.match(output.stderr, pattern, argv.join(' '));
  }
});

test('allow-unsupported-build is explicit and only valid for memory diagnostics', async () => {
  const calls = [];
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      readMemory: async (options) => { calls.push(options); return { supportedBuild: true, ranges: [] }; },
    }),
  };
  assert.equal(await main([
    'memory', 'read', '--range', '0x7FF612340000:192', '--allow-unsupported-build',
  ], { sdk, io: memoryIo().io }), 0);
  assert.deepEqual(calls, [{
    ranges: [{ address: '0x7FF612340000', length: 192 }],
    allowUnsupportedBuild: true,
  }]);

  const invalid = memoryIo();
  assert.equal(await main(['status', '--allow-unsupported-build'], {
    sdk: {}, io: invalid.io,
  }), 2);
  assert.match(invalid.output.stderr, /only valid for memory/);
});

test('memory transact reads one JSON request file and preserves the validated SDK result', async () => {
  const request = {
    transactionId: 'recruiting.influence-proof-1',
    operations: [{
      address: '0x7FF612340000',
      expectedHex: '1020',
      replacementHex: '1121',
    }],
  };
  const result = {
    transactionId: request.transactionId,
    status: 'applied_verified',
    operations: [{ index: 0, applied: true, verified: true }],
  };
  const reads = [];
  const calls = [];
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      writeTransaction: async (value) => { calls.push(value); return result; },
    }),
  };
  const fileSystem = {
    readFile: async (file, encoding) => {
      reads.push([file, encoding]);
      return JSON.stringify(request);
    },
    realpath: async (value) => path.resolve(value),
  };

  assert.equal(await main([
    'memory', 'transact', 'proof-transaction.json', '--json',
  ], { sdk, io, fileSystem, cwd: 'C:\\workspace' }), 0);
  assert.deepEqual(reads, [[path.resolve('C:\\workspace', 'proof-transaction.json'), 'utf8']]);
  assert.deepEqual(calls, [request]);
  assert.deepEqual(JSON.parse(output.stdout), result);
});

test('memory transact human output contains only transaction identity, status, and counts', async () => {
  const request = {
    transactionId: 'recruiting.influence-proof-1',
    operations: [{
      address: '0x7FF612340000',
      expectedHex: '1020',
      replacementHex: '1121',
    }],
  };
  const result = {
    transactionId: request.transactionId,
    status: 'applied_verified',
    operations: [{ index: 0, applied: true, verified: true }],
  };
  const { io, output } = memoryIo();
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({ writeTransaction: async () => result }),
  };
  assert.equal(await main(['memory', 'transact', 'proof.json'], {
    sdk,
    io,
    fileSystem: memoryFileSystem(async () => JSON.stringify(request)),
    cwd: 'C:\\workspace',
  }), 0);
  assert.match(output.stdout, /recruiting\.influence-proof-1/);
  assert.match(output.stdout, /applied_verified/);
  assert.match(output.stdout, /1 operation/);
  assert.match(output.stdout, /1 applied/);
  assert.match(output.stdout, /1 verified/);
  for (const secret of ['0x7FF612340000', '1020', '1121', 'address', 'expectedHex', 'replacementHex']) {
    assert.equal(output.stdout.includes(secret), false, `human output leaked ${secret}`);
  }
});

test('memory transact refuses stdin, non-JSON files, and external absolute paths by default', async () => {
  const cases = [
    [['memory', 'transact', '-'], /JSON file/],
    [['memory', 'transact', 'proof.txt'], /\.json/],
    [['memory', 'transact', 'C:\\outside\\proof.json'], /outside the current working directory/],
    [['memory', 'transact'], /exactly one JSON file/],
    [['memory', 'transact', 'one.json', 'two.json'], /exactly one JSON file/],
  ];
  for (const [argv, pattern] of cases) {
    let reads = 0;
    const { io, output } = memoryIo();
    assert.equal(await main(argv, {
      sdk: {},
      io,
      fileSystem: memoryFileSystem(async () => { reads += 1; return '{}'; }),
      cwd: 'C:\\workspace',
    }), 2, argv.join(' '));
    assert.match(output.stderr, pattern, argv.join(' '));
    assert.equal(reads, 0, argv.join(' '));
  }
});

test('bare dash remains an invalid option outside the transaction file slot', async () => {
  const cases = [
    ['run', '-'],
    ['eval', '-'],
    ['telemetry', 'register', '-'],
  ];
  for (const argv of cases) {
    const { io, output } = memoryIo();
    assert.equal(await main(argv, { sdk: {}, io }), 2, argv.join(' '));
    assert.match(output.stderr, /Unknown option: -/, argv.join(' '));
  }
});

test('memory transact allows an external absolute JSON file only with the explicit flag', async () => {
  const request = {
    transactionId: 'proof.external-1',
    operations: [{ address: '0x1000', expectedHex: '00', replacementHex: '01' }],
  };
  const result = {
    transactionId: request.transactionId,
    status: 'applied_verified',
    operations: [{ index: 0, applied: true, verified: true }],
  };
  const reads = [];
  const calls = [];
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      writeTransaction: async (value) => { calls.push(value); return result; },
    }),
  };
  assert.equal(await main([
    'memory', 'transact', 'C:\\outside\\proof.json', '--allow-external-file', '--json',
  ], {
    sdk,
    io: memoryIo().io,
    fileSystem: memoryFileSystem(async (file) => { reads.push(file); return JSON.stringify(request); }),
    cwd: 'C:\\workspace',
  }), 0);
  assert.deepEqual(reads, ['C:\\outside\\proof.json']);
  assert.deepEqual(calls, [request]);
});

test('memory transact resolves junction targets before enforcing CWD containment', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cfb27-cli-cwd-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'cfb27-cli-external-'));
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  const request = {
    transactionId: 'proof.link-1',
    operations: [{ address: '0x1000', expectedHex: '00', replacementHex: '01' }],
  };
  const result = {
    transactionId: request.transactionId,
    status: 'applied_verified',
    operations: [{ index: 0, applied: true, verified: true }],
  };
  await fs.writeFile(path.join(external, 'proof.json'), JSON.stringify(request));
  await fs.symlink(external, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  let calls = 0;
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({
      writeTransaction: async () => { calls += 1; return result; },
    }),
  };
  const refused = memoryIo();
  assert.equal(await main(['memory', 'transact', 'linked/proof.json'], {
    sdk, io: refused.io, cwd,
  }), 2);
  assert.match(refused.output.stderr, /outside the current working directory/);
  assert.equal(calls, 0);

  const allowed = memoryIo();
  assert.equal(await main([
    'memory', 'transact', 'linked/proof.json', '--allow-external-file', '--json',
  ], { sdk, io: allowed.io, cwd }), 0);
  assert.deepEqual(JSON.parse(allowed.output.stdout), result);
  assert.equal(calls, 1);
});

test('allow-external-file is only valid for memory transact', async () => {
  const { io, output } = memoryIo();
  assert.equal(await main(['status', '--allow-external-file'], { sdk: {}, io }), 2);
  assert.match(output.stderr, /only valid for memory transact/);
});

test('memory transact rejects diagnostic controls and accepts only the JSON file request', async () => {
  const cases = [
    ['--pattern', '0011223344556677'],
    ['--mask', 'FFFFFFFFFFFFFFFF'],
    ['--max-matches', '1'],
    ['--max-pages', '1'],
    ['--context', '0'],
    ['--range', '0x1000:1'],
    ['--allow-unsupported-build'],
    ['--follow'],
    ['--after', '1'],
    ['--game-dir', 'C:\\game'],
    ['--mmc-dir', 'C:\\mmc'],
    ['--artifacts-dir', 'C:\\artifacts'],
  ];
  for (const option of cases) {
    let reads = 0;
    const { io, output } = memoryIo();
    const argv = ['memory', 'transact', 'proof.json', ...option];
    assert.equal(await main(argv, {
      sdk: {},
      io,
      fileSystem: memoryFileSystem(async () => { reads += 1; return '{}'; }),
      cwd: 'C:\\workspace',
    }), 2, argv.join(' '));
    assert.match(output.stderr, /not valid for memory transact/, argv.join(' '));
    assert.equal(reads, 0, argv.join(' '));
  }
});

test('memory transact sanitizes hostile errors in human and JSON output', async () => {
  const hostile = Object.assign(
    new Error('address 0x7FF612340000 expected 1020 actual DEADBEEF'),
    {
      code: 'MEMORY_MISMATCH',
      details: {
        address: '0x7FF612340000',
        expectedHex: '1020',
        actualHex: 'DEADBEEF',
      },
    },
  );
  const sdk = {
    discoverGame: async () => ({ pid: 27 }),
    createClient: () => ({ writeTransaction: async () => { throw hostile; } }),
  };
  for (const json of [false, true]) {
    const { io, output } = memoryIo();
    const argv = ['memory', 'transact', 'proof.json', ...(json ? ['--json'] : [])];
    assert.notEqual(await main(argv, {
      sdk,
      io,
      fileSystem: memoryFileSystem(async () => JSON.stringify({
        transactionId: 'proof.hostile-1',
        operations: [{ address: '0x1000', expectedHex: '00', replacementHex: '01' }],
      })),
      cwd: 'C:\\workspace',
    }), 0);
    const combined = `${output.stdout}${output.stderr}`;
    assert.equal(combined.includes('0x7FF612340000'), false);
    assert.equal(combined.includes('1020'), false);
    assert.equal(combined.includes('DEADBEEF'), false);
    assert.equal(combined.includes('expectedHex'), false);
    assert.equal(combined.includes('actualHex'), false);
    assert.match(combined, /MEMORY_MISMATCH/);
  }
});

test('developer-only options are rejected outside their exact diagnostic operation', async () => {
  const cases = [
    ['status', '--pattern', '0011223344556677'],
    ['memory', 'read', '--range', '0x7FF612340000:16', '--context', '4'],
    ['memory', 'scan', '--pattern', '0011223344556677', '--mask', 'FFFFFFFFFFFFFFFF', '--max-matches', '1', '--context', '0', '--range', '0x1:1'],
    ['telemetry', 'register', 'probe.snapshot', '--max-matches', '1'],
  ];
  for (const argv of cases) {
    const { io, output } = memoryIo();
    assert.equal(await main(argv, { sdk: {}, io }), 2, argv.join(' '));
    assert.match(output.stderr, /not valid/, argv.join(' '));
  }
});
