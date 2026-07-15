'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodePlayerStringSlot, toLiveMirrorHex } = require('../src/live-class-generator.cjs');
const { replaceLiveClass } = require('../src/live-class-replace.cjs');

function address(base, row, stride) {
  return `0x${(BigInt(base) + BigInt(row * stride)).toString(16).toUpperCase()}`;
}

function makeFixture({ count = 12, failForwardBatch = 0, failRollback = false } = {}) {
  const playerRecordSize = 8;
  const recruitRecordSize = 4;
  const stringSize = 138;
  const surfaces = {
    playerBase: '0x100000',
    recruitBase: '0x200000',
    playerStringsBase: '0x300000',
  };
  const memory = new Map();
  const playerRows = [];
  const recruitRows = [];

  for (let row = 0; row < count; row += 1) {
    const playerBefore = Buffer.alloc(playerRecordSize, 0x10 + row);
    const playerMask = Buffer.from('FF00000000000000', 'hex');
    const playerValue = Buffer.alloc(playerRecordSize);
    playerValue[0] = 0x80 + row;
    const recruitBefore = Buffer.alloc(recruitRecordSize, 0x20 + row);
    const recruitMask = Buffer.from('00FF0000', 'hex');
    const recruitValue = Buffer.alloc(recruitRecordSize);
    recruitValue[1] = 0x40 + row;
    const stringBefore = Buffer.alloc(stringSize, 0x2E);
    const strings = {
      FirstName: `First${row}`,
      LastName: `Last${row}`,
      HomeTown: `Town${row}`,
      ...(row === 0 ? { GenericHeadAssetName: 'head_generated' } : {}),
    };
    const stringValue = encodePlayerStringSlot(stringBefore, strings);

    playerRows.push({
      row,
      beforeHex: playerBefore.toString('hex').toUpperCase(),
      maskHex: playerMask.toString('hex').toUpperCase(),
      valueHex: playerValue.toString('hex').toUpperCase(),
      beforeStringSlotHex: stringBefore.toString('hex').toUpperCase(),
      stringValueHex: stringValue.toString('hex').toUpperCase(),
      strings,
    });
    recruitRows.push({
      row,
      beforeHex: recruitBefore.toString('hex').toUpperCase(),
      maskHex: recruitMask.toString('hex').toUpperCase(),
      valueHex: recruitValue.toString('hex').toUpperCase(),
    });
    memory.set(address(surfaces.playerBase, row, playerRecordSize),
      Buffer.from(toLiveMirrorHex(playerBefore.toString('hex').toUpperCase()), 'hex'));
    memory.set(address(surfaces.recruitBase, row, recruitRecordSize),
      Buffer.from(toLiveMirrorHex(recruitBefore.toString('hex').toUpperCase()), 'hex'));
    memory.set(address(surfaces.playerStringsBase, row, stringSize), Buffer.from(stringBefore));
  }

  const initial = snapshot(memory);
  const events = [];
  let forwardBatch = 0;
  const client = {
    async readMemory({ ranges }) {
      events.push({ type: 'read', ranges: ranges.length });
      return {
        supportedBuild: true,
        ranges: ranges.map((range) => {
          const bytes = memory.get(range.address);
          if (!bytes || bytes.length !== range.length) throw new Error('unexpected test range');
          return {
            address: range.address,
            length: range.length,
            bytesHex: bytes.toString('hex').toUpperCase(),
          };
        }),
      };
    },
    async writeTransaction(transaction) {
      const rollback = transaction.transactionId.includes('-rollback-');
      events.push({ type: rollback ? 'rollback' : 'write', operations: transaction.operations.length });
      if (rollback && failRollback) throw new Error('rollback rejected');
      if (!rollback) {
        forwardBatch += 1;
        if (forwardBatch === failForwardBatch) throw new Error('forward rejected');
      }
      for (const operation of transaction.operations) {
        const current = memory.get(operation.address);
        assert.equal(current.toString('hex').toUpperCase(), operation.expectedHex);
      }
      for (const operation of transaction.operations) {
        memory.set(operation.address, Buffer.from(operation.replacementHex, 'hex'));
      }
      return {
        transactionId: transaction.transactionId,
        status: 'applied_verified',
        operations: transaction.operations.map((unused, index) => ({
          index, applied: true, verified: true,
        })),
      };
    },
  };

  return {
    client,
    events,
    initial,
    memory,
    surfaces,
    plan: {
      classSize: count,
      playerRecordSize,
      recruitRecordSize,
      playerRows,
      recruitRows,
      gearSkipped: count,
    },
  };
}

function snapshot(memory) {
  return [...memory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value.toString('hex').toUpperCase()]);
}

test('snapshots the full class, applies batches of at most 32, and verifies every batch', async () => {
  const fixture = makeFixture();
  const result = await replaceLiveClass({
    client: fixture.client,
    plan: fixture.plan,
    surfaces: fixture.surfaces,
    generation: 7,
  });

  assert.equal(result.status, 'applied_verified');
  assert.equal(result.classSize, 12);
  assert.equal(result.batchesApplied, 2);
  assert.equal(result.playerRowsWritten, 12);
  assert.equal(result.recruitRowsWritten, 12);
  assert.equal(result.nameSlotsWritten, 12);
  assert.deepEqual(result.optionalSkipped, { portraits: 11, gear: 12 });
  assert.equal(result.rollbackStatus, 'not_needed');
  assert.ok(fixture.events.filter((event) => event.type === 'write')
    .every((event) => event.operations <= 32));
  const firstWrite = fixture.events.findIndex((event) => event.type === 'write');
  assert.equal(fixture.events.slice(0, firstWrite).reduce((sum, event) => sum + event.ranges, 0), 36);

  const firstPlayer = fixture.memory.get('0x100000');
  assert.equal(firstPlayer[3], 0x80);
  assert.equal(firstPlayer[0], 0x10, 'unmanaged player bytes are preserved');
  const firstStrings = fixture.memory.get('0x300000');
  assert.equal(firstStrings.subarray(0, 17).toString('utf8').replace(/\0.*$/s, ''), 'First0');
  assert.equal(firstStrings.subarray(17, 50).toString('utf8').replace(/\0.*$/s, ''), 'head_generated');
  const secondStrings = fixture.memory.get(address('0x300000', 1, 138));
  assert.ok(secondStrings.subarray(17, 50).every((byte) => byte === 0x2E),
    'missing optional portrait leaves the live bytes untouched');
});

test('dry-run performs the complete snapshot without writing', async () => {
  const fixture = makeFixture();
  const result = await replaceLiveClass({
    client: fixture.client,
    plan: fixture.plan,
    surfaces: fixture.surfaces,
    generation: 8,
    dryRun: true,
  });

  assert.equal(result.status, 'dry_run');
  assert.equal(result.batchesApplied, 0);
  assert.equal(result.plannedBatches, 2);
  assert.equal(fixture.events.some((event) => event.type === 'write'), false);
  assert.deepEqual(snapshot(fixture.memory), fixture.initial);
});

test('a later forward failure rolls every successful batch back to the live snapshot', async () => {
  const fixture = makeFixture({ failForwardBatch: 2 });
  await assert.rejects(
    replaceLiveClass({
      client: fixture.client,
      plan: fixture.plan,
      surfaces: fixture.surfaces,
      generation: 9,
    }),
    (error) => error.code === 'LIVE_CLASS_APPLY_FAILED' && /rolled back/i.test(error.message),
  );
  assert.deepEqual(snapshot(fixture.memory), fixture.initial);
  assert.equal(fixture.events.filter((event) => event.type === 'rollback').length, 1);
});

test('reports a distinct hard failure when automatic rollback cannot be verified', async () => {
  const fixture = makeFixture({ failForwardBatch: 2, failRollback: true });
  await assert.rejects(
    replaceLiveClass({
      client: fixture.client,
      plan: fixture.plan,
      surfaces: fixture.surfaces,
      generation: 10,
    }),
    (error) => error.code === 'LIVE_CLASS_ROLLBACK_FAILED',
  );
});
