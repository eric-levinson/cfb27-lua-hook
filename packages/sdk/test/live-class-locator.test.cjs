'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  locateContiguousSurface,
  locateLiveClassSurfaces,
} = require('../src/live-class-locator.cjs');
const { toLiveMirrorHex } = require('../src/live-class-generator.cjs');

const addr = (value) => `0x${BigInt(value).toString(16).toUpperCase()}`;

function rowBytes(row, size, salt) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (row * 17 + index + salt) & 0xff;
  return bytes;
}

function makePlan() {
  const rows = [2, 4, 7, 9, 12];
  return {
    classSize: rows.length,
    playerRecordSize: 8,
    recruitRecordSize: 4,
    playerRows: rows.map((row) => ({
      row,
      beforeHex: rowBytes(row, 8, 3).toString('hex').toUpperCase(),
      maskHex: 'FFFFFFFFFFFFFFFF',
      beforeStringSlotHex: rowBytes(row, 138, 91).toString('hex').toUpperCase(),
    })),
    recruitRows: rows.map((row) => ({
      row,
      beforeHex: rowBytes(row, 4, 47).toString('hex').toUpperCase(),
      maskHex: 'FFFFFFFF',
    })),
  };
}

function surface(base, stride, rows, hexField, transform = false) {
  const maximum = Math.max(...rows.map((row) => row.row));
  const bytes = Buffer.alloc((maximum + 1) * stride, 0xee);
  for (const row of rows) {
    const value = transform ? toLiveMirrorHex(row[hexField]) : row[hexField];
    Buffer.from(value, 'hex').copy(bytes, row.row * stride);
  }
  return { base: BigInt(base), bytes };
}

function fakeClient(segments, options = {}) {
  const scans = [];
  const reads = [];
  return {
    scans,
    reads,
    async scanMemory(request) {
      scans.push(request);
      const pattern = Buffer.from(request.patternHex, 'hex');
      const mask = Buffer.from(request.maskHex, 'hex');
      const matches = [];
      for (const segment of segments) {
        for (let offset = 0; offset + pattern.length <= segment.bytes.length; offset += 1) {
          const candidate = segment.bytes.subarray(offset, offset + pattern.length);
          if (candidate.every((byte, index) =>
            (byte & mask[index]) === (pattern[index] & mask[index]))) {
            matches.push({ address: addr(segment.base + BigInt(offset)) });
          }
        }
      }
      return { supportedBuild: true, complete: true, scannedBytes: 1, matches };
    },
    async readMemory(request) {
      reads.push(request);
      if (options.shortRead) return { supportedBuild: true, ranges: [] };
      return {
        supportedBuild: true,
        ranges: request.ranges.map((range) => {
          const start = BigInt(range.address);
          const segment = segments.find((item) =>
            start >= item.base && start + BigInt(range.length) <= item.base + BigInt(item.bytes.length));
          if (!segment) return { address: range.address, length: range.length, bytesHex: '00'.repeat(range.length) };
          const offset = Number(start - segment.base);
          return {
            address: range.address,
            length: range.length,
            bytesHex: segment.bytes.subarray(offset, offset + range.length).toString('hex').toUpperCase(),
          };
        }),
      };
    },
  };
}

test('locates relocated Player, Recruit, and Player string surfaces', async () => {
  const plan = makePlan();
  const client = fakeClient([
    surface(0x10000000, 8, plan.playerRows, 'beforeHex', true),
    surface(0x20000000, 4, plan.recruitRows, 'beforeHex', true),
    surface(0x30000000, 138, plan.playerRows, 'beforeStringSlotHex'),
  ]);
  assert.deepEqual(await locateLiveClassSurfaces({ client, plan }), {
    playerBase: '0x10000000',
    recruitBase: '0x20000000',
    playerStringsBase: '0x30000000',
  });
  assert.equal(client.scans.length, 3);
  assert.ok(client.reads.every((request) => request.ranges.length >= 4));
});

test('selects the only candidate whose spread-out rows match', async () => {
  const plan = makePlan();
  const real = surface(0x40000000, 8, plan.playerRows, 'beforeHex');
  const decoy = surface(0x50000000, 8, plan.playerRows, 'beforeHex');
  decoy.bytes[4 * 8] ^= 0xff;
  const client = fakeClient([real, decoy]);
  assert.equal(await locateContiguousSurface(client, {
    rows: plan.playerRows,
    recordSize: 8,
    hexField: 'beforeHex',
    label: 'Player',
  }), '0x40000000');
});

test('fails closed on missing, ambiguous, or short-read surfaces', async () => {
  const plan = makePlan();
  await assert.rejects(locateContiguousSurface(fakeClient([]), {
    rows: plan.playerRows, recordSize: 8, hexField: 'beforeHex', label: 'Player',
  }), /not found/);

  await assert.rejects(locateContiguousSurface(fakeClient([
    surface(0x60000000, 8, plan.playerRows, 'beforeHex'),
    surface(0x70000000, 8, plan.playerRows, 'beforeHex'),
  ]), {
    rows: plan.playerRows, recordSize: 8, hexField: 'beforeHex', label: 'Player',
  }), /ambiguous/);

  await assert.rejects(locateContiguousSurface(fakeClient([
    surface(0x80000000, 8, plan.playerRows, 'beforeHex'),
  ], { shortRead: true }), {
    rows: plan.playerRows, recordSize: 8, hexField: 'beforeHex', label: 'Player',
  }), /not found/);
});
