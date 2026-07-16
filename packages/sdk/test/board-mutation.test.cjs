'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createClient } = require('../src/client.cjs');
const { ERROR_CODES } = require('../src/errors.cjs');
const { FrameDecoder, encodeFrame } = require('../src/frame.cjs');

function pipeName(label) {
  return `\\\\.\\pipe\\cfb27-board-${label}-${process.pid}-${Date.now()}-${Math.random()}`;
}

function listen(server, name) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, resolve);
  });
}

function result(operation, params, overrides = {}) {
  return {
    operation,
    status: 'applied_verified',
    recruitRow: params.recruitRow,
    teamRow: params.teamRow,
    membershipRow: 72,
    boardSlot: 3,
    targetRow: 3,
    activePitchRow: 3,
    callValue: '0x0',
    uiRefresh: 'next_recruiting_screen_change',
    ...overrides,
  };
}

test('board mutation error codes are public and stable', () => {
  for (const code of [
    'RECRUITING_NOT_LOADED',
    'RUNTIME_DISCOVERY_AMBIGUOUS',
    'BOARD_TABLE_DISCOVERY_FAILED',
    'BOARD_STATE_INVALID',
    'BOARD_FULL',
    'BOARD_NATIVE_CALL_FAILED',
    'BOARD_POSTCONDITION_FAILED',
  ]) assert.equal(ERROR_CODES.includes(code), true, code);
});

test('addBoard and removeBoard negotiate capability and send exact cloned requests', async (t) => {
  const name = pipeName('valid');
  const requests = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        requests.push({ command: request.command, params: request.params });
        const response = request.command === 'hello'
          ? { protocolVersion: 1, capabilities: ['boardMutationV1'] }
          : result(request.command === 'addBoard' ? 'add' : 'remove', request.params);
        socket.end(encodeFrame({ protocol: 1, id: request.id, ok: true, result: response }));
      }
    });
  });
  await listen(server, name);
  t.after(() => server.close());

  const client = createClient({ pipeName: name, timeoutMs: 1000 });
  const add = { recruitRow: 3182, teamRow: 92 };
  const pendingAdd = client.addBoard(add);
  add.recruitRow = 1;
  assert.equal((await pendingAdd).operation, 'add');
  assert.equal((await client.removeBoard({ recruitRow: 3182, teamRow: 92 })).operation, 'remove');
  assert.deepEqual(requests, [
    { command: 'hello', params: {} },
    { command: 'addBoard', params: { recruitRow: 3182, teamRow: 92 } },
    { command: 'hello', params: {} },
    { command: 'removeBoard', params: { recruitRow: 3182, teamRow: 92 } },
  ]);
});

test('board mutations reject malformed rows before I/O', async () => {
  const client = createClient({ pipeName: pipeName('unused'), timeoutMs: 25 });
  for (const input of [
    {},
    { recruitRow: 1 },
    { recruitRow: -1, teamRow: 92 },
    { recruitRow: 0x20000, teamRow: 92 },
    { recruitRow: 1, teamRow: 1.5 },
    { recruitRow: 1, teamRow: 92, extra: true },
  ]) {
    await assert.rejects(Promise.resolve().then(() => client.addBoard(input)), {
      code: 'INVALID_REQUEST',
    });
  }
});

test('board mutations fail closed without the capability', async (t) => {
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
  await assert.rejects(
    createClient({ pipeName: name, timeoutMs: 1000 }).addBoard({ recruitRow: 1, teamRow: 92 }),
    { code: 'PROTOCOL_MISMATCH' },
  );
});

test('board mutations accept unchanged and reject malformed host results', async (t) => {
  const name = pipeName('responses');
  let calls = 0;
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const request of decoder.push(chunk)) {
        let response;
        if (request.command === 'hello') {
          response = { protocolVersion: 1, capabilities: ['boardMutationV1'] };
        } else if (calls++ === 0) {
          response = result('remove', request.params, {
            status: 'unchanged', boardSlot: null, targetRow: null, activePitchRow: null,
          });
        } else {
          response = result('add', request.params, { boardSlot: 35 });
        }
        socket.end(encodeFrame({ protocol: 1, id: request.id, ok: true, result: response }));
      }
    });
  });
  await listen(server, name);
  t.after(() => server.close());
  const client = createClient({ pipeName: name, timeoutMs: 1000 });
  assert.equal((await client.removeBoard({ recruitRow: 3182, teamRow: 92 })).status, 'unchanged');
  await assert.rejects(client.addBoard({ recruitRow: 3182, teamRow: 92 }), {
    code: 'INVALID_RESPONSE',
  });
});
