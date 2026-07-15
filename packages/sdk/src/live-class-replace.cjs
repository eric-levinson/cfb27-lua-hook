'use strict';

const { Cfb27HookError } = require('./errors.cjs');
const { PLAYER_STRING_SLOT_SIZE, toLiveMirrorHex } = require('./live-class-generator.cjs');

const READ_BATCH_SIZE = 64;
const WRITE_BATCH_SIZE = 32;
const ADDRESS = /^0x(?:0|[1-9A-F][0-9A-F]{0,15})$/;
const HEX = /^[0-9A-F]+$/;

function fail(code, message) {
  return new Cfb27HookError(code, message);
}

function formatAddress(value) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function rowAddress(base, row, stride) {
  return formatAddress(BigInt(base) + BigInt(row) * BigInt(stride));
}

function isHex(value, bytes) {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value);
}

function validatePatchRows(rows, size, { strings = false } = {}) {
  if (!Array.isArray(rows) || rows.length < 1 || !Number.isInteger(size) || size < 1) return false;
  const seen = new Set();
  for (const row of rows) {
    if (!row || !Number.isInteger(row.row) || row.row < 0 || seen.has(row.row) ||
        !isHex(row.beforeHex, size) || !isHex(row.maskHex, size) ||
        !isHex(row.valueHex, size)) return false;
    if (strings && (!isHex(row.beforeStringSlotHex, PLAYER_STRING_SLOT_SIZE) ||
        !isHex(row.stringValueHex, PLAYER_STRING_SLOT_SIZE) || !row.strings ||
        typeof row.strings.FirstName !== 'string' || !row.strings.FirstName ||
        typeof row.strings.LastName !== 'string' || !row.strings.LastName ||
        (row.strings.HomeTown !== undefined &&
          (typeof row.strings.HomeTown !== 'string' || !row.strings.HomeTown)))) return false;
    seen.add(row.row);
  }
  return true;
}

function validateInputs({ client, plan, surfaces, generation, dryRun }) {
  if (!client || typeof client.readMemory !== 'function' ||
      typeof client.writeTransaction !== 'function' ||
      !plan || !surfaces || !Number.isSafeInteger(generation) || generation < 0 ||
      typeof dryRun !== 'boolean' || !ADDRESS.test(surfaces.playerBase) ||
      !ADDRESS.test(surfaces.recruitBase) || !ADDRESS.test(surfaces.playerStringsBase) ||
      !Number.isInteger(plan.classSize) || plan.classSize < 1 ||
      plan.playerRows?.length !== plan.classSize || plan.recruitRows?.length !== plan.classSize ||
      !validatePatchRows(plan.playerRows, plan.playerRecordSize, { strings: true }) ||
      !validatePatchRows(plan.recruitRows, plan.recruitRecordSize)) {
    throw fail('LIVE_CLASS_PLAN_INVALID', 'Live recruit class plan is invalid');
  }
}

function applyMask(current, maskHex, valueHex) {
  const mask = Buffer.from(maskHex, 'hex');
  const value = Buffer.from(valueHex, 'hex');
  const replacement = Buffer.alloc(current.length);
  for (let index = 0; index < current.length; index += 1) {
    replacement[index] = (current[index] & (~mask[index] & 0xFF)) |
      (value[index] & mask[index]);
  }
  return replacement;
}

function buildStringMask(strings) {
  const mask = Buffer.alloc(PLAYER_STRING_SLOT_SIZE);
  mask.fill(0xFF, 0, 17);
  mask.fill(0xFF, 50, 71);
  if (typeof strings.HomeTown === 'string' && strings.HomeTown) {
    mask.fill(0xFF, 112, 138);
  }
  if (typeof strings.GenericHeadAssetName === 'string' && strings.GenericHeadAssetName) {
    mask.fill(0xFF, 17, 50);
  }
  return mask.toString('hex').toUpperCase();
}

function buildDescriptors(plan, surfaces) {
  const descriptors = [];
  for (const row of plan.playerRows) {
    descriptors.push({
      kind: 'player',
      address: rowAddress(surfaces.playerBase, row.row, plan.playerRecordSize),
      length: plan.playerRecordSize,
      maskHex: toLiveMirrorHex(row.maskHex),
      valueHex: toLiveMirrorHex(row.valueHex),
    });
  }
  for (const row of plan.recruitRows) {
    descriptors.push({
      kind: 'recruit',
      address: rowAddress(surfaces.recruitBase, row.row, plan.recruitRecordSize),
      length: plan.recruitRecordSize,
      maskHex: toLiveMirrorHex(row.maskHex),
      valueHex: toLiveMirrorHex(row.valueHex),
    });
  }
  for (const row of plan.playerRows) {
    descriptors.push({
      kind: 'names',
      address: rowAddress(surfaces.playerStringsBase, row.row, PLAYER_STRING_SLOT_SIZE),
      length: PLAYER_STRING_SLOT_SIZE,
      maskHex: buildStringMask(row.strings),
      valueHex: row.stringValueHex,
    });
  }
  return descriptors;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function readDescriptors(client, descriptors) {
  const bytes = [];
  for (const batch of chunks(descriptors, READ_BATCH_SIZE)) {
    const result = await client.readMemory({
      ranges: batch.map((item) => ({ address: item.address, length: item.length })),
    });
    if (!result || !Array.isArray(result.ranges) || result.ranges.length !== batch.length) {
      throw fail('LIVE_CLASS_APPLY_FAILED', 'Live recruit class snapshot could not be verified');
    }
    for (let index = 0; index < batch.length; index += 1) {
      const range = result.ranges[index];
      if (!range || range.address !== batch[index].address ||
          range.length !== batch[index].length || !isHex(range.bytesHex, batch[index].length)) {
        throw fail('LIVE_CLASS_APPLY_FAILED', 'Live recruit class snapshot could not be verified');
      }
      bytes.push(Buffer.from(range.bytesHex, 'hex'));
    }
  }
  return bytes;
}

function makeOperations(descriptors, snapshots) {
  const operations = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const current = snapshots[index];
    const replacement = applyMask(current, descriptor.maskHex, descriptor.valueHex);
    if (!current.equals(replacement)) {
      operations.push({
        kind: descriptor.kind,
        address: descriptor.address,
        expectedHex: current.toString('hex').toUpperCase(),
        replacementHex: replacement.toString('hex').toUpperCase(),
      });
    }
  }
  return operations;
}

function transactionOperations(batch, reverse = false) {
  return batch.map((operation) => ({
    address: operation.address,
    expectedHex: reverse ? operation.replacementHex : operation.expectedHex,
    replacementHex: reverse ? operation.expectedHex : operation.replacementHex,
  }));
}

async function verifyBatch(client, batch, expectedKey) {
  const actual = await readDescriptors(client, batch.map((operation) => ({
    address: operation.address,
    length: operation[expectedKey].length / 2,
  })));
  for (let index = 0; index < batch.length; index += 1) {
    if (actual[index].toString('hex').toUpperCase() !== batch[index][expectedKey]) {
      throw new Error('batch verification failed');
    }
  }
}

async function rollbackBatches(client, applied, generation) {
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    const batch = applied[index];
    const rollbackNumber = applied.length - index;
    await client.writeTransaction({
      transactionId: `live-class-${generation}-rollback-${rollbackNumber}`,
      operations: transactionOperations(batch, true),
    });
    await verifyBatch(client, batch, 'expectedHex');
  }
}

function buildResult(plan, operations, status, batchesApplied, plannedBatches) {
  const count = (kind) => operations.filter((operation) => operation.kind === kind).length;
  return Object.freeze({
    status,
    classSize: plan.classSize,
    plannedBatches,
    batchesApplied,
    playerRowsWritten: count('player'),
    recruitRowsWritten: count('recruit'),
    nameSlotsWritten: count('names'),
    optionalSkipped: Object.freeze({
      portraits: plan.playerRows.filter((row) => !row.strings.GenericHeadAssetName).length,
      gear: Number.isInteger(plan.gearSkipped) ? plan.gearSkipped : plan.classSize,
    }),
    rollbackStatus: 'not_needed',
  });
}

async function replaceLiveClass({ client, plan, surfaces, generation, dryRun = false }) {
  validateInputs({ client, plan, surfaces, generation, dryRun });
  const descriptors = buildDescriptors(plan, surfaces);
  let snapshots;
  try {
    snapshots = await readDescriptors(client, descriptors);
  } catch (error) {
    if (error?.code === 'LIVE_CLASS_APPLY_FAILED') throw error;
    throw fail('LIVE_CLASS_APPLY_FAILED', 'Live recruit class snapshot failed before any writes');
  }
  const operations = makeOperations(descriptors, snapshots);
  const batches = chunks(operations, WRITE_BATCH_SIZE);
  if (dryRun) return buildResult(plan, operations, 'dry_run', 0, batches.length);

  const applied = [];
  try {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      await client.writeTransaction({
        transactionId: `live-class-${generation}-forward-${index + 1}`,
        operations: transactionOperations(batch),
      });
      applied.push(batch);
      await verifyBatch(client, batch, 'replacementHex');
    }
  } catch {
    try {
      await rollbackBatches(client, applied, generation);
    } catch {
      throw fail('LIVE_CLASS_ROLLBACK_FAILED',
        'Live recruit class write failed and automatic rollback could not be verified');
    }
    throw fail('LIVE_CLASS_APPLY_FAILED',
      'Live recruit class write failed; every applied batch was rolled back and verified');
  }

  return buildResult(plan, operations, 'applied_verified', batches.length, batches.length);
}

module.exports = { replaceLiveClass };
