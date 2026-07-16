'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sdk = require('../../packages/sdk');

const TABLES = [
  { id: 4168, table1Length: 40444, words: 9, capacity: 1120, stride: 36, headerSize: 324, offsetStart: 0 },
  { id: 4176, table1Length: 19364, words: 1, capacity: 4830, stride: 4, headerSize: 244, offsetStart: 0 },
  { id: 4190, table1Length: 37560, words: 1, capacity: 9380, stride: 4, headerSize: 240, offsetStart: 0 },
  { id: 4251, table1Length: 1704, words: 3, capacity: 138, stride: 12, headerSize: 248, offsetStart: 0 },
  { id: 5790, table1Length: 77312, words: 3, capacity: 4830, stride: 12, headerSize: 265, offsetStart: 33, isArray: true },
  { id: 5847, table1Length: 19904, words: 35, capacity: 138, stride: 140, headerSize: 263, offsetStart: 31, isArray: true },
];

const OUTPUT = path.resolve(__dirname, '..', '..', '.frtk', 'board-verification', 'live-mirror-bases.json');

function canonical(value) {
  return `0x${value.toString(16).toUpperCase()}`;
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

function scoreCandidate(table, data) {
  let freeRows = 0;
  let contentRows = 0;
  const sampleRows = Math.min(table.capacity, 512);
  for (let row = 0; row < sampleRows; row += 1) {
    const offset = row * table.stride;
    const first = data.readUInt32LE(offset);
    let restZero = true;
    for (let byte = offset + 4; byte < offset + table.stride; byte += 4) {
      if (data.readUInt32LE(byte) !== 0) {
        restZero = false;
        break;
      }
    }
    if (first === row + 1 && restZero) freeRows += 1;

    if (table.id === 4168 && expectedRef(data.readUInt32LE(offset + 12), 4269)) contentRows += 1;
    if (table.id === 4251 && expectedRef(first, 5847, 138)) contentRows += 1;
    if (table.id === 5790 && expectedRef(first, 4190, 9380)) contentRows += 1;
    if (table.id === 5847) {
      const ref = decodeRef(first);
      if ((ref.tableId === 4168 || ref.tableId === 4288) && ref.row < 0x20000) contentRows += 1;
    }
  }
  return { freeRows, contentRows, score: freeRows + (contentRows * 8) };
}

async function readRange(client, address, length) {
  const result = await client.readMemory({ ranges: [{ address: canonical(address), length }] });
  return Buffer.from(result.ranges[0].bytesHex, 'hex');
}

async function locateTable(client, table) {
  process.stderr.write(`Locating table ${table.id}...\n`);
  const dataOffset = table.headerSize - 204 - table.offsetStart +
    (table.isArray ? table.capacity * 4 : 0);
  const candidates = [];
  let cursor = process.env.CFB27_SCAN_START || '0x380000000';
  let signatureMatches = 0;
  for (let pageNumber = 0; pageNumber < 512; pageNumber += 1) {
    const page = await client.scanMemoryPage({
      patternHex: signature(table),
      maskHex: 'FF'.repeat(16),
      maxMatches: 4,
      contextBefore: 0,
      contextAfter: 0,
      includeAllocationMetadata: true,
      cursor,
    });
    signatureMatches += page.matches.length;
    for (const match of page.matches) {
      const header = BigInt(match.address);
      const base = header + BigInt(dataOffset);
      try {
        const data = await readRange(client, base, table.capacity * table.stride);
        const score = scoreCandidate(table, data);
        if (score.score > 0) {
          candidates.push({ header, base, data, score, allocationBase: match.allocationBase, allocationSize: match.allocationSize });
        }
      } catch {
        // A signature at a page boundary can be valid while its derived region is not.
      }
    }
    if (candidates.length > 0 || page.complete) break;
    cursor = page.nextCursor;
    if (pageNumber > 0 && pageNumber % 16 === 0) process.stderr.write(`  scanned ${pageNumber + 1} pages...\n`);
  }
  candidates.sort((left, right) => right.score.score - left.score.score);
  if (candidates.length === 0 || candidates[0].score.score === 0) {
    throw new Error(`Table ${table.id} signatures failed structural validation`);
  }
  const selected = candidates[0];
  const head = (await readRange(client, selected.header + 24n, 4)).readUInt32LE(0);
  process.stderr.write(`  ${canonical(selected.base)} score=${selected.score.score} candidates=${candidates.length}\n`);
  return { ...table, ...selected, freelistHead: head, signatureMatches };
}

function findUserBoard(tables) {
  const boardIndex = tables.get(4251);
  const membership = tables.get(5847);
  const candidates = [];
  for (let boardRow = 0; boardRow < boardIndex.capacity; boardRow += 1) {
    const boardOffset = boardRow * boardIndex.stride;
    const boardRefValue = boardIndex.data.readUInt32LE(boardOffset);
    const boardRef = decodeRef(boardRefValue);
    if (boardRef.tableId !== 5847 || boardRef.row >= membership.capacity) continue;

    const membershipOffset = boardRef.row * membership.stride;
    let userRefs = 0;
    let cpuRefs = 0;
    let occupied = 0;
    let firstFreeSlot = -1;
    for (let slot = 0; slot < membership.words; slot += 1) {
      const value = membership.data.readUInt32LE(membershipOffset + slot * 4);
      if (value === 0) {
        if (firstFreeSlot < 0) firstFreeSlot = slot;
        continue;
      }
      occupied += 1;
      const ref = decodeRef(value);
      if (ref.tableId === 4168) userRefs += 1;
      if (ref.tableId === 4288) cpuRefs += 1;
    }
    candidates.push({
      boardRow,
      teamRow: boardRef.row,
      boardRefValue,
      occupied,
      userRefs,
      cpuRefs,
      firstFreeSlot,
    });
  }

  candidates.sort((left, right) =>
    (right.userRefs - left.userRefs) ||
    (left.cpuRefs - right.cpuRefs) ||
    (right.occupied - left.occupied));
  const selected = candidates.find((candidate) => candidate.userRefs > 0 && candidate.cpuRefs === 0);
  if (!selected) {
    throw new Error('Could not uniquely identify the user board from table 4168 membership references');
  }
  if (selected.firstFreeSlot < 0) throw new Error('The active recruiting board has no free membership slot');
  return { selected, candidates: candidates.slice(0, 8) };
}

async function main() {
  const game = await sdk.discoverGame();
  const client = sdk.createClient({ pid: game.pid, timeoutMs: 60_000 });
  const hello = await client.hello();
  if (!hello.capabilities.includes('researchWatch')) throw new Error('Loaded host does not support researchWatch');

  const located = [];
  for (const table of TABLES) located.push(await locateTable(client, table));
  const tables = new Map(located.map((table) => [table.id, table]));
  const board = findUserBoard(tables);
  const membership = tables.get(5847);
  const boardIndex = tables.get(4251);
  const freelist4168 = tables.get(4168).header + 24n;
  const membershipSlot = membership.base + BigInt(board.selected.teamRow * membership.stride + board.selected.firstFreeSlot * 4);

  const output = {
    capturedAt: new Date().toISOString(),
    pid: game.pid,
    supportedBuild: hello.supportedBuild,
    tables: Object.fromEntries(located.map((table) => [String(table.id), {
      headerSignature: canonical(table.header),
      dataBase: canonical(table.base),
      stride: table.stride,
      capacity: table.capacity,
      freelistHeadValue: table.freelistHead,
      score: table.score,
      signatureMatches: table.signatureMatches,
    }])),
    userBoard: {
      ...board.selected,
      boardIndexAddress: canonical(boardIndex.base + BigInt(board.selected.boardRow * boardIndex.stride)),
      membershipRowAddress: canonical(membership.base + BigInt(board.selected.teamRow * membership.stride)),
      firstFreeSlotAddress: canonical(membershipSlot),
    },
    captureAddresses: {
      table4168FreelistHead: canonical(freelist4168),
      firstFreeMembershipSlot: canonical(membershipSlot),
    },
    topBoardCandidates: board.candidates,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
