'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodePackedReference,
  encodePackedReference,
  decodeField,
  encodeField,
} = require('../src/frtk-fields.cjs');

function syntheticRecord(length, seed) {
  return Buffer.from({ length }, (_, index) => (seed + (index * 0x31)) & 0xFF);
}

function encodeMsbFirstOracle(record, definition, numericValue) {
  const updated = Buffer.from(record);
  const width = BigInt(definition.bitWidth);
  const windowBits = BigInt(definition.storageBytes * 8);
  const shift = windowBits - BigInt(definition.bitOffset) - width;
  let storage = 0n;
  for (let index = 0; index < definition.storageBytes; index += 1) {
    storage = (storage << 8n) | BigInt(record[definition.byteOffset + index]);
  }
  const raw = numericValue < 0
    ? (1n << width) + BigInt(numericValue)
    : BigInt(numericValue);
  const fieldMask = ((1n << width) - 1n) << shift;
  storage = (storage & ~fieldMask) | ((raw << shift) & fieldMask);
  for (let index = definition.storageBytes - 1; index >= 0; index -= 1) {
    updated[definition.byteOffset + index] = Number(storage & 0xFFn);
    storage >>= 8n;
  }
  return updated;
}

function decodeLittleEndianLsbFirst(record, definition) {
  let storage = 0n;
  for (let index = 0; index < definition.storageBytes; index += 1) {
    storage |= BigInt(record[definition.byteOffset + index]) << BigInt(index * 8);
  }
  return Number((storage >> BigInt(definition.bitOffset)) &
    ((1n << BigInt(definition.bitWidth)) - 1n));
}

test('packed references round trip table and row identities', () => {
  assert.deepEqual(decodePackedReference(encodePackedReference({ tableId: 4288, rowIndex: 37 })), {
    tableId: 4288,
    rowIndex: 37,
  });
  assert.throws(() => encodePackedReference({ tableId: 0x8000, rowIndex: 0 }), /tableId/);
  assert.throws(() => encodePackedReference({ tableId: 1, rowIndex: 0x20000 }), /rowIndex/);
});

test('aligned packed references use big-endian record bytes', () => {
  const definition = {
    name: 'RecruitTarget', encoding: 'packed-reference', byteOffset: 0,
    storageBytes: 4, bitOffset: 0, bitWidth: 32, minimum: 0, maximum: 0xFFFFFFFF,
    referenceTableId: 4288,
  };
  const value = { tableId: 4288, rowIndex: 37 };
  const packed = encodePackedReference(value);
  const record = Buffer.alloc(4);
  record.writeUInt32BE(packed);

  assert.deepEqual(decodeField(record, definition), value);
  assert.deepEqual(encodeField(syntheticRecord(4, 0x17), definition, value), record);
  assert.notEqual(decodeLittleEndianLsbFirst(record, definition), packed);
});

test('MSB-first unaligned fields match synthetic golden vectors and preserve outer bits', () => {
  const unsigned = {
    name: 'UnsignedTen', encoding: 'bitfield', byteOffset: 1,
    storageBytes: 2, bitOffset: 3, bitWidth: 10, minimum: 0, maximum: 1023,
  };
  const unsignedOriginal = syntheticRecord(4, 0x29);
  const unsignedExpected = encodeMsbFirstOracle(unsignedOriginal, unsigned, 0x2D3);
  const unsignedEncoded = encodeField(unsignedOriginal, unsigned, 0x2D3);
  assert.deepEqual(unsignedEncoded, unsignedExpected);
  assert.equal(decodeField(unsignedExpected, unsigned), 0x2D3);
  assert.equal(unsignedEncoded[1] & 0xE0, unsignedOriginal[1] & 0xE0);
  assert.equal(unsignedEncoded[2] & 0x07, unsignedOriginal[2] & 0x07);
  assert.notEqual(decodeLittleEndianLsbFirst(unsignedExpected, unsigned), 0x2D3);

  const signed = {
    name: 'SignedEleven', encoding: 'signed', byteOffset: 1,
    storageBytes: 2, bitOffset: 2, bitWidth: 11, minimum: -1024, maximum: 1023,
  };
  const signedOriginal = syntheticRecord(4, 0x6B);
  const signedExpected = encodeMsbFirstOracle(signedOriginal, signed, -317);
  const signedEncoded = encodeField(signedOriginal, signed, -317);
  assert.deepEqual(signedEncoded, signedExpected);
  assert.equal(decodeField(signedExpected, signed), -317);
  assert.equal(signedEncoded[1] & 0xC0, signedOriginal[1] & 0xC0);
  assert.equal(signedEncoded[2] & 0x07, signedOriginal[2] & 0x07);
});

test('32-bit MSB-first fields may span five storage bytes', () => {
  const definition = {
    name: 'FiveByteWindow', encoding: 'unsigned', byteOffset: 1,
    storageBytes: 5, bitOffset: 4, bitWidth: 32, minimum: 0, maximum: 0xFFFFFFFF,
  };
  const original = syntheticRecord(8, 0x3D);
  const expected = encodeMsbFirstOracle(original, definition, 0x89ABCDEF);
  const encoded = encodeField(original, definition, 0x89ABCDEF);
  assert.deepEqual(encoded, expected);
  assert.equal(decodeField(expected, definition), 0x89ABCDEF);
  assert.equal(encoded[1] & 0xF0, original[1] & 0xF0);
  assert.equal(encoded[5] & 0x0F, original[5] & 0x0F);
});

test('cross-byte bitfields decode and preserve unrelated bits', () => {
  const definition = {
    name: 'CrossByte', encoding: 'bitfield', byteOffset: 0,
    storageBytes: 2, bitOffset: 5, bitWidth: 7, minimum: 0, maximum: 127,
  };
  const original = Buffer.from('A55A', 'hex');
  const updated = encodeField(original, definition, 73);
  assert.equal(decodeField(updated, definition), 73);
  assert.equal(updated[0] & 0xF8, original[0] & 0xF8);
  assert.equal(updated[1] & 0x0F, original[1] & 0x0F);
  assert.deepEqual(original, Buffer.from('A55A', 'hex'));
});

test('signed 11-bit fields round trip their legal extremes', () => {
  const definition = {
    name: 'SignedEleven', encoding: 'signed', byteOffset: 1,
    storageBytes: 2, bitOffset: 2, bitWidth: 11, minimum: -1024, maximum: 1023,
  };
  for (const value of [-1024, -17, 0, 1023]) {
    const encoded = encodeField(Buffer.from('AA55AA', 'hex'), definition, value);
    assert.equal(decodeField(encoded, definition), value);
    assert.equal(encoded[0], 0xAA);
    assert.equal(encoded[1] & 0xC0, 0x40);
    assert.equal(encoded[2] & 0x07, 0x02);
  }
  assert.throws(() => encodeField(Buffer.alloc(3), definition, -1025), /bounds|range/i);
});

test('offset-binary 11-bit fields add the declared minimum and preserve outer bits', () => {
  const definition = {
    name: 'FormattedScore', encoding: 'offset-binary', byteOffset: 1,
    storageBytes: 2, bitOffset: 2, bitWidth: 11, minimum: -200, maximum: 1847,
  };
  const original = syntheticRecord(4, 0x6B);
  const expected = encodeMsbFirstOracle(original, definition, 226);
  const encoded = encodeField(original, definition, 26);
  assert.deepEqual(encoded, expected);
  assert.equal(decodeField(expected, definition), 26);
  assert.equal(encoded[1] & 0xC0, original[1] & 0xC0);
  assert.equal(encoded[2] & 0x07, original[2] & 0x07);

  for (const value of [-17, 0, definition.maximum]) {
    assert.equal(decodeField(encodeField(original, definition, value), definition), value);
  }
  assert.throws(() => encodeField(original, definition, -201), /bounds/i);
  assert.throws(() => decodeField(original, { ...definition, maximum: 1848 }), /offset-binary range/i);
});

test('unsigned and packed-reference fields enforce definitions and record bounds', () => {
  const unsigned = {
    name: 'Count', encoding: 'unsigned', byteOffset: 0,
    storageBytes: 2, bitOffset: 0, bitWidth: 16, minimum: 10, maximum: 500,
  };
  assert.equal(decodeField(encodeField(Buffer.alloc(2), unsigned, 300), unsigned), 300);
  assert.throws(() => encodeField(Buffer.alloc(2), unsigned, 9), /bounds/i);
  assert.throws(() => decodeField(Buffer.alloc(1), unsigned), /record/i);
  assert.throws(() => decodeField(Buffer.alloc(4), { ...unsigned, bitWidth: 0 }), /bitWidth/i);
  assert.throws(() => decodeField(Buffer.alloc(8), { ...unsigned, storageBytes: 8, bitWidth: 33 }), /bitWidth/i);

  const reference = {
    name: 'RecruitTarget', encoding: 'packed-reference', byteOffset: 0,
    storageBytes: 4, bitOffset: 0, bitWidth: 32, minimum: 0, maximum: 0xFFFFFFFF,
    referenceTableId: 4288,
  };
  const value = { tableId: 4288, rowIndex: 91 };
  assert.deepEqual(decodeField(encodeField(Buffer.alloc(4), reference, value), reference), value);
  assert.throws(() => encodeField(Buffer.alloc(4), reference,
    { tableId: 5840, rowIndex: 91 }), /target/i);
});

test('signed definitions cannot claim values outside their bit width', () => {
  const invalid = {
    name: 'Invalid', encoding: 'signed', byteOffset: 0,
    storageBytes: 2, bitOffset: 0, bitWidth: 11, minimum: -1025, maximum: 1023,
  };
  assert.throws(() => decodeField(Buffer.alloc(2), invalid), /signed range/i);
});
