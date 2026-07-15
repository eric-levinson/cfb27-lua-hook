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

async function locateContiguousSurface(client, {
  rows, recordSize, hexField = 'beforeHex', maskField, label = 'surface',
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
  });
  if (!scan || scan.complete !== true || !Array.isArray(scan.matches)) {
    throw fail(`${label} live surface scan was incomplete`);
  }
  const candidateBases = new Set();
  for (const match of scan.matches) {
    const address = parseAddress(match.address);
    const displacement = BigInt(anchor.row) * BigInt(recordSize);
    if (address >= displacement) candidateBases.add(address - displacement);
  }
  const verified = [];
  const verificationRows = spreadRows(sorted);
  for (const base of candidateBases) {
    if (await candidateMatches(client, base, verificationRows, recordSize, hexField, maskField)) {
      verified.push(base);
    }
  }
  if (verified.length === 0) throw fail(`${label} live surface was not found`);
  if (verified.length !== 1) throw fail(`${label} live surface is ambiguous`);
  return formatAddress(verified[0]);
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
  const playerBase = await locateContiguousSurface(client, {
    rows: mirrorRows(plan.playerRows),
    recordSize: plan.playerRecordSize,
    maskField: 'maskHex',
    label: 'Player',
  });
  const recruitBase = await locateContiguousSurface(client, {
    rows: mirrorRows(plan.recruitRows),
    recordSize: plan.recruitRecordSize,
    maskField: 'maskHex',
    label: 'Recruit',
  });
  const playerStringsBase = await locateContiguousSurface(client, {
    rows: plan.playerRows,
    recordSize: PLAYER_STRING_SLOT_SIZE,
    hexField: 'beforeStringSlotHex',
    label: 'Player strings',
  });
  return Object.freeze({ playerBase, recruitBase, playerStringsBase });
}

module.exports = { locateContiguousSurface, locateLiveClassSurfaces };
