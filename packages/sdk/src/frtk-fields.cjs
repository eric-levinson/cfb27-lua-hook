'use strict';

const { isSafeIntegerBetween } = require('./validation.cjs');

const MAX_TABLE_ID = 0x7FFF;
const MAX_ROW_INDEX = 0x1FFFF;

function encodePackedReference({ tableId, rowIndex } = {}) {
  if (!isSafeIntegerBetween(tableId, 0, MAX_TABLE_ID)) {
    throw new RangeError('tableId must be a 15-bit unsigned integer');
  }
  if (!isSafeIntegerBetween(rowIndex, 0, MAX_ROW_INDEX)) {
    throw new RangeError('rowIndex must be a 17-bit unsigned integer');
  }
  return Number((BigInt(tableId) << 17n) | BigInt(rowIndex));
}

function decodePackedReference(value) {
  if (!isSafeIntegerBetween(value, 0, 0xFFFFFFFF)) {
    throw new RangeError('Packed reference must be a 32-bit unsigned integer');
  }
  return {
    tableId: Number(BigInt(value) >> 17n),
    rowIndex: Number(BigInt(value) & 0x1FFFFn),
  };
}

function normalizeDefinition(record, definition) {
  if (!Buffer.isBuffer(record)) throw new TypeError('record must be a Buffer');
  if (!definition || typeof definition !== 'object') throw new TypeError('definition is required');
  const { byteOffset, storageBytes, bitOffset, bitWidth, encoding } = definition;
  if (!isSafeIntegerBetween(bitWidth, 1, 32)) {
    throw new RangeError('bitWidth must be from 1 through 32');
  }
  if (!isSafeIntegerBetween(byteOffset, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(storageBytes, 1, 5) || byteOffset + storageBytes > record.length) {
    throw new RangeError('Field storage exceeds the record bounds');
  }
  if (!isSafeIntegerBetween(bitOffset, 0, storageBytes * 8 - 1) ||
      bitOffset + bitWidth > storageBytes * 8) {
    throw new RangeError('Field bit range exceeds its storage');
  }
  if (!['unsigned', 'signed', 'offset-binary', 'bitfield', 'packed-reference'].includes(encoding)) {
    throw new TypeError(`Unsupported field encoding: ${encoding}`);
  }
  if (encoding === 'packed-reference' && (storageBytes !== 4 || bitOffset !== 0 || bitWidth !== 32)) {
    throw new RangeError('Packed-reference fields must occupy exactly 32 bits');
  }
  const signedMinimum = -(2 ** (bitWidth - 1));
  const signedMaximum = (2 ** (bitWidth - 1)) - 1;
  const isOffsetBinary = encoding === 'offset-binary';
  const legalMinimum = encoding === 'signed' ? signedMinimum : isOffsetBinary ? Number.MIN_SAFE_INTEGER : 0;
  const legalMaximum = encoding === 'signed' ? signedMaximum : isOffsetBinary ? Number.MAX_SAFE_INTEGER : Number((1n << BigInt(bitWidth)) - 1n);
  if (!isSafeIntegerBetween(definition.minimum, legalMinimum, legalMaximum) ||
      !isSafeIntegerBetween(definition.maximum, legalMinimum, legalMaximum) ||
      definition.minimum > definition.maximum) {
    throw new RangeError(encoding === 'signed'
      ? 'Definition declares an illegal signed range'
      : 'Definition declares an illegal unsigned range');
  }
  if (isOffsetBinary &&
      BigInt(definition.maximum) - BigInt(definition.minimum) >= (1n << BigInt(bitWidth))) {
    throw new RangeError('Definition declares an illegal offset-binary range');
  }
  return { byteOffset, storageBytes, bitOffset, bitWidth, encoding };
}

function readStorage(record, byteOffset, storageBytes) {
  let result = 0n;
  for (let index = 0; index < storageBytes; index += 1) {
    result = (result << 8n) | BigInt(record[byteOffset + index]);
  }
  return result;
}

function extractRaw(record, normalized) {
  const mask = (1n << BigInt(normalized.bitWidth)) - 1n;
  const shift = BigInt((normalized.storageBytes * 8) - normalized.bitOffset -
    normalized.bitWidth);
  return (readStorage(record, normalized.byteOffset, normalized.storageBytes) >>
    shift) & mask;
}

function decodeField(record, definition) {
  const normalized = normalizeDefinition(record, definition);
  const raw = extractRaw(record, normalized);
  if (normalized.encoding === 'packed-reference') return decodePackedReference(Number(raw));
  if (normalized.encoding === 'offset-binary') return Number(raw) + definition.minimum;
  if (normalized.encoding !== 'signed') return Number(raw);
  const sign = 1n << BigInt(normalized.bitWidth - 1);
  return Number((raw & sign) === 0n ? raw : raw - (1n << BigInt(normalized.bitWidth)));
}

function encodeField(record, definition, value) {
  const normalized = normalizeDefinition(record, definition);
  let numericValue = value;
  if (normalized.encoding === 'packed-reference') {
    if (definition.referenceTableId !== value?.tableId) {
      throw new RangeError('Packed reference does not match the declared target table');
    }
    numericValue = encodePackedReference(value);
  }
  if (!Number.isSafeInteger(numericValue) || numericValue < definition.minimum ||
      numericValue > definition.maximum) {
    throw new RangeError('Field value is outside its declared bounds');
  }
  const width = BigInt(normalized.bitWidth);
  const storedValue = normalized.encoding === 'offset-binary'
    ? numericValue - definition.minimum
    : numericValue;
  const raw = storedValue < 0 ? (1n << width) + BigInt(storedValue) : BigInt(storedValue);
  const shift = BigInt((normalized.storageBytes * 8) - normalized.bitOffset -
    normalized.bitWidth);
  const fieldMask = ((1n << width) - 1n) << shift;
  const storage = readStorage(record, normalized.byteOffset, normalized.storageBytes);
  const updatedStorage = (storage & ~fieldMask) |
    ((raw << shift) & fieldMask);
  const updated = Buffer.from(record);
  let remaining = updatedStorage;
  for (let index = normalized.storageBytes - 1; index >= 0; index -= 1) {
    updated[normalized.byteOffset + index] = Number(
      remaining & 0xFFn,
    );
    remaining >>= 8n;
  }
  return updated;
}

module.exports = { decodePackedReference, encodePackedReference, decodeField, encodeField };
