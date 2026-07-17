'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { REQUIRED_GATE_NAMES } = require('../scripts/board-verification/reanchor-evidence.cjs');
const { certifyManifest, demoteManifest, parseCli } = require('../scripts/promote-game-build.cjs');

const OLD_SHA = '9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8';
const PATCH_SHA = 'A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD';

function manifest() {
  return { version: 1, builds: [
    { label: 'july-11-2026', size: 247845776, sha256: OLD_SHA, support: 'certified', board: {
      genericRecordWrapperVtableRva: '0xB093F68', recruitingControllerVtableRva: '0xB0B5BA8',
      fullAddRva: '0x8109060', fullRemoveRva: '0x8166090',
      recruitTableId: '0x10AD', teamTableId: '0x18BE',
      controllerDescriptorTableId: '0x138B', userTargetTableId: '0x1048',
      activePitchTableId: '0x169E', membershipTableId: '0x16D7',
    } },
    { label: 'patch-1-2026-07-16', size: 249801616, sha256: PATCH_SHA,
      support: 'diagnostic', board: null },
  ] };
}

function candidate() {
  return {
    schemaVersion: 1,
    build: { label: 'patch-1-2026-07-16', executableSize: 249801616, executableSha256: PATCH_SHA },
    session: { pid: 77, sessionId: 'session', moduleBase: '0x140000000', capturedAt: '2026-07-16T12:00:00.000Z' },
    tables: {}, captures: {},
    proposedBoard: { genericRecordWrapperVtableRva: '0xB193F68',
      recruitingControllerVtableRva: '0xB1B5BA8', fullAddRva: '0x8209060', fullRemoveRva: '0x8266090',
      recruitTableId: '0x10B1', teamTableId: '0x18B1',
      controllerDescriptorTableId: '0x138D', userTargetTableId: '0x104B',
      activePitchTableId: '0x1691', membershipTableId: '0x16CA' },
    gates: REQUIRED_GATE_NAMES.map((name) => ({ name, passed: true, detail: `${name} passed` })),
    passed: true,
  };
}

test('certification changes only the exact diagnostic build and layout', () => {
  const input = manifest();
  const output = certifyManifest(input, candidate());
  assert.deepEqual(input, manifest());
  assert.equal(output.builds[0].support, 'certified');
  assert.equal(output.builds[1].support, 'certified');
  assert.deepEqual(output.builds[1].board, candidate().proposedBoard);
});

test('certification rejects failed, wrong-identity, zero-RVA, and gate-set candidates', () => {
  const cases = [
    (value) => { value.passed = false; },
    (value) => { value.build.executableSha256 = 'A'.repeat(64); },
    (value) => { value.proposedBoard.fullAddRva = '0x0'; },
    (value) => { value.gates.pop(); },
    (value) => { value.gates[0].name = 'anything'; },
    (value) => { value.gates[0].passed = false; },
  ];
  for (const mutate of cases) {
    const value = candidate(); mutate(value);
    assert.throws(() => certifyManifest(manifest(), value), /candidate|gate|RVA|registered|pass/i);
  }
});

test('demotion removes layout and preserves other builds', () => {
  const certified = certifyManifest(manifest(), candidate());
  const output = demoteManifest(certified, PATCH_SHA);
  assert.equal(output.builds[1].support, 'diagnostic');
  assert.equal(output.builds[1].board, null);
  assert.deepEqual(output.builds[0], manifest().builds[0]);
  assert.throws(() => demoteManifest(manifest(), 'A'.repeat(64)), /exactly one/);
});

test('promotion CLI accepts only explicit certify or diagnostic modes', () => {
  assert.deepEqual(parseCli(['--candidate', 'candidate.json', '--certify']), {
    mode: 'certify', candidatePath: 'candidate.json',
  });
  assert.deepEqual(parseCli(['--sha', PATCH_SHA, '--diagnostic']), {
    mode: 'diagnostic', sha256: PATCH_SHA,
  });
  assert.throws(() => parseCli(['--candidate', 'candidate.json']), /Usage/);
});
