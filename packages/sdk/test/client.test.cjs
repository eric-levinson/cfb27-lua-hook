'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createClient } = require('../src/client.cjs');
const { FrameDecoder, encodeFrame } = require('../src/frame.cjs');

function listen(server, pipeName) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, resolve);
  });
}

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
