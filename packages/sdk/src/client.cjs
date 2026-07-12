'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { Cfb27HookError } = require('./errors.cjs');
const { encodeFrame, FrameDecoder } = require('./frame.cjs');
const { discoverGame } = require('./process.cjs');

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
const UPPER_HEX_BYTES = /^(?:[0-9A-F]{2})+$/;
const TELEMETRY_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const TRANSACTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_TELEMETRY_TYPES = new Set(['game_ready', 'tick', 'log']);
const PIPE_CONNECT_RETRY_DELAY_MS = 10;
const MAX_UINT64 = 0xFFFFFFFFFFFFFFFFn;
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

function invalidRequest(message) {
  return new Cfb27HookError('INVALID_REQUEST', message);
}

function invalidResponse(message) {
  return new Cfb27HookError('INVALID_RESPONSE', message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function isSafeIntegerBetween(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isCanonicalAddress(value) {
  return typeof value === 'string' && CANONICAL_ADDRESS.test(value);
}

function cloneUpperHex(value, minimumBytes, maximumBytes, fieldName) {
  if (typeof value !== 'string' || !UPPER_HEX_BYTES.test(value)) {
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
        typeof match.contextHex !== 'string' || !UPPER_HEX_BYTES.test(match.contextHex) ||
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
        typeof range.bytesHex !== 'string' || !UPPER_HEX_BYTES.test(range.bytesHex) ||
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

function validateTelemetryRegistration(result, types) {
  if (!hasExactKeys(result, ['types']) || !Array.isArray(result.types) ||
      result.types.length !== types.length ||
      !result.types.every((type, index) => type === types[index])) {
    throw invalidResponse('Host returned an invalid registerTelemetry result');
  }
  return result;
}

function createClient({ pid, pipeName, timeoutMs = 3000 } = {}) {
  if (!pipeName && (!Number.isInteger(pid) || pid <= 0)) {
    throw new Cfb27HookError('INVALID_REQUEST', 'createClient requires a positive PID or pipe name');
  }
  const resolvedPipeName = pipeName || `\\\\.\\pipe\\CFB27LuaHost.v1.${pid}`;

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
                const code = hostErrorValidator(response, id);
                finish(new Cfb27HookError(code, 'Host rejected the request'));
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
