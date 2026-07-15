'use strict';

const { PLAYER_STRING_SLOT_SIZE, toLiveMirrorHex } = require('./live-class-generator.cjs');

function fail(message) {
  const error = new Error(message);
  error.code = 'LIVE_CLASS_SURFACE_UNVERIFIED';
  return error;
}

function parseAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9A-Fa-f]+$/.test(value)) {
    throw fail('live surface returned an invalid address');
  }
  return BigInt(value);
}

function formatAddress(value) {
  if (value < 0n) throw fail('live surface address underflowed');
  return `0x${value.toString(16).toUpperCase()}`;
}

function validateRows(rows, recordSize, hexField, maskField, label) {
  if (!Array.isArray(rows) || rows.length < 4 || !Number.isInteger(recordSize) ||
      recordSize < 1 || typeof hexField !== 'string') {
    throw fail(`${label} locator requires at least four valid rows`);
  }
  for (const row of rows) {
    if (!row || !Number.isInteger(row.row) || row.row < 0 ||
        typeof row[hexField] !== 'string' ||
        !/^[0-9A-F]+$/.test(row[hexField]) || row[hexField].length !== recordSize * 2 ||
        (maskField && (typeof row[maskField] !== 'string' ||
          !/^[0-9A-F]+$/.test(row[maskField]) || row[maskField].length !== recordSize * 2))) {
      throw fail(`${label} locator row is malformed`);
    }
  }
}

function spreadRows(rows) {
  const indexes = [0, Math.floor((rows.length - 1) / 3),
    Math.floor(((rows.length - 1) * 2) / 3), rows.length - 1];
  const selected = [];
  const seen = new Set();
  for (const index of indexes) {
    const row = rows[index];
    if (!seen.has(row.row)) {
      selected.push(row);
      seen.add(row.row);
    }
  }
  for (const row of rows) {
    if (selected.length >= 4) break;
    if (!seen.has(row.row)) {
      selected.push(row);
      seen.add(row.row);
    }
  }
  if (selected.length < 4) throw fail('live surface needs four distinct verification rows');
  return selected;
}

function maskedEqual(actualHex, expectedHex, maskHex) {
  if (!maskHex) return actualHex === expectedHex;
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const mask = Buffer.from(maskHex, 'hex');
  return actual.every((byte, index) => (byte & mask[index]) === (expected[index] & mask[index]));
}

async function candidateMatches(client, base, verificationRows, recordSize, hexField, maskField) {
  const ranges = verificationRows.map((row) => ({
    address: formatAddress(base + BigInt(row.row) * BigInt(recordSize)),
    length: recordSize,
  }));
  let result;
  try {
    result = await client.readMemory({ ranges });
  } catch {
    return false;
  }
  if (!result || !Array.isArray(result.ranges) || result.ranges.length !== ranges.length) {
    return false;
  }
  for (let index = 0; index < ranges.length; index += 1) {
    const actual = result.ranges[index];
    if (!actual || actual.length !== recordSize ||
        parseAddress(actual.address) !== parseAddress(ranges[index].address) ||
        !maskedEqual(actual.bytesHex, verificationRows[index][hexField],
          maskField ? verificationRows[index][maskField] : undefined)) {
      return false;
    }
  }
  return true;
}

async function locateContiguousSurfaceDetailed(client, {
  rows, recordSize, hexField = 'beforeHex', maskField, label = 'surface',
  preferredAllocationBase,
}) {
  if (!client || typeof client.scanMemory !== 'function' ||
      typeof client.readMemory !== 'function') {
    throw fail(`${label} locator requires memory scan and read support`);
  }
  validateRows(rows, recordSize, hexField, maskField, label);
  const sorted = [...rows].sort((left, right) => left.row - right.row);
  const anchor = rows[0];
  const scan = await client.scanMemory({
    patternHex: anchor[hexField],
    maskHex: maskField ? anchor[maskField] : 'FF'.repeat(recordSize),
    maxMatches: 64,
    contextBefore: 0,
    contextAfter: 0,
    maxPages: 4096,
    includeAllocationMetadata: true,
  });
  if (!scan || scan.complete !== true || !Array.isArray(scan.matches)) {
    throw fail(`${label} live surface scan was incomplete`);
  }
  const candidateBases = new Map();
  for (const match of scan.matches) {
    const address = parseAddress(match.address);
    const displacement = BigInt(anchor.row) * BigInt(recordSize);
    if (address >= displacement) {
      const base = address - displacement;
      candidateBases.set(base.toString(), {
        base,
        allocationBase: typeof match.allocationBase === 'string'
          ? parseAddress(match.allocationBase) : null,
        allocationSize: Number.isSafeInteger(match.allocationSize) && match.allocationSize > 0
          ? match.allocationSize : null,
      });
    }
  }
  const verified = [];
  const verificationRows = spreadRows(sorted);
  for (const candidate of candidateBases.values()) {
    if (await candidateMatches(client, candidate.base, verificationRows,
      recordSize, hexField, maskField)) {
      verified.push(candidate);
    }
  }
  if (verified.length === 0) throw fail(`${label} live surface was not found`);
  let selected = verified;
  if (selected.length > 1 && typeof preferredAllocationBase === 'bigint') {
    selected = selected.filter((candidate) =>
      candidate.allocationBase === preferredAllocationBase);
  }
  if (selected.length !== 1) throw fail(`${label} live surface is ambiguous`);
  return Object.freeze({
    base: formatAddress(selected[0].base),
    allocationBase: selected[0].allocationBase,
    allocationSize: selected[0].allocationSize,
  });
}

async function locateContiguousSurface(client, options) {
  return (await locateContiguousSurfaceDetailed(client, options)).base;
}

async function locateLiveClassSurfaces({ client, plan }) {
  if (!plan || !Array.isArray(plan.playerRows) || !Array.isArray(plan.recruitRows)) {
    throw fail('live class plan is invalid');
  }
  const mirrorRows = (rows) => rows.map((row) => ({
    ...row,
    beforeHex: toLiveMirrorHex(row.beforeHex),
    maskHex: toLiveMirrorHex(row.maskHex),
  }));
  const player = await locateContiguousSurfaceDetailed(client, {
    rows: mirrorRows(plan.playerRows),
    recordSize: plan.playerRecordSize,
    label: 'Player',
  });
  const recruit = await locateContiguousSurfaceDetailed(client, {
    rows: mirrorRows(plan.recruitRows),
    recordSize: plan.recruitRecordSize,
    label: 'Recruit',
  });
  const nextPlayerAllocation = player.allocationBase !== null && player.allocationSize !== null
    ? player.allocationBase + BigInt(player.allocationSize) : undefined;
  const playerStrings = await locateContiguousSurfaceDetailed(client, {
    rows: plan.playerRows,
    recordSize: PLAYER_STRING_SLOT_SIZE,
    hexField: 'beforeStringSlotHex',
    label: 'Player strings',
    preferredAllocationBase: nextPlayerAllocation,
  });
  return Object.freeze({
    playerBase: player.base,
    recruitBase: recruit.base,
    playerStringsBase: playerStrings.base,
  });
}

module.exports = { locateContiguousSurface, locateLiveClassSurfaces };
