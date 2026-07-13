'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasExactKeys,
  hasOnlyKeys,
  isSafeIntegerBetween,
  isUpperHexBytes,
  isValidUtf8BoundedString,
  canonicalStringify,
} = require('../src/validation.cjs');

test('generic validators enforce exact and allowed object keys', () => {
  assert.equal(hasExactKeys({ b: 2, a: 1 }, ['a', 'b']), true);
  assert.equal(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b']), false);
  assert.equal(hasExactKeys([], []), false);
  assert.equal(hasOnlyKeys({ a: 1 }, ['a', 'b']), true);
  assert.equal(hasOnlyKeys({ c: 1 }, ['a', 'b']), false);
});

test('UTF-8 string validation rejects lone surrogates and measures encoded bytes', () => {
  assert.equal(isValidUtf8BoundedString('é'.repeat(64), 128), true);
  assert.equal(isValidUtf8BoundedString('é'.repeat(64) + 'a', 128), false);
  assert.equal(isValidUtf8BoundedString('\uD800', 128), false);
  assert.equal(isValidUtf8BoundedString('\uDC00', 128), false);
});

test('bounded integer validator rejects unsafe, fractional, and out-of-range values', () => {
  assert.equal(isSafeIntegerBetween(0, 0, 2), true);
  assert.equal(isSafeIntegerBetween(2, 0, 2), true);
  for (const value of [-1, 3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isSafeIntegerBetween(value, 0, 2), false);
  }
});

test('hex validator accepts only uppercase even-length byte strings', () => {
  assert.equal(isUpperHexBytes('00A5FF'), true);
  for (const value of ['', '0', 'ABC', '00a5', 'GG', 12]) {
    assert.equal(isUpperHexBytes(value), false);
  }
});

test('canonical serialization orders nested object keys deterministically', () => {
  const left = { z: 1, a: { y: 2, x: 3 }, list: [{ b: 2, a: 1 }] };
  const right = { list: [{ a: 1, b: 2 }], a: { x: 3, y: 2 }, z: 1 };
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(canonicalStringify(left),
    '{"a":{"x":3,"y":2},"list":[{"a":1,"b":2}],"z":1}');
  assert.throws(() => canonicalStringify({ value: undefined }), /JSON value/i);
});
