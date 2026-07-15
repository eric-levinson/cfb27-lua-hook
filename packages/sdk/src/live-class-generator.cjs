'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLAYER_STRING_SLOT_SIZE = 138;
const PLAYER_STRING_FIELDS = Object.freeze({
  FirstName: Object.freeze({ offset: 0, size: 17, required: true }),
  GenericHeadAssetName: Object.freeze({ offset: 17, size: 33, required: false }),
  LastName: Object.freeze({ offset: 50, size: 21, required: true }),
  HomeTown: Object.freeze({ offset: 112, size: 26, required: false }),
});

function fail(message) {
  const error = new Error(message);
  error.code = 'LIVE_CLASS_PLAN_INVALID';
  return error;
}

function toLiveMirrorHex(value) {
  if (typeof value !== 'string' || !/^[0-9A-F]+$/.test(value) ||
      value.length % 8 !== 0) {
    throw fail('live mirror values require complete aligned 32-bit words');
  }
  const bytes = Buffer.from(value, 'hex');
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes.subarray(offset, offset + 4).reverse();
  }
  return bytes.toString('hex').toUpperCase();
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function requireBuffer(value, size, label) {
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw fail(`${label} must be exactly ${size} bytes`);
  }
  return Buffer.from(value);
}

function setMaskBits(mask, offset, length) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 1 ||
      offset + length > mask.length * 8) {
    throw fail('field metadata is outside the record');
  }
  for (let bit = offset; bit < offset + length; bit += 1) {
    mask[bit >> 3] |= 1 << (7 - (bit & 7));
  }
}

function buildMaskedPatch(before, after, fields) {
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || before.length === 0 ||
      before.length !== after.length || !Array.isArray(fields) || fields.length === 0) {
    throw fail('numeric patch requires equal non-empty records and at least one field');
  }
  const mask = Buffer.alloc(before.length);
  for (const field of fields) setMaskBits(mask, field.offset, field.length);
  return Object.freeze({
    beforeHex: before.toString('hex').toUpperCase(),
    maskHex: mask.toString('hex').toUpperCase(),
    valueHex: after.toString('hex').toUpperCase(),
  });
}

function encodePlayerStringSlot(beforeSlot, strings) {
  const output = requireBuffer(beforeSlot, PLAYER_STRING_SLOT_SIZE, 'Player string slot');
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) {
    throw fail('Player strings must be an object');
  }
  for (const [name, definition] of Object.entries(PLAYER_STRING_FIELDS)) {
    const value = strings[name];
    if (value == null && !definition.required) continue;
    if (typeof value !== 'string' || (definition.required && value.length === 0)) {
      throw fail(`${name} is required`);
    }
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > definition.size - 1) {
      throw fail(`${name} is ${bytes.length} bytes; maximum is ${definition.size - 1}`);
    }
    output.fill(0, definition.offset, definition.offset + definition.size);
    bytes.copy(output, definition.offset);
  }
  return output;
}

function fieldMetadata(record, fieldNames) {
  return fieldNames.map((name) => {
    const metadata = record._fields && record._fields[name] && record._fields[name]._offset;
    if (!metadata || !Number.isInteger(metadata.offset) || !Number.isInteger(metadata.length)) {
      throw fail(`field ${name} lacks bit metadata`);
    }
    return { offset: metadata.offset, length: metadata.length };
  });
}

function mutateRecord(record, values, setRecordField) {
  const names = Object.keys(values);
  const before = Buffer.from(record._data);
  const originals = names.map((name) => {
    const field = record.fieldsArray.find((entry) => entry.key === name);
    if (!field) throw fail(`record ${record.index} is missing ${name}`);
    return [name, field.value];
  });
  const fields = fieldMetadata(record, names);
  try {
    for (const [name, value] of Object.entries(values)) setRecordField(record, name, value);
    return { before, after: Buffer.from(record._data), fields };
  } finally {
    for (const [name, value] of originals) setRecordField(record, name, value);
  }
}

function playerStringSlot(file, playerTable, row) {
  const start = playerTable.offset + playerTable.header.table2StartIndex +
    row * PLAYER_STRING_SLOT_SIZE;
  const end = start + PLAYER_STRING_SLOT_SIZE;
  if (!Buffer.isBuffer(file.unpackedFileContents) || start < 0 ||
      end > file.unpackedFileContents.length) {
    throw fail(`Player row ${row} string slot is outside table2`);
  }
  return Buffer.from(file.unpackedFileContents.subarray(start, end));
}

async function openBrooksWriteTables(openCollegeSave, savePath) {
  // Brooks's write map intentionally targets generic Field_N keys. Opening
  // with useSchema:true renames many of those fields and makes planApply's
  // otherwise valid output impossible to apply to the in-memory records.
  const file = await openCollegeSave(savePath);
  const playerTable = file.tables.find((table) => table.name === 'Player');
  const recruitTable = file.tables.find((table) => table.name === 'Recruit');
  if (!playerTable || !recruitTable) throw fail('Player or Recruit table is missing');
  if (!playerTable.recordsRead) await playerTable.readRecords();
  if (!recruitTable.recordsRead) await recruitTable.readRecords();
  return { file, playerTable, recruitTable };
}

async function defaultRunBrooks({ savePath, brooksRoot, seed, outDir, skeleton }) {
  const load = (relativePath) => require(path.join(brooksRoot, relativePath));
  const { runPreview } = load('franchise-lab/generator/preview.js');
  const { loadRecruitPool } = load('franchise-lab/generator/join.js');
  const { planApply, setRecordField } = load('franchise-lab/generator/apply.js');
  const { openCollegeSave } = load('franchise-lab/college-franchise.js');

  const previewResult = await runPreview({ save: savePath, seed, outDir, skeleton });
  const preview = JSON.parse(await fsp.readFile(previewResult.previewPath, 'utf8'));
  const { pool } = await loadRecruitPool(savePath);
  const planned = planApply(preview, pool);
  if (planned.errors.length) throw fail(`Brooks plan rejected: ${planned.errors.join('; ')}`);

  const { file, playerTable, recruitTable } =
    await openBrooksWriteTables(openCollegeSave, savePath);

  const players = [];
  const recruits = [];
  for (const write of planned.writes) {
    const player = playerTable.records[write.playerRow];
    const recruit = recruitTable.records[write.recruitRow];
    if (!player || player.isEmpty || !recruit || recruit.isEmpty) {
      throw fail(`Brooks targeted an empty row ${write.recruitRow}:${write.playerRow}`);
    }
    players.push({
      row: write.playerRow,
      ...mutateRecord(player, write.playerFields, setRecordField),
      beforeStringSlot: playerStringSlot(file, playerTable, write.playerRow),
      strings: { ...write.playerStrings },
    });
    recruits.push({
      row: write.recruitRow,
      ...mutateRecord(recruit, write.recruitFields, setRecordField),
    });
  }

  return {
    sourceRevision: execFileSync('git', ['-C', brooksRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true,
    }).trim(),
    playerRecordSize: playerTable.header.record1Size,
    recruitRecordSize: recruitTable.header.record1Size,
    players,
    recruits,
    gearSkipped: planned.writes.filter((write) => write.gear).length,
  };
}

function normalizeRow(raw, recordSize, label) {
  if (!raw || !Number.isInteger(raw.row) || raw.row < 0) throw fail(`${label} row is invalid`);
  const before = requireBuffer(raw.before, recordSize, `${label} before record`);
  const after = requireBuffer(raw.after, recordSize, `${label} after record`);
  return { row: raw.row, ...buildMaskedPatch(before, after, raw.fields) };
}

function uniqueRows(rows, label) {
  const found = new Set();
  for (const row of rows) {
    if (found.has(row.row)) throw fail(`${label} row ${row.row} is duplicated`);
    found.add(row.row);
  }
}

async function generateLiveClassPlan({ savePath, brooksRoot, seed = 'default', dependencies = {} }) {
  if (typeof savePath !== 'string' || typeof brooksRoot !== 'string') {
    throw fail('savePath and brooksRoot are required');
  }
  const resolvedSave = path.resolve(savePath);
  const resolvedBrooks = path.resolve(brooksRoot);
  const beforeHash = await hashFile(resolvedSave);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfb27-live-class-'));
  const runBrooks = dependencies.runBrooks || defaultRunBrooks;
  let raw;
  let caught;
  try {
    raw = await runBrooks({
      savePath: resolvedSave,
      brooksRoot: resolvedBrooks,
      seed,
      outDir,
      skeleton: true,
    });
  } catch (error) {
    caught = error;
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
  const afterHash = await hashFile(resolvedSave);
  if (afterHash !== beforeHash) throw fail('Dynasty save file changed during live-class generation');
  if (caught) throw caught;

  if (!raw || !Number.isInteger(raw.playerRecordSize) || raw.playerRecordSize < 1 ||
      !Number.isInteger(raw.recruitRecordSize) || raw.recruitRecordSize < 1 ||
      !Array.isArray(raw.players) || !Array.isArray(raw.recruits) ||
      raw.players.length === 0 || raw.players.length !== raw.recruits.length) {
    throw fail('Brooks returned an invalid class plan');
  }
  const playerRows = raw.players.map((row) => {
    const normalized = normalizeRow(row, raw.playerRecordSize, 'Player');
    const beforeStringSlot = requireBuffer(
      row.beforeStringSlot, PLAYER_STRING_SLOT_SIZE, 'Player string slot',
    );
    const desiredSlot = encodePlayerStringSlot(beforeStringSlot, row.strings);
    return Object.freeze({
      ...normalized,
      strings: Object.freeze({ ...row.strings }),
      beforeStringSlotHex: beforeStringSlot.toString('hex').toUpperCase(),
      stringValueHex: desiredSlot.toString('hex').toUpperCase(),
    });
  });
  const recruitRows = raw.recruits.map((row) =>
    Object.freeze(normalizeRow(row, raw.recruitRecordSize, 'Recruit')));
  uniqueRows(playerRows, 'Player');
  uniqueRows(recruitRows, 'Recruit');

  return Object.freeze({
    sourceRevision: String(raw.sourceRevision || 'unknown'),
    seed,
    classSize: playerRows.length,
    playerRecordSize: raw.playerRecordSize,
    recruitRecordSize: raw.recruitRecordSize,
    playerRows: Object.freeze(playerRows),
    recruitRows: Object.freeze(recruitRows),
    gearSkipped: playerRows.length,
  });
}

module.exports = {
  PLAYER_STRING_FIELDS,
  PLAYER_STRING_SLOT_SIZE,
  buildMaskedPatch,
  encodePlayerStringSlot,
  generateLiveClassPlan,
  openBrooksWriteTables,
  toLiveMirrorHex,
};
