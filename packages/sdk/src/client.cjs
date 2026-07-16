'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { Cfb27HookError } = require('./errors.cjs');
const { encodeFrame, FrameDecoder } = require('./frame.cjs');
const { discoverGame } = require('./process.cjs');
const {
  isObject,
  hasExactKeys,
  hasOnlyKeys,
  isSafeIntegerBetween,
  isUpperHexBytes,
  isValidUtf8BoundedString,
} = require('./validation.cjs');

const MEMORY_LIMITS = Object.freeze({
  minPatternBytes: 8,
  maxPatternBytes: 4096,
  maxMatches: 64,
  maxContextBytes: 512,
  maxScanPageBytes: 32 * 1024 * 1024,
  maxPages: 4096,
  maxReadRanges: 64,
  maxReadRangeBytes: 64 * 1024,
  maxReadBytes: 256 * 1024,
});

const CANONICAL_ADDRESS = /^0x(?:0|[1-9A-F][0-9A-F]{0,15})$/;
const TELEMETRY_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const TRANSACTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_TELEMETRY_TYPES = new Set(['game_ready', 'tick', 'log']);
const PIPE_CONNECT_RETRY_DELAY_MS = 10;
const MAX_UINT64 = 0xFFFFFFFFFFFFFFFFn;
const NATIVE_CALL_CAPABILITY = 'nativeCall';
const BOARD_MUTATION_CAPABILITY = 'boardMutationV1';
const WRITE_TRANSACTION_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Host rejected the write transaction request',
  UNSUPPORTED_BUILD: 'Memory writes require the supported game build',
  MEMORY_ACCESS_DENIED: 'Transaction memory is not available for writing',
  MEMORY_MISMATCH: 'Live memory does not match the transaction preflight',
  TRANSACTION_LIMIT_EXCEEDED: 'Transaction exceeds an operation or byte limit',
  TRANSACTION_APPLY_FAILED: 'Transaction failed and was rolled back',
  ROLLBACK_VERIFICATION_FAILED: 'Transaction rollback could not be verified',
  SESSION_WRITES_DISABLED: 'Writes are disabled for this host session',
  HOST_NOT_READY: 'Could not connect to the Lua host',
  PIPE_TIMEOUT: 'Lua host transaction request timed out',
  PROTOCOL_MISMATCH: 'Host protocol version does not match',
  INVALID_RESPONSE: 'Host returned an invalid writeTransaction response',
});
const HOST_WRITE_TRANSACTION_ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'UNSUPPORTED_BUILD',
  'MEMORY_ACCESS_DENIED',
  'MEMORY_MISMATCH',
  'TRANSACTION_LIMIT_EXCEEDED',
  'TRANSACTION_APPLY_FAILED',
  'ROLLBACK_VERIFICATION_FAILED',
  'SESSION_WRITES_DISABLED',
]);
const FRTK_CAPABILITIES = Object.freeze({
  profile: 'frtkProfileV1',
  catalog: 'frtkCatalogV1',
  read: 'frtkRecordReadV1',
  transaction: 'frtkFieldTransactionV1',
});
const FRTK_ERROR_MESSAGES = Object.freeze({
  FRTK_PROFILE_INVALID: 'FrTk profile is invalid',
  FRTK_DISCOVERY_FAILED: 'Required FrTk tables were not resolved',
  FRTK_DISCOVERY_TIMEOUT: 'FrTk discovery exceeded its native operation budget',
  FRTK_CATALOG_STALE: 'FrTk catalog generation is stale',
  FRTK_FIELD_INVALID: 'FrTk field or value is invalid',
  FRTK_AUTHORITY_UNPROVEN: 'FrTk write authority is unproven',
  MEMORY_ACCESS_DENIED: 'FrTk memory access was denied',
  UNSUPPORTED_BUILD: 'FrTk profile does not match the supported build',
  TRANSACTION_APPLY_FAILED: 'FrTk transaction failed and was rolled back',
  ROLLBACK_VERIFICATION_FAILED: 'FrTk transaction rollback could not be verified',
  SESSION_WRITES_DISABLED: 'Writes are disabled for this host session',
  INVALID_REQUEST: 'Host rejected the FrTk request',
  INVALID_RESPONSE: 'Host returned an invalid FrTk response',
  HOST_NOT_READY: 'Could not connect to the Lua host',
  PIPE_TIMEOUT: 'Lua host FrTk request timed out',
  PROTOCOL_MISMATCH: 'Host protocol version does not match',
});
const FRTK_AUTHORITY = new Set(['discovery_only', 'commit_adapter_required', 'direct_verified']);
const FRTK_FIELD_ENCODINGS = new Set([
  'unsigned', 'signed', 'offset-binary', 'bitfield', 'packed-reference',
]);
const FRTK_REASONS = new Set(['caller_transition', 'save_changed', 'shutdown']);
const FRTK_TRANSACTION_ID = /^[A-Za-z0-9._-]{1,64}$/;

function cloneJsonValue(value, depth = 0) {
  if (depth > 32) throw invalidRequest('FrTk profile nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item, depth + 1));
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidRequest('FrTk profile must contain only JSON values');
  }
  const clone = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(clone, key, {
      value: cloneJsonValue(item, depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return clone;
}

function requireFrtkArtifactString(value, label) {
  if (!isValidUtf8BoundedString(value, 128)) {
    throw invalidRequest(`${label} must use 1..128 valid UTF-8 bytes`);
  }
}

function validateFrtkProfileTable(table) {
  if (!hasExactKeys(table, ['logicalName', 'tableId', 'uniqueId', 'capacity', 'recordSize',
    'rows', 'relationships']) || !Array.isArray(table.rows) ||
      !Array.isArray(table.relationships)) {
    throw invalidRequest('FrTk profile table is malformed');
  }
  requireFrtkArtifactString(table.logicalName, 'FrTk profile table name');
  for (const row of table.rows) {
    if (!hasExactKeys(row, ['rowIndex', 'patternHex', 'maskHex']) ||
        !isUpperHexBytes(row.patternHex) || row.patternHex.length > 8192 ||
        !isUpperHexBytes(row.maskHex) || row.maskHex.length > 8192) {
      throw invalidRequest('FrTk row evidence strings are malformed');
    }
  }
  for (const relationship of table.relationships) {
    if (!hasExactKeys(relationship,
      ['sourceRow', 'fieldName', 'targetTableId', 'targetRow'])) {
      throw invalidRequest('FrTk relationship is malformed');
    }
    requireFrtkArtifactString(relationship.fieldName, 'FrTk relationship field name');
  }
}

function validateFrtkLayoutTable(table) {
  if (!hasExactKeys(table, ['logicalName', 'tableId', 'uniqueId', 'capacity', 'recordSize',
    'authorityStatus', 'fields']) || !Array.isArray(table.fields) ||
      !FRTK_AUTHORITY.has(table.authorityStatus)) {
    throw invalidRequest('FrTk layout table is malformed');
  }
  requireFrtkArtifactString(table.logicalName, 'FrTk layout table name');
  for (const field of table.fields) {
    if (!hasExactKeys(field, ['name', 'encoding', 'byteOffset', 'storageBytes', 'bitOffset',
      'bitWidth', 'minimum', 'maximum', 'referenceTableId']) ||
        !FRTK_FIELD_ENCODINGS.has(field.encoding)) {
      throw invalidRequest('FrTk layout field is malformed');
    }
    requireFrtkArtifactString(field.name, 'FrTk layout field name');
  }
}

function validateFrtkBundleStrings(bundle) {
  const { profile, layout } = bundle;
  if (!hasExactKeys(profile,
    ['formatVersion', 'profileId', 'schemaIdentity', 'buildIdentity', 'tables']) ||
      !hasExactKeys(layout, ['formatVersion', 'schemaIdentity', 'buildIdentity', 'tables']) ||
      profile.formatVersion !== 1 || layout.formatVersion !== 1 ||
      !/^[0-9A-F]{64}$/.test(profile.profileId) ||
      !Array.isArray(profile.tables) || !Array.isArray(layout.tables) ||
      profile.tables.length < 1 || profile.tables.length > 256 ||
      layout.tables.length < 1 || layout.tables.length > 256) {
    throw invalidRequest('FrTk version-1 profile bundle is malformed');
  }
  requireFrtkArtifactString(profile.schemaIdentity, 'FrTk profile schema identity');
  requireFrtkArtifactString(profile.buildIdentity, 'FrTk profile build identity');
  requireFrtkArtifactString(layout.schemaIdentity, 'FrTk layout schema identity');
  requireFrtkArtifactString(layout.buildIdentity, 'FrTk layout build identity');
  if (profile.schemaIdentity !== layout.schemaIdentity ||
      profile.buildIdentity !== layout.buildIdentity) {
    throw invalidRequest('FrTk profile and layout identities do not match');
  }
  for (const table of profile.tables) validateFrtkProfileTable(table);
  for (const table of layout.tables) validateFrtkLayoutTable(table);
}

function cloneFrtkBundle(bundle) {
  if (!hasExactKeys(bundle, ['profile', 'layout']) || !isObject(bundle.profile) ||
      !isObject(bundle.layout)) throw invalidRequest('loadFrtkProfile requires profile and layout');
  const clone = cloneJsonValue(bundle);
  validateFrtkBundleStrings(clone);
  if (JSON.stringify(clone).length > 1024 * 1024) {
    throw invalidRequest('FrTk profile exceeds the supported size');
  }
  return clone;
}

function cloneGenerationOptions(options) {
  if (!hasExactKeys(options, ['generation']) ||
      !isSafeIntegerBetween(options.generation, 1, Number.MAX_SAFE_INTEGER)) {
    throw invalidRequest('FrTk catalog generation is invalid');
  }
  return { generation: options.generation };
}

function cloneFieldNames(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 64) {
    throw invalidRequest('FrTk field list must contain 1 to 64 names');
  }
  const seen = new Set();
  return fields.map((field) => {
    if (!isValidUtf8BoundedString(field) || seen.has(field)) {
      throw invalidRequest('FrTk field names must be unique bounded strings');
    }
    seen.add(field);
    return field;
  });
}

function cloneRecordOptions(options) {
  if (!hasExactKeys(options, ['generation', 'records']) ||
      !isSafeIntegerBetween(options.generation, 1, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(options.records) || options.records.length < 1 || options.records.length > 64) {
    throw invalidRequest('readFrtkRecords options are invalid');
  }
  return {
    generation: options.generation,
    records: options.records.map((record) => {
      if (!hasExactKeys(record, ['uniqueId', 'row', 'fields']) ||
          !isSafeIntegerBetween(record.uniqueId, 0, 0xFFFFFFFF) ||
          !isSafeIntegerBetween(record.row, 0, 0xFFFFFFFF)) {
        throw invalidRequest('FrTk record selector must use only uniqueId, row, and fields');
      }
      return { uniqueId: record.uniqueId, row: record.row, fields: cloneFieldNames(record.fields) };
    }),
  };
}

function cloneTypedValue(value) {
  if (Number.isSafeInteger(value)) return value;
  if (hasExactKeys(value, ['uniqueId', 'row']) &&
      isSafeIntegerBetween(value.uniqueId, 0, 0xFFFFFFFF) &&
      isSafeIntegerBetween(value.row, 0, 0x1FFFF)) {
    return { uniqueId: value.uniqueId, row: value.row };
  }
  throw new Cfb27HookError('FRTK_FIELD_INVALID', FRTK_ERROR_MESSAGES.FRTK_FIELD_INVALID);
}

function cloneTransactionOptions(options) {
  if (!hasExactKeys(options, ['transactionId', 'generation', 'changes']) ||
      typeof options.transactionId !== 'string' || !FRTK_TRANSACTION_ID.test(options.transactionId) ||
      !isSafeIntegerBetween(options.generation, 1, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(options.changes) || options.changes.length < 1 || options.changes.length > 128) {
    throw invalidRequest('transactFrtkFields options are invalid');
  }
  const identities = new Set();
  const changes = options.changes.map((change) => {
    if (!hasExactKeys(change, ['uniqueId', 'row', 'field', 'value']) ||
        !isSafeIntegerBetween(change.uniqueId, 0, 0xFFFFFFFF) ||
        !isSafeIntegerBetween(change.row, 0, 0xFFFFFFFF) ||
        !isValidUtf8BoundedString(change.field)) {
      throw invalidRequest('FrTk field change is invalid');
    }
    const identity = `${change.uniqueId}:${change.row}:${change.field}`;
    if (identities.has(identity)) throw invalidRequest('FrTk field changes must be unique');
    identities.add(identity);
    return { uniqueId: change.uniqueId, row: change.row, field: change.field,
      value: cloneTypedValue(change.value) };
  });
  return { transactionId: options.transactionId, generation: options.generation, changes };
}

function cloneInvalidateOptions(options) {
  if (!hasExactKeys(options, ['reason']) || !FRTK_REASONS.has(options.reason)) {
    throw invalidRequest('FrTk invalidation reason is invalid');
  }
  return { reason: options.reason };
}

function validBoundedString(value, maximum = 128) {
  return isValidUtf8BoundedString(value, maximum);
}

function validateEvidence(value) {
  if (!Array.isArray(value) || value.length > 64) throw invalidResponse('Invalid FrTk evidence');
  return value.map((item) => {
    if (!hasExactKeys(item, ['code', 'fingerprintCount']) || !validBoundedString(item.code) ||
        !isSafeIntegerBetween(item.fingerprintCount, 0, 64)) {
      throw invalidResponse('Invalid FrTk evidence');
    }
    return { code: item.code, fingerprintCount: item.fingerprintCount };
  });
}

function validateLoadResult(result) {
  if (!hasExactKeys(result, ['profileId', 'schemaIdentity', 'buildIdentity', 'tableCount']) ||
      !validBoundedString(result.profileId) || !validBoundedString(result.schemaIdentity) ||
      !validBoundedString(result.buildIdentity) ||
      !isSafeIntegerBetween(result.tableCount, 1, 4096)) throw invalidResponse('Invalid FrTk profile result');
  return { profileId: result.profileId, schemaIdentity: result.schemaIdentity,
    buildIdentity: result.buildIdentity, tableCount: result.tableCount };
}

function validateDiscoveryResult(result) {
  if (!hasExactKeys(result, ['generation', 'tableCount']) ||
      !isSafeIntegerBetween(result.generation, 1, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(result.tableCount, 1, 4096)) throw invalidResponse('Invalid FrTk discovery result');
  return { generation: result.generation, tableCount: result.tableCount };
}

function validateCatalogResult(result, expectedGeneration) {
  if (!hasExactKeys(result, ['generation', 'tables']) || result.generation !== expectedGeneration ||
      !Array.isArray(result.tables) || result.tables.length < 1 || result.tables.length > 4096) {
    throw invalidResponse('Invalid FrTk catalog result');
  }
  const uniqueIds = new Set();
  const tables = result.tables.map((table) => {
    if (!hasExactKeys(table, ['uniqueId', 'logicalName', 'authorityStatus', 'capacity',
      'profileId', 'generation', 'evidence']) ||
        !isSafeIntegerBetween(table.uniqueId, 0, 0xFFFFFFFF) ||
        !validBoundedString(table.logicalName) || !FRTK_AUTHORITY.has(table.authorityStatus) ||
        !isSafeIntegerBetween(table.capacity, 1, 0xFFFFFFFF) || !validBoundedString(table.profileId) ||
        table.generation !== expectedGeneration || uniqueIds.has(table.uniqueId)) {
      throw invalidResponse('Invalid FrTk catalog table');
    }
    uniqueIds.add(table.uniqueId);
    return { uniqueId: table.uniqueId, logicalName: table.logicalName,
      authorityStatus: table.authorityStatus, capacity: table.capacity, profileId: table.profileId,
      generation: table.generation, evidence: validateEvidence(table.evidence) };
  });
  return { generation: result.generation, tables };
}

function validateReadRecordsResult(result, params) {
  if (!hasExactKeys(result, ['generation', 'records']) || result.generation !== params.generation ||
      !Array.isArray(result.records) || result.records.length !== params.records.length) {
    throw invalidResponse('Invalid FrTk records result');
  }
  const records = result.records.map((record, index) => {
    const requested = params.records[index];
    if (!hasExactKeys(record, ['uniqueId', 'row', 'values']) ||
        record.uniqueId !== requested.uniqueId || record.row !== requested.row ||
        !Array.isArray(record.values) || record.values.length !== requested.fields.length) {
      throw invalidResponse('Invalid FrTk record result');
    }
    const values = record.values.map((entry, fieldIndex) => {
      if (!hasExactKeys(entry, ['field', 'value']) || entry.field !== requested.fields[fieldIndex]) {
        throw invalidResponse('Invalid FrTk field result');
      }
      try { return { field: entry.field, value: cloneTypedValue(entry.value) }; }
      catch { throw invalidResponse('Invalid FrTk typed value'); }
    });
    return { uniqueId: record.uniqueId, row: record.row, values };
  });
  return { generation: result.generation, records };
}

function validateFrtkTransactionResult(result, params) {
  if (!hasExactKeys(result, ['transactionId', 'status', 'changedFields']) ||
      result.transactionId !== params.transactionId || result.status !== 'applied_verified' ||
      result.changedFields !== params.changes.length) throw invalidResponse('Invalid FrTk transaction result');
  return { transactionId: result.transactionId, status: result.status, changedFields: result.changedFields };
}

function validateInvalidateResult(result, params) {
  if (!hasExactKeys(result, ['generation', 'reason']) ||
      !isSafeIntegerBetween(result.generation, 1, Number.MAX_SAFE_INTEGER) ||
      result.reason !== params.reason) throw invalidResponse('Invalid FrTk invalidation result');
  return { generation: result.generation, reason: result.reason };
}

function sanitizeFrtkError(error) {
  const code = typeof error?.code === 'string' && Object.hasOwn(FRTK_ERROR_MESSAGES, error.code)
    ? error.code : 'INVALID_RESPONSE';
  const details = code === 'FRTK_DISCOVERY_TIMEOUT' ? error.details : undefined;
  return new Cfb27HookError(code, FRTK_ERROR_MESSAGES[code], details);
}

function validateFrtkTimeoutDetails(details) {
  if (!hasExactKeys(details, ['stage', 'tableUniqueId', 'fingerprintOrdinal',
    'completedFingerprintCount', 'elapsedMilliseconds', 'pagesScanned', 'chunksScanned',
    'scannedBytes', 'candidateWindows', 'cappedMatches']) ||
      !['scan', 'allocation', 'relationship', 'reread'].includes(details.stage) ||
      (details.tableUniqueId !== null &&
        !isSafeIntegerBetween(details.tableUniqueId, 0, 0xFFFFFFFF)) ||
      (details.fingerprintOrdinal !== null &&
        !isSafeIntegerBetween(details.fingerprintOrdinal, 0, Number.MAX_SAFE_INTEGER)) ||
      !isSafeIntegerBetween(details.completedFingerprintCount, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(details.elapsedMilliseconds, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(details.pagesScanned, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(details.chunksScanned, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(details.scannedBytes, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(details.candidateWindows, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeIntegerBetween(details.cappedMatches, 0, 8) ||
      (details.stage === 'scan' && details.tableUniqueId === null) ||
      (details.stage !== 'scan' && details.fingerprintOrdinal !== null)) {
    throw invalidResponse('Host returned malformed FrTk timeout details');
  }
  return { ...details };
}

function validateFrtkSuccessResponse(response, expectedId) {
  if (!hasExactKeys(response, ['protocol', 'id', 'ok', 'result']) ||
      response.protocol !== 1 || response.id !== expectedId || response.ok !== true) {
    throw invalidResponse('Host returned a malformed FrTk success response');
  }
}

function validateFrtkErrorResponse(response, expectedId) {
  if (!hasExactKeys(response, ['protocol', 'id', 'ok', 'error']) ||
      response.protocol !== 1 || response.id !== expectedId || response.ok !== false ||
      !hasExactKeys(response.error, ['code', 'message', 'details']) ||
      typeof response.error.code !== 'string' || typeof response.error.message !== 'string' ||
      !isObject(response.error.details)) {
    throw invalidResponse('Host returned a malformed FrTk error response');
  }
  if (response.error.code === 'FRTK_DISCOVERY_TIMEOUT') {
    return { code: response.error.code,
      details: validateFrtkTimeoutDetails(response.error.details) };
  }
  return response.error.code;
}

function invalidRequest(message) {
  return new Cfb27HookError('INVALID_REQUEST', message);
}

function invalidResponse(message) {
  return new Cfb27HookError('INVALID_RESPONSE', message);
}

function isCanonicalAddress(value) {
  return typeof value === 'string' && CANONICAL_ADDRESS.test(value);
}

function cloneUpperHex(value, minimumBytes, maximumBytes, fieldName) {
  if (!isUpperHexBytes(value)) {
    throw invalidRequest(`${fieldName} must contain uppercase hexadecimal bytes`);
  }
  const byteLength = value.length / 2;
  if (byteLength < minimumBytes || byteLength > maximumBytes) {
    throw invalidRequest(`${fieldName} byte length is outside the supported limits`);
  }
  return value.toUpperCase();
}

function cloneScanPageOptions(options) {
  const keys = ['patternHex', 'maskHex', 'maxMatches', 'contextBefore', 'contextAfter',
    'allowUnsupportedBuild', 'cursor', 'includeAllocationMetadata'];
  if (!hasOnlyKeys(options, keys)) throw invalidRequest('scanMemory options are invalid');
  const patternHex = cloneUpperHex(
    options.patternHex,
    MEMORY_LIMITS.minPatternBytes,
    MEMORY_LIMITS.maxPatternBytes,
    'patternHex',
  );
  const maskHex = cloneUpperHex(
    options.maskHex,
    MEMORY_LIMITS.minPatternBytes,
    MEMORY_LIMITS.maxPatternBytes,
    'maskHex',
  );
  if (maskHex.length !== patternHex.length) {
    throw invalidRequest('maskHex must have the same byte length as patternHex');
  }
  if (!isSafeIntegerBetween(options.maxMatches, 1, MEMORY_LIMITS.maxMatches) ||
      !isSafeIntegerBetween(options.contextBefore, 0, MEMORY_LIMITS.maxContextBytes) ||
      !isSafeIntegerBetween(options.contextAfter, 0, MEMORY_LIMITS.maxContextBytes) ||
      options.contextBefore + options.contextAfter > MEMORY_LIMITS.maxContextBytes) {
    throw invalidRequest('scanMemory numeric options are outside the supported limits');
  }
  if (Object.hasOwn(options, 'allowUnsupportedBuild') &&
      typeof options.allowUnsupportedBuild !== 'boolean') {
    throw invalidRequest('allowUnsupportedBuild must be a boolean');
  }
  if (Object.hasOwn(options, 'cursor') && !isCanonicalAddress(options.cursor)) {
    throw invalidRequest('cursor must be a canonical uppercase address');
  }
  if (Object.hasOwn(options, 'includeAllocationMetadata') &&
      typeof options.includeAllocationMetadata !== 'boolean') {
    throw invalidRequest('includeAllocationMetadata must be a boolean');
  }

  const clone = {
    patternHex,
    maskHex,
    maxMatches: options.maxMatches,
    contextBefore: options.contextBefore,
    contextAfter: options.contextAfter,
  };
  if (Object.hasOwn(options, 'allowUnsupportedBuild')) {
    clone.allowUnsupportedBuild = options.allowUnsupportedBuild;
  }
  if (Object.hasOwn(options, 'cursor')) clone.cursor = options.cursor;
  if (Object.hasOwn(options, 'includeAllocationMetadata')) {
    clone.includeAllocationMetadata = options.includeAllocationMetadata;
  }
  return clone;
}

function cloneAggregateScanOptions(options) {
  if (!hasOnlyKeys(options, ['patternHex', 'maskHex', 'maxMatches', 'contextBefore',
    'contextAfter', 'allowUnsupportedBuild', 'includeAllocationMetadata', 'maxPages']) ||
      Object.hasOwn(options, 'cursor')) {
    throw invalidRequest('scanMemory aggregate options are invalid');
  }
  const maxPages = Object.hasOwn(options, 'maxPages') ? options.maxPages : MEMORY_LIMITS.maxPages;
  if (!isSafeIntegerBetween(maxPages, 1, MEMORY_LIMITS.maxPages)) {
    throw invalidRequest('maxPages must be an integer from 1 through 4096');
  }
  const pageOptions = { ...options };
  delete pageOptions.maxPages;
  return { pageOptions: cloneScanPageOptions(pageOptions), maxPages };
}

function cloneReadOptions(options) {
  if (!hasOnlyKeys(options, ['ranges', 'allowUnsupportedBuild']) ||
      !Array.isArray(options.ranges) ||
      options.ranges.length < 1 ||
      options.ranges.length > MEMORY_LIMITS.maxReadRanges) {
    throw invalidRequest('readMemory options are invalid');
  }
  if (Object.hasOwn(options, 'allowUnsupportedBuild') &&
      typeof options.allowUnsupportedBuild !== 'boolean') {
    throw invalidRequest('allowUnsupportedBuild must be a boolean');
  }

  let totalBytes = 0;
  const ranges = options.ranges.map((range) => {
    if (!hasExactKeys(range, ['address', 'length']) || !isCanonicalAddress(range.address) ||
        !isSafeIntegerBetween(range.length, 1, MEMORY_LIMITS.maxReadRangeBytes) ||
        totalBytes > MEMORY_LIMITS.maxReadBytes - range.length) {
      throw invalidRequest('readMemory range is invalid or exceeds the supported limits');
    }
    totalBytes += range.length;
    return { address: range.address, length: range.length };
  });

  const clone = { ranges };
  if (Object.hasOwn(options, 'allowUnsupportedBuild')) {
    clone.allowUnsupportedBuild = options.allowUnsupportedBuild;
  }
  return clone;
}

function validateScanPageResult(result, params) {
  if (!hasExactKeys(result, ['supportedBuild', 'complete', 'nextCursor', 'scannedBytes', 'matches']) ||
      typeof result.supportedBuild !== 'boolean' ||
      (result.supportedBuild === false && params.allowUnsupportedBuild !== true) ||
      typeof result.complete !== 'boolean' ||
      (result.complete ? result.nextCursor !== null : !isCanonicalAddress(result.nextCursor)) ||
      !isSafeIntegerBetween(result.scannedBytes, 0, MEMORY_LIMITS.maxScanPageBytes) ||
      !Array.isArray(result.matches) || result.matches.length > params.maxMatches) {
    throw invalidResponse('Host returned an invalid scanMemory result');
  }
  if (!result.complete && Object.hasOwn(params, 'cursor') &&
      BigInt(result.nextCursor) <= BigInt(params.cursor)) {
    throw invalidResponse('Host returned a non-advancing scanMemory cursor');
  }

  const maximumContextBytes = params.patternHex.length / 2 +
    params.contextBefore + params.contextAfter;
  for (const match of result.matches) {
    const matchKeys = params.includeAllocationMetadata === true
      ? ['address', 'regionBase', 'regionSize', 'protection', 'contextAddress', 'contextHex',
        'allocationBase', 'allocationSize', 'allocationProtect', 'offsetInAllocation']
      : ['address', 'regionBase', 'regionSize', 'protection', 'contextAddress', 'contextHex'];
    if (!hasExactKeys(match, matchKeys) ||
        !isCanonicalAddress(match.address) || !isCanonicalAddress(match.regionBase) ||
        !isSafeIntegerBetween(match.regionSize, 1, Number.MAX_SAFE_INTEGER) ||
        !isSafeIntegerBetween(match.protection, 0, 0xFFFFFFFF) ||
        !isCanonicalAddress(match.contextAddress) ||
        !isUpperHexBytes(match.contextHex) ||
        !isSafeIntegerBetween(
          match.contextHex.length / 2,
          params.patternHex.length / 2,
          maximumContextBytes,
        ) ||
        (params.includeAllocationMetadata === true &&
          (!isCanonicalAddress(match.allocationBase) ||
           !isSafeIntegerBetween(match.allocationSize, 1, Number.MAX_SAFE_INTEGER) ||
           !isSafeIntegerBetween(match.allocationProtect, 0, 0xFFFFFFFF) ||
           !isSafeIntegerBetween(match.offsetInAllocation, 0,
             match.allocationSize - 1) ||
           BigInt(match.address) !==
             BigInt(match.allocationBase) + BigInt(match.offsetInAllocation)))) {
      throw invalidResponse('Host returned an invalid scanMemory match');
    }
  }
  return result;
}

function validateReadResult(result, params) {
  if (!hasExactKeys(result, ['supportedBuild', 'ranges']) ||
      typeof result.supportedBuild !== 'boolean' ||
      (result.supportedBuild === false && params.allowUnsupportedBuild !== true) ||
      !Array.isArray(result.ranges) ||
      result.ranges.length !== params.ranges.length ||
      result.ranges.length > MEMORY_LIMITS.maxReadRanges) {
    throw invalidResponse('Host returned an invalid readMemory result');
  }

  for (let index = 0; index < result.ranges.length; index += 1) {
    const range = result.ranges[index];
    const requested = params.ranges[index];
    if (!hasExactKeys(range, ['address', 'length', 'bytesHex']) ||
        !isCanonicalAddress(range.address) || range.address !== requested.address ||
        range.length !== requested.length ||
        !isUpperHexBytes(range.bytesHex) ||
        range.bytesHex.length !== range.length * 2) {
      throw invalidResponse('Host returned an invalid readMemory range');
    }
  }
  return result;
}

function cloneWriteTransactionOptions(options) {
  if (!hasExactKeys(options, ['transactionId', 'operations']) ||
      typeof options.transactionId !== 'string' ||
      !TRANSACTION_ID.test(options.transactionId) ||
      !Array.isArray(options.operations) ||
      options.operations.length < 1 || options.operations.length > 32) {
    throw invalidRequest('writeTransaction options are invalid');
  }

  let totalBytes = 0;
  const ranges = [];
  const operations = options.operations.map((operation) => {
    if (!hasExactKeys(operation, ['address', 'expectedHex', 'replacementHex']) ||
        !isCanonicalAddress(operation.address)) {
      throw invalidRequest('writeTransaction operation is invalid');
    }
    const expectedHex = cloneUpperHex(operation.expectedHex, 1, 4096, 'expectedHex');
    const replacementHex = cloneUpperHex(operation.replacementHex, 1, 4096, 'replacementHex');
    if (expectedHex.length !== replacementHex.length) {
      throw invalidRequest('expectedHex and replacementHex must have equal byte lengths');
    }
    const byteLength = expectedHex.length / 2;
    if (totalBytes > 65536 - byteLength) {
      throw invalidRequest('writeTransaction exceeds the total byte limit');
    }
    totalBytes += byteLength;
    const start = BigInt(operation.address);
    const end = start + BigInt(byteLength);
    if (end > MAX_UINT64) {
      throw invalidRequest('writeTransaction operation exceeds the address space');
    }
    ranges.push({ start, end });
    return Object.freeze({ address: operation.address, expectedHex, replacementHex });
  });

  ranges.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw invalidRequest('writeTransaction operations must not overlap');
    }
  }
  return Object.freeze({
    transactionId: options.transactionId,
    operations: Object.freeze(operations),
  });
}

function validateWriteTransactionResult(result, params) {
  if (!hasExactKeys(result, ['transactionId', 'status', 'operations']) ||
      result.transactionId !== params.transactionId ||
      result.status !== 'applied_verified' ||
      !Array.isArray(result.operations) ||
      result.operations.length !== params.operations.length) {
    throw invalidResponse('Host returned an invalid writeTransaction result');
  }
  const operations = result.operations.map((operation, index) => {
    if (!hasExactKeys(operation, ['index', 'applied', 'verified']) ||
        operation.index !== index || operation.applied !== true || operation.verified !== true) {
      throw invalidResponse('Host returned an invalid writeTransaction operation result');
    }
    return Object.freeze({ index, applied: true, verified: true });
  });
  return Object.freeze({
    transactionId: result.transactionId,
    status: result.status,
    operations: Object.freeze(operations),
  });
}

function validateWriteTransactionFailureDetails(details, params, code) {
  const expectedStatus = code === 'TRANSACTION_APPLY_FAILED'
    ? 'rolled_back_verified'
    : 'rollback_unverified';
  if (!hasExactKeys(details, ['transactionId', 'status', 'operations']) ||
      details.transactionId !== params.transactionId ||
      details.status !== expectedStatus ||
      !Array.isArray(details.operations) ||
      details.operations.length !== params.operations.length) {
    throw invalidResponse('Host returned malformed writeTransaction error details');
  }
  for (let index = 0; index < details.operations.length; index += 1) {
    const operation = details.operations[index];
    if (!hasExactKeys(operation, ['index', 'applied', 'verified']) ||
        operation.index !== index || typeof operation.applied !== 'boolean' ||
        typeof operation.verified !== 'boolean') {
      throw invalidResponse('Host returned malformed writeTransaction error operation details');
    }
  }
}

function validateWriteTransactionErrorResponse(response, expectedId, params) {
  if (!hasExactKeys(response, ['protocol', 'id', 'ok', 'error']) ||
      response.protocol !== 1 || response.id !== expectedId || response.ok !== false ||
      !isObject(response.error)) {
    throw invalidResponse('Host returned a malformed writeTransaction error response');
  }
  const { error } = response;
  if (typeof error.code !== 'string' || !HOST_WRITE_TRANSACTION_ERROR_CODES.has(error.code) ||
      typeof error.message !== 'string') {
    throw invalidResponse('Host returned a malformed writeTransaction error');
  }
  const hasFailureDetails = error.code === 'TRANSACTION_APPLY_FAILED' ||
    error.code === 'ROLLBACK_VERIFICATION_FAILED';
  if (!hasExactKeys(error, ['code', 'message', 'details'])) {
    throw invalidResponse('Host returned unexpected writeTransaction error properties');
  }
  if (hasFailureDetails) {
    validateWriteTransactionFailureDetails(error.details, params, error.code);
  } else if (!hasExactKeys(error.details, [])) {
    throw invalidResponse('Host returned nonempty writeTransaction error details');
  }
  return error.code;
}

function validateWriteTransactionSuccessResponse(response, expectedId) {
  if (!hasExactKeys(response, ['protocol', 'id', 'ok', 'result']) ||
      response.protocol !== 1 || response.id !== expectedId || response.ok !== true) {
    throw invalidResponse('Host returned a malformed writeTransaction success response');
  }
}

function sanitizeWriteTransactionError(error) {
  const code = typeof error?.code === 'string' &&
    Object.hasOwn(WRITE_TRANSACTION_ERROR_MESSAGES, error.code)
    ? error.code
    : 'INVALID_RESPONSE';
  return new Cfb27HookError(code, WRITE_TRANSACTION_ERROR_MESSAGES[code]);
}

function cloneTelemetryTypes(types) {
  if (!Array.isArray(types) || types.length < 1 || types.length > 16) {
    throw invalidRequest('registerTelemetryTypes requires 1 to 16 type names');
  }
  const clone = [];
  const seen = new Set();
  for (const type of types) {
    if (typeof type !== 'string' || !TELEMETRY_TYPE.test(type) ||
        RESERVED_TELEMETRY_TYPES.has(type) || seen.has(type)) {
      throw invalidRequest('Telemetry type names are invalid, reserved, or duplicated');
    }
    seen.add(type);
    clone.push(type);
  }
  return clone;
}

function cloneNativeCallOptions(options = {}) {
  if (!isObject(options) || !hasOnlyKeys(options, ['address', 'arguments']) ||
      typeof options.address !== 'string' || !CANONICAL_ADDRESS.test(options.address)) {
    throw invalidRequest('nativeCall requires a canonical hexadecimal address');
  }
  const argumentsValue = options.arguments === undefined ? [] : options.arguments;
  if (!Array.isArray(argumentsValue) || argumentsValue.length > 8 ||
      !argumentsValue.every((value) =>
        typeof value === 'string' && CANONICAL_ADDRESS.test(value))) {
    throw invalidRequest('nativeCall accepts zero to eight canonical hexadecimal arguments');
  }
  return { address: options.address, arguments: [...argumentsValue] };
}

function validateNativeCallResult(result, params) {
  if (!hasExactKeys(result, ['address', 'value']) || result.address !== params.address ||
      typeof result.value !== 'string' || !CANONICAL_ADDRESS.test(result.value)) {
    throw invalidResponse('Host returned an invalid nativeCall result');
  }
  return result;
}

function cloneBoardMutationOptions(options = {}) {
  if (!isObject(options) || !hasExactKeys(options, ['recruitRow', 'teamRow']) ||
      !isSafeIntegerBetween(options.recruitRow, 0, 0x1FFFF) ||
      !isSafeIntegerBetween(options.teamRow, 0, 0x1FFFF)) {
    throw invalidRequest('Board mutation requires recruitRow and teamRow');
  }
  return { recruitRow: options.recruitRow, teamRow: options.teamRow };
}

function validateBoardMutationResult(result, params, operation) {
  const keys = ['operation', 'status', 'recruitRow', 'teamRow', 'membershipRow',
    'boardSlot', 'targetRow', 'activePitchRow', 'callValue', 'uiRefresh'];
  const optionalRow = (value) => value === null || isSafeIntegerBetween(value, 0, 0x1FFFF);
  if (!hasExactKeys(result, keys) || result.operation !== operation ||
      !['applied_verified', 'unchanged'].includes(result.status) ||
      result.recruitRow !== params.recruitRow || result.teamRow !== params.teamRow ||
      !isSafeIntegerBetween(result.membershipRow, 0, 137) ||
      !optionalRow(result.boardSlot) || !optionalRow(result.targetRow) ||
      !optionalRow(result.activePitchRow) || typeof result.callValue !== 'string' ||
      !CANONICAL_ADDRESS.test(result.callValue) ||
      result.uiRefresh !== 'next_recruiting_screen_change') {
    throw invalidResponse('Host returned an invalid board mutation result');
  }
  if (result.boardSlot !== null && result.boardSlot > 34) {
    throw invalidResponse('Host returned an invalid board slot');
  }
  return result;
}

function validateTelemetryRegistration(result, types) {
  if (!hasExactKeys(result, ['types']) || !Array.isArray(result.types) ||
      result.types.length !== types.length ||
      !result.types.every((type, index) => type === types[index])) {
    throw invalidResponse('Host returned an invalid registerTelemetry result');
  }
  return result;
}

function createClient({ pid, pipeName, timeoutMs = 20000 } = {}) {
  if (!pipeName && (!Number.isInteger(pid) || pid <= 0)) {
    throw new Cfb27HookError('INVALID_REQUEST', 'createClient requires a positive PID or pipe name');
  }
  const resolvedPipeName = pipeName || `\\\\.\\pipe\\CFB27LuaHost.v1.${pid}`;
  const frtkAuthority = new Map();

  function request(command, params = {}, {
    hostErrorValidator,
    successResponseValidator,
  } = {}) {
    if (typeof command !== 'string' || !command || !params || typeof params !== 'object') {
      return Promise.reject(new Cfb27HookError('INVALID_REQUEST', 'Command and params are invalid'));
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder();
      let socket;
      let retryTimer;
      let commandSent = false;
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Cfb27HookError('PIPE_TIMEOUT', `Host did not respond within ${timeoutMs} ms`, {
          pipeName: resolvedPipeName,
        }));
      }, timeoutMs);

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(retryTimer);
        socket?.destroy();
        if (error) reject(error);
        else resolve(result);
      }

      function connect() {
        if (settled) return;
        const attemptSocket = net.createConnection(resolvedPipeName);
        socket = attemptSocket;
        let connected = false;

        attemptSocket.once('connect', () => {
          connected = true;
          commandSent = true;
          try {
            attemptSocket.write(encodeFrame({ protocol: 1, id, command, params }));
          } catch (error) {
            finish(error);
          }
        });
        attemptSocket.on('data', (chunk) => {
          let responses;
          try {
            responses = decoder.push(chunk);
          } catch (error) {
            finish(error);
            return;
          }
          for (const response of responses) {
            if (response?.ok === false && typeof hostErrorValidator === 'function') {
              try {
                const validated = hostErrorValidator(response, id);
                const code = typeof validated === 'string' ? validated : validated.code;
                const details = typeof validated === 'string' ? undefined : validated.details;
                finish(new Cfb27HookError(code, 'Host rejected the request', details));
              } catch (error) {
                finish(error);
              }
              return;
            }
            if (typeof successResponseValidator === 'function') {
              try {
                successResponseValidator(response, id);
              } catch (error) {
                finish(error);
                return;
              }
            }
            if (!response || response.protocol !== 1) {
              finish(new Cfb27HookError('PROTOCOL_MISMATCH', 'Host protocol version does not match'));
              return;
            }
            if (response.id !== id || typeof response.ok !== 'boolean') {
              finish(new Cfb27HookError('INVALID_RESPONSE', 'Host response does not match the request'));
              return;
            }
            if (!response.ok) {
              const hostError = response.error || {};
              finish(new Cfb27HookError(
                typeof hostError.code === 'string' ? hostError.code : 'INVALID_RESPONSE',
                typeof hostError.message === 'string' ? hostError.message : 'Host request failed',
                hostError.details,
              ));
              return;
            }
            finish(null, response.result);
            return;
          }
        });
        attemptSocket.once('end', () => {
          if (!settled) {
            finish(new Cfb27HookError('INVALID_RESPONSE', 'Host closed without a response'));
          }
        });
        attemptSocket.once('error', (error) => {
          if (!connected && !commandSent && error.code === 'ENOENT') {
            attemptSocket.destroy();
            retryTimer = setTimeout(connect, PIPE_CONNECT_RETRY_DELAY_MS);
            return;
          }
          finish(new Cfb27HookError('HOST_NOT_READY', 'Could not connect to the Lua host', {
            pipeName: resolvedPipeName,
            cause: error.message,
          }));
        });
      }

      connect();
    });
  }

  async function requireAllocationMetadataCapability() {
    const hello = await request('hello');
    if (!hello || hello.protocolVersion !== 1 ||
        !Array.isArray(hello.capabilities) ||
        !hello.capabilities.includes('memoryScanAllocationMetadata')) {
      throw new Cfb27HookError(
        'PROTOCOL_MISMATCH',
        'Host does not advertise memoryScanAllocationMetadata capability',
      );
    }
  }

  async function requireNativeCallCapability() {
    const hello = await request('hello');
    if (!hello || hello.protocolVersion !== 1 ||
        !Array.isArray(hello.capabilities) ||
        !hello.capabilities.includes(NATIVE_CALL_CAPABILITY)) {
      throw new Cfb27HookError(
        'PROTOCOL_MISMATCH',
        'Host does not advertise nativeCall capability',
      );
    }
  }

  async function requireBoardMutationCapability() {
    const hello = await request('hello');
    if (!hello || hello.protocolVersion !== 1 ||
        !Array.isArray(hello.capabilities) ||
        !hello.capabilities.includes(BOARD_MUTATION_CAPABILITY)) {
      throw new Cfb27HookError(
        'PROTOCOL_MISMATCH',
        'Host does not advertise boardMutationV1 capability',
      );
    }
  }

  async function requireFrtkCapability(capability) {
    const hello = await request('hello');
    if (!hasExactKeys(hello, ['protocolVersion', 'hostVersion', 'supportedBuild', 'writesAllowed',
      'capabilities']) || hello.protocolVersion !== 1 || !validBoundedString(hello.hostVersion, 64) ||
        typeof hello.supportedBuild !== 'boolean' || typeof hello.writesAllowed !== 'boolean' ||
        !Array.isArray(hello.capabilities) || hello.capabilities.length > 64 ||
        !hello.capabilities.every((item) => typeof item === 'string') ||
        new Set(hello.capabilities).size !== hello.capabilities.length ||
        !hello.capabilities.includes(capability)) {
      throw new Cfb27HookError(
        'PROTOCOL_MISMATCH',
        `Host does not advertise ${capability} capability`,
      );
    }
  }

  async function frtkRequest(capability, command, params, validator) {
    try {
      await requireFrtkCapability(capability);
      return validator(await request(command, params, {
        hostErrorValidator: validateFrtkErrorResponse,
        successResponseValidator: validateFrtkSuccessResponse,
      }));
    } catch (error) {
      throw sanitizeFrtkError(error);
    }
  }

  async function loadFrtkProfile(bundle = {}) {
    const params = cloneFrtkBundle(bundle);
    const result = await frtkRequest(FRTK_CAPABILITIES.profile, 'loadFrtkProfile', params,
      validateLoadResult);
    frtkAuthority.clear();
    return result;
  }

  return Object.freeze({
    request,
    async hello() {
      const result = await request('hello');
      if (!result || result.protocolVersion !== 1) {
        throw new Cfb27HookError('PROTOCOL_MISMATCH', 'Host protocol version does not match');
      }
      return result;
    },
    status() {
      return request('status');
    },
    runScript({ name, source } = {}) {
      return request('runScript', { name, source });
    },
    evaluateLua(source) {
      return request('evaluate', { source });
    },
    async nativeCall(options = {}) {
      const params = cloneNativeCallOptions(options);
      await requireNativeCallCapability();
      return validateNativeCallResult(await request('nativeCall', params), params);
    },
    async addBoard(options = {}) {
      const params = cloneBoardMutationOptions(options);
      await requireBoardMutationCapability();
      return validateBoardMutationResult(await request('addBoard', params), params, 'add');
    },
    async removeBoard(options = {}) {
      const params = cloneBoardMutationOptions(options);
      await requireBoardMutationCapability();
      return validateBoardMutationResult(await request('removeBoard', params), params, 'remove');
    },
    getLogs({ limit = 100 } = {}) {
      return request('logs', { limit });
    },
    getEvents({ after = 0, limit = 100 } = {}) {
      return request('events', { after, limit });
    },
    async scanMemoryPage(options = {}) {
      const params = cloneScanPageOptions(options);
      if (params.includeAllocationMetadata === true) {
        await requireAllocationMetadataCapability();
      }
      return validateScanPageResult(await request('scanMemory', params), params);
    },
    async scanMemory(options = {}) {
      const { pageOptions, maxPages } = cloneAggregateScanOptions(options);
      if (pageOptions.includeAllocationMetadata === true) {
        await requireAllocationMetadataCapability();
      }
      const matches = [];
      const cursors = new Set();
      let cursor;
      let scannedBytes = 0;
      let supportedBuild;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const remainingMatches = pageOptions.maxMatches - matches.length;
        const params = { ...pageOptions, maxMatches: Math.max(1, remainingMatches) };
        if (cursor) params.cursor = cursor;
        const page = validateScanPageResult(await request('scanMemory', params), params);
        if (supportedBuild === undefined) supportedBuild = page.supportedBuild;
        else if (page.supportedBuild !== supportedBuild) {
          throw invalidResponse('Host changed supportedBuild during scanMemory');
        }
        if (!Number.isSafeInteger(scannedBytes + page.scannedBytes)) {
          throw invalidResponse('Host scan byte total exceeds the safe integer range');
        }
        scannedBytes += page.scannedBytes;
        matches.push(...page.matches);
        if (matches.length > pageOptions.maxMatches) {
          throw new Cfb27HookError('TOO_MANY_MATCHES', 'Memory scan found too many matches');
        }
        if (page.complete) {
          return { supportedBuild, complete: true, scannedBytes, matches };
        }
        if (cursors.has(page.nextCursor) ||
            (cursor && BigInt(page.nextCursor) <= BigInt(cursor))) {
          throw invalidResponse('Host returned a non-progressing scan cursor');
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw new Cfb27HookError('SCAN_LIMIT_EXCEEDED', 'scanMemory exceeded maxPages');
    },
    async readMemory(options = {}) {
      const params = cloneReadOptions(options);
      return validateReadResult(await request('readMemory', params), params);
    },
    async writeTransaction(options = {}) {
      const params = cloneWriteTransactionOptions(options);
      try {
        const result = await request('writeTransaction', params, {
          hostErrorValidator: (response, id) =>
            validateWriteTransactionErrorResponse(response, id, params),
          successResponseValidator: validateWriteTransactionSuccessResponse,
        });
        return validateWriteTransactionResult(result, params);
      } catch (error) {
        throw sanitizeWriteTransactionError(error);
      }
    },
    async registerTelemetryTypes(types) {
      const clonedTypes = cloneTelemetryTypes(types);
      return validateTelemetryRegistration(
        await request('registerTelemetry', { types: clonedTypes }),
        clonedTypes,
      );
    },
    loadFrtkProfile,
    async loadFrtkProfileFromFile(filePath, options = {}) {
      if (!hasOnlyKeys(options, ['fileSystem'])) throw invalidRequest('FrTk profile file options are invalid');
      const fileSystem = options.fileSystem || fs;
      if (typeof filePath !== 'string' || !filePath || filePath.length > 32768 ||
          typeof fileSystem?.readFile !== 'function') {
        throw invalidRequest('FrTk profile file is invalid');
      }
      let source;
      try { source = await fileSystem.readFile(filePath, 'utf8'); }
      catch { throw new Cfb27HookError('FRTK_PROFILE_INVALID', FRTK_ERROR_MESSAGES.FRTK_PROFILE_INVALID); }
      let bundle;
      try { bundle = JSON.parse(source); }
      catch { throw new Cfb27HookError('FRTK_PROFILE_INVALID', FRTK_ERROR_MESSAGES.FRTK_PROFILE_INVALID); }
      try {
        return await loadFrtkProfile(bundle);
      } catch (error) {
        if (error?.code === 'INVALID_REQUEST' || error?.code === 'FRTK_PROFILE_INVALID') {
          throw new Cfb27HookError('FRTK_PROFILE_INVALID', FRTK_ERROR_MESSAGES.FRTK_PROFILE_INVALID);
        }
        throw error;
      }
    },
    async discoverFrtkCatalog(options = {}) {
      if (!hasExactKeys(options, [])) throw invalidRequest('discoverFrtkCatalog accepts no selectors');
      frtkAuthority.clear();
      const result = await frtkRequest(FRTK_CAPABILITIES.catalog, 'discoverFrtkCatalog', {},
        validateDiscoveryResult);
      return result;
    },
    async inspectFrtkCatalog(options = {}) {
      const params = cloneGenerationOptions(options);
      const result = await frtkRequest(FRTK_CAPABILITIES.catalog, 'inspectFrtkCatalog', params,
        (result) => validateCatalogResult(result, params.generation));
      frtkAuthority.clear();
      for (const table of result.tables) {
        frtkAuthority.set(`${result.generation}:${table.uniqueId}`, table.authorityStatus);
      }
      return result;
    },
    async readFrtkRecords(options = {}) {
      const params = cloneRecordOptions(options);
      return frtkRequest(FRTK_CAPABILITIES.read, 'readFrtkRecords', params,
        (result) => validateReadRecordsResult(result, params));
    },
    async transactFrtkFields(options = {}) {
      const params = cloneTransactionOptions(options);
      try {
        await requireFrtkCapability(FRTK_CAPABILITIES.transaction);
        if (params.changes.some((change) =>
          frtkAuthority.get(`${params.generation}:${change.uniqueId}`) !== 'direct_verified')) {
          throw new Cfb27HookError('FRTK_AUTHORITY_UNPROVEN',
            FRTK_ERROR_MESSAGES.FRTK_AUTHORITY_UNPROVEN);
        }
        const result = await request('transactFrtkFields', params, {
          hostErrorValidator: validateFrtkErrorResponse,
          successResponseValidator: validateFrtkSuccessResponse,
        });
        return validateFrtkTransactionResult(result, params);
      } catch (error) {
        throw sanitizeFrtkError(error);
      }
    },
    async invalidateFrtkCatalog(options = {}) {
      const params = cloneInvalidateOptions(options);
      const result = await frtkRequest(FRTK_CAPABILITIES.catalog, 'invalidateFrtkCatalog', params,
        (result) => validateInvalidateResult(result, params));
      frtkAuthority.clear();
      return result;
    },
  });
}

async function resolvePid(options) {
  if (Number.isInteger(options.pid) && options.pid > 0) return options.pid;
  return (await discoverGame(options)).pid;
}

async function getHostStatus(options = {}) {
  const pid = await resolvePid(options);
  const client = createClient({ pid, pipeName: options.pipeName, timeoutMs: options.timeoutMs });
  const hello = await client.hello();
  if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes('status')) {
    throw new Cfb27HookError('PROTOCOL_MISMATCH', 'Host does not advertise status capability');
  }
  return client.status();
}

async function runScriptFile(filePath, options = {}) {
  const source = await fs.readFile(filePath, 'utf8');
  const pid = await resolvePid(options);
  const client = createClient({ pid, pipeName: options.pipeName, timeoutMs: options.timeoutMs });
  return client.runScript({ name: path.basename(filePath), source });
}

module.exports = { createClient, getHostStatus, runScriptFile };
