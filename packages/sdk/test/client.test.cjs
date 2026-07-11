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
  const server = net.createServer(() => {});
  await listen(server, pipeName);
  t.after(() => server.close());

  const client = createClient({ pipeName, timeoutMs: 25 });
  await assert.rejects(client.status(), (error) => error.code === 'PIPE_TIMEOUT');
});

test('memory APIs clone options and send exact typed commands', async (t) => {
  const requests = [];
  const client = await fakeClient(t, (request) => {
    requests.push({ command: request.command, params: request.params });
    return request.command === 'scanMemory' ? VALID_SCAN_RESULT : VALID_READ_RESULT;
  });

  const scanOptions = { ...VALID_SCAN_OPTIONS };
  const scanPromise = client.scanMemory(scanOptions);
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
    ];
    for (const options of scanCases) {
      await assert.rejects(
        Promise.resolve().then(() => client.scanMemory(options)),
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

test('scanMemory rejects malformed host result fields', async (t) => {
  const invalidResults = [
    { ...VALID_SCAN_RESULT, supportedBuild: 1 },
    { ...VALID_SCAN_RESULT, complete: undefined },
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
      client.scanMemory(VALID_SCAN_OPTIONS),
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
    client.scanMemory(VALID_SCAN_OPTIONS),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    client.readMemory({ ranges: [{ address: '0x7FF612340000', length: 16 }] }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    client.scanMemory({ ...VALID_SCAN_OPTIONS, allowUnsupportedBuild: false }),
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
    await client.scanMemory({ ...VALID_SCAN_OPTIONS, allowUnsupportedBuild: true }),
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
