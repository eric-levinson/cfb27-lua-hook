'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildMaskedPatch,
  encodePlayerStringSlot,
  generateLiveClassPlan,
  openBrooksWriteTables,
  toLiveMirrorHex,
} = require('../src/live-class-generator.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfb27-live-class-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const savePath = path.join(dir, 'DYNASTY-AUTOSAVE');
  await fs.writeFile(savePath, Buffer.from('read-only-save-fixture'));
  return { dir, savePath };
}

function rawPlan(overrides = {}) {
  const playerBefore = Buffer.alloc(8);
  const playerAfter = Buffer.from(playerBefore);
  playerAfter[0] = 0x12;
  const recruitBefore = Buffer.alloc(4);
  const recruitAfter = Buffer.from(recruitBefore);
  recruitAfter[2] = 0x30;
  return {
    sourceRevision: 'abc123',
    playerRecordSize: 8,
    recruitRecordSize: 4,
    players: [{
      row: 20,
      before: playerBefore,
      after: playerAfter,
      fields: [{ offset: 0, length: 8 }],
      beforeStringSlot: Buffer.alloc(138),
      strings: { FirstName: 'Marcus', LastName: 'Hill', HomeTown: 'Austin' },
    }],
    recruits: [{
      row: 30,
      before: recruitBefore,
      after: recruitAfter,
      fields: [{ offset: 16, length: 4 }],
    }],
    gearSkipped: 0,
    ...overrides,
  };
}

test('normalizes Brooks output into masked numeric patches and mandatory names', async (t) => {
  const { savePath } = await fixture(t);
  const plan = await generateLiveClassPlan({
    savePath,
    brooksRoot: path.dirname(savePath),
    dependencies: { runBrooks: async () => rawPlan() },
  });

  assert.equal(plan.classSize, 1);
  assert.equal(plan.sourceRevision, 'abc123');
  assert.equal(plan.playerRows[0].row, 20);
  assert.equal(plan.playerRows[0].maskHex, 'FF00000000000000');
  assert.equal(plan.playerRows[0].valueHex, '1200000000000000');
  assert.deepEqual(plan.playerRows[0].strings, {
    FirstName: 'Marcus', LastName: 'Hill', HomeTown: 'Austin',
  });
  assert.equal(plan.playerRows[0].beforeStringSlotHex.length, 276);
  assert.equal(plan.recruitRows[0].row, 30);
  assert.equal(plan.recruitRows[0].maskHex, '0000F000');
  assert.equal(plan.gearSkipped, 1);
  assert.equal((await fs.readFile(savePath, 'utf8')), 'read-only-save-fixture');
});

test('requests Brooks skeleton mode for every live class plan', async (t) => {
  const { savePath } = await fixture(t);
  let received;
  await generateLiveClassPlan({
    savePath,
    brooksRoot: path.dirname(savePath),
    dependencies: {
      runBrooks: async (options) => {
        received = options;
        return rawPlan();
      },
    },
  });

  assert.equal(received.skeleton, true);
});

test('buildMaskedPatch marks complete declared fields, including unchanged bits', () => {
  const patch = buildMaskedPatch(
    Buffer.from('0000', 'hex'),
    Buffer.from('8000', 'hex'),
    [{ offset: 0, length: 4 }, { offset: 12, length: 4 }],
  );
  assert.deepEqual(patch, {
    beforeHex: '0000',
    maskHex: 'F00F',
    valueHex: '8000',
  });
});

test('converts save-order records into the live little-endian dword mirror', () => {
  assert.equal(toLiveMirrorHex('0011223344556677'), '3322110077665544');
  assert.throws(() => toLiveMirrorHex('0011'), /32-bit words/);
});

test('encodes mandatory Player strings into fixed table2 subslots', () => {
  const before = Buffer.alloc(138, 0x7f);
  const slot = encodePlayerStringSlot(before, {
    FirstName: 'A', LastName: 'Bee', HomeTown: 'Cedar Park',
  });
  assert.equal(slot.subarray(0, 17).toString('hex'), `${Buffer.from('A').toString('hex')}00${'00'.repeat(15)}`);
  assert.equal(slot.subarray(50, 71).toString('utf8').replace(/\0.*$/s, ''), 'Bee');
  assert.equal(slot.subarray(112, 138).toString('utf8').replace(/\0.*$/s, ''), 'Cedar Park');
  assert.equal(slot[17], 0x7f, 'optional head slot remains untouched');
});

test('preserves the existing hometown when skeleton mode omits it', () => {
  const before = Buffer.alloc(138, 0x7f);
  before.fill(0, 112, 138);
  Buffer.from('Nashville', 'utf8').copy(before, 112);

  const slot = encodePlayerStringSlot(before, {
    FirstName: 'Solomon', LastName: 'Bennett', GenericHeadAssetName: 'Unique_Test_1',
  });

  assert.deepEqual(slot.subarray(112, 138), before.subarray(112, 138));
});

test('opens Brooks records schema-less so Field_N write aliases remain available', async () => {
  const calls = [];
  const player = { name: 'Player', recordsRead: true };
  const recruit = { name: 'Recruit', recordsRead: true };
  const file = { tables: [player, recruit] };
  const result = await openBrooksWriteTables(async (...args) => {
    calls.push(args);
    return file;
  }, 'save-path');
  assert.deepEqual(calls, [['save-path']]);
  assert.deepEqual(result, { file, playerTable: player, recruitTable: recruit });
});

test('rejects missing or oversized mandatory names before returning a plan', async (t) => {
  const { savePath } = await fixture(t);
  for (const strings of [
    { FirstName: '', LastName: 'Hill', HomeTown: 'Austin' },
    { FirstName: 'X'.repeat(17), LastName: 'Hill', HomeTown: 'Austin' },
  ]) {
    await assert.rejects(
      generateLiveClassPlan({
        savePath,
        brooksRoot: path.dirname(savePath),
        dependencies: {
          runBrooks: async () => rawPlan({
            players: [{ ...rawPlan().players[0], strings }],
          }),
        },
      }),
      /FirstName/,
    );
  }
});

test('rejects malformed rows, Brooks errors, and any save mutation', async (t) => {
  const { savePath } = await fixture(t);
  const args = { savePath, brooksRoot: path.dirname(savePath) };

  await assert.rejects(generateLiveClassPlan({
    ...args,
    dependencies: { runBrooks: async () => rawPlan({ players: [{ ...rawPlan().players[0], row: -1 }] }) },
  }), /row/);

  await assert.rejects(generateLiveClassPlan({
    ...args,
    dependencies: { runBrooks: async () => { throw new Error('generator exploded'); } },
  }), /generator exploded/);

  await assert.rejects(generateLiveClassPlan({
    ...args,
    dependencies: {
      runBrooks: async () => {
        await fs.appendFile(savePath, 'changed');
        return rawPlan();
      },
    },
  }), /save file changed/i);
});
