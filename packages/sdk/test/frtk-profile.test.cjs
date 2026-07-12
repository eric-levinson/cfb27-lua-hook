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
