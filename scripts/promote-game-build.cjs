'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseManifest,
  writeGeneratedHeader,
} = require('./game-build-manifest.cjs');
const {
  REQUIRED_GATE_NAMES,
  evidenceDirectory,
} = require('./board-verification/reanchor-evidence.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'native', 'host', 'game_builds.json');
const HEADER_PATH = path.join(ROOT, 'native', 'host', 'game_builds.generated.h');
const BOARD_KEYS = [
  'genericRecordWrapperVtableRva',
  'recruitingControllerVtableRva',
  'fullAddRva',
  'fullRemoveRva',
  'recruitTableId',
  'teamTableId',
  'controllerDescriptorTableId',
  'userTargetTableId',
  'activePitchTableId',
  'membershipTableId',
];

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function canonicalSha(value) {
  if (typeof value !== 'string' || !/^[0-9A-F]{64}$/.test(value)) {
    throw new TypeError('Build SHA must be uppercase SHA-256');
  }
  return value;
}

function canonicalRva(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9A-F]+$/.test(value) || BigInt(value) === 0n ||
      `0x${BigInt(value).toString(16).toUpperCase()}` !== value) {
    throw new TypeError(`${label} must be a nonzero canonical uppercase RVA`);
  }
  return value;
}

function validateCandidate(candidate) {
  exactKeys(candidate, ['schemaVersion', 'build', 'session', 'tables', 'captures',
    'proposedBoard', 'gates', 'passed'], 'Candidate');
  if (candidate.schemaVersion !== 1 || candidate.passed !== true) throw new Error('Candidate did not pass all evidence gates');
  exactKeys(candidate.build, ['label', 'executableSize', 'executableSha256'], 'Candidate build');
  if (typeof candidate.build.label !== 'string' || candidate.build.label.length === 0 ||
      !Number.isSafeInteger(candidate.build.executableSize) || candidate.build.executableSize <= 0) {
    throw new TypeError('Candidate build identity is invalid');
  }
  canonicalSha(candidate.build.executableSha256);
  exactKeys(candidate.proposedBoard, BOARD_KEYS, 'Candidate board layout');
  const board = Object.fromEntries(BOARD_KEYS.map((key) => [key,
    canonicalRva(candidate.proposedBoard[key], key)]));
  if (!Array.isArray(candidate.gates) || candidate.gates.length !== REQUIRED_GATE_NAMES.length) {
    throw new Error('Candidate has an incomplete evidence gate set');
  }
  const names = candidate.gates.map((gate) => gate?.name);
  if (new Set(names).size !== names.length ||
      names.some((name, index) => name !== REQUIRED_GATE_NAMES[index]) ||
      candidate.gates.some((gate) => gate.passed !== true || typeof gate.detail !== 'string' || !gate.detail)) {
    throw new Error('Candidate evidence gates are missing, reordered, duplicated, or failed');
  }
  return { build: { ...candidate.build }, board };
}

function certifyManifest(rawManifest, candidate) {
  parseManifest(rawManifest);
  const validated = validateCandidate(candidate);
  const output = JSON.parse(JSON.stringify(rawManifest));
  const matches = output.builds.filter((build) => build.size === validated.build.executableSize &&
    build.sha256 === validated.build.executableSha256);
  if (matches.length !== 1) throw new Error('Candidate does not match exactly one registered build');
  const build = matches[0];
  if (build.support !== 'diagnostic' || build.board !== null) throw new Error('Only a diagnostic build can be certified');
  if (build.label !== validated.build.label) throw new Error('Candidate build label does not match the registry');
  build.support = 'certified';
  build.board = validated.board;
  parseManifest(output);
  return output;
}

function demoteManifest(rawManifest, sha256) {
  parseManifest(rawManifest);
  const sha = canonicalSha(sha256);
  const output = JSON.parse(JSON.stringify(rawManifest));
  const matches = output.builds.filter((build) => build.sha256 === sha);
  if (matches.length !== 1) throw new Error('Demotion SHA does not match exactly one registered build');
  matches[0].support = 'diagnostic';
  matches[0].board = null;
  parseManifest(output);
  return output;
}

function containedCandidatePath(candidatePath) {
  const absolute = path.resolve(candidatePath);
  const parent = path.dirname(absolute);
  const sha = path.basename(parent);
  canonicalSha(sha);
  if (path.basename(absolute) !== 'candidate.json' || path.resolve(evidenceDirectory(sha), 'candidate.json') !== absolute) {
    throw new Error('Candidate path must be the fixed .frtk/board-reanchor/<SHA>/candidate.json');
  }
  const status = fs.lstatSync(absolute);
  if (!status.isFile() || status.isSymbolicLink() || fs.realpathSync.native(absolute) !== absolute) {
    throw new Error('Candidate path is not a contained regular file');
  }
  return absolute;
}

function writeManifest(rawManifest) {
  const temporary = `${MANIFEST_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(rawManifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temporary, MANIFEST_PATH); }
  finally { fs.rmSync(temporary, { force: true }); }
  writeGeneratedHeader({ manifestPath: MANIFEST_PATH, headerPath: HEADER_PATH });
}

function parseCli(argv) {
  if (argv.length === 3 && argv[0] === '--candidate' && argv[2] === '--certify') {
    return { mode: 'certify', candidatePath: argv[1] };
  }
  if (argv.length === 3 && argv[0] === '--sha' && argv[2] === '--diagnostic') {
    return { mode: 'diagnostic', sha256: argv[1] };
  }
  throw new Error('Usage: promote-game-build.cjs --candidate <candidate.json> --certify | --sha <SHA256> --diagnostic');
}

function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const output = options.mode === 'certify'
    ? certifyManifest(manifest, JSON.parse(fs.readFileSync(containedCandidatePath(options.candidatePath), 'utf8')))
    : demoteManifest(manifest, options.sha256);
  writeManifest(output);
  process.stdout.write(`${options.mode === 'certify' ? 'certified' : 'demoted'} ${
    options.mode === 'certify' ? output.builds.find((build) => build.support === 'certified' &&
      build.sha256 !== manifest.builds.find((entry) => entry.support === 'certified')?.sha256)?.sha256 || 'build'
      : options.sha256}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { validateCandidate, certifyManifest, demoteManifest, parseCli };
