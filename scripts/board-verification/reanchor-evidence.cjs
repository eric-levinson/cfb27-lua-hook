'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUTPUT_ROOT = path.join(REPOSITORY_ROOT, '.frtk', 'board-reanchor');
const TABLE_IDS = Object.freeze(['4168', '4176', '4190', '4251', '5790', '5847']);
const BOARD_RVAS = Object.freeze([
  'genericRecordWrapperVtableRva',
  'recruitingControllerVtableRva',
  'fullAddRva',
  'fullRemoveRva',
]);
const REQUIRED_GATE_NAMES = Object.freeze([
  'buildIdentity',
  'sessionIdentity',
  'tableAnchors',
  'addCaptureConsistency',
  'removeCaptureConsistency',
  'routinePeSections',
  'argumentShapes',
  'vtablePeSections',
  'vtableTransitionStability',
]);
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const PARSED_PE_VALUES = new WeakSet();
let evidenceWriteTestHook = null;

function canonicalSha(value) {
  if (typeof value !== 'string' || !/^[0-9A-F]{64}$/.test(value)) {
    throw new TypeError('Executable identity must be an uppercase SHA-256 string');
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}

function nonemptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${label} must contain exactly: ${required.join(', ')}`);
  }
}

function assertPlainJson(value, label = 'Evidence') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPlainJson(entry, `${label}[${index}]`));
    return;
  }
  plainObject(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new TypeError(`${label} contains a prohibited object key`);
    }
    assertPlainJson(entry, `${label}.${key}`);
  }
}

function validateIdentity(identity, label) {
  plainObject(identity, label);
  return Object.freeze({
    pid: positiveInteger(identity.pid, `${label} PID`),
    sessionId: nonemptyString(identity.sessionId, `${label} session ID`),
    executableSha256: canonicalSha(identity.executableSha256),
  });
}

function evidenceIdentity(evidence) {
  plainObject(evidence.build, 'Evidence build identity');
  plainObject(evidence.session, 'Evidence session identity');
  return validateIdentity({
    pid: evidence.session.pid,
    sessionId: evidence.session.sessionId,
    executableSha256: evidence.build.executableSha256,
  }, 'Evidence identity');
}

function validateEvidenceEnvelope(evidence) {
  assertPlainJson(evidence);
  plainObject(evidence, 'Evidence envelope');
  positiveInteger(evidence.schemaVersion, 'Evidence schemaVersion');
  evidenceIdentity(evidence);
  return evidence;
}

function toAddress(value, label = 'address') {
  let result;
  if (typeof value === 'bigint') {
    result = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    result = BigInt(value);
  } else if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
    result = BigInt(value);
  } else {
    throw new TypeError(`${label} must be a bigint, safe integer, or hexadecimal string`);
  }
  if (result < 0n) throw new RangeError(`${label} must not be negative`);
  return result;
}

function canonicalHex(value, label) {
  return `0x${toAddress(value, label).toString(16).toUpperCase()}`;
}

function canonicalNonzeroHex(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9A-F]+$/.test(value) || canonicalHex(value, label) !== value ||
      toAddress(value, label) === 0n) {
    throw new TypeError(`${label} must be a nonzero canonical uppercase hexadecimal RVA`);
  }
  return value;
}

function canonicalNonzeroAddress(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9A-F]+$/.test(value) || canonicalHex(value, label) !== value ||
      toAddress(value, label) === 0n) {
    throw new TypeError(`${label} must be a nonzero canonical uppercase hexadecimal address`);
  }
  return value;
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toUpperCase() : normalized;
}

function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function realpath(filePath) {
  return (fs.realpathSync.native ?? fs.realpathSync)(filePath);
}

function ensureDirectoryComponents(components, create) {
  let lexical = REPOSITORY_ROOT;
  let expectedReal = realpath(REPOSITORY_ROOT);
  for (const component of components) {
    lexical = path.join(lexical, component);
    expectedReal = path.join(expectedReal, component);
    if (!fs.existsSync(lexical)) {
      if (!create) throw Object.assign(new Error(`Evidence path does not exist: ${lexical}`), { code: 'ENOENT' });
      fs.mkdirSync(lexical);
    }
    const status = fs.lstatSync(lexical);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error(`Evidence directory containment rejected a junction or non-directory: ${lexical}`);
    }
    const actualReal = realpath(lexical);
    if (!samePath(actualReal, expectedReal)) {
      throw new Error(`Evidence directory real path escaped containment: ${lexical}`);
    }
  }
  return lexical;
}

function evidenceDirectory(executableSha256) {
  if (arguments.length !== 1) throw new TypeError('evidenceDirectory accepts only the executable SHA argument; its root is fixed');
  return path.join(DEFAULT_OUTPUT_ROOT, canonicalSha(executableSha256));
}

function evidencePathParts(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0') ||
      path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new TypeError('Evidence path must be a nonempty relative evidence path');
  }
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    throw new TypeError('Relative evidence path contains an escape or unsafe component');
  }
  if (!parts.at(-1).endsWith('.json')) throw new TypeError('Evidence path must name a JSON file');
  return parts;
}

function resolveContainedEvidencePath(relativePath, executableSha256, { createParents, requireFile }) {
  const sha = canonicalSha(executableSha256);
  const parts = evidencePathParts(relativePath);
  const parentParts = ['.frtk', 'board-reanchor', sha, ...parts.slice(0, -1)];
  const parent = ensureDirectoryComponents(parentParts, createParents);
  const target = path.join(parent, parts.at(-1));
  if (fs.existsSync(target)) {
    const status = fs.lstatSync(target);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Evidence target is a junction or non-file: ${target}`);
    }
    const expectedReal = path.join(realpath(parent), parts.at(-1));
    if (!samePath(realpath(target), expectedReal)) throw new Error('Evidence target real path escaped containment');
  } else if (requireFile) {
    throw Object.assign(new Error(`Evidence file does not exist: ${target}`), { code: 'ENOENT' });
  }
  return target;
}

function setEvidenceWriteTestHook(hook) {
  if (hook !== null && typeof hook !== 'function') throw new TypeError('Evidence write test hook must be a function or null');
  evidenceWriteTestHook = hook;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyOwnedTemporary(relativePath, sha, temporary, identity, requireEmpty) {
  const parts = evidencePathParts(relativePath);
  const parent = ensureDirectoryComponents(
    ['.frtk', 'board-reanchor', sha, ...parts.slice(0, -1)], false);
  if (!samePath(path.dirname(temporary), parent)) throw new Error('Evidence temporary parent changed containment');
  const status = fs.lstatSync(temporary, { bigint: true });
  if (!status.isFile() || status.isSymbolicLink() || !sameFileIdentity(status, identity)) {
    throw new Error('Evidence temporary identity changed containment');
  }
  if (requireEmpty && status.size !== 0n) throw new Error('Exclusive evidence temporary was not empty before content write');
  const expectedReal = path.join(realpath(parent), path.basename(temporary));
  if (!samePath(realpath(temporary), expectedReal)) throw new Error('Evidence temporary real path escaped containment');
}

function removeOwnedTemporary(sha, temporaryName, identity) {
  let root;
  try {
    root = ensureDirectoryComponents(['.frtk', 'board-reanchor', sha], false);
  } catch {
    return;
  }
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const status = fs.lstatSync(entryPath, { bigint: true });
      if (status.isSymbolicLink()) continue;
      if (status.isDirectory()) {
        pending.push(entryPath);
      } else if (status.isFile() && entry.name === temporaryName && sameFileIdentity(status, identity)) {
        fs.rmSync(entryPath);
        return;
      }
    }
  }
}

function writeEvidence(relativePath, evidence) {
  validateEvidenceEnvelope(evidence);
  const sha = evidence.build.executableSha256;
  const target = resolveContainedEvidencePath(relativePath, sha, { createParents: true, requireFile: false });
  const directory = path.dirname(target);
  const temporary = path.join(directory,
    `.${path.basename(target)}.${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`);
  const serialized = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  let descriptor = null;
  let temporaryIdentity = null;
  let committed = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (!temporaryIdentity.isFile() || temporaryIdentity.size !== 0n) {
      throw new Error('Exclusive evidence temporary was not a zero-byte regular file');
    }
    evidenceWriteTestHook?.({ temporaryPath: temporary, targetPath: target });
    verifyOwnedTemporary(relativePath, sha, temporary, temporaryIdentity, true);
    const written = fs.writeSync(descriptor, serialized, 0, serialized.length, 0);
    if (written !== serialized.length) throw new Error('Evidence temporary write was incomplete');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    verifyOwnedTemporary(relativePath, sha, temporary, temporaryIdentity, false);
    const rechecked = resolveContainedEvidencePath(relativePath, sha, { createParents: false, requireFile: false });
    if (!samePath(rechecked, target)) throw new Error('Evidence target changed during atomic write');
    fs.renameSync(temporary, target);
    committed = true;
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.ftruncateSync(descriptor, 0);
        fs.fsyncSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
      descriptor = null;
    }
    throw error;
  } finally {
    if (!committed && temporaryIdentity !== null) {
      try {
        removeOwnedTemporary(sha, path.basename(temporary), temporaryIdentity);
      } catch {
        // Cleanup is identity-bound and must not mask the original failure.
      }
    }
  }
  return target;
}

function readEvidence(relativePath, expectedIdentity) {
  if (arguments.length !== 2 || expectedIdentity === undefined) {
    throw new TypeError('readEvidence requires an exact expected identity');
  }
  const expected = validateIdentity(expectedIdentity, 'Expected identity');
  const target = resolveContainedEvidencePath(relativePath, expected.executableSha256,
    { createParents: false, requireFile: true });
  const evidence = JSON.parse(fs.readFileSync(target, 'utf8'));
  validateEvidenceEnvelope(evidence);
  const actual = evidenceIdentity(evidence);
  if (actual.pid !== expected.pid) throw new Error('Evidence belongs to a different process PID');
  if (actual.sessionId !== expected.sessionId) throw new Error('Evidence belongs to a different host session');
  if (actual.executableSha256 !== expected.executableSha256) {
    throw new Error('Evidence belongs to a different executable SHA-256');
  }
  return evidence;
}

function requireBufferRange(buffer, offset, length, label) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PE image must be a Buffer');
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset + length > buffer.length) {
    throw new Error(`PE image is truncated before ${label}`);
  }
}

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function parsePeSections(image) {
  requireBufferRange(image, 0, 0x40, 'the DOS header');
  if (image.toString('ascii', 0, 2) !== 'MZ') throw new Error('PE image has no MZ signature');
  const peOffset = image.readUInt32LE(0x3C);
  requireBufferRange(image, peOffset, 24, 'the PE file header');
  if (image.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('PE image has no PE signature');

  const numberOfSections = image.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = image.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  if (numberOfSections === 0 || numberOfSections > 96) throw new Error('PE image has an invalid section count');
  if (optionalHeaderSize < 64) throw new Error('PE optional header is too small');
  requireBufferRange(image, optionalHeaderOffset, optionalHeaderSize, 'the PE optional header');
  const magic = image.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x20B && magic !== 0x10B) throw new Error('PE optional header has an unsupported magic');
  const sectionAlignment = image.readUInt32LE(optionalHeaderOffset + 32);
  const fileAlignment = image.readUInt32LE(optionalHeaderOffset + 36);
  const sizeOfImage = image.readUInt32LE(optionalHeaderOffset + 56);
  const sizeOfHeaders = image.readUInt32LE(optionalHeaderOffset + 60);
  if (!isPowerOfTwo(fileAlignment) || fileAlignment < 0x200 || fileAlignment > 0x10000) {
    throw new Error('PE file alignment is invalid');
  }
  if (!isPowerOfTwo(sectionAlignment) ||
      (sectionAlignment < 0x1000 ? sectionAlignment !== fileAlignment : sectionAlignment < fileAlignment)) {
    throw new Error('PE section alignment is invalid');
  }
  if (sizeOfImage === 0 || sizeOfImage % sectionAlignment !== 0) throw new Error('PE SizeOfImage is not section-aligned');
  if (sizeOfHeaders === 0 || sizeOfHeaders % fileAlignment !== 0 || sizeOfHeaders > image.length) {
    throw new Error('PE SizeOfHeaders is invalid');
  }
  if (sizeOfHeaders > sizeOfImage) throw new Error('PE SizeOfHeaders exceeds SizeOfImage');
  const headerImageRange = { start: 0, end: alignUp(sizeOfHeaders, sectionAlignment) };

  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sectionTableLength = numberOfSections * 40;
  requireBufferRange(image, sectionTableOffset, sectionTableLength, 'the PE section table');
  if (sectionTableOffset + sectionTableLength > sizeOfHeaders) throw new Error('PE section table escapes SizeOfHeaders');

  const sections = [];
  const rawRanges = [];
  const virtualRanges = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const name = image.toString('ascii', offset, offset + 8).replace(/\0.*$/, '');
    const virtualSize = image.readUInt32LE(offset + 8);
    const virtualAddress = image.readUInt32LE(offset + 12);
    const rawSize = image.readUInt32LE(offset + 16);
    const rawAddress = image.readUInt32LE(offset + 20);
    const characteristics = image.readUInt32LE(offset + 36);
    const mappedSize = Math.max(virtualSize, rawSize);
    if (mappedSize === 0) throw new Error(`PE section ${name || index} has no mapped content`);
    if (virtualAddress === 0 || virtualAddress % sectionAlignment !== 0) {
      throw new Error(`PE section ${name || index} violates section alignment`);
    }
    const virtualRange = { start: virtualAddress, end: virtualAddress + mappedSize };
    if (virtualRange.end > sizeOfImage) throw new Error(`PE section ${name || index} escapes SizeOfImage`);
    if (rangesOverlap(headerImageRange, virtualRange)) {
      throw new Error(`PE header image range overlaps section ${name || index}`);
    }
    if (virtualRanges.some((range) => rangesOverlap(range, virtualRange))) {
      throw new Error(`PE virtual section ranges overlap at ${name || index}`);
    }
    virtualRanges.push(virtualRange);

    if (rawSize > 0) {
      if (rawSize % fileAlignment !== 0 || rawAddress < sizeOfHeaders || rawAddress % fileAlignment !== 0) {
        throw new Error(`PE section ${name || index} has an invalid raw range alignment`);
      }
      const rawRange = { start: rawAddress, end: rawAddress + rawSize };
      if (rawRange.end > image.length) throw new Error(`PE section ${name || index} raw range is truncated`);
      if (rawRanges.some((range) => rangesOverlap(range, rawRange))) {
        throw new Error(`PE raw section ranges overlap at ${name || index}`);
      }
      rawRanges.push(rawRange);
    } else if (rawAddress !== 0) {
      throw new Error(`PE section ${name || index} has a raw address without raw data`);
    }

    sections.push(Object.freeze({
      name,
      virtualAddress,
      virtualSize,
      rawAddress,
      rawSize,
      mappedSize,
      characteristics,
      readable: (characteristics & IMAGE_SCN_MEM_READ) !== 0,
      executable: (characteristics & IMAGE_SCN_MEM_EXECUTE) !== 0,
    }));
  }
  const result = Object.freeze({
    fileSize: image.length,
    executableSha256: crypto.createHash('sha256').update(image).digest('hex').toUpperCase(),
    sizeOfImage,
    sizeOfHeaders,
    sectionAlignment,
    fileAlignment,
    sections: Object.freeze(sections),
  });
  PARSED_PE_VALUES.add(result);
  return result;
}

function classifyModuleAddress(address, moduleBase, pe) {
  if (!PARSED_PE_VALUES.has(pe)) throw new TypeError('PE metadata must come from parsePeSections');
  const target = toAddress(address);
  const base = toAddress(moduleBase, 'module base');
  const end = base + BigInt(pe.sizeOfImage);
  if (target < base || target >= end) {
    return Object.freeze({
      address: canonicalHex(target), insideImage: false, rva: null, section: null,
      readable: false, executable: false,
    });
  }
  const rvaValue = target - base;
  const section = pe.sections.find((candidate) =>
    rvaValue >= BigInt(candidate.virtualAddress) &&
    rvaValue < BigInt(candidate.virtualAddress + candidate.mappedSize)) ?? null;
  return Object.freeze({
    address: canonicalHex(target),
    insideImage: true,
    rva: canonicalHex(rvaValue),
    section,
    readable: section?.readable === true,
    executable: section?.executable === true,
  });
}

function captureStackReturns(capture) {
  if (Array.isArray(capture?.hits)) {
    return capture.hits.flatMap((hit) => Array.isArray(hit?.stackReturnAddresses) ? hit.stackReturnAddresses : []);
  }
  return [];
}

function captureIdentity(capture) {
  plainObject(capture, 'Capture');
  return validateIdentity({
    pid: capture.session?.pid,
    sessionId: capture.session?.sessionId,
    executableSha256: capture.build?.executableSha256,
  }, 'Capture identity');
}

function rankRoutineCandidates(captures, { moduleBase, pe }) {
  if (!Array.isArray(captures) || captures.length !== 2) {
    throw new Error('Exactly two captures are required to rank routine candidates');
  }
  const captureIds = captures.map((entry) => nonemptyString(entry?.captureId, 'Capture ID'));
  if (captureIds[0] === captureIds[1]) throw new Error('Two distinct capture IDs are required');
  const identities = captures.map(captureIdentity);
  if (identities[0].pid !== identities[1].pid || identities[0].sessionId !== identities[1].sessionId ||
      identities[0].executableSha256 !== identities[1].executableSha256) {
    throw new Error('Routine captures must have the same exact process, host session, and executable identity');
  }
  const captureCounts = captures.map((entry) => {
    const counts = new Map();
    for (const address of captureStackReturns(entry)) {
      const key = canonicalHex(address);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });
  const ranked = [];
  for (const address of captureCounts[0].keys()) {
    if (!captureCounts[1].has(address)) continue;
    const classification = classifyModuleAddress(address, moduleBase, pe);
    if (!classification.insideImage || !classification.executable) continue;
    const hitCount = captureCounts[0].get(address) + captureCounts[1].get(address);
    ranked.push({ address, rva: classification.rva, captureCount: 2, hitCount, score: 200 + hitCount });
  }
  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftAddress = toAddress(left.address);
    const rightAddress = toAddress(right.address);
    return leftAddress < rightAddress ? -1 : leftAddress > rightAddress ? 1 : 0;
  });
  return ranked;
}

function sameAddress(left, right) {
  return toAddress(left) === toAddress(right);
}

function validRow(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateVtable(object, label, moduleBase, pe) {
  try {
    const vtableAddress = canonicalNonzeroAddress(object?.vtableAddress, `${label} vtable address`);
    const table = classifyModuleAddress(vtableAddress, moduleBase, pe);
    if (!table.insideImage || !table.readable) return `${label} vtable is not in readable main-module image memory`;
    if (!Array.isArray(object.vtableEntries) || object.vtableEntries.length === 0) {
      return `${label} vtable has no sampled entries`;
    }
    for (const entry of object.vtableEntries) {
      const target = classifyModuleAddress(
        canonicalNonzeroAddress(entry, `${label} vtable entry`), moduleBase, pe);
      if (!target.insideImage || !target.executable) {
        return `${label} vtable entry is not in an executable main-module section`;
      }
    }
    return null;
  } catch (error) {
    return `${label} vtable is malformed: ${error.message}`;
  }
}

function validateCaptureVtables(capture, moduleBase, pe) {
  for (const [object, label] of [[capture?.controller, 'Controller'], [capture?.team, 'Team'], [capture?.recruit, 'Recruit']]) {
    const error = validateVtable(object, label, moduleBase, pe);
    if (error) return Object.freeze({ passed: false, detail: error });
  }
  return Object.freeze({ passed: true, detail: 'All sampled vtables passed PE checks' });
}

function validateObjectShapes(capture, { moduleBase, pe }) {
  const reject = (detail) => Object.freeze({ passed: false, detail });
  try {
    const args = capture?.arguments;
    const cells = capture?.pointerCells;
    const controller = capture?.controller;
    const team = capture?.team;
    const recruit = capture?.recruit;
    const expected = capture?.expected;
    if (!args || !cells || !controller || !team || !recruit || !expected) return reject('Full entry object shape is incomplete');
    for (const [address, label] of [
      [args.rcx, 'RCX'], [args.rdx, 'RDX'], [args.r8, 'R8'],
      [controller.address, 'Controller object'], [team.address, 'Team wrapper'],
      [recruit.address, 'Recruit wrapper'], [cells.team?.address, 'Team pointer cell'],
      [cells.team?.value, 'Team pointer value'], [cells.recruit?.address, 'Recruit pointer cell'],
      [cells.recruit?.value, 'Recruit pointer value'],
    ]) canonicalNonzeroAddress(address, label);
    const distinctObjectsAndCells = [
      controller.address, team.address, recruit.address, cells.team.address, cells.recruit.address,
    ].map((address) => canonicalHex(address));
    if (new Set(distinctObjectsAndCells).size !== distinctObjectsAndCells.length) {
      return reject('Controller, wrappers, and pointer cells must have distinct nonzero addresses');
    }
    canonicalNonzeroAddress(controller.vtableAddress, 'Controller vtable');
    canonicalNonzeroAddress(team.vtableAddress, 'Team vtable');
    canonicalNonzeroAddress(recruit.vtableAddress, 'Recruit vtable');
    if (sameAddress(controller.vtableAddress, team.vtableAddress)) {
      return reject('Controller and generic record-wrapper vtables must be distinct');
    }
    if (![expected.membershipRow, expected.teamRow, expected.recruitRow].every(validRow)) {
      return reject('Expected membership, Team, and Recruit rows must be nonnegative safe integers');
    }
    if (!validRow(controller.membershipRow) || !validRow(controller.boardStore?.membershipRow) ||
        !validRow(team.row) || !validRow(recruit.row)) {
      return reject('Captured membership, Team, and Recruit rows must be nonnegative safe integers');
    }
    if (!sameAddress(args.rcx, controller.address)) return reject('RCX does not contain the recruiting controller');
    if (controller.readable !== true || controller.descriptorTableId !== 5003) {
      return reject('RCX object is not a readable descriptor-table 5003 recruiting controller');
    }
    if (controller.membershipRow !== expected.membershipRow || controller.boardStore.offset !== 0x138 ||
        controller.boardStore.readable !== true || controller.boardStore.membershipRow !== expected.membershipRow) {
      return reject('Controller board store at +0x138 does not expose the expected membership row');
    }
    if (cells.team?.readable !== true || !sameAddress(args.rdx, cells.team.address) ||
        !sameAddress(cells.team.value, team.address)) {
      return reject('RDX is not a readable pointer cell containing the Team wrapper');
    }
    if (cells.recruit?.readable !== true || !sameAddress(args.r8, cells.recruit.address) ||
        !sameAddress(cells.recruit.value, recruit.address)) {
      return reject('R8 is not a readable pointer cell containing the Recruit wrapper');
    }
    if (team.readable !== true || team.descriptorTableId !== 6334 || team.row !== expected.teamRow ||
        team.field10Readable !== true || team.field18Readable !== true) {
      return reject('Team wrapper descriptor, row identity, or +0x10/+0x18 fields are invalid');
    }
    if (recruit.readable !== true || recruit.descriptorTableId !== 4269 || recruit.row !== expected.recruitRow ||
        recruit.field10Readable !== true || recruit.field18Readable !== true) {
      return reject('Recruit wrapper descriptor, row identity, or +0x10/+0x18 fields are invalid');
    }
    if (!sameAddress(team.vtableAddress, recruit.vtableAddress)) {
      return reject('Team and Recruit wrappers do not share the generic record-wrapper vtable');
    }
    const vtables = validateCaptureVtables(capture, moduleBase, pe);
    if (!vtables.passed) return reject(vtables.detail);
    return Object.freeze({
      passed: true,
      detail: 'Full entry arguments and object shapes matched',
      genericRecordWrapperVtableAddress: canonicalHex(team.vtableAddress),
      recruitingControllerVtableAddress: canonicalHex(controller.vtableAddress),
    });
  } catch (error) {
    return reject(`Full entry object shape is malformed: ${error.message}`);
  }
}

function deriveVtableRvas(captures, { moduleBase, pe }) {
  if (!Array.isArray(captures) || captures.length < 2) throw new Error('At least two object captures are required to prove stable vtables');
  const validations = captures.map((entry) => validateObjectShapes(entry, { moduleBase, pe }));
  const rejected = validations.findIndex((validation) => !validation.passed);
  if (rejected !== -1) throw new Error(`Capture ${rejected + 1} object shape rejected: ${validations[rejected].detail}`);
  const wrapper = validations[0].genericRecordWrapperVtableAddress;
  const controller = validations[0].recruitingControllerVtableAddress;
  if (!validations.every((validation) => validation.genericRecordWrapperVtableAddress === wrapper &&
      validation.recruitingControllerVtableAddress === controller)) {
    throw new Error('Vtable addresses were not stable across captures');
  }
  return Object.freeze({
    genericRecordWrapperVtableRva: classifyModuleAddress(wrapper, moduleBase, pe).rva,
    recruitingControllerVtableRva: classifyModuleAddress(controller, moduleBase, pe).rva,
  });
}

function validateBuild(build) {
  assertExactKeys(build, ['label', 'executableSize', 'executableSha256'], 'Candidate build');
  return {
    label: nonemptyString(build.label, 'Build label'),
    executableSize: positiveInteger(build.executableSize, 'Executable size'),
    executableSha256: canonicalSha(build.executableSha256),
  };
}

function validateSession(session) {
  assertExactKeys(session, ['pid', 'sessionId', 'moduleBase', 'capturedAt'], 'Candidate session');
  const moduleBase = canonicalNonzeroHex(session.moduleBase, 'Module base');
  const capturedAt = nonemptyString(session.capturedAt, 'Capture timestamp');
  const parsedDate = new Date(capturedAt);
  if (!Number.isFinite(parsedDate.valueOf()) || parsedDate.toISOString() !== capturedAt) {
    throw new TypeError('Capture timestamp must be a canonical ISO-8601 instant');
  }
  return {
    pid: positiveInteger(session.pid, 'Session PID'),
    sessionId: nonemptyString(session.sessionId, 'Session ID'),
    moduleBase,
    capturedAt,
  };
}

function validateTables(tables) {
  assertExactKeys(tables, TABLE_IDS, 'Candidate tables (exactly six table summaries)');
  return Object.fromEntries(TABLE_IDS.map((id) => {
    const summary = tables[id];
    assertExactKeys(summary, ['passed', 'candidateCount', 'score', 'rereadPassed'], `Table ${id} summary`);
    if (typeof summary.passed !== 'boolean' || typeof summary.rereadPassed !== 'boolean' ||
        typeof summary.score !== 'number' || !Number.isFinite(summary.score) || summary.score < 0) {
      throw new TypeError(`Table ${id} summary is invalid`);
    }
    return [id, {
      passed: summary.passed,
      candidateCount: nonnegativeInteger(summary.candidateCount, `Table ${id} candidate count`),
      score: summary.score,
      rereadPassed: summary.rereadPassed,
    }];
  }));
}

function validateCaptures(captures) {
  assertExactKeys(captures, ['add', 'remove'], 'Candidate captures');
  return Object.fromEntries(['add', 'remove'].map((operation) => {
    const summary = captures[operation];
    assertExactKeys(summary, ['writeCount', 'executeCount', 'consistent'], `${operation} capture summary`);
    if (typeof summary.consistent !== 'boolean') throw new TypeError(`${operation} capture summary is invalid`);
    return [operation, {
      writeCount: nonnegativeInteger(summary.writeCount, `${operation} capture summary write count`),
      executeCount: nonnegativeInteger(summary.executeCount, `${operation} capture summary execute count`),
      consistent: summary.consistent,
    }];
  }));
}

function validateBoardRvas(board) {
  assertExactKeys(board, BOARD_RVAS, 'Proposed board');
  return Object.fromEntries(BOARD_RVAS.map((name) => [name, canonicalNonzeroHex(board[name], `Nonzero ${name} RVA`)]));
}

function validateProofCapture(capture, label, build, session, requireEntryAddress) {
  plainObject(capture, `${label} proof capture`);
  nonemptyString(capture.captureId, `${label} proof capture ID`);
  assertExactKeys(capture.build, ['executableSize', 'executableSha256'], `${label} proof capture build identity`);
  assertExactKeys(capture.session, ['pid', 'sessionId'], `${label} proof capture session identity`);
  const captureSize = positiveInteger(capture.build.executableSize, `${label} proof capture executable size`);
  const captureSha = canonicalSha(capture.build.executableSha256);
  const capturePid = positiveInteger(capture.session.pid, `${label} proof capture PID`);
  const captureSessionId = nonemptyString(capture.session.sessionId, `${label} proof capture session ID`);
  if (captureSize !== build.executableSize || captureSha !== build.executableSha256) {
    throw new Error(`${label} proof capture build identity does not match the authenticated candidate build size and SHA`);
  }
  if (capturePid !== session.pid || captureSessionId !== session.sessionId) {
    throw new Error(`${label} proof capture session identity does not match candidate PID and session ID`);
  }
  if (requireEntryAddress) canonicalNonzeroAddress(capture.entryAddress, `${label} proof capture entry address`);
  return capture;
}

function validateProof(proof, build, session) {
  assertExactKeys(proof, [
    'pe', 'fullAddCapture', 'fullRemoveCapture', 'transitionObjectCapture',
  ], 'Candidate proof');
  if (!PARSED_PE_VALUES.has(proof.pe)) throw new TypeError('Candidate proof PE metadata must come from parsePeSections');
  const peIdentityMatches = proof.pe.fileSize === build.executableSize &&
    proof.pe.executableSha256 === build.executableSha256;
  if (!peIdentityMatches) {
    throw new Error('Candidate build size and SHA must exactly match authenticated PE metadata');
  }
  const fullAddCapture = validateProofCapture(proof.fullAddCapture, 'Add execute', build, session, true);
  const fullRemoveCapture = validateProofCapture(proof.fullRemoveCapture, 'Remove execute', build, session, true);
  const transitionObjectCapture = validateProofCapture(
    proof.transitionObjectCapture, 'Transition object', build, session, false);
  const captureIds = [fullAddCapture.captureId, fullRemoveCapture.captureId, transitionObjectCapture.captureId];
  if (new Set(captureIds).size !== captureIds.length) throw new Error('Proof captures must have distinct capture IDs');
  return {
    pe: proof.pe,
    fullAddCapture,
    fullRemoveCapture,
    transitionObjectCapture,
    buildIdentityPassed: peIdentityMatches && [fullAddCapture, fullRemoveCapture, transitionObjectCapture].every(
      (capture) => capture.build.executableSize === build.executableSize &&
        capture.build.executableSha256 === build.executableSha256),
    sessionIdentityPassed: [fullAddCapture, fullRemoveCapture, transitionObjectCapture].every(
      (capture) => capture.session.pid === session.pid && capture.session.sessionId === session.sessionId),
  };
}

function buildCandidateArtifact(input) {
  assertExactKeys(input, ['build', 'session', 'tables', 'captures', 'proposedBoard', 'proof'],
    'Candidate input');
  const build = validateBuild(input.build);
  const session = validateSession(input.session);
  const tables = validateTables(input.tables);
  const captures = validateCaptures(input.captures);
  const proposedBoard = validateBoardRvas(input.proposedBoard);
  const proof = validateProof(input.proof, build, session);
  const moduleBase = session.moduleBase;

  const addRoutine = classifyModuleAddress(proof.fullAddCapture.entryAddress, moduleBase, proof.pe);
  const removeRoutine = classifyModuleAddress(proof.fullRemoveCapture.entryAddress, moduleBase, proof.pe);
  const routinePeSections = addRoutine.executable && removeRoutine.executable &&
    addRoutine.rva === proposedBoard.fullAddRva && removeRoutine.rva === proposedBoard.fullRemoveRva;
  const addShape = validateObjectShapes(proof.fullAddCapture, { moduleBase, pe: proof.pe });
  const removeShape = validateObjectShapes(proof.fullRemoveCapture, { moduleBase, pe: proof.pe });
  const argumentShapes = addShape.passed && removeShape.passed;
  const allObjectCaptures = [proof.fullAddCapture, proof.fullRemoveCapture, proof.transitionObjectCapture];
  const vtablePeSections = allObjectCaptures.every((entry) =>
    validateCaptureVtables(entry, moduleBase, proof.pe).passed);
  let vtableTransitionStability = false;
  try {
    const derived = deriveVtableRvas(allObjectCaptures, { moduleBase, pe: proof.pe });
    vtableTransitionStability = derived.genericRecordWrapperVtableRva ===
      proposedBoard.genericRecordWrapperVtableRva && derived.recruitingControllerVtableRva ===
      proposedBoard.recruitingControllerVtableRva;
  } catch {
    vtableTransitionStability = false;
  }
  const tableAnchors = Object.values(tables).every((table) =>
    table.passed && table.candidateCount === 1 && table.score > 0 && table.rereadPassed);
  const addCaptureConsistency = captures.add.writeCount >= 2 && captures.add.executeCount >= 1 && captures.add.consistent;
  const removeCaptureConsistency = captures.remove.writeCount >= 2 && captures.remove.executeCount >= 1 && captures.remove.consistent;
  const derivedGates = {
    buildIdentity: {
      passed: proof.buildIdentityPassed,
      detail: `Authenticated PE and all proof captures match executable size ${build.executableSize} and SHA-256 ${build.executableSha256}`,
    },
    sessionIdentity: {
      passed: proof.sessionIdentityPassed,
      detail: `All proof captures match PID ${session.pid} and host session ${session.sessionId}`,
    },
    tableAnchors: {
      passed: tableAnchors,
      detail: tableAnchors ? 'All six tables have exactly one positive, reread-verified candidate' :
        'One or more tables lack exactly one positive, reread-verified candidate',
    },
    addCaptureConsistency: {
      passed: addCaptureConsistency,
      detail: `Add evidence has ${captures.add.writeCount} write captures, ${captures.add.executeCount} execute captures, consistent=${captures.add.consistent}`,
    },
    removeCaptureConsistency: {
      passed: removeCaptureConsistency,
      detail: `Remove evidence has ${captures.remove.writeCount} write captures, ${captures.remove.executeCount} execute captures, consistent=${captures.remove.consistent}`,
    },
    routinePeSections: {
      passed: routinePeSections,
      detail: routinePeSections ? `Add ${addRoutine.rva} and remove ${removeRoutine.rva} entries match executable image sections` :
        'An executed entry is non-executable or does not equal the proposed operation RVA',
    },
    argumentShapes: {
      passed: argumentShapes,
      detail: argumentShapes ? 'Add and remove executed entries carry the required RCX/RDX/R8 object shapes' :
        `Add: ${addShape.detail}; remove: ${removeShape.detail}`,
    },
    vtablePeSections: {
      passed: vtablePeSections,
      detail: vtablePeSections ? 'All proof vtables are readable with executable sampled entries' :
        'A proof vtable or sampled entry failed main-module PE checks',
    },
    vtableTransitionStability: {
      passed: vtableTransitionStability,
      detail: vtableTransitionStability ? 'Wrapper and controller vtable RVAs remain stable across all identity-bound proofs' :
        'Wrapper or controller vtable RVAs are invalid, mismatched, or unstable',
    },
  };
  const gates = REQUIRED_GATE_NAMES.map((name) => ({ name, ...derivedGates[name] }));

  return {
    schemaVersion: 1,
    build,
    session,
    tables,
    captures,
    proposedBoard,
    gates,
    passed: gates.every((gate) => gate.passed),
  };
}

module.exports = {
  REQUIRED_GATE_NAMES,
  setEvidenceWriteTestHook,
  evidenceDirectory,
  writeEvidence,
  readEvidence,
  parsePeSections,
  classifyModuleAddress,
  rankRoutineCandidates,
  validateObjectShapes,
  deriveVtableRvas,
  buildCandidateArtifact,
};
