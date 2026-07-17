'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  generateHeader,
  loadManifest,
  parseManifest,
  writeGeneratedHeader,
} = require('../scripts/game-build-manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'native', 'host', 'game_builds.json');
const HEADER = path.join(ROOT, 'native', 'host', 'game_builds.generated.h');
const JULY_11_SHA =
  '9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8';
const PATCH1_SHA =
  'A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD';

function diagnosticBuild(overrides = {}) {
  return {
    label: 'patch-1-2026-07-16',
    size: 249801616,
    sha256: PATCH1_SHA,
    support: 'diagnostic',
    board: null,
    ...overrides,
  };
}

function certifiedBuild(overrides = {}) {
  return {
    label: 'july-11-2026',
    size: 247845776,
    sha256: JULY_11_SHA,
    support: 'certified',
    board: {
      genericRecordWrapperVtableRva: '0xB093F68',
      recruitingControllerVtableRva: '0xB0B5BA8',
      fullAddRva: '0x8109060',
      fullRemoveRva: '0x8166090',
      recruitTableId: '0x10AD',
      teamTableId: '0x18BE',
      controllerDescriptorTableId: '0x138B',
      userTargetTableId: '0x1048',
      activePitchTableId: '0x169E',
      membershipTableId: '0x16D7',
    },
    ...overrides,
  };
}

function manifest(builds) {
  return { version: 1, builds };
}

test('SHA-256 values must already be normalized uppercase hexadecimal', () => {
  for (const sha256 of [JULY_11_SHA.toLowerCase(), `0x${JULY_11_SHA}`, 'A'.repeat(63)]) {
    assert.throws(
      () => parseManifest(manifest([certifiedBuild({ sha256 })])),
      /sha256.*uppercase.*64/i,
    );
  }
});

test('duplicate executable sizes and hashes are rejected', () => {
  assert.throws(
    () => parseManifest(manifest([
      certifiedBuild(),
      diagnosticBuild({ size: 247845776 }),
    ])),
    /duplicate.*size/i,
  );
  assert.throws(
    () => parseManifest(manifest([
      certifiedBuild(),
      diagnosticBuild({ sha256: JULY_11_SHA }),
    ])),
    /duplicate.*sha256/i,
  );
});

test('diagnostic builds cannot carry a board layout', () => {
  assert.throws(() => parseManifest(manifest([diagnosticBuild({
    board: { genericRecordWrapperVtableRva: '0x1' },
  })])), /diagnostic.*board/i);
});

test('certified builds require all nonzero layout values', () => {
  const board = certifiedBuild().board;
  for (const key of Object.keys(board)) {
    const missing = { ...board };
    delete missing[key];
    assert.throws(
      () => parseManifest(manifest([certifiedBuild({ board: missing })])),
      new RegExp(key, 'i'),
    );
    assert.throws(
      () => parseManifest(manifest([certifiedBuild({
        board: { ...board, [key]: '0x0' },
      })])),
      new RegExp(`${key}.*nonzero`, 'i'),
    );
  }
});

test('unknown manifest, build, and board keys are rejected', () => {
  assert.throws(
    () => parseManifest({ ...manifest([]), extra: true }),
    /unknown.*extra/i,
  );
  assert.throws(
    () => parseManifest(manifest([diagnosticBuild({ extra: true })])),
    /unknown.*extra/i,
  );
  assert.throws(
    () => parseManifest(manifest([certifiedBuild({
      board: { ...certifiedBuild().board, extra: '0x1' },
    })])),
    /unknown.*extra/i,
  );
});

test('RVA strings are parsed to BigInt and emitted canonically', () => {
  const build = certifiedBuild({
    board: {
      ...certifiedBuild().board,
      fullAddRva: '0x0008109060',
      fullRemoveRva: '0x816609a',
    },
  });
  const parsed = parseManifest(manifest([build]));

  assert.equal(parsed.builds[0].board.fullAddRva, 0x8109060n);
  assert.equal(parsed.builds[0].board.fullRemoveRva, 0x816609An);
  assert.match(generateHeader(parsed), /0x8109060ULL, 0x816609AULL/);
});

test('generated entries preserve manifest order', () => {
  const parsed = parseManifest(manifest([diagnosticBuild(), certifiedBuild()]));
  const header = generateHeader(parsed);

  assert.ok(header.indexOf('patch-1-2026-07-16') < header.indexOf('july-11-2026'));
  assert.match(header, /std::array<GeneratedBuild, 2>/);
  assert.doesNotMatch(header, /fstream|filesystem|readFile|game_builds\.json/i);
});

test('loadManifest reads and parses a JSON manifest', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-builds-'));
  const manifestPath = path.join(temporaryDirectory, 'game_builds.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest([diagnosticBuild()])), 'utf8');
    assert.deepEqual(loadManifest(manifestPath), parseManifest(manifest([diagnosticBuild()])));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('writeGeneratedHeader writes deterministically and check mode never changes files', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-builds-'));
  const manifestPath = path.join(temporaryDirectory, 'game_builds.json');
  const headerPath = path.join(temporaryDirectory, 'game_builds.generated.h');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest([diagnosticBuild()])), 'utf8');

    assert.equal(writeGeneratedHeader({ manifestPath, headerPath, check: false }), true);
    const generated = fs.readFileSync(headerPath, 'utf8');
    assert.equal(writeGeneratedHeader({ manifestPath, headerPath, check: true }), true);
    assert.equal(fs.readFileSync(headerPath, 'utf8'), generated);

    fs.writeFileSync(headerPath, 'stale\n', 'utf8');
    assert.equal(writeGeneratedHeader({ manifestPath, headerPath, check: true }), false);
    assert.equal(fs.readFileSync(headerPath, 'utf8'), 'stale\n');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the checked-in generated header is current', () => {
  const parsed = parseManifest(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')));
  assert.equal(fs.readFileSync(HEADER, 'utf8'), generateHeader(parsed));
});
