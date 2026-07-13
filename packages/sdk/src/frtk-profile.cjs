'use strict';

const crypto = require('node:crypto');
const {
  hasExactKeys,
  isSafeIntegerBetween,
  isUpperHexBytes,
  isValidUtf8BoundedString,
  canonicalStringify,
} = require('./validation.cjs');
const { decodeField } = require('./frtk-fields.cjs');

const TABLE_KEYS = ['logicalName', 'tableId', 'uniqueId', 'capacity', 'recordSize'];
const LIMITS = Object.freeze({
  tables: 256,
  fingerprintsPerTable: 8,
  fingerprintsTotal: 1024,
  relationshipsPerTable: 64,
  relationshipsTotal: 4096,
  fieldsPerTable: 512,
  fieldsTotal: 32768,
  nameBytes: 128,
});

function compareUtf8Ordinal(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function requireIdentity(value, name) {
  if (!isValidUtf8BoundedString(value, LIMITS.nameBytes)) {
    if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)) {
      throw new TypeError(`${name} must be valid UTF-8`);
    }
    throw new TypeError(`${name} must use 1..128 UTF-8 bytes`);
  }
  return value;
}

function requireLogicalName(value, name) {
  if (!isValidUtf8BoundedString(value, LIMITS.nameBytes)) {
    if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)) {
      throw new TypeError(`${name} must be valid UTF-8`);
    }
    throw new TypeError(`${name} must use 1..128 UTF-8 bytes`);
  }
  return value;
}

function validateTableIdentity(table, extraKeys) {
  if (!hasExactKeys(table, [...TABLE_KEYS, ...extraKeys])) {
    if (table?.logicalName === 'Team' && !Object.hasOwn(table, 'tableId')) {
      throw new TypeError('Team selection requires an explicit table ID and unique ID');
    }
    throw new TypeError('Table definition has unexpected or missing keys');
  }
  requireLogicalName(table.logicalName, 'logical table name');
  if (!isSafeIntegerBetween(table.tableId, 0, 0x7FFF) ||
      !isSafeIntegerBetween(table.uniqueId, 0, 0xFFFFFFFF) ||
      !isSafeIntegerBetween(table.capacity, 1, 0x1FFFF) ||
      !isSafeIntegerBetween(table.recordSize, 1, 4096)) {
    throw new RangeError('Table identity or dimensions are invalid');
  }
}

function ensureUniqueTableIds(tables, kind) {
  const ids = new Set();
  const uniqueIds = new Set();
  for (const table of tables) {
    if (ids.has(table.tableId)) throw new Error(`Duplicate table ID in ${kind}`);
    ids.add(table.tableId);
    if (uniqueIds.has(table.uniqueId)) throw new Error(`Duplicate unique ID in ${kind}`);
    uniqueIds.add(table.uniqueId);
  }
}

function popcountHex(hex) {
  let selected = 0;
  for (const byte of Buffer.from(hex, 'hex')) {
    let value = byte;
    while (value !== 0) {
      selected += value & 1;
      value >>>= 1;
    }
  }
  return selected;
}

function maskedPattern(recordHex, maskHex) {
  const record = Buffer.from(recordHex, 'hex');
  const mask = Buffer.from(maskHex, 'hex');
  for (let index = 0; index < record.length; index += 1) record[index] &= mask[index];
  return record.toString('hex').toUpperCase();
}

function compileRows(table) {
  if (!Array.isArray(table.rows)) throw new TypeError('Table rows must be an array');
  if (table.rows.length > LIMITS.fingerprintsPerTable) {
    throw new RangeError('At most 8 fingerprints are allowed per table');
  }
  const rowIndexes = new Set();
  const patterns = new Set();
  let selectedBits = 0;
  const rows = table.rows.map((row) => {
    if (!hasExactKeys(row, ['rowIndex', 'recordHex', 'maskHex']) ||
        !isSafeIntegerBetween(row.rowIndex, 0, table.capacity - 1)) {
      throw new RangeError('Row fingerprint is invalid');
    }
    if (rowIndexes.has(row.rowIndex)) throw new Error('Duplicate row index');
    rowIndexes.add(row.rowIndex);
    if (!isUpperHexBytes(row.recordHex) || row.recordHex.length !== table.recordSize * 2) {
      throw new RangeError('Row record length must match recordSize');
    }
    if (!isUpperHexBytes(row.maskHex) || row.maskHex.length !== table.recordSize * 2) {
      throw new RangeError('Row mask length must match recordSize');
    }
    selectedBits += popcountHex(row.maskHex);
    const patternHex = maskedPattern(row.recordHex, row.maskHex);
    patterns.add(patternHex);
    return { rowIndex: row.rowIndex, patternHex, maskHex: row.maskHex };
  });
  if (selectedBits < 64) throw new Error('Table masks require at least 64 selected bits');
  if (rows.length < 3 || patterns.size < 3) {
    throw new Error('Each table requires at least three distinct occupied rows');
  }
  return rows.sort((left, right) => left.rowIndex - right.rowIndex);
}

function compileRelationships(table, knownTables) {
  if (!Array.isArray(table.relationships)) throw new TypeError('relationships must be an array');
  if (table.relationships.length > LIMITS.relationshipsPerTable) {
    throw new RangeError('At most 64 relationships are allowed per table');
  }
  const identities = new Set();
  return table.relationships.map((relationship) => {
    if (!hasExactKeys(relationship,
      ['sourceRow', 'fieldName', 'targetTableId', 'targetRow']) ||
        !isSafeIntegerBetween(relationship.sourceRow, 0, table.capacity - 1) ||
        !isSafeIntegerBetween(relationship.targetTableId, 0, 0x7FFF) ||
        !isSafeIntegerBetween(relationship.targetRow, 0, 0x1FFFF)) {
      throw new TypeError('Relationship definition is invalid');
    }
    requireLogicalName(relationship.fieldName, 'relationship field name');
    const targetTable = knownTables.get(relationship.targetTableId);
    if (!targetTable) {
      throw new Error('Unknown relationship target table');
    }
    if (relationship.targetRow >= targetTable.capacity) {
      throw new RangeError('Relationship target row exceeds target table capacity');
    }
    const identity = `${relationship.sourceRow}:${relationship.fieldName}`;
    if (identities.has(identity)) throw new Error('Duplicate relationship source field identity');
    identities.add(identity);
    return { ...relationship };
  }).sort((left, right) => left.sourceRow - right.sourceRow ||
    compareUtf8Ordinal(left.fieldName, right.fieldName));
}

function compileFields(table, knownTableIds) {
  if (table.authorityStatus !== 'discovery_only') {
    throw new TypeError('Version-1 artifacts must use discovery_only authority');
  }
  if (!Array.isArray(table.fields)) throw new TypeError('Table fields must be an array');
  if (table.fields.length > LIMITS.fieldsPerTable) {
    throw new RangeError('At most 512 fields are allowed per table');
  }
  const names = new Set();
  const fields = table.fields.map((field) => {
    if (!hasExactKeys(field, [
      'name', 'encoding', 'byteOffset', 'storageBytes', 'bitOffset', 'bitWidth',
      'minimum', 'maximum', 'referenceTableId',
    ]) || names.has(field.name)) {
      throw new TypeError('Field definition is invalid or duplicated');
    }
    requireLogicalName(field.name, 'field name');
    names.add(field.name);
    decodeField(Buffer.alloc(table.recordSize), field);
    if (field.encoding === 'packed-reference') {
      if (!isSafeIntegerBetween(field.referenceTableId, 0, 0x7FFF)) {
        throw new RangeError('Packed-reference field requires referenceTableId');
      }
      if (!knownTableIds.has(field.referenceTableId)) {
        throw new Error('Packed-reference field targets an unknown reference table');
      }
    } else if (field.referenceTableId !== null) {
      throw new TypeError('Non-reference field referenceTableId must be null');
    }
    return { ...field };
  });
  return fields.sort((left, right) => left.byteOffset - right.byteOffset ||
    left.bitOffset - right.bitOffset || compareUtf8Ordinal(left.name, right.name));
}

function compileFrtkArtifacts({ snapshot, layout } = {}) {
  if (!hasExactKeys(snapshot, ['schemaIdentity', 'buildIdentity', 'tables']) ||
      !hasExactKeys(layout, ['schemaIdentity', 'buildIdentity', 'tables']) ||
      !Array.isArray(snapshot.tables) || !Array.isArray(layout.tables)) {
    throw new TypeError('Snapshot and layout must use the version-1 compiler input shape');
  }
  if (snapshot.tables.length === 0 || layout.tables.length === 0) {
    throw new Error('Snapshot and layout must contain at least one table');
  }
  if (snapshot.tables.length > LIMITS.tables || layout.tables.length > LIMITS.tables) {
    throw new RangeError('Version-1 artifacts allow at most 256 tables');
  }
  const schemaIdentity = requireIdentity(snapshot.schemaIdentity, 'schemaIdentity');
  const buildIdentity = requireIdentity(snapshot.buildIdentity, 'buildIdentity');
  if (layout.schemaIdentity !== schemaIdentity || layout.buildIdentity !== buildIdentity) {
    throw new Error('Snapshot/layout identity mismatch');
  }
  for (const table of snapshot.tables) validateTableIdentity(table, ['rows', 'relationships']);
  for (const table of layout.tables) validateTableIdentity(table, ['authorityStatus', 'fields']);
  const fingerprintTotal = snapshot.tables.reduce((total, table) => total + table.rows.length, 0);
  const relationshipTotal = snapshot.tables.reduce(
    (total, table) => total + table.relationships.length, 0);
  const fieldTotal = layout.tables.reduce((total, table) => total + table.fields.length, 0);
  if (fingerprintTotal > LIMITS.fingerprintsTotal) {
    throw new RangeError('At most 1024 fingerprints are allowed in total');
  }
  if (relationshipTotal > LIMITS.relationshipsTotal) {
    throw new RangeError('At most 4096 relationships are allowed in total');
  }
  if (fieldTotal > LIMITS.fieldsTotal) {
    throw new RangeError('At most 32768 fields are allowed in total');
  }
  ensureUniqueTableIds(snapshot.tables, 'snapshot');
  ensureUniqueTableIds(layout.tables, 'layout');

  const layoutById = new Map(layout.tables.map((table) => [table.tableId, table]));
  if (layoutById.size !== snapshot.tables.length) {
    throw new Error('Snapshot/layout table identity mismatch');
  }
  const knownTables = new Map(snapshot.tables.map((table) => [table.tableId, table]));
  const knownTableIds = new Set(knownTables.keys());
  const profileTables = [];
  const layoutTables = [];
  for (const source of snapshot.tables) {
    const schema = layoutById.get(source.tableId);
    if (!schema || TABLE_KEYS.some((key) => schema[key] !== source[key])) {
      throw new Error('Snapshot/layout table identity mismatch');
    }
    profileTables.push({
      logicalName: source.logicalName,
      tableId: source.tableId,
      uniqueId: source.uniqueId,
      capacity: source.capacity,
      recordSize: source.recordSize,
      rows: compileRows(source),
      relationships: compileRelationships(source, knownTables),
    });
    layoutTables.push({
      logicalName: schema.logicalName,
      tableId: schema.tableId,
      uniqueId: schema.uniqueId,
      capacity: schema.capacity,
      recordSize: schema.recordSize,
      authorityStatus: schema.authorityStatus,
      fields: compileFields(schema, knownTableIds),
    });
  }
  profileTables.sort((left, right) => left.tableId - right.tableId);
  layoutTables.sort((left, right) => left.tableId - right.tableId);
  const profileWithoutProfileId = {
    formatVersion: 1, schemaIdentity, buildIdentity, tables: profileTables,
  };
  const layoutArtifact = {
    formatVersion: 1, schemaIdentity, buildIdentity, tables: layoutTables,
  };
  const hashContent = { profile: profileWithoutProfileId, layout: layoutArtifact };
  const profileId = crypto.createHash('sha256')
    .update(canonicalStringify(hashContent))
    .digest('hex').toUpperCase();
  return {
    profile: { formatVersion: 1, profileId, schemaIdentity, buildIdentity, tables: profileTables },
    layout: layoutArtifact,
  };
}

module.exports = { compileFrtkArtifacts };
