'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  REQUIRED_GATE_NAMES,
  setEvidenceWriteTestHook,
  evidenceDirectory,
  writeEvidence,
  readEvidence,
  parsePeSections,
  classifyModuleAddress,
  rankRoutineCandidates,
  validateObjectShapes,
  deriveVtableRvas,
  buildCandidateArtifact,
} = require('../scripts/board-verification/reanchor-evidence.cjs');

const MODULE_BASE = 0x140000000n;
const SHA = crypto.createHash('sha256').update('board-reanchor-evidence-test').digest('hex').toUpperCase();
const IDENTITY = Object.freeze({ pid: 77, sessionId: 'host-start-1', executableSha256: SHA });
const EVIDENCE_ROOT = path.resolve('.frtk', 'board-reanchor');

function shaFor(label) {
  return crypto.createHash('sha256').update(`board-reanchor-evidence-test:${label}`).digest('hex').toUpperCase();
}

function cleanupSha(t, sha) {
  t.after(() => fs.rmSync(path.join(EVIDENCE_ROOT, sha), { recursive: true, force: true }));
}

function evidenceEnvelope(sha = SHA, overrides = {}) {
  return {
    schemaVersion: 1,
    build: { executableSha256: sha },
    session: { pid: 77, sessionId: 'host-start-1' },
    payload: { captureId: 'add-1' },
    ...overrides,
  };
}

function peFixture() {
  const image = Buffer.alloc(0x600);
  image.write('MZ', 0, 'ascii');
  image.writeUInt32LE(0x80, 0x3C);
  image.write('PE\0\0', 0x80, 'binary');
  image.writeUInt16LE(0x8664, 0x84);
  image.writeUInt16LE(2, 0x86);
  image.writeUInt16LE(0xF0, 0x94);
  image.writeUInt16LE(0x20B, 0x98);
  image.writeUInt32LE(0x1000, 0x98 + 32);
  image.writeUInt32LE(0x200, 0x98 + 36);
  image.writeUInt32LE(0x3000, 0x98 + 56);
  image.writeUInt32LE(0x200, 0x98 + 60);

  const sectionTable = 0x98 + 0xF0;
  image.write('.text\0\0\0', sectionTable, 'ascii');
  image.writeUInt32LE(0x600, sectionTable + 8);
  image.writeUInt32LE(0x1000, sectionTable + 12);
  image.writeUInt32LE(0x200, sectionTable + 16);
  image.writeUInt32LE(0x200, sectionTable + 20);
  image.writeUInt32LE(0x60000020, sectionTable + 36);

  const rdata = sectionTable + 40;
  image.write('.rdata\0\0', rdata, 'ascii');
  image.writeUInt32LE(0x400, rdata + 8);
  image.writeUInt32LE(0x2000, rdata + 12);
  image.writeUInt32LE(0x200, rdata + 16);
  image.writeUInt32LE(0x400, rdata + 20);
  image.writeUInt32LE(0x40000040, rdata + 36);
  return image;
}

function canonical(value) {
  return `0x${BigInt(value).toString(16).toUpperCase()}`;
}

function capture(captureId, addresses, identity = IDENTITY) {
  return {
    captureId,
    schemaVersion: 1,
    build: { executableSha256: identity.executableSha256 },
    session: { pid: identity.pid, sessionId: identity.sessionId },
    hits: [{ stackReturnAddresses: addresses.map(canonical) }],
  };
}

function objectShape(heapOffset = 0n) {
  const controllerAddress = 0x200000000n + heapOffset;
  const teamCellAddress = 0x200001000n + heapOffset;
  const recruitCellAddress = 0x200001100n + heapOffset;
  const teamAddress = 0x200002000n + heapOffset;
  const recruitAddress = 0x200003000n + heapOffset;
  const wrapperVtableAddress = MODULE_BASE + 0x2100n;
  const controllerVtableAddress = MODULE_BASE + 0x2200n;
  const executableEntries = [MODULE_BASE + 0x1100n, MODULE_BASE + 0x1200n];
  return {
    arguments: {
      rcx: canonical(controllerAddress),
      rdx: canonical(teamCellAddress),
      r8: canonical(recruitCellAddress),
    },
    pointerCells: {
      team: { address: canonical(teamCellAddress), value: canonical(teamAddress), readable: true },
      recruit: { address: canonical(recruitCellAddress), value: canonical(recruitAddress), readable: true },
    },
    controller: {
      address: canonical(controllerAddress),
      readable: true,
      descriptorTableId: 5003,
      membershipRow: 11,
      vtableAddress: canonical(controllerVtableAddress),
      vtableEntries: executableEntries.map(canonical),
      boardStore: { offset: 0x138, readable: true, membershipRow: 11 },
    },
    team: {
      address: canonical(teamAddress),
      readable: true,
      descriptorTableId: 6334,
      row: 22,
      field10Readable: true,
      field18Readable: true,
      vtableAddress: canonical(wrapperVtableAddress),
      vtableEntries: executableEntries.map(canonical),
    },
    recruit: {
      address: canonical(recruitAddress),
      readable: true,
      descriptorTableId: 4269,
      row: 33,
      field10Readable: true,
      field18Readable: true,
      vtableAddress: canonical(wrapperVtableAddress),
      vtableEntries: executableEntries.map(canonical),
    },
    expected: { membershipRow: 11, teamRow: 22, recruitRow: 33, recruitTableId: 4269 },
  };
}

function proofCapture(captureId, heapOffset, pe, entryAddress) {
  return {
    captureId,
    build: { executableSize: pe.fileSize, executableSha256: pe.executableSha256 },
    session: { pid: 77, sessionId: 'host-start-1' },
    ...(entryAddress === undefined ? {} : { entryAddress: canonical(entryAddress) }),
    ...objectShape(heapOffset),
  };
}

function tableSummaries() {
  return Object.fromEntries(['4168', '4176', '4190', '4251', '5790', '5847'].map((id) => [id, {
    passed: true,
    candidateCount: 1,
    score: 9,
    rereadPassed: true,
  }]));
}

function candidateInput() {
  const pe = parsePeSections(peFixture());
  return {
    build: { label: 'Patch 1', executableSize: pe.fileSize, executableSha256: pe.executableSha256 },
    session: { pid: 77, sessionId: 'host-start-1', moduleBase: canonical(MODULE_BASE), capturedAt: '2026-07-16T12:00:00.000Z' },
    tables: tableSummaries(),
    captures: {
      add: { writeCount: 2, executeCount: 1, consistent: true },
      remove: { writeCount: 2, executeCount: 1, consistent: true },
    },
    proposedBoard: {
      genericRecordWrapperVtableRva: '0x2100',
      recruitingControllerVtableRva: '0x2200',
      fullAddRva: '0x1100',
      fullRemoveRva: '0x1200',
      recruitTableId: '0x10AD',
      teamTableId: '0x18BE',
      controllerDescriptorTableId: '0x138B',
      userTargetTableId: '0x1048',
      activePitchTableId: '0x169E',
      membershipTableId: '0x16D7',
    },
    proof: {
      pe,
      fullAddCapture: proofCapture('add-execute', 0n, pe, MODULE_BASE + 0x1100n),
      fullRemoveCapture: proofCapture('remove-execute', 0x100000n, pe, MODULE_BASE + 0x1200n),
      transitionObjectCapture: proofCapture('transition', 0x200000n, pe),
    },
  };
}

test('storage root is fixed to the ignored uppercase-SHA directory', () => {
  assert.equal(evidenceDirectory(SHA), path.join(EVIDENCE_ROOT, SHA));
  assert.throws(() => evidenceDirectory(SHA.toLowerCase()), /uppercase SHA-256/i);
  assert.throws(() => evidenceDirectory(SHA, 'elsewhere'), /argument|root/i);
});

test('writeEvidence atomically writes and readEvidence requires exact identity', (t) => {
  const sha = shaFor('atomic');
  cleanupSha(t, sha);
  const envelope = evidenceEnvelope(sha);
  const identity = { ...IDENTITY, executableSha256: sha };
  const target = writeEvidence('captures/add-1.json', envelope);
  assert.equal(target, path.join(evidenceDirectory(sha), 'captures', 'add-1.json'));
  assert.deepEqual(readEvidence('captures/add-1.json', identity), envelope);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['add-1.json']);

  assert.throws(() => readEvidence('captures/add-1.json'), /expected identity/i);
  assert.throws(() => readEvidence('captures/add-1.json', { ...identity, pid: 78 }), /different process/i);
  assert.throws(() => readEvidence('captures/add-1.json', { ...identity, sessionId: 'other' }), /different host session/i);
  assert.throws(() => readEvidence('captures/add-1.json', { ...identity, executableSha256: SHA }), /does not exist|different executable/i);
  assert.throws(() => readEvidence('captures/add-1.json', { ...identity, executableSha256: sha.toLowerCase() }), /uppercase SHA-256/i);
});

test('storage rejects traversal, absolute paths, junction escapes, and malformed envelopes', (t) => {
  const sha = shaFor('containment');
  cleanupSha(t, sha);
  const envelope = evidenceEnvelope(sha);
  assert.throws(() => writeEvidence('../escape.json', envelope), /relative evidence path|escape/i);
  assert.throws(() => writeEvidence(path.resolve('escape.json'), envelope), /relative evidence path/i);
  for (const invalid of [
    undefined,
    [],
    { ...envelope, schemaVersion: 0 },
    { ...envelope, build: { executableSha256: sha.toLowerCase() } },
    { ...envelope, session: { pid: 0, sessionId: '' } },
    { ...envelope, payload: { invalid: undefined } },
  ]) {
    assert.throws(() => writeEvidence('invalid.json', invalid), /evidence|schema|uppercase SHA-256|PID|session/i);
  }

  const shaDirectory = evidenceDirectory(sha);
  const outside = path.join(EVIDENCE_ROOT, `${sha}-OUTSIDE`);
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(shaDirectory, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const junction = path.join(shaDirectory, 'junction');
  try {
    fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.code}`);
    return;
  }
  assert.throws(() => writeEvidence('junction/escaped.json', envelope), /junction|real path|containment/i);
});

test('readEvidence rejects invalid JSON and missing actual identity fields', (t) => {
  const sha = shaFor('invalid-read');
  cleanupSha(t, sha);
  const directory = evidenceDirectory(sha);
  fs.mkdirSync(directory, { recursive: true });
  const identity = { ...IDENTITY, executableSha256: sha };
  fs.writeFileSync(path.join(directory, 'invalid.json'), '{not-json', 'utf8');
  fs.writeFileSync(path.join(directory, 'missing.json'), JSON.stringify({ schemaVersion: 1 }), 'utf8');
  assert.throws(() => readEvidence('invalid.json', identity), /JSON|Unexpected/i);
  assert.throws(() => readEvidence('missing.json', identity), /PID|session|SHA-256|identity/i);
});

test('rename failure removes only the owned temp and preserves the existing destination', (t) => {
  const sha = shaFor('rename-failure');
  cleanupSha(t, sha);
  const envelope = evidenceEnvelope(sha);
  const destination = writeEvidence('blocked.json', envelope);
  const originalContents = fs.readFileSync(destination, 'utf8');
  const originalRename = fs.renameSync;
  t.after(() => { fs.renameSync = originalRename; });
  fs.renameSync = () => { throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' }); };
  assert.throws(() => writeEvidence('blocked.json', {
    ...envelope,
    payload: { captureId: 'replacement' },
  }), /simulated rename failure/i);
  assert.equal(fs.readFileSync(destination, 'utf8'), originalContents);
  assert.deepEqual(fs.readdirSync(evidenceDirectory(sha)), ['blocked.json']);
});

test('parent swap after exclusive temp open writes zero raw bytes outside containment', (t) => {
  const sha = shaFor('parent-swap');
  cleanupSha(t, sha);
  const envelope = evidenceEnvelope(sha);
  const shaDirectory = evidenceDirectory(sha);
  const parent = path.join(shaDirectory, 'captures');
  const movedParent = path.join(shaDirectory, 'captures-moved');
  const outside = path.join(EVIDENCE_ROOT, `${sha}-OUTSIDE`);
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => {
    try {
      if (typeof setEvidenceWriteTestHook === 'function') setEvidenceWriteTestHook(null);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  setEvidenceWriteTestHook(({ temporaryPath }) => {
    assert.equal(path.dirname(temporaryPath), parent);
    fs.renameSync(parent, movedParent);
    fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
  });

  assert.throws(() => writeEvidence('captures/swap.json', envelope), /junction|real path|containment|EPERM/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(fs.existsSync(movedParent) ? movedParent : parent), []);
});

test('parsePeSections classifies valid aligned sections and rejects malformed layouts', () => {
  const valid = peFixture();
  const pe = parsePeSections(valid);
  assert.equal(pe.sizeOfImage, 0x3000);
  assert.equal(pe.fileSize, valid.length);
  assert.equal(pe.executableSha256, crypto.createHash('sha256').update(valid).digest('hex').toUpperCase());
  assert.equal(Object.isFrozen(pe), true);
  assert.deepEqual(pe.sections.map(({ name, readable, executable }) => ({ name, readable, executable })), [
    { name: '.text', readable: true, executable: true },
    { name: '.rdata', readable: true, executable: false },
  ]);

  const truncated = Buffer.from(valid.subarray(0, 0x300));
  const rawOverlap = Buffer.from(valid);
  rawOverlap.writeUInt32LE(0x200, 0x98 + 0xF0 + 40 + 20);
  const virtualOverlap = Buffer.from(valid);
  virtualOverlap.writeUInt32LE(0x1000, 0x98 + 0xF0 + 40 + 12);
  const misaligned = Buffer.from(valid);
  misaligned.writeUInt32LE(0x1800, 0x98 + 0xF0 + 40 + 12);
  const badAlignment = Buffer.from(valid);
  badAlignment.writeUInt32LE(0x300, 0x98 + 36);
  const headersLargerThanImage = Buffer.alloc(0x4000);
  valid.copy(headersLargerThanImage);
  headersLargerThanImage.writeUInt32LE(0x4000, 0x98 + 60);
  const headersOverlapSection = Buffer.alloc(0x1400);
  valid.copy(headersOverlapSection);
  headersOverlapSection.writeUInt32LE(0x1200, 0x98 + 60);
  for (const [image, message] of [
    [truncated, /raw range|truncated/i],
    [rawOverlap, /raw.*overlap/i],
    [virtualOverlap, /virtual.*overlap/i],
    [misaligned, /section alignment/i],
    [badAlignment, /file alignment/i],
    [headersLargerThanImage, /headers.*image/i],
    [headersOverlapSection, /header image range.*overlap/i],
  ]) assert.throws(() => parsePeSections(image), message);
});

test('classifyModuleAddress emits RVAs only inside the image', () => {
  const pe = parsePeSections(peFixture());
  const text = classifyModuleAddress(MODULE_BASE + 0x1100n, MODULE_BASE, pe);
  assert.deepEqual(
    { insideImage: text.insideImage, rva: text.rva, section: text.section.name, executable: text.executable },
    { insideImage: true, rva: '0x1100', section: '.text', executable: true },
  );
  assert.equal(classifyModuleAddress(MODULE_BASE - 1n, MODULE_BASE, pe).rva, null);
  assert.equal(classifyModuleAddress(MODULE_BASE + 0x3000n, MODULE_BASE, pe).rva, null);
});

test('rankRoutineCandidates requires exactly two distinct same-identity captures and breaks ties by address', () => {
  const pe = parsePeSections(peFixture());
  const lower = MODULE_BASE + 0x1100n;
  const higher = MODULE_BASE + 0x1200n;
  const first = capture('add-1', [higher, lower, MODULE_BASE + 0x2100n]);
  const second = capture('add-2', [lower, higher, MODULE_BASE + 0x2100n]);
  assert.deepEqual(rankRoutineCandidates([first, second], { moduleBase: MODULE_BASE, pe }).map(({ rva }) => rva), [
    '0x1100',
    '0x1200',
  ]);
  assert.throws(() => rankRoutineCandidates([first], { moduleBase: MODULE_BASE, pe }), /exactly two/i);
  assert.throws(() => rankRoutineCandidates([first, first], { moduleBase: MODULE_BASE, pe }), /distinct capture/i);
  assert.throws(() => rankRoutineCandidates([first, { ...second, session: { ...second.session, pid: 78 } }], { moduleBase: MODULE_BASE, pe }), /same.*identity|different process/i);
  assert.throws(() => rankRoutineCandidates([first, { ...second, session: { ...second.session, sessionId: 'other' } }], { moduleBase: MODULE_BASE, pe }), /same.*identity|host session/i);
  assert.throws(() => rankRoutineCandidates([first, { ...second, build: { executableSha256: 'A'.repeat(64) } }], { moduleBase: MODULE_BASE, pe }), /same.*identity|executable/i);
});

test('object validation requires integer expected and captured membership, Team, and Recruit rows', () => {
  const pe = parsePeSections(peFixture());
  assert.equal(validateObjectShapes(objectShape(), { moduleBase: MODULE_BASE, pe }).passed, true);
  for (const mutate of [
    (shape) => { delete shape.expected.membershipRow; },
    (shape) => { shape.expected.teamRow = 1.5; },
    (shape) => { shape.expected.recruitRow = '33'; },
    (shape) => { delete shape.controller.membershipRow; },
    (shape) => { shape.controller.boardStore.membershipRow = -1; },
    (shape) => { delete shape.team.row; },
    (shape) => { delete shape.recruit.row; },
  ]) {
    const shape = objectShape();
    mutate(shape);
    assert.equal(validateObjectShapes(shape, { moduleBase: MODULE_BASE, pe }).passed, false);
  }
});

test('object validation rejects zero and mutually contradictory object or pointer addresses', () => {
  const pe = parsePeSections(peFixture());
  for (const mutate of [
    (shape) => { shape.arguments.rcx = '0x0'; shape.controller.address = '0x0'; },
    (shape) => { shape.arguments.rdx = '0x0'; shape.pointerCells.team.address = '0x0'; },
    (shape) => {
      shape.team.address = shape.recruit.address;
      shape.pointerCells.team.value = shape.recruit.address;
    },
    (shape) => {
      shape.pointerCells.team.address = shape.pointerCells.recruit.address;
      shape.arguments.rdx = shape.arguments.r8;
    },
    (shape) => { shape.controller.vtableAddress = shape.team.vtableAddress; },
  ]) {
    const shape = objectShape();
    mutate(shape);
    assert.equal(validateObjectShapes(shape, { moduleBase: MODULE_BASE, pe }).passed, false);
  }
});

test('wrong arguments and PE-invalid vtables are decisive object-shape rejections', () => {
  const pe = parsePeSections(peFixture());
  const lowLevel = objectShape();
  lowLevel.arguments.rcx = lowLevel.team.address;
  assert.match(validateObjectShapes(lowLevel, { moduleBase: MODULE_BASE, pe }).detail, /RCX/i);
  assert.throws(() => deriveVtableRvas([lowLevel, objectShape(0x100000n)], { moduleBase: MODULE_BASE, pe }), /object shape/i);

  const invalidVtable = objectShape();
  invalidVtable.team.vtableEntries[0] = canonical(MODULE_BASE + 0x2100n);
  assert.equal(validateObjectShapes(invalidVtable, { moduleBase: MODULE_BASE, pe }).passed, false);
});

test('buildCandidateArtifact requires exact schema, exact gates, and independently derived proofs', () => {
  assert.deepEqual(REQUIRED_GATE_NAMES, [
    'buildIdentity',
    'sessionIdentity',
    'tableAnchors',
    'addCaptureConsistency',
    'removeCaptureConsistency',
    'routinePeSections',
    'argumentShapes',
    'vtablePeSections',
    'vtableTransitionStability',
  ]);
  const input = candidateInput();
  const candidate = buildCandidateArtifact(input);
  assert.equal(candidate.schemaVersion, 1);
  assert.deepEqual(Object.keys(candidate.tables), ['4168', '4176', '4190', '4251', '5790', '5847']);
  assert.deepEqual(candidate.proposedBoard, input.proposedBoard);
  assert.deepEqual(candidate.gates.map(({ name }) => name), REQUIRED_GATE_NAMES);
  assert.equal(candidate.gates.every((gate) => typeof gate.passed === 'boolean'), true);
  assert.equal(candidate.gates.every((gate) => gate.detail.length > 0 && !gate.detail.includes('caller')), true);
  assert.equal(candidate.passed, true);

  const nonExecutableRoutine = candidateInput();
  nonExecutableRoutine.proof.fullAddCapture.entryAddress = canonical(MODULE_BASE + 0x2100n);
  assert.equal(buildCandidateArtifact(nonExecutableRoutine).passed, false);
  const wrongArguments = candidateInput();
  wrongArguments.proof.fullAddCapture.arguments.rcx = wrongArguments.proof.fullAddCapture.team.address;
  assert.equal(buildCandidateArtifact(wrongArguments).passed, false);
  const wrongEntry = candidateInput();
  wrongEntry.proof.fullAddCapture.entryAddress = canonical(MODULE_BASE + 0x1200n);
  const wrongEntryCandidate = buildCandidateArtifact(wrongEntry);
  assert.equal(wrongEntryCandidate.passed, false);
  assert.equal(wrongEntryCandidate.gates.find(({ name }) => name === 'routinePeSections').passed, false);
  const ambiguousTable = candidateInput();
  ambiguousTable.tables['4168'].candidateCount = 2;
  assert.equal(buildCandidateArtifact(ambiguousTable).passed, false);
});

test('buildCandidateArtifact binds authenticated PE and every proof capture to build and session identity', () => {
  const mutateAndReject = (mutate, message) => {
    const input = candidateInput();
    mutate(input);
    assert.throws(() => buildCandidateArtifact(input), message);
  };
  mutateAndReject((input) => { input.build.executableSize += 1; }, /authenticated PE.*size|build.*PE/i);
  mutateAndReject((input) => { input.build.executableSha256 = 'A'.repeat(64); }, /authenticated PE.*SHA|build.*PE/i);
  mutateAndReject((input) => { input.proof.fullAddCapture.session.pid = 78; }, /proof capture.*PID|session identity/i);
  mutateAndReject((input) => { input.proof.fullRemoveCapture.session.sessionId = 'other'; }, /proof capture.*session|session identity/i);
  mutateAndReject((input) => { input.proof.transitionObjectCapture.build.executableSha256 = 'A'.repeat(64); }, /proof capture.*SHA|build identity/i);
  mutateAndReject((input) => { input.proof.fullAddCapture.build.executableSize += 1; }, /proof capture.*size|build identity/i);
});

test('buildCandidateArtifact rejects invalid metadata, zero RVAs, incomplete summaries, proofs, and gate sets', () => {
  const mutateAndReject = (mutate, message) => {
    const input = candidateInput();
    mutate(input);
    assert.throws(() => buildCandidateArtifact(input), message);
  };
  mutateAndReject((input) => { input.build.label = ''; }, /build label/i);
  mutateAndReject((input) => { input.build.executableSize = 0; }, /executable size/i);
  mutateAndReject((input) => { input.build.executableSha256 = SHA.toLowerCase(); }, /uppercase SHA-256/i);
  mutateAndReject((input) => { input.session.pid = 0; }, /session PID/i);
  mutateAndReject((input) => { input.session.sessionId = ''; }, /session ID/i);
  mutateAndReject((input) => { input.session.moduleBase = '0x0'; }, /module base/i);
  mutateAndReject((input) => { input.proposedBoard.fullAddRva = '0x0'; }, /nonzero.*RVA/i);
  mutateAndReject((input) => { delete input.tables['5847']; }, /exactly six table/i);
  mutateAndReject((input) => { input.tables.extra = input.tables['4168']; }, /exactly six table/i);
  mutateAndReject((input) => { input.captures.add.writeCount = -1; }, /capture summary/i);
  mutateAndReject((input) => { delete input.proof.pe; }, /proof/i);
  mutateAndReject((input) => { delete input.proof.fullAddCapture; }, /proof/i);
  mutateAndReject((input) => { input.unreviewedEvidence = true; }, /candidate input.*exactly/i);
  mutateAndReject((input) => {
    input.gates = REQUIRED_GATE_NAMES.map((name) => ({ name, passed: true, detail: 'caller says pass' }));
  }, /candidate input.*exactly/i);
});
