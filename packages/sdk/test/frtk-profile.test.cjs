'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalStringify } = require('../src/validation.cjs');
const { compileFrtkArtifacts } = require('../src/frtk-profile.cjs');
const { TABLES, makeSyntheticInputs } = require('./fixtures/frtk/synthetic-snapshot.cjs');

function clone(value) {
  return structuredClone(value);
}

function boundedInputs(tableCount, { rows = 3, relationships = 0, fields = 1 } = {}) {
  const snapshotTables = [];
  const layoutTables = [];
  for (let index = 0; index < tableCount; index += 1) {
    const identity = {
      logicalName: `Table${index}`, tableId: index + 1, uniqueId: index + 1000,
      capacity: 128, recordSize: 8,
    };
    snapshotTables.push({
      ...identity,
      rows: Array.from({ length: rows }, (_, rowIndex) => ({
        rowIndex,
        recordHex: Buffer.from([index & 0xFF, rowIndex, 2, 3, 4, 5, 6, 7])
          .toString('hex').toUpperCase(),
        maskHex: 'FFFFFFFFFFFFFFFF',
      })),
      relationships: Array.from({ length: relationships }, (_, relationship) => ({
        sourceRow: relationship, fieldName: `Field${relationship}`,
        targetTableId: index + 1, targetRow: 0,
      })),
    });
    layoutTables.push({
      ...identity, authorityStatus: 'discovery_only',
      fields: Array.from({ length: fields }, (_, field) => ({
        name: `Field${field}`, encoding: 'unsigned', byteOffset: 0, storageBytes: 1,
        bitOffset: 0, bitWidth: 8, minimum: 0, maximum: 255, referenceTableId: null,
      })),
    });
  }
  return {
    snapshot: { schemaIdentity: 'bounded-schema', buildIdentity: 'bounded-build', tables: snapshotTables },
    layout: { schemaIdentity: 'bounded-schema', buildIdentity: 'bounded-build', tables: layoutTables },
  };
}

test('compiler emits deterministic version-1 profile and field layout artifacts', () => {
  const first = compileFrtkArtifacts(makeSyntheticInputs());
  const second = compileFrtkArtifacts(makeSyntheticInputs({ reverse: true }));
  assert.equal(canonicalStringify(first), canonicalStringify(second));
  assert.equal(first.profile.profileId, second.profile.profileId);
  assert.match(first.profile.profileId, /^[0-9A-F]{64}$/);
  assert.equal(first.profile.formatVersion, 1);
  assert.equal(first.layout.formatVersion, 1);
  assert.deepEqual(first.profile.tables.map((table) => table.tableId),
    TABLES.map((table) => table[1]).sort((a, b) => a - b));
  assert.deepEqual(first.profile.tables[0].rows.map((row) => row.rowIndex), [3, 19, 37]);
  assert.equal(first.profile.tables[0].rows[0].recordHex, undefined);
  assert.deepEqual(Object.keys(first.profile), [
    'formatVersion', 'profileId', 'schemaIdentity', 'buildIdentity', 'tables',
  ]);
});

test('profile identity binds the complete canonical field layout', () => {
  const first = compileFrtkArtifacts(makeSyntheticInputs());
  const changed = makeSyntheticInputs();
  changed.layout.tables[0].fields[0].maximum -= 1;
  const second = compileFrtkArtifacts(changed);
  assert.notEqual(first.profile.profileId, second.profile.profileId);
});

test('compiler accepts a 32-bit field spanning a five-byte MSB-first window', () => {
  const inputs = makeSyntheticInputs();
  const table = inputs.layout.tables[0];
  table.fields = [{
    name: 'FiveByteWindow', encoding: 'unsigned', byteOffset: 0, storageBytes: 5,
    bitOffset: 4, bitWidth: 32, minimum: 0, maximum: 0xFFFFFFFF,
    referenceTableId: null,
  }];
  const artifacts = compileFrtkArtifacts(inputs);
  assert.equal(artifacts.layout.tables[0].fields[0].storageBytes, 5);
});

test('version-1 compiler rejects attempts to promote file artifact authority', () => {
  for (const authorityStatus of ['commit_adapter_required', 'direct_verified']) {
    const inputs = makeSyntheticInputs();
    inputs.layout.tables[0].authorityStatus = authorityStatus;
    assert.throws(() => compileFrtkArtifacts(inputs), /discovery.only/i, authorityStatus);
  }
});

test('compiler enforces table count at 256 and rejects 257', () => {
  assert.equal(compileFrtkArtifacts(boundedInputs(256)).profile.tables.length, 256);
  assert.throws(() => compileFrtkArtifacts(boundedInputs(257)), /256 tables/i);
});

test('compiler enforces fingerprint per-table and total bounds', () => {
  assert.equal(compileFrtkArtifacts(boundedInputs(128, { rows: 8 })).profile.tables.length, 128);
  assert.throws(() => compileFrtkArtifacts(boundedInputs(1, { rows: 9 })), /8 fingerprints.*table/i);
  const total = boundedInputs(129, { rows: 8 });
  total.snapshot.tables[127].rows.length = 6;
  total.snapshot.tables[128].rows.length = 3;
  assert.throws(() => compileFrtkArtifacts(total), /1024 fingerprints.*total/i);
});

test('compiler enforces relationship per-table and total bounds', () => {
  assert.equal(compileFrtkArtifacts(boundedInputs(64, { relationships: 64, fields: 64 }))
    .profile.tables.length, 64);
  assert.throws(() => compileFrtkArtifacts(boundedInputs(1, { relationships: 65, fields: 65 })),
    /64 relationships.*table/i);
  const total = boundedInputs(65, { relationships: 64, fields: 64 });
  total.snapshot.tables[64].relationships.length = 1;
  assert.throws(() => compileFrtkArtifacts(total), /4096 relationships.*total/i);
});

test('compiler enforces field per-table and total bounds', () => {
  assert.equal(compileFrtkArtifacts(boundedInputs(64, { fields: 512 })).layout.tables.length, 64);
  assert.throws(() => compileFrtkArtifacts(boundedInputs(1, { fields: 513 })), /512 fields.*table/i);
  const total = boundedInputs(65, { fields: 512 });
  total.layout.tables[64].fields.length = 1;
  assert.throws(() => compileFrtkArtifacts(total), /32768 fields.*total/i);
});

test('compiler measures logical table and field names as 1..128 UTF-8 bytes', () => {
  const boundary = boundedInputs(1);
  boundary.snapshot.tables[0].logicalName = 'é'.repeat(64);
  boundary.layout.tables[0].logicalName = 'é'.repeat(64);
  boundary.layout.tables[0].fields[0].name = 'é'.repeat(64);
  boundary.snapshot.tables[0].relationships = [{
    sourceRow: 0, fieldName: 'é'.repeat(64), targetTableId: 1, targetRow: 0,
  }];
  assert.equal(compileFrtkArtifacts(boundary).profile.tables.length, 1);

  for (const mutate of [
    (inputs) => { inputs.snapshot.tables[0].logicalName += 'a'; inputs.layout.tables[0].logicalName += 'a'; },
    (inputs) => { inputs.layout.tables[0].fields[0].name += 'a'; },
    (inputs) => { inputs.snapshot.tables[0].relationships[0].fieldName += 'a'; },
  ]) {
    const oversized = clone(boundary);
    mutate(oversized);
    assert.throws(() => compileFrtkArtifacts(oversized), /128 UTF-8 bytes/i);
  }
});

test('compiler rejects unpaired UTF-16 surrogates that are not valid UTF-8 names', () => {
  const inputs = boundedInputs(1);
  inputs.snapshot.tables[0].logicalName = '\uD800';
  inputs.layout.tables[0].logicalName = '\uD800';
  assert.throws(() => compileFrtkArtifacts(inputs), /valid UTF-8/i);
});

test('compiler measures schema and build identities as valid 1..128 UTF-8 bytes', () => {
  const boundary = boundedInputs(1);
  for (const key of ['schemaIdentity', 'buildIdentity']) {
    boundary.snapshot[key] = 'é'.repeat(64);
    boundary.layout[key] = 'é'.repeat(64);
  }
  assert.equal(compileFrtkArtifacts(boundary).profile.tables.length, 1);
  for (const key of ['schemaIdentity', 'buildIdentity']) {
    const oversized = clone(boundary);
    oversized.snapshot[key] += 'a';
    oversized.layout[key] += 'a';
    assert.throws(() => compileFrtkArtifacts(oversized), /128 UTF-8 bytes/i, key);
    const surrogate = clone(boundary);
    surrogate.snapshot[key] = '\uD800';
    surrogate.layout[key] = '\uD800';
    assert.throws(() => compileFrtkArtifacts(surrogate), /valid UTF-8/i, key);
  }
});

test('compiler rejects insufficient or duplicate row evidence', () => {
  const fewer = makeSyntheticInputs();
  fewer.snapshot.tables[0].rows.pop();
  assert.throws(() => compileFrtkArtifacts(fewer), /three distinct occupied rows/i);

  const duplicateIndex = makeSyntheticInputs();
  duplicateIndex.snapshot.tables[0].rows[2].rowIndex = duplicateIndex.snapshot.tables[0].rows[0].rowIndex;
  assert.throws(() => compileFrtkArtifacts(duplicateIndex), /duplicate row/i);

  const duplicatePattern = makeSyntheticInputs();
  duplicatePattern.snapshot.tables[0].rows[2].recordHex =
    duplicatePattern.snapshot.tables[0].rows[0].recordHex;
  assert.throws(() => compileFrtkArtifacts(duplicatePattern), /three distinct occupied rows/i);
});

test('compiler rejects malformed record and mask evidence', () => {
  const wrongLength = makeSyntheticInputs();
  wrongLength.snapshot.tables[0].rows[0].recordHex = 'AA';
  assert.throws(() => compileFrtkArtifacts(wrongLength), /record length/i);

  const weakMask = makeSyntheticInputs();
  for (const row of weakMask.snapshot.tables[0].rows) row.maskHex = '01' + '00'.repeat(35);
  assert.throws(() => compileFrtkArtifacts(weakMask), /64 selected bits/i);
});

test('compiler rejects ambiguous or duplicate table identities', () => {
  const duplicate = makeSyntheticInputs();
  duplicate.snapshot.tables[1].tableId = duplicate.snapshot.tables[0].tableId;
  assert.throws(() => compileFrtkArtifacts(duplicate), /duplicate table ID/i);

  const team = makeSyntheticInputs();
  team.snapshot.tables[0] = {
    logicalName: 'Team', uniqueId: 12, capacity: 10, recordSize: 8,
    rows: clone(team.snapshot.tables[0].rows).map((row) => ({
      ...row, recordHex: row.recordHex.slice(0, 16), maskHex: row.maskHex.slice(0, 16),
    })), relationships: [],
  };
  assert.throws(() => compileFrtkArtifacts(team), /Team.*table ID/i);
});

test('compiler rejects duplicate snapshot unique IDs', () => {
  const duplicate = makeSyntheticInputs();
  duplicate.snapshot.tables[1].uniqueId = duplicate.snapshot.tables[0].uniqueId;
  assert.throws(() => compileFrtkArtifacts(duplicate), /duplicate unique ID.*snapshot/i);
});

test('compiler rejects duplicate layout unique IDs', () => {
  const duplicate = makeSyntheticInputs();
  duplicate.layout.tables[1].uniqueId = duplicate.layout.tables[0].uniqueId;
  assert.throws(() => compileFrtkArtifacts(duplicate), /duplicate unique ID.*layout/i);
});

test('compiler permits one unique ID to use build-local table IDs in distinct builds', () => {
  const firstInputs = makeSyntheticInputs();
  const secondInputs = makeSyntheticInputs();
  secondInputs.snapshot.buildIdentity = 'synthetic-build-v2';
  secondInputs.layout.buildIdentity = 'synthetic-build-v2';
  secondInputs.snapshot.tables[0].tableId = 7000;
  secondInputs.layout.tables[0].tableId = 7000;

  const first = compileFrtkArtifacts(firstInputs);
  const second = compileFrtkArtifacts(secondInputs);
  const uniqueId = firstInputs.snapshot.tables[0].uniqueId;
  const firstTable = first.profile.tables.find((table) => table.uniqueId === uniqueId);
  const secondTable = second.profile.tables.find((table) => table.uniqueId === uniqueId);
  assert.equal(firstTable.uniqueId, secondTable.uniqueId);
  assert.notEqual(firstTable.tableId, secondTable.tableId);
  assert.notEqual(first.profile.buildIdentity, second.profile.buildIdentity);
});

test('compiler requires exact per-table unique ID and build-local table ID mappings', () => {
  const uniqueIdMismatch = makeSyntheticInputs();
  uniqueIdMismatch.layout.tables[0].uniqueId += 1;
  assert.throws(() => compileFrtkArtifacts(uniqueIdMismatch), /table identity mismatch/i);

  const tableIdMismatch = makeSyntheticInputs();
  tableIdMismatch.layout.tables[0].tableId = 7000;
  assert.throws(() => compileFrtkArtifacts(tableIdMismatch), /table identity mismatch/i);
});

test('compiler rejects unknown relationship targets and identity mismatch', () => {
  const unknownTarget = makeSyntheticInputs();
  unknownTarget.snapshot.tables.find((table) => table.tableId === 4288)
    .relationships[0].targetTableId = 9999;
  assert.throws(() => compileFrtkArtifacts(unknownTarget), /unknown relationship target/i);

  const mismatch = makeSyntheticInputs();
  mismatch.layout.buildIdentity = 'other-build';
  assert.throws(() => compileFrtkArtifacts(mismatch), /identity mismatch/i);
});

test('compiler rejects relationship target rows outside referenced table capacity', () => {
  const outOfCapacity = makeSyntheticInputs();
  outOfCapacity.snapshot.tables.find((table) => table.tableId === 4288)
    .relationships[0].targetRow = 7600;
  assert.throws(() => compileFrtkArtifacts(outOfCapacity), /target row.*capacity/i);
});

test('compiler rejects packed-reference fields targeting unknown tables', () => {
  const unknownFieldTarget = makeSyntheticInputs();
  unknownFieldTarget.layout.tables.find((table) => table.tableId === 4288)
    .fields[0].referenceTableId = 9999;
  assert.throws(() => compileFrtkArtifacts(unknownFieldTarget), /unknown reference table/i);
});

test('compiler accepts the exact offset-binary encoding and rejects misspellings', () => {
  const accepted = makeSyntheticInputs();
  const field = accepted.layout.tables.find((table) => table.tableId === 4269).fields[0];
  Object.assign(field, {
    encoding: 'offset-binary', bitWidth: 11, minimum: -200, maximum: 1847,
  });
  assert.equal(compileFrtkArtifacts(accepted).layout.tables
    .find((table) => table.tableId === 4269).fields[0].encoding, 'offset-binary');

  const misspelled = makeSyntheticInputs();
  misspelled.layout.tables.find((table) => table.tableId === 4269)
    .fields[0].encoding = 'offset_binary';
  assert.throws(() => compileFrtkArtifacts(misspelled), /unsupported field encoding/i);
});

test('compiler rejects empty snapshot and layout table sets', () => {
  const empty = makeSyntheticInputs();
  empty.snapshot.tables = [];
  empty.layout.tables = [];
  assert.throws(() => compileFrtkArtifacts(empty), /at least one table/i);
});

test('compiler rejects duplicate relationship source field identities', () => {
  const duplicate = makeSyntheticInputs();
  const relationships = duplicate.snapshot.tables.find((table) => table.tableId === 4288)
    .relationships;
  relationships.push({ ...relationships[0], targetRow: 19 });
  assert.throws(() => compileFrtkArtifacts(duplicate), /duplicate relationship/i);
});

test('relationship ordering is deterministic for reversed inputs sharing a source row', () => {
  const firstInputs = makeSyntheticInputs();
  const secondInputs = makeSyntheticInputs({ reverse: true });
  const extra = {
    sourceRow: 19, fieldName: 'SchoolRef', targetTableId: 5841, targetRow: 3,
  };
  firstInputs.snapshot.tables.find((table) => table.tableId === 4288).relationships.push(extra);
  secondInputs.snapshot.tables.find((table) => table.tableId === 4288).relationships.unshift(extra);
  const first = compileFrtkArtifacts(firstInputs);
  const second = compileFrtkArtifacts(secondInputs);
  assert.equal(canonicalStringify(first), canonicalStringify(second));
  assert.equal(first.profile.profileId, second.profile.profileId);
});

test('compiler sorts fields and relationships by their contract keys', () => {
  const inputs = makeSyntheticInputs();
  const table = inputs.layout.tables.find((candidate) => candidate.tableId === 4288);
  table.fields.push({
    name: 'Earlier', encoding: 'bitfield', byteOffset: 0, storageBytes: 1,
    bitOffset: 1, bitWidth: 2, minimum: 0, maximum: 3, referenceTableId: null,
  });
  table.fields.push({
    name: 'Latest', encoding: 'unsigned', byteOffset: 4, storageBytes: 1,
    bitOffset: 0, bitWidth: 8, minimum: 0, maximum: 255, referenceTableId: null,
  });
  const artifacts = compileFrtkArtifacts(inputs);
  const compiled = artifacts.layout.tables.find((candidate) => candidate.tableId === 4288);
  assert.deepEqual(compiled.fields.map((field) => field.name), ['RecruitRef', 'Earlier', 'Latest']);
  const profile = artifacts.profile.tables.find((candidate) => candidate.tableId === 4288);
  assert.deepEqual(profile.relationships.map((relationship) => relationship.sourceRow), [19, 37]);
});

test('compiler uses UTF-8 bytewise name ordering for tied mixed-case keys', () => {
  const inputs = makeSyntheticInputs();
  const snapshot = inputs.snapshot.tables.find((table) => table.tableId === 4288);
  snapshot.relationships = [
    { sourceRow: 19, fieldName: 'alpha', targetTableId: 4269, targetRow: 37 },
    { sourceRow: 19, fieldName: 'Beta', targetTableId: 4269, targetRow: 19 },
  ];
  const layout = inputs.layout.tables.find((table) => table.tableId === 4288);
  layout.fields.push({
    name: 'alpha', encoding: 'bitfield', byteOffset: 4, storageBytes: 1,
    bitOffset: 0, bitWidth: 2, minimum: 0, maximum: 3, referenceTableId: null,
  });
  layout.fields.push({
    name: 'Beta', encoding: 'bitfield', byteOffset: 4, storageBytes: 1,
    bitOffset: 0, bitWidth: 2, minimum: 0, maximum: 3, referenceTableId: null,
  });

  const artifacts = compileFrtkArtifacts(inputs);
  const profile = artifacts.profile.tables.find((table) => table.tableId === 4288);
  const schema = artifacts.layout.tables.find((table) => table.tableId === 4288);
  assert.deepEqual(profile.relationships.map(({ fieldName }) => fieldName), ['Beta', 'alpha']);
  assert.deepEqual(schema.fields.map(({ name }) => name), ['RecruitRef', 'Beta', 'alpha']);
});

test('local CLI writes only inside .frtk and refuses overwrite without force', (t) => {
  const root = path.resolve(__dirname, '../../..');
  const local = path.join(root, '.frtk', `test-${process.pid}`);
  fs.mkdirSync(local, { recursive: true });
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const inputs = makeSyntheticInputs();
  const snapshotPath = path.join(local, 'snapshot.json');
  const layoutPath = path.join(local, 'layout.json');
  const outputPath = path.join(local, 'profile.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(inputs.snapshot));
  fs.writeFileSync(layoutPath, JSON.stringify(inputs.layout));
  const script = path.join(root, 'scripts', 'build-frtk-profile.cjs');
  const args = [script, '--snapshot', snapshotPath, '--layout', layoutPath,
    '--output', outputPath];
  const first = childProcess.spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const bundle = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(bundle.profile.formatVersion, 1);
  assert.equal(bundle.layout.formatVersion, 1);
  const second = childProcess.spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /exists/i);
  const forced = childProcess.spawnSync(process.execPath, [...args, '--force'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
});

test('local CLI rejects unknown arguments and paths outside .frtk', () => {
  const root = path.resolve(__dirname, '../../..');
  const script = path.join(root, 'scripts', 'build-frtk-profile.cjs');
  const unknown = childProcess.spawnSync(process.execPath, [script, '--wat'],
    { cwd: root, encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown argument/i);
  const outside = childProcess.spawnSync(process.execPath, [script,
    '--snapshot', 'package.json', '--layout', 'package.json', '--output', 'profile.json'],
  { cwd: root, encoding: 'utf8' });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /\.frtk/i);
});

test('local CLI resolves junction targets before enforcing .frtk containment', (t) => {
  const root = path.resolve(__dirname, '../../..');
  const local = path.join(root, '.frtk', `junction-test-${process.pid}`);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-frtk-external-'));
  fs.mkdirSync(local, { recursive: true });
  t.after(() => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  const inputs = makeSyntheticInputs();
  fs.writeFileSync(path.join(external, 'snapshot.json'), JSON.stringify(inputs.snapshot));
  fs.writeFileSync(path.join(external, 'layout.json'), JSON.stringify(inputs.layout));
  const linked = path.join(local, 'linked');
  fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, 'scripts/build-frtk-profile.cjs'),
    '--snapshot', path.join(linked, 'snapshot.json'),
    '--layout', path.join(linked, 'layout.json'),
    '--output', path.join(local, 'profile.json'),
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.frtk/i);
});

test('local CLI validates output junctions before creating external directories', (t) => {
  const root = path.resolve(__dirname, '../../..');
  const local = path.join(root, '.frtk', `mkdir-junction-test-${process.pid}`);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-frtk-output-'));
  fs.mkdirSync(local, { recursive: true });
  t.after(() => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  const inputs = makeSyntheticInputs();
  const snapshotPath = path.join(local, 'snapshot.json');
  const layoutPath = path.join(local, 'layout.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(inputs.snapshot));
  fs.writeFileSync(layoutPath, JSON.stringify(inputs.layout));
  const linked = path.join(local, 'linked');
  fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, 'scripts/build-frtk-profile.cjs'),
    '--snapshot', snapshotPath,
    '--layout', layoutPath,
    '--output', path.join(linked, 'created', 'profile.json'),
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.frtk/i);
  assert.equal(fs.existsSync(path.join(external, 'created')), false);
});

test('release package declarations exclude local profiles, saves, schemas, and raw dumps', () => {
  const root = path.resolve(__dirname, '../../..');
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(root, 'packages/sdk/package.json')));
  assert.deepEqual(sdkPackage.files, ['index.cjs', 'src']);
  const { assertAllowedEntry } = require('../../../scripts/package-release.cjs');
  for (const entry of [
    '.frtk/profile.json', 'saves/dynasty.dat', 'schemas/game.json',
    'docs/process.dmp', 'docs/records.dump', 'docs/record.raw',
  ]) {
    assert.throws(() => assertAllowedEntry(entry), /not allowed/i, entry);
  }
});
