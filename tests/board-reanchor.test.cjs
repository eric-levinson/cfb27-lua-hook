'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
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
} = require('../scripts/board-verification/reanchor-lib.cjs');

function encodedRef(tableId, row) {
  return ((tableId << 17) | row) >>> 0;
}

function tableData(table) {
  return Buffer.alloc(table.capacity * table.stride);
}

function setFreeRow(table, data, row) {
  data.writeUInt32LE(row + 1, row * table.stride);
}

function setContentRow(table, data, row) {
  const offset = row * table.stride;
  if (table.id === 4168) {
    data.writeUInt32LE(encodedRef(4269, 7), offset + 12);
    data.writeUInt32LE(encodedRef(5790, 7), offset + 16);
  }
  if (table.id === 4251) data.writeUInt32LE(encodedRef(5847, 7), offset);
  if (table.id === 5790) data.writeUInt32LE(encodedRef(4190, 7), offset);
  if (table.id === 5847) data.writeUInt32LE(encodedRef(4168, 7), offset);
}

function boardFixtures() {
  const userRowsDefinition = TABLES.get(4168);
  const boardIndexDefinition = TABLES.get(4251);
  const membershipDefinition = TABLES.get(5847);
  const userRows = { ...userRowsDefinition, data: tableData(userRowsDefinition) };
  const boardIndex = { ...boardIndexDefinition, data: tableData(boardIndexDefinition) };
  const membership = { ...membershipDefinition, data: tableData(membershipDefinition) };
  setContentRow(userRowsDefinition, userRows.data, 10);
  setContentRow(userRowsDefinition, userRows.data, 11);
  return {
    userRows,
    boardIndex,
    membership,
    tables: new Map([[4168, userRows], [4251, boardIndex], [5847, membership]]),
  };
}

function anchorFixture() {
  const table = TABLES.get(4168);
  const data = tableData(table);
  setFreeRow(table, data, 0);
  setContentRow(table, data, 1);
  const header = 0x1000n;
  return {
    table,
    candidate: {
      header,
      base: deriveDataAddress(table, header),
      data,
      score: scoreCandidate(table, data),
      freelistHead: 7,
    },
  };
}

function rereadClient(table, candidate, replacements = {}) {
  const requests = [];
  return {
    requests,
    client: {
      async readMemory(request) {
        requests.push(request);
        const range = request.ranges[0];
        const address = BigInt(range.address);
        let bytes;
        if (address === candidate.header) bytes = Buffer.from(signature(table), 'hex');
        if (address === candidate.header + 24n) {
          bytes = Buffer.alloc(4);
          bytes.writeUInt32LE(replacements.freelistHead ?? candidate.freelistHead);
        }
        for (const row of [0, 1]) {
          if (address !== candidate.base + BigInt(row * table.stride)) continue;
          const key = row === 0 ? 'freeRow' : 'contentRow';
          bytes = replacements[key] ?? candidate.data.subarray(
            row * table.stride, (row + 1) * table.stride);
        }
        assert.ok(bytes, `unexpected reread ${range.address}`);
        return { ranges: [{ bytesHex: bytes.toString('hex') }] };
      },
    },
  };
}

test('TABLES contains six frozen table definitions', () => {
  assert.equal(TABLES.size, 6);
  assert.deepEqual([...TABLES.keys()], [4168, 4176, 4190, 4251, 5790, 5847]);
  assert.equal(Object.isFrozen(TABLES), true);
  for (const table of TABLES.values()) assert.equal(Object.isFrozen(table), true);
});

test('TABLES rejects registry mutation', () => {
  try {
    assert.throws(() => TABLES.set(9999, {}), /read-only/i);
    assert.throws(() => TABLES.delete(4168), /read-only/i);
    assert.throws(() => TABLES.clear(), /read-only/i);
    assert.throws(() => Map.prototype.set.call(TABLES, 9999, {}), /incompatible|receiver/i);
  } finally {
    if (TABLES instanceof Map) Map.prototype.delete.call(TABLES, 9999);
  }
});

test('signature serializes table identity as four little-endian words', () => {
  assert.equal(signature(TABLES.get(4168)), 'FC9D0000FC9D00000900000060040000');
});

test('canonical and decodeRef preserve unsigned address and row identity', () => {
  assert.equal(canonical(0x7ff61234n), '0x7FF61234');
  assert.deepEqual(decodeRef(encodedRef(5847, 137)), { tableId: 5847, row: 137 });
});

test('deriveDataAddress applies header, offset, and array geometry for all tables', () => {
  const header = 0x100000n;
  for (const table of TABLES.values()) {
    const expectedOffset = table.headerSize - 204 - table.offsetStart +
      (table.isArray ? table.capacity * 4 : 0);
    assert.equal(deriveDataAddress(table, header), header + BigInt(expectedOffset), String(table.id));
  }
});

test('scoreCandidate recognizes freelist and table-specific content fixtures', () => {
  for (const table of TABLES.values()) {
    const data = tableData(table);
    setFreeRow(table, data, 0);
    if ([4168, 4251, 5790, 5847].includes(table.id)) setContentRow(table, data, 1);
    assert.deepEqual(scoreCandidate(table, data), {
      freeRows: 1,
      contentRows: [4168, 4251, 5790, 5847].includes(table.id) ? 1 : 0,
      score: [4168, 4251, 5790, 5847].includes(table.id) ? 9 : 1,
    }, String(table.id));
  }
});

test('board index scoring accepts a build-specific membership table ID', () => {
  const table = TABLES.get(4251);
  const data = tableData(table);
  data.writeUInt32LE(encodedRef(5834, 7), table.stride);
  assert.deepEqual(scoreCandidate(table, data), { freeRows: 0, contentRows: 1, score: 8 });
});

test('selectTableCandidate requires a positive structural winner', () => {
  const table = TABLES.get(4168);
  assert.throws(() => selectTableCandidate(table, [{ score: { score: 0 } }]), /structural validation/i);
});

test('selectTableCandidate rejects tied structural winners', () => {
  const table = TABLES.get(4168);
  const winnerA = { header: 0x1000n, score: { score: 9 } };
  const winnerB = { header: 0x2000n, score: { score: 9 } };
  assert.throws(() => selectTableCandidate(table, [winnerA, winnerB]), /ambiguous/i);
});

test('findUserBoard discovers one compact user membership row', () => {
  const { boardIndex, membership, tables } = boardFixtures();

  boardIndex.data.writeUInt32LE(encodedRef(5847, 3), 2 * boardIndex.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 10), 3 * membership.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 11), 3 * membership.stride + 4);

  const result = findUserBoard(tables);
  assert.equal(result.selected.boardRow, 2);
  assert.equal(result.selected.teamRow, 3);
  assert.equal(result.selected.firstFreeSlot, 2);
  assert.equal(result.selected.compact, true);
});

test('findUserBoard infers the Patch 1 membership table ID', () => {
  const { boardIndex, membership, tables } = boardFixtures();
  boardIndex.data.writeUInt32LE(encodedRef(5834, 3), 2 * boardIndex.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 10), 3 * membership.stride);

  const result = findUserBoard(tables);
  assert.equal(result.selected.boardRow, 2);
  assert.equal(result.selected.teamRow, 3);
});

test('findUserBoard rejects a user membership row with an interior hole', () => {
  const { boardIndex, membership, tables } = boardFixtures();
  boardIndex.data.writeUInt32LE(encodedRef(5847, 3), 2 * boardIndex.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 10), 3 * membership.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 11), 3 * membership.stride + 8);

  assert.throws(() => findUserBoard(tables), /compact/i);
});

test('findUserBoard rejects compact membership containing a mixed table reference', () => {
  const { boardIndex, membership, tables } = boardFixtures();
  boardIndex.data.writeUInt32LE(encodedRef(5847, 3), 2 * boardIndex.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 10), 3 * membership.stride);
  membership.data.writeUInt32LE(encodedRef(4190, 11), 3 * membership.stride + 4);

  assert.throws(() => findUserBoard(tables), /user-only|mixed|occupied/i);
});

test('findUserBoard rejects an out-of-range 4168 membership reference', () => {
  const { userRows, boardIndex, membership, tables } = boardFixtures();
  boardIndex.data.writeUInt32LE(encodedRef(5847, 3), 2 * boardIndex.stride);
  membership.data.writeUInt32LE(encodedRef(4168, userRows.capacity), 3 * membership.stride);

  assert.throws(() => findUserBoard(tables), /range|user-only/i);
});

test('findUserBoard rejects multiple eligible compact user rows', () => {
  const { boardIndex, membership, tables } = boardFixtures();
  boardIndex.data.writeUInt32LE(encodedRef(5847, 3), 2 * boardIndex.stride);
  boardIndex.data.writeUInt32LE(encodedRef(5847, 4), 3 * boardIndex.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 10), 3 * membership.stride);
  membership.data.writeUInt32LE(encodedRef(4168, 11), 4 * membership.stride);

  assert.throws(() => findUserBoard(tables), /uniquely|ambiguous/i);
});

test('readRange explicitly opts diagnostic reads into unsupported builds', async () => {
  const requests = [];
  const client = {
    async readMemory(request) {
      requests.push(request);
      return { ranges: [{ bytesHex: '00010203' }] };
    },
  };
  assert.deepEqual(await readRange(client, 0x1000n, 4), Buffer.from('00010203', 'hex'));
  assert.equal(requests[0].allowUnsupportedBuild, true);
});

test('validateAnchorReread rejects a changed table header', async () => {
  const table = TABLES.get(4168);
  const data = tableData(table);
  setFreeRow(table, data, 0);
  setContentRow(table, data, 1);
  const candidate = {
    header: 0x1000n,
    base: deriveDataAddress(table, 0x1000n),
    data,
    score: scoreCandidate(table, data),
    freelistHead: 0,
  };
  const requests = [];
  const client = {
    async readMemory(request) {
      requests.push(request);
      return { ranges: [{ bytesHex: Buffer.alloc(request.ranges[0].length).toString('hex') }] };
    },
  };

  await assert.rejects(() => validateAnchorReread(client, table, candidate), /header.*mismatch/i);
  assert.equal(requests[0].ranges[0].length, 16);
  assert.ok(requests.every((request) => request.allowUnsupportedBuild === true));
});

test('validateAnchorReread rejects a changed freelist head', async () => {
  const { table, candidate } = anchorFixture();
  const { client, requests } = rereadClient(table, candidate, { freelistHead: 8 });

  await assert.rejects(() => validateAnchorReread(client, table, candidate), /freelist.*mismatch/i);
  assert.ok(requests.every((request) => request.allowUnsupportedBuild === true));
});

test('validateAnchorReread rejects a changed representative free row', async () => {
  const { table, candidate } = anchorFixture();
  const changed = Buffer.from(candidate.data.subarray(0, table.stride));
  changed.writeUInt32LE(99, 0);
  const { client, requests } = rereadClient(table, candidate, { freeRow: changed });

  await assert.rejects(() => validateAnchorReread(client, table, candidate), /freeRow.*mismatch/i);
  assert.ok(requests.every((request) => request.allowUnsupportedBuild === true));
});

test('validateAnchorReread rejects a changed representative content row', async () => {
  const { table, candidate } = anchorFixture();
  const offset = table.stride;
  const changed = Buffer.from(candidate.data.subarray(offset, offset + table.stride));
  changed.writeUInt32LE(99, 12);
  const { client, requests } = rereadClient(table, candidate, { contentRow: changed });

  await assert.rejects(() => validateAnchorReread(client, table, candidate), /contentRow.*mismatch/i);
  assert.ok(requests.every((request) => request.allowUnsupportedBuild === true));
});

test('locateTable explicitly opts scans and validation reads into unsupported builds', async () => {
  const table = TABLES.get(4176);
  const header = 0x1000n;
  const base = deriveDataAddress(table, header);
  const data = tableData(table);
  setFreeRow(table, data, 0);
  const scanRequests = [];
  const readRequests = [];
  const client = {
    async scanMemoryPage(request) {
      scanRequests.push(request);
      return {
        complete: true,
        nextCursor: null,
        matches: [{ address: canonical(header), allocationBase: '0x1000', allocationSize: 0x10000 }],
      };
    },
    async readMemory(request) {
      readRequests.push(request);
      const range = request.ranges[0];
      const address = BigInt(range.address);
      let bytes = Buffer.alloc(range.length);
      if (address === base && range.length === data.length) bytes = data;
      if (address === header && range.length === 16) bytes = Buffer.from(signature(table), 'hex');
      if (address === base && range.length === table.stride) bytes = data.subarray(0, table.stride);
      return { ranges: [{ bytesHex: bytes.toString('hex') }] };
    },
  };

  const located = await locateTable(client, table, { log: () => {} });
  assert.equal(located.base, base);
  assert.equal(located.validation.header, true);
  assert.ok(scanRequests.every((request) => request.allowUnsupportedBuild === true));
  assert.ok(readRequests.every((request) => request.allowUnsupportedBuild === true));
});

test('locateTable rejects a positive candidate when bounded scanning never completes', async () => {
  const table = TABLES.get(4176);
  const header = 0x1000n;
  const base = deriveDataAddress(table, header);
  const data = tableData(table);
  setFreeRow(table, data, 0);
  let pages = 0;
  const client = {
    async scanMemoryPage() {
      pages += 1;
      return {
        complete: false,
        nextCursor: canonical(BigInt(pages + 1) * 0x1000n),
        matches: pages === 1 ? [{ address: canonical(header) }] : [],
      };
    },
    async readMemory(request) {
      const range = request.ranges[0];
      const bytes = BigInt(range.address) === base ? data : Buffer.alloc(range.length);
      return { ranges: [{ bytesHex: bytes.toString('hex') }] };
    },
  };

  await assert.rejects(() => locateTable(client, table, { log: () => {} }), /scan.*complete|incomplete/i);
  assert.equal(pages, 512);
});

test('live anchor consumes the reusable layer and records identity validation summaries', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'board-verification',
    'live-anchor.cjs'), 'utf8');
  assert.match(source, /require\(['"]\.\/reanchor-lib\.cjs['"]\)/);
  assert.doesNotMatch(source, /const TABLES\s*=/);
  assert.doesNotMatch(source, /function signature\(/);
  assert.match(source, /executableSha256/);
  assert.match(source, /sessionIdentity/);
  assert.match(source, /validationSummaries/);
});

test('live snapshot behavior rejects identity drift and opts every read into diagnostics', async () => {
  const priorExitCode = process.exitCode;
  let snapshot;
  try {
    snapshot = require('../scripts/board-verification/live-table-snapshot.cjs');
  } finally {
    process.exitCode = priorExitCode;
  }
  assert.equal(typeof snapshot.assertAnchorIdentity, 'function');
  assert.equal(typeof snapshot.readAnchoredTables, 'function');
  assert.throws(() => snapshot.assertAnchorIdentity(
    { pid: 7, executableSha256: 'AA' }, { pid: 8 }, 'AA'), /different game process/i);
  assert.throws(() => snapshot.assertAnchorIdentity(
    { pid: 7, executableSha256: 'AA' }, { pid: 7 }, 'BB'), /different game executable/i);

  const requests = [];
  const client = {
    async readMemory(request) {
      requests.push(request);
      return { ranges: [{ bytesHex: '00'.repeat(request.ranges[0].length) }] };
    },
  };
  const tables = await snapshot.readAnchoredTables(client, { tables: {
    4168: { dataBase: '0x1000', stride: 4, capacity: 2, freelistHeadValue: 0 },
    4176: { dataBase: '0x2000', stride: 4, capacity: 1, freelistHeadValue: 0 },
  } });
  assert.deepEqual(Object.keys(tables), ['4168', '4176']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.allowUnsupportedBuild === true));
});
