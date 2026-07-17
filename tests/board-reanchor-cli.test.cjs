'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  parseArgs,
  parseCaptureLogs,
  sessionId,
  findBoardSlot,
  serializeTables,
  run,
} = require('../scripts/board-verification/reanchor-build.cjs');

test('guided CLI parses only phase-scoped options', () => {
  assert.deepEqual(parseArgs(['capture-add-write', '--game-dir', 'G', '--save', 'S',
    '--capture', '2', '--recruit-row', '33', '--team-row', '22']), {
    command: 'capture-add-write', gameDir: 'G', save: 'S', capture: 2,
    recruitRow: 33, teamRow: 22,
  });
  assert.throws(() => parseArgs(['unknown']), /Usage/);
  assert.throws(() => parseArgs(['validate', '--output-root', 'elsewhere']), /Invalid/);
  assert.throws(() => parseArgs(['analyze', '--stage', 'final']), /stage/);
  assert.throws(() => parseArgs(['capture-add-write', '--capture', '-1']), /nonnegative/);
});

test('watch log parser requires complete zero-drop evidence', () => {
  const prefix = 'CAPTURE';
  const base = [
    { message: `${prefix}|HIT|1|0|77|0x140001100|0x2000|0x1|0x2|0x3|0x4|0x5|0x6|0x7|0x8|0x9|0xA|0xB` },
    { message: `${prefix}|STACK|1|0x140001200,0x140001300` },
    { message: `${prefix}|RCX|1|0x10,0x20` },
    { message: `${prefix}|META|1|0` },
  ];
  const hits = parseCaptureLogs(base, prefix);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rip, '0x140001100');
  assert.deepEqual(hits[0].stackReturnAddresses, ['0x140001200', '0x140001300']);
  assert.deepEqual(hits[0].rcxMemory, ['0x10', '0x20']);
  assert.throws(() => parseCaptureLogs(base.slice(0, -1), prefix), /incomplete/);
  assert.throws(() => parseCaptureLogs([...base.slice(0, -1),
    { message: `${prefix}|META|1|1` }], prefix), /dropped=1/);
});

test('session identity is stable and sensitive to host start evidence', () => {
  const input = { pid: 77, creationDate: '20260716120000.000000-300',
    hostVersion: '0.2.0-dev.2' };
  assert.match(sessionId(input), /^[0-9A-F]{64}$/);
  assert.equal(sessionId(input), sessionId({ ...input }));
  assert.notEqual(sessionId(input), sessionId({ ...input, creationDate: '20260716120001.000000-300' }));
});

test('board slot lookup follows membership to the recruit target', () => {
  const membershipData = Buffer.alloc(140);
  membershipData.writeUInt32LE((4168 << 17) | 4, 3 * 4);
  const targetData = Buffer.alloc(36 * 10);
  targetData.writeUInt32LE((4269 << 17) | 33, 4 * 36 + 12);
  const tables = new Map([
    [5847, { capacity: 138, stride: 140, words: 35, data: membershipData }],
    [4168, { capacity: 10, stride: 36, data: targetData }],
  ]);
  assert.equal(findBoardSlot(tables, 0, 33), 3);
  assert.throws(() => findBoardSlot(tables, 0, 34), /not on membership/);
});

test('serialized validation retains strict candidate counts and six summaries', () => {
  const located = [4168, 4176, 4190, 4251, 5790, 5847].map((id) => ({
    id, header: 0x1000n + BigInt(id), base: 0x2000n + BigInt(id), stride: 4,
    capacity: 8, words: 1, candidateCount: 1, signatureMatches: 2, freelistHead: 0,
    score: { score: 9 },
  }));
  const output = serializeTables({ located, board: { selected: { teamRow: 2, firstFreeSlot: 3 } } });
  assert.equal(Object.keys(output.tableSummaries).length, 6);
  assert.equal(output.tableSummaries['4168'].candidateCount, 1);
  assert.equal(output.tables['5847'].rereadPassed, true);
});

test('run refuses missing common gates before process discovery', async () => {
  await assert.rejects(run({ command: 'validate', save: 'S' }), /game-dir/);
  await assert.rejects(run({ command: 'validate', gameDir: 'G' }), /save/);
});

test('CLI source is import-safe and contains no custom evidence root authority', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'board-verification',
    'reanchor-build.cjs'), 'utf8');
  assert.match(source, /require\.main === module/);
  assert.doesNotMatch(source, /--output-root/);
  assert.match(source, /allowUnsupportedBuild: true/);
  assert.match(source, /supportedBuild !== false/);
  assert.match(source, /writesAllowed !== false/);
});
