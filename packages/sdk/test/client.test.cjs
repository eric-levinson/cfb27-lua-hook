'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createClient } = require('../src/client.cjs');
const { ERROR_CODES } = require('../src/errors.cjs');
const { FrameDecoder, encodeFrame } = require('../src/frame.cjs');

function listen(server, pipeName) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, resolve);
  });
}

function testPipeName(label) {
  return `\\\\.\\pipe\\cfb27-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fakeClient(t, responder) {
  const pipeName = testPipeName('memory');
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        const response = encodeFrame({
          protocol: 1,
          id: request.id,
          ok: true,
          result: responder(request),
        });
        socket.end(response);
      }
    });
  });
  await listen(server, pipeName);
  t.after(() => server.close());
  return createClient({ pipeName, timeoutMs: 1000 });
}

const VALID_SCAN_OPTIONS = Object.freeze({
  patternHex: 'CFB27A1100A1B2C3D4E5F60718293A4B',
  maskHex: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
  maxMatches: 2,
  contextBefore: 4,
  contextAfter: 4,
});

const VALID_SCAN_RESULT = Object.freeze({
  supportedBuild: true,
  complete: true,
  nextCursor: null,
  scannedBytes: 65536,
  matches: Object.freeze([Object.freeze({
    address: '0x7FF612340080',
    regionBase: '0x7FF612340000',
    regionSize: 65536,
    protection: 4,
    contextAddress: '0x7FF61234007C',
    contextHex: '00000000CFB27A1100A1B2C3D4E5F60718293A4B00000000',
  })]),
});

const VALID_READ_RESULT = Object.freeze({
  supportedBuild: true,
  ranges: Object.freeze([Object.freeze({
    address: '0x7FF612340000',
    length: 16,
    bytesHex: 'CFB27A1100A1B2C3D4E5F60718293A4B',
  })]),
});

test('SDK publishes stable memory error codes', () => {
  for (const code of ['MEMORY_ACCESS_DENIED', 'SCAN_LIMIT_EXCEEDED', 'TOO_MANY_MATCHES']) {
    assert.ok(ERROR_CODES.includes(code), `missing ${code}`);
  }
});

test('client negotiates hello and preserves multiline evaluate', async (t) => {
  const pipeName = `\\\\.\\pipe\\cfb27-test-${process.pid}-${Date.now()}`;
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        const result = request.command === 'hello'
          ? { protocolVersion: 1, capabilities: ['status', 'evaluate'] }
          : { echoed: request.params.source };
        const response = encodeFrame({ protocol: 1, id: request.id, ok: true, result });
        socket.write(response.subarray(0, 2));
        setImmediate(() => socket.end(response.subarray(2)));
      }
    });
  });
  await listen(server, pipeName);
  t.after(() => server.close());

  const client = createClient({ pipeName, timeoutMs: 1000 });
  assert.equal((await client.hello()).protocolVersion, 1);
  assert.equal((await client.evaluateLua('x=1\nx=2')).echoed, 'x=1\nx=2');
});

test('client maps a silent host to PIPE_TIMEOUT', async (t) => {
  const pipeName = `\\\\.\\pipe\\cfb27-timeout-${process.pid}-${Date.now()}`;
  let connections = 0;
  const server = net.createServer(() => {
    connections += 1;
  });
  await listen(server, pipeName);
  t.after(() => server.close());

  const client = createClient({ pipeName, timeoutMs: 25 });
  await assert.rejects(client.status(), (error) => error.code === 'PIPE_TIMEOUT');
  assert.equal(connections, 1);
});

test('client applies one total deadline while a named pipe stays absent', async () => {
  const timeoutMs = 35;
  const startedAt = Date.now();
  const client = createClient({ pipeName: testPipeName('absent'), timeoutMs });

  await assert.rejects(client.status(), (error) => error.code === 'PIPE_TIMEOUT');
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= timeoutMs, `request ended before its deadline (${elapsedMs} ms)`);
  assert.ok(elapsedMs < 250, `request deadline was reset by retries (${elapsedMs} ms)`);
});

test('scanMemory retries a transient gap between named-pipe server instances', async (t) => {
  const pipeName = testPipeName('pipe-gap');
  const server = net.createServer();
  const requests = [];
  let relistenTimer;

  server.on('connection', (socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        requests.push(request);
        const firstPage = requests.length === 1;
        const result = firstPage
          ? { supportedBuild: true, complete: false, nextCursor: '0x1000',
            scannedBytes: 32, matches: [] }
          : { supportedBuild: true, complete: true, nextCursor: null,
            scannedBytes: 8, matches: [] };

        if (firstPage) {
          server.close(() => {
            relistenTimer = setTimeout(() => server.listen(pipeName), 40);
          });
        }
        socket.end(encodeFrame({ protocol: 1, id: request.id, ok: true, result }));
      }
    });
  });
  await listen(server, pipeName);
  t.after(async () => {
    clearTimeout(relistenTimer);
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  const client = createClient({ pipeName, timeoutMs: 500 });
  assert.deepEqual(
    await client.scanMemory({ ...VALID_SCAN_OPTIONS, maxPages: 2 }),
    { supportedBuild: true, complete: true, scannedBytes: 40, matches: [] },
  );
  assert.deepEqual(requests.map((request) => request.params.cursor), [undefined, '0x1000']);
});

test('client does not retry after a host response error', async (t) => {
  const pipeName = testPipeName('host-error');
  let requests = 0;
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        requests += 1;
        server.close();
        socket.end(encodeFrame({
          protocol: 1,
          id: request.id,
          ok: false,
          error: { code: 'TEST_HOST_ERROR', message: 'Host rejected the request' },
        }));
      }
    });
  });
  await listen(server, pipeName);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  const client = createClient({ pipeName, timeoutMs: 100 });
  await assert.rejects(client.status(), (error) => error.code === 'TEST_HOST_ERROR');
  assert.equal(requests, 1);
});

test('memory APIs clone options and send exact typed commands', async (t) => {
  const requests = [];
  const client = await fakeClient(t, (request) => {
    requests.push({ command: request.command, params: request.params });
    return request.command === 'scanMemory' ? VALID_SCAN_RESULT : VALID_READ_RESULT;
  });

  const scanOptions = { ...VALID_SCAN_OPTIONS };
  const scanPromise = client.scanMemoryPage(scanOptions);
  scanOptions.patternHex = '0000000000000000';
  scanOptions.maxMatches = 64;
  scanOptions.extra = true;
  assert.deepEqual(await scanPromise, VALID_SCAN_RESULT);

  const readOptions = { ranges: [{ address: '0x7FF612340000', length: 16 }] };
  const readPromise = client.readMemory(readOptions);
  readOptions.ranges[0].address = '0x1';
  readOptions.ranges.push({ address: '0x2', length: 1 });
  assert.deepEqual(await readPromise, VALID_READ_RESULT);

  assert.deepEqual(requests, [
    { command: 'scanMemory', params: VALID_SCAN_OPTIONS },
    {
      command: 'readMemory',
      params: { ranges: [{ address: '0x7FF612340000', length: 16 }] },
    },
  ]);
});

test('memory APIs reject invalid requests before creating a socket', async () => {
  const originalCreateConnection = net.createConnection;
  let socketCreations = 0;
  net.createConnection = (...args) => {
    socketCreations += 1;
    return originalCreateConnection(...args);
  };

  try {
    const client = createClient({ pipeName: testPipeName('unused'), timeoutMs: 25 });
    const scanCases = [
      { ...VALID_SCAN_OPTIONS, extra: true },
      { ...VALID_SCAN_OPTIONS, patternHex: VALID_SCAN_OPTIONS.patternHex.toLowerCase() },
      { ...VALID_SCAN_OPTIONS, patternHex: `${VALID_SCAN_OPTIONS.patternHex}F`, maskHex: `${VALID_SCAN_OPTIONS.maskHex}F` },
      { ...VALID_SCAN_OPTIONS, patternHex: 'GGGGGGGGGGGGGGGG' },
      { ...VALID_SCAN_OPTIONS, maskHex: 'FFFFFFFFFFFFFFFF' },
      { ...VALID_SCAN_OPTIONS, patternHex: '00112233445566', maskHex: 'FFFFFFFFFFFFFF' },
      { ...VALID_SCAN_OPTIONS, patternHex: '00'.repeat(4097), maskHex: 'FF'.repeat(4097) },
      { ...VALID_SCAN_OPTIONS, maxMatches: 65 },
      { ...VALID_SCAN_OPTIONS, maxMatches: Number.MAX_SAFE_INTEGER + 1 },
      { ...VALID_SCAN_OPTIONS, contextBefore: 256, contextAfter: 257 },
      { ...VALID_SCAN_OPTIONS, allowUnsupportedBuild: 'true' },
      { ...VALID_SCAN_OPTIONS, cursor: '0xabcdef' },
      { ...VALID_SCAN_OPTIONS, cursor: 4096 },
    ];
    for (const options of scanCases) {
      await assert.rejects(
        Promise.resolve().then(() => client.scanMemoryPage(options)),
        (error) => error.code === 'INVALID_REQUEST',
      );
    }
    await assert.rejects(
      Promise.resolve().then(() => client.scanMemory({ ...VALID_SCAN_OPTIONS, cursor: '0x1000' })),
      (error) => error.code === 'INVALID_REQUEST',
    );
    for (const maxPages of [0, 4097, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      await assert.rejects(
        Promise.resolve().then(() => client.scanMemory({ ...VALID_SCAN_OPTIONS, maxPages })),
        (error) => error.code === 'INVALID_REQUEST',
      );
    }

    const validRange = { address: '0x7FF612340000', length: 16 };
    const readCases = [
      { ranges: [validRange], extra: true },
      { ranges: [{ ...validRange, extra: true }] },
      { ranges: [{ address: 0x1234, length: 16 }] },
      { ranges: [{ address: '0x7ff612340000', length: 16 }] },
      { ranges: [{ address: '0x0001', length: 16 }] },
      { ranges: [{ address: '7FF612340000', length: 16 }] },
      { ranges: [{ address: validRange.address, length: Number.MAX_SAFE_INTEGER + 1 }] },
      { ranges: [{ address: validRange.address, length: 65537 }] },
      { ranges: Array.from({ length: 65 }, () => ({ ...validRange })) },
      { ranges: Array.from({ length: 5 }, (_, index) => ({ address: `0x${index + 1}`, length: 65536 })) },
      { ranges: [] },
      { ranges: [validRange], allowUnsupportedBuild: 1 },
    ];
    for (const options of readCases) {
      await assert.rejects(
        Promise.resolve().then(() => client.readMemory(options)),
        (error) => error.code === 'INVALID_REQUEST',
      );
    }
    assert.equal(socketCreations, 0);
  } finally {
    net.createConnection = originalCreateConnection;
  }
});

test('scanMemoryPage rejects malformed host result fields', async (t) => {
  const invalidResults = [
    { ...VALID_SCAN_RESULT, supportedBuild: 1 },
    { ...VALID_SCAN_RESULT, complete: undefined },
    { ...VALID_SCAN_RESULT, complete: false, nextCursor: null },
    { ...VALID_SCAN_RESULT, nextCursor: '0x1000' },
    { ...VALID_SCAN_RESULT, complete: false, nextCursor: 4096 },
    { ...VALID_SCAN_RESULT, complete: false, nextCursor: '0xabcdef' },
    { ...VALID_SCAN_RESULT, scannedBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_SCAN_RESULT, matches: Array.from({ length: 65 }, () => VALID_SCAN_RESULT.matches[0]) },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], address: 140694844080256 }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], address: '0x0001' }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], regionBase: '0x7ff612340000' }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], regionBase: '0x0001' }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], regionSize: -1 }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], protection: 4.5 }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], contextAddress: '0x7ff61234007C' }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], contextAddress: '0x0001' }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], contextHex: 'ABC' }] },
    { ...VALID_SCAN_RESULT, matches: [{ ...VALID_SCAN_RESULT.matches[0], contextHex: '00'.repeat(25) }] },
  ];
  let index = 0;
  const client = await fakeClient(t, () => invalidResults[index++]);

  for (const ignored of invalidResults) {
    await assert.rejects(
      client.scanMemoryPage(VALID_SCAN_OPTIONS),
      (error) => error.code === 'INVALID_RESPONSE',
    );
  }
});

test('readMemory rejects malformed host result fields', async (t) => {
  const invalidResults = [
    { ...VALID_READ_RESULT, supportedBuild: 'true' },
    { ...VALID_READ_RESULT, ranges: Array.from({ length: 65 }, () => VALID_READ_RESULT.ranges[0]) },
    { ...VALID_READ_RESULT, ranges: [{ ...VALID_READ_RESULT.ranges[0], address: 140694844080128 }] },
    { ...VALID_READ_RESULT, ranges: [{ ...VALID_READ_RESULT.ranges[0], address: '0x7ff612340000' }] },
    { ...VALID_READ_RESULT, ranges: [{ ...VALID_READ_RESULT.ranges[0], address: '0x0001' }] },
    { ...VALID_READ_RESULT, ranges: [{ ...VALID_READ_RESULT.ranges[0], length: 15 }] },
    { ...VALID_READ_RESULT, ranges: [{ ...VALID_READ_RESULT.ranges[0], bytesHex: '00'.repeat(15) }] },
  ];
  let index = 0;
  const client = await fakeClient(t, () => invalidResults[index++]);

  for (const ignored of invalidResults) {
    await assert.rejects(
      client.readMemory({ ranges: [{ address: '0x7FF612340000', length: 16 }] }),
      (error) => error.code === 'INVALID_RESPONSE',
    );
  }
});

test('memory APIs reject unsupported-build results unless explicitly allowed', async (t) => {
  const client = await fakeClient(t, (request) => request.command === 'scanMemory'
    ? { ...VALID_SCAN_RESULT, supportedBuild: false }
    : { ...VALID_READ_RESULT, supportedBuild: false });

  await assert.rejects(
    client.scanMemoryPage(VALID_SCAN_OPTIONS),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    client.readMemory({ ranges: [{ address: '0x7FF612340000', length: 16 }] }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    client.scanMemoryPage({ ...VALID_SCAN_OPTIONS, allowUnsupportedBuild: false }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    client.readMemory({
      ranges: [{ address: '0x7FF612340000', length: 16 }],
      allowUnsupportedBuild: false,
    }),
    (error) => error.code === 'INVALID_RESPONSE',
  );

  assert.deepEqual(
    await client.scanMemoryPage({ ...VALID_SCAN_OPTIONS, allowUnsupportedBuild: true }),
    { ...VALID_SCAN_RESULT, supportedBuild: false },
  );
  assert.deepEqual(
    await client.readMemory({
      ranges: [{ address: '0x7FF612340000', length: 16 }],
      allowUnsupportedBuild: true,
    }),
    { ...VALID_READ_RESULT, supportedBuild: false },
  );
});

test('scanMemory aggregates pages and sends exact continuation cursors', async (t) => {
  const pages = [
    { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 32, matches: [] },
    { supportedBuild: true, complete: false, nextCursor: '0x2000', scannedBytes: 32,
      matches: [VALID_SCAN_RESULT.matches[0]] },
    { supportedBuild: true, complete: true, nextCursor: null, scannedBytes: 8, matches: [] },
  ];
  const seen = [];
  const client = await fakeClient(t, (request) => {
    seen.push(request);
    return pages.shift();
  });

  assert.deepEqual(
    await client.scanMemory({ ...VALID_SCAN_OPTIONS, maxPages: 3 }),
    { supportedBuild: true, complete: true, scannedBytes: 72,
      matches: [VALID_SCAN_RESULT.matches[0]] },
  );
  assert.deepEqual(seen.map((request) => request.params.cursor),
    [undefined, '0x1000', '0x2000']);
  assert.ok(seen.every((request) => !Object.hasOwn(request.params, 'maxPages')));
});

test('scanMemory rejects hostile pagination responses', async (t) => {
  const scenarios = [
    [
      { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 1, matches: [] },
      { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 1, matches: [] },
    ],
    [
      { supportedBuild: true, complete: false, nextCursor: '0x2000', scannedBytes: 1, matches: [] },
      { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 1, matches: [] },
    ],
    [
      { supportedBuild: true, complete: false, nextCursor: '0x1000',
        scannedBytes: Number.MAX_SAFE_INTEGER, matches: [] },
      { supportedBuild: true, complete: true, nextCursor: null, scannedBytes: 1, matches: [] },
    ],
    [
      { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 1,
        matches: [VALID_SCAN_RESULT.matches[0]] },
      { supportedBuild: true, complete: true, nextCursor: null, scannedBytes: 1,
        matches: [VALID_SCAN_RESULT.matches[0]] },
    ],
    [
      { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 1, matches: [] },
      { supportedBuild: false, complete: true, nextCursor: null, scannedBytes: 1, matches: [] },
    ],
  ];

  for (const scenario of scenarios) {
    const pages = [...scenario];
    const client = await fakeClient(t, () => pages.shift());
    const options = scenario === scenarios[3]
      ? { ...VALID_SCAN_OPTIONS, maxMatches: 1 }
      : { ...VALID_SCAN_OPTIONS, allowUnsupportedBuild: true };
    await assert.rejects(
      client.scanMemory(options),
      (error) => error.code === 'INVALID_RESPONSE' || error.code === 'TOO_MANY_MATCHES',
    );
  }
});

test('scanMemory enforces maxPages without returning partial coverage', async (t) => {
  let cursor = 0x1000;
  const client = await fakeClient(t, () => {
    const result = { supportedBuild: true, complete: false,
      nextCursor: `0x${cursor.toString(16).toUpperCase()}`, scannedBytes: 32, matches: [] };
    cursor += 0x1000;
    return result;
  });
  await assert.rejects(
    client.scanMemory({ ...VALID_SCAN_OPTIONS, maxPages: 2 }),
    (error) => error.code === 'SCAN_LIMIT_EXCEEDED',
  );
});

test('registerTelemetryTypes clones names and sends the exact typed command', async (t) => {
  const requests = [];
  const client = await fakeClient(t, (request) => {
    requests.push({ command: request.command, params: request.params });
    return { types: ['probe.snapshot', 'recruiting.stability'] };
  });
  const types = ['probe.snapshot', 'recruiting.stability'];
  const pending = client.registerTelemetryTypes(types);
  types[0] = 'mutated';
  types.push('extra');
  assert.deepEqual(await pending, { types: ['probe.snapshot', 'recruiting.stability'] });
  assert.deepEqual(requests, [{
    command: 'registerTelemetry',
    params: { types: ['probe.snapshot', 'recruiting.stability'] },
  }]);
});

test('registerTelemetryTypes rejects invalid names before creating a socket', async () => {
  const originalCreateConnection = net.createConnection;
  let socketCreations = 0;
  net.createConnection = (...args) => {
    socketCreations += 1;
    return originalCreateConnection(...args);
  };
  try {
    const client = createClient({ pipeName: testPipeName('unused'), timeoutMs: 25 });
    const cases = [
      undefined,
      [],
      'probe.snapshot',
      ['game_ready'],
      ['tick'],
      ['log'],
      ['Probe.snapshot'],
      ['probe snapshot'],
      ['probe.snapshot', 'probe.snapshot'],
      Array.from({ length: 17 }, (_, index) => `probe.type${index}`),
    ];
    for (const types of cases) {
      await assert.rejects(
        Promise.resolve().then(() => client.registerTelemetryTypes(types)),
        (error) => error.code === 'INVALID_REQUEST',
      );
    }
    assert.equal(socketCreations, 0);
  } finally {
    net.createConnection = originalCreateConnection;
  }
});

test('registerTelemetryTypes rejects malformed host results', async (t) => {
  const invalidResults = [
    undefined,
    {},
    { types: 'probe.snapshot' },
    { types: ['other.type'] },
    { types: ['probe.snapshot'], extra: true },
  ];
  let index = 0;
  const client = await fakeClient(t, () => invalidResults[index++]);
  for (const ignored of invalidResults) {
    await assert.rejects(
      client.registerTelemetryTypes(['probe.snapshot']),
      (error) => error.code === 'INVALID_RESPONSE',
    );
  }
});
