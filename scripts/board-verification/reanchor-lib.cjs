'use strict';

const TABLE_ENTRIES = [
  [4168, Object.freeze({ id: 4168, table1Length: 40444, words: 9, capacity: 1120, stride: 36, headerSize: 324, offsetStart: 0 })],
  [4176, Object.freeze({ id: 4176, table1Length: 19364, words: 1, capacity: 4830, stride: 4, headerSize: 244, offsetStart: 0 })],
  [4190, Object.freeze({ id: 4190, table1Length: 37560, words: 1, capacity: 9380, stride: 4, headerSize: 240, offsetStart: 0 })],
  [4251, Object.freeze({ id: 4251, table1Length: 1704, words: 3, capacity: 138, stride: 12, headerSize: 248, offsetStart: 0 })],
  [5790, Object.freeze({ id: 5790, table1Length: 77312, words: 3, capacity: 4830, stride: 12, headerSize: 265, offsetStart: 33, isArray: true })],
  [5847, Object.freeze({ id: 5847, table1Length: 19904, words: 35, capacity: 138, stride: 140, headerSize: 263, offsetStart: 31, isArray: true })],
];
const TABLE_LOOKUP = new Map(TABLE_ENTRIES);
const readOnlyError = () => { throw new TypeError('TABLES is read-only'); };
const TABLES = Object.freeze({
  get size() { return TABLE_LOOKUP.size; },
  get(id) { return TABLE_LOOKUP.get(id); },
  has(id) { return TABLE_LOOKUP.has(id); },
  keys() { return TABLE_LOOKUP.keys(); },
  values() { return TABLE_LOOKUP.values(); },
  entries() { return TABLE_LOOKUP.entries(); },
  forEach(callback, thisArg) {
    TABLE_LOOKUP.forEach((value, key) => callback.call(thisArg, value, key, TABLES));
  },
  [Symbol.iterator]() { return TABLE_LOOKUP[Symbol.iterator](); },
  set: readOnlyError,
  delete: readOnlyError,
  clear: readOnlyError,
});

function canonical(value) {
  return `0x${BigInt(value).toString(16).toUpperCase()}`;
}

function signature(table) {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(table.table1Length, 0);
  bytes.writeUInt32LE(table.table1Length, 4);
  bytes.writeUInt32LE(table.words, 8);
  bytes.writeUInt32LE(table.capacity, 12);
  return bytes.toString('hex').toUpperCase();
}

function decodeRef(value) {
  return { tableId: value >>> 17, row: value & 0x1FFFF };
}

function expectedRef(value, tableId, capacity = Number.MAX_SAFE_INTEGER) {
  const ref = decodeRef(value);
  return ref.tableId === tableId && ref.row < capacity;
}

function isFreeRow(table, data, row) {
  const offset = row * table.stride;
  if (data.readUInt32LE(offset) !== row + 1) return false;
  for (let byte = offset + 4; byte < offset + table.stride; byte += 4) {
    if (data.readUInt32LE(byte) !== 0) return false;
  }
  return true;
}

function isContentRow(table, data, row) {
  const offset = row * table.stride;
  const first = data.readUInt32LE(offset);
  if (table.id === 4168) {
    const ref = decodeRef(data.readUInt32LE(offset + 12));
    return ref.tableId > 0;
  }
  if (table.id === 4251) {
    const ref = decodeRef(first);
    return ref.tableId > 0 && ref.row < 138;
  }
  if (table.id === 5790) return expectedRef(first, 4190, 9380);
  if (table.id === 5847) {
    const ref = decodeRef(first);
    return ref.tableId > 0 && ref.row < 0x20000;
  }
  return false;
}

function sampledRowCount(table, data) {
  return Math.min(table.capacity, 512, Math.floor(data.length / table.stride));
}

function scoreCandidate(table, data) {
  let freeRows = 0;
  let contentRows = 0;
  const sampleRows = sampledRowCount(table, data);
  for (let row = 0; row < sampleRows; row += 1) {
    if (isFreeRow(table, data, row)) freeRows += 1;
    if (isContentRow(table, data, row)) contentRows += 1;
  }
  return { freeRows, contentRows, score: freeRows + (contentRows * 8) };
}

function deriveDataAddress(table, header) {
  const dataOffset = table.headerSize - 204 - table.offsetStart +
    (table.isArray ? table.capacity * 4 : 0);
  return BigInt(header) + BigInt(dataOffset);
}

function selectTableCandidate(table, candidates) {
  const ranked = [...candidates].sort((left, right) => right.score.score - left.score.score);
  if (ranked.length === 0 || ranked[0].score.score <= 0) {
    throw new Error(`Table ${table.id} signatures failed structural validation`);
  }
  if (ranked.length > 1 && ranked[0].score.score === ranked[1].score.score) {
    throw new Error(`Table ${table.id} has ambiguous top structural candidates`);
  }
  return ranked[0];
}

async function readRange(client, address, length) {
  const result = await client.readMemory({
    ranges: [{ address: canonical(address), length }],
    allowUnsupportedBuild: true,
  });
  return Buffer.from(result.ranges[0].bytesHex, 'hex');
}

function representativeRows(table, data) {
  let freeRow = null;
  let contentRow = null;
  const sampleRows = sampledRowCount(table, data);
  for (let row = 0; row < sampleRows && (freeRow === null || contentRow === null); row += 1) {
    if (freeRow === null && isFreeRow(table, data, row)) freeRow = row;
    if (contentRow === null && isContentRow(table, data, row)) contentRow = row;
  }
  return { freeRow, contentRow };
}

async function validateAnchorReread(client, table, candidate) {
  const header = await readRange(client, candidate.header, 16);
  if (header.toString('hex').toUpperCase() !== signature(table)) {
    throw new Error(`Table ${table.id} header reread mismatch`);
  }

  const freelistHead = (await readRange(client, candidate.header + 24n, 4)).readUInt32LE(0);
  if (candidate.freelistHead !== undefined && candidate.freelistHead !== freelistHead) {
    throw new Error(`Table ${table.id} freelist head reread mismatch`);
  }

  const rows = representativeRows(table, candidate.data);
  for (const [kind, row] of Object.entries(rows)) {
    if (row === null) continue;
    const offset = row * table.stride;
    const reread = await readRange(client, candidate.base + BigInt(offset), table.stride);
    if (!reread.equals(candidate.data.subarray(offset, offset + table.stride))) {
      throw new Error(`Table ${table.id} representative ${kind} reread mismatch`);
    }
  }

  return Object.freeze({
    header: true,
    freelistHead: true,
    freelistHeadValue: freelistHead,
    freeRow: rows.freeRow,
    contentRow: rows.contentRow,
  });
}

async function locateTable(client, table, { log = (message) => process.stderr.write(message) } = {}) {
  log(`Locating table ${table.id}...\n`);
  const candidates = [];
  let cursor = process.env.CFB27_SCAN_START || '0x380000000';
  let signatureMatches = 0;
  let scanComplete = false;
  for (let pageNumber = 0; pageNumber < 512; pageNumber += 1) {
    const page = await client.scanMemoryPage({
      patternHex: signature(table),
      maskHex: 'FF'.repeat(16),
      maxMatches: 4,
      contextBefore: 0,
      contextAfter: 0,
      includeAllocationMetadata: true,
      allowUnsupportedBuild: true,
      cursor,
    });
    signatureMatches += page.matches.length;
    for (const match of page.matches) {
      const header = BigInt(match.address);
      const base = deriveDataAddress(table, header);
      try {
        const data = await readRange(client, base, table.capacity * table.stride);
        candidates.push({
          header,
          base,
          data,
          score: scoreCandidate(table, data),
          allocationBase: match.allocationBase,
          allocationSize: match.allocationSize,
        });
      } catch {
        // A signature at a page boundary can be valid while its derived region is not.
      }
    }
    if (page.complete) {
      scanComplete = true;
      break;
    }
    cursor = page.nextCursor;
    if (pageNumber > 0 && pageNumber % 16 === 0) log(`  scanned ${pageNumber + 1} pages...\n`);
  }

  if (!scanComplete) {
    throw new Error(`Table ${table.id} scan did not complete within 512 pages`);
  }
  const selected = selectTableCandidate(table, candidates);
  selected.freelistHead = (await readRange(client, selected.header + 24n, 4)).readUInt32LE(0);
  const validation = await validateAnchorReread(client, table, selected);
  log(`  ${canonical(selected.base)} score=${selected.score.score} candidates=${candidates.length}\n`);
  return {
    ...table,
    ...selected,
    freelistHead: validation.freelistHeadValue,
    candidateCount: candidates.length,
    signatureMatches,
    validation,
  };
}

function findUserBoard(tables) {
  const userRows = tables.get(4168);
  const boardIndex = tables.get(4251);
  const membership = tables.get(5847);
  if (!userRows || !boardIndex || !membership) {
    throw new Error('User rows, board index, and membership tables are required');
  }
  const membershipTableIds = new Set();
  for (let boardRow = 0; boardRow < boardIndex.capacity; boardRow += 1) {
    const value = boardIndex.data.readUInt32LE(boardRow * boardIndex.stride);
    const ref = decodeRef(value);
    if (ref.tableId > 0 && ref.row < membership.capacity) membershipTableIds.add(ref.tableId);
  }
  if (membershipTableIds.size !== 1) {
    throw new Error('Board index does not identify one stable membership table ID');
  }
  const membershipTableId = [...membershipTableIds][0];
  const userTableIds = new Set();
  for (let row = 0; row < membership.capacity; row += 1) {
    const offset = row * membership.stride;
    for (let slot = 0; slot < membership.words; slot += 1) {
      const ref = decodeRef(membership.data.readUInt32LE(offset + slot * 4));
      if (ref.tableId > 0 && ref.row < userRows.capacity && isContentRow(userRows, userRows.data, ref.row)) {
        userTableIds.add(ref.tableId);
      }
    }
  }
  if (userTableIds.size !== 1) {
    throw new Error('Membership rows contain mixed or out-of-range user-board table IDs');
  }
  const userTableId = [...userTableIds][0];
  const recruitTableIds = new Set();
  const activePitchTableIds = new Set();
  for (let row = 0; row < membership.capacity; row += 1) {
    const offset = row * membership.stride;
    for (let slot = 0; slot < membership.words; slot += 1) {
      const ref = decodeRef(membership.data.readUInt32LE(offset + slot * 4));
      if (ref.tableId !== userTableId || ref.row >= userRows.capacity) continue;
      const recruitRef = decodeRef(userRows.data.readUInt32LE(ref.row * userRows.stride + 12));
      if (recruitRef.tableId > 0) recruitTableIds.add(recruitRef.tableId);
      const pitchRef = decodeRef(userRows.data.readUInt32LE(ref.row * userRows.stride + 16));
      if (pitchRef.tableId > 0) activePitchTableIds.add(pitchRef.tableId);
    }
  }
  if (recruitTableIds.size !== 1) {
    throw new Error('User-board rows contain mixed or missing recruit table IDs');
  }
  const recruitTableId = [...recruitTableIds][0];
  if (activePitchTableIds.size !== 1) {
    throw new Error('User-board rows contain mixed or missing active-pitch table IDs');
  }
  const activePitchTableId = [...activePitchTableIds][0];
  const candidates = [];
  for (let boardRow = 0; boardRow < boardIndex.capacity; boardRow += 1) {
    const boardOffset = boardRow * boardIndex.stride;
    const boardRefValue = boardIndex.data.readUInt32LE(boardOffset);
    const boardRef = decodeRef(boardRefValue);
    if (boardRef.tableId !== membershipTableId || boardRef.row >= membership.capacity) continue;

    const membershipOffset = boardRef.row * membership.stride;
    let userRefs = 0;
    let cpuRefs = 0;
    let invalidUserRefs = 0;
    let occupied = 0;
    let firstFreeSlot = -1;
    let compact = true;
    for (let slot = 0; slot < membership.words; slot += 1) {
      const value = membership.data.readUInt32LE(membershipOffset + slot * 4);
      if (value === 0) {
        if (firstFreeSlot < 0) firstFreeSlot = slot;
        continue;
      }
      if (firstFreeSlot >= 0) compact = false;
      occupied += 1;
      const ref = decodeRef(value);
      if (ref.tableId === userTableId) {
        userRefs += 1;
        if (ref.row >= userRows.capacity) invalidUserRefs += 1;
      }
      if (ref.tableId !== userTableId) cpuRefs += 1;
    }
    candidates.push({
      boardRow,
      teamRow: boardRef.row,
      boardRefValue,
      occupied,
      userRefs,
      cpuRefs,
      invalidUserRefs,
      firstFreeSlot,
      compact,
    });
  }

  candidates.sort((left, right) =>
    (right.userRefs - left.userRefs) ||
    (left.cpuRefs - right.cpuRefs) ||
    (right.occupied - left.occupied));
  const userCandidates = candidates.filter((candidate) => candidate.userRefs > 0);
  const eligibleCandidates = userCandidates.filter((candidate) =>
    candidate.compact && candidate.invalidUserRefs === 0 &&
    candidate.occupied === candidate.userRefs);
  if (eligibleCandidates.length > 1) {
    throw new Error('Could not uniquely identify the user board from user-record membership references');
  }
  if (eligibleCandidates.length === 0) {
    if (userCandidates.some((candidate) => candidate.invalidUserRefs > 0)) {
      throw new Error('User board membership contains an out-of-range user-record reference');
    }
    if (userCandidates.some((candidate) => candidate.occupied !== candidate.userRefs)) {
      throw new Error('User board membership is not user-only and contains a mixed table reference');
    }
    if (userCandidates.some((candidate) => !candidate.compact)) {
      throw new Error('Could not identify a compact user board membership row');
    }
    throw new Error('Could not uniquely identify the user board from user-record membership references');
  }
  const selected = { ...eligibleCandidates[0], membershipTableId, userTableId,
    recruitTableId, activePitchTableId };
  if (selected.firstFreeSlot < 0) throw new Error('The active recruiting board has no free membership slot');
  return { selected, candidates: candidates.slice(0, 8) };
}

module.exports = {
  TABLES,
  canonical,
  signature,
  decodeRef,
  scoreCandidate,
  deriveDataAddress,
  selectTableCandidate,
  locateTable,
  findUserBoard,
  readRange,
  validateAnchorReread,
};
