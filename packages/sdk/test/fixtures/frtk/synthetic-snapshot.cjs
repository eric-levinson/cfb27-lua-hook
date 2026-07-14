'use strict';

const TABLES = Object.freeze([
  ['UserRecruitTarget', 4168, 36, 1120],
  ['Player', 4244, 192, 16500],
  ['RecruitingBoard', 4251, 12, 138],
  ['Recruit', 4269, 24, 7600],
  ['RecruitTarget', 4288, 28, 4870],
  ['ProspectTargetSchool', 5840, 4, 41010],
  ['ProspectTargetSchoolOverflow', 5841, 4, 41010],
  ['ProspectTargetSchoolArray', 5842, 40, 7600],
  ['RecruitTargetArray', 5847, 140, 138],
]);

function recordHex(tableId, rowIndex, recordSize) {
  const record = Buffer.alloc(recordSize);
  for (let index = 0; index < record.length; index += 1) {
    record[index] = (tableId * 13 + rowIndex * 29 + index * 17) & 0xFF;
  }
  return record.toString('hex').toUpperCase();
}

function makeSyntheticInputs({ reverse = false } = {}) {
  const entries = TABLES.map(([logicalName, tableId, recordSize, capacity]) => ({
    logicalName,
    tableId,
    uniqueId: tableId * 100 + 7,
    capacity,
    recordSize,
  }));
  const snapshotTables = entries.map((table) => ({
    ...table,
    rows: [37, 3, 19].map((rowIndex) => ({
      rowIndex,
      recordHex: recordHex(table.tableId, rowIndex, table.recordSize),
      maskHex: 'FF'.repeat(table.recordSize),
    })),
    relationships: table.tableId === 4288 ? [
      { sourceRow: 19, fieldName: 'RecruitRef', targetTableId: 4269, targetRow: 37 },
      { sourceRow: 37, fieldName: 'SchoolRef', targetTableId: 5840, targetRow: 19 },
    ] : [],
  }));
  const layoutTables = entries.map((table) => ({
    ...table,
    authorityStatus: 'discovery_only',
    fields: [{
      name: table.tableId === 4288 ? 'RecruitRef' : 'SyntheticValue',
      encoding: table.tableId === 4288 ? 'packed-reference' : 'unsigned',
      byteOffset: 0,
      storageBytes: table.tableId === 4288 ? 4 : Math.min(2, table.recordSize),
      bitOffset: 0,
      bitWidth: table.tableId === 4288 ? 32 : Math.min(16, table.recordSize * 8),
      minimum: 0,
      maximum: table.tableId === 4288 ? 0xFFFFFFFF : 0xFFFF,
      referenceTableId: table.tableId === 4288 ? 4269 : null,
    }],
  }));
  if (reverse) {
    snapshotTables.reverse();
    layoutTables.reverse();
    for (const table of snapshotTables) {
      table.rows.reverse();
      table.relationships.reverse();
    }
    for (const table of layoutTables) table.fields.reverse();
  }
  return {
    snapshot: {
      schemaIdentity: 'synthetic-schema-v1',
      buildIdentity: 'synthetic-build-v1',
      tables: snapshotTables,
    },
    layout: {
      schemaIdentity: 'synthetic-schema-v1',
      buildIdentity: 'synthetic-build-v1',
      tables: layoutTables,
    },
  };
}

module.exports = { TABLES, makeSyntheticInputs };
