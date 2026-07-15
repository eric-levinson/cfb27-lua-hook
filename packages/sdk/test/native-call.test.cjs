'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createClient } = require('../src/client.cjs');
const { ERROR_CODES } = require('../src/errors.cjs');
const { FrameDecoder, encodeFrame } = require('../src/frame.cjs');

function pipeName(label) {
  return `\\\\.\\pipe\\cfb27-native-call-${label}-${process.pid}-${Date.now()}-${Math.random()}`;
}

function listen(server, name) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, resolve);
  });
}

test('native call error codes are public and stable', () => {
  assert.equal(ERROR_CODES.includes('NATIVE_CALL_TARGET_INVALID'), true);
  assert.equal(ERROR_CODES.includes('NATIVE_CALL_EXCEPTION'), true);
});

test('nativeCall negotiates capability and sends an exact cloned request', async (t) => {
  const name = pipeName('valid');
  const requests = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        requests.push({ command: request.command, params: request.params });
        const result = request.command === 'hello'
          ? {
            protocolVersion: 1,
            hostVersion: 'test',
            supportedBuild: true,
            writesAllowed: true,
            capabilities: ['nativeCall'],
          }
          : { address: request.params.address, value: '0x24' };
        socket.end(encodeFrame({ protocol: 1, id: request.id, ok: true, result }));
      }
    });
  });
  await listen(server, name);
  t.after(() => server.close());

  const client = createClient({ pipeName: name, timeoutMs: 1000 });
  const input = { address: '0x140001000', arguments: ['0x1', '0x2', '0x3'] };
  const pending = client.nativeCall(input);
  input.address = '0x140002000';
  input.arguments[0] = '0x9';
  assert.deepEqual(await pending, { address: '0x140001000', value: '0x24' });
  assert.deepEqual(requests, [
    { command: 'hello', params: {} },
    {
      command: 'nativeCall',
      params: { address: '0x140001000', arguments: ['0x1', '0x2', '0x3'] },
    },
  ]);
});

test('nativeCall rejects malformed targets and arguments before I/O', async () => {
  const client = createClient({ pipeName: pipeName('unused'), timeoutMs: 25 });
  const invalid = [
    {},
    { address: '140001000' },
    { address: '0x0140001000' },
    { address: '0x140001000', arguments: new Array(9).fill('0x0') },
    { address: '0x140001000', arguments: [1] },
    { address: '0x140001000', arguments: ['0xabc'] },
    { address: '0x140001000', arguments: [], extra: true },
  ];
  for (const input of invalid) {
    await assert.rejects(Promise.resolve().then(() => client.nativeCall(input)), {
      code: 'INVALID_REQUEST',
    });
  }
});

test('nativeCall fails closed when the host lacks the capability', async (t) => {
  const name = pipeName('capability');
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        socket.end(encodeFrame({
          protocol: 1,
          id: request.id,
          ok: true,
          result: { protocolVersion: 1, capabilities: [] },
        }));
      }
    });
  });
  await listen(server, name);
  t.after(() => server.close());

  const client = createClient({ pipeName: name, timeoutMs: 1000 });
  await assert.rejects(client.nativeCall({ address: '0x140001000' }), {
    code: 'PROTOCOL_MISMATCH',
  });
});

test('nativeCall rejects malformed host results', async (t) => {
  const name = pipeName('response');
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        const result = request.command === 'hello'
          ? { protocolVersion: 1, capabilities: ['nativeCall'] }
          : { address: request.params.address, value: 36 };
        socket.end(encodeFrame({ protocol: 1, id: request.id, ok: true, result }));
      }
    });
  });
  await listen(server, name);
  t.after(() => server.close());

  const client = createClient({ pipeName: name, timeoutMs: 1000 });
  await assert.rejects(client.nativeCall({ address: '0x140001000' }), {
    code: 'INVALID_RESPONSE',
  });
});
