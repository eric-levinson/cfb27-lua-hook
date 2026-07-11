'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
