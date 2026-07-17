#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { writeGeneratedHeader } = require('./game-build-manifest.cjs');

const args = process.argv.slice(2);
const unknown = args.filter((argument) => argument !== '--check');
if (unknown.length > 0 || args.filter((argument) => argument === '--check').length > 1) {
  console.error('Usage: node scripts/generate-game-builds.cjs [--check]');
  process.exitCode = 1;
} else {
  const check = args.includes('--check');
  const root = path.resolve(__dirname, '..');
  const manifestPath = path.join(root, 'native', 'host', 'game_builds.json');
  const headerPath = path.join(root, 'native', 'host', 'game_builds.generated.h');
  const current = writeGeneratedHeader({ manifestPath, headerPath, check });

  if (!current) {
    console.error(
      'native/host/game_builds.generated.h is stale; run node scripts/generate-game-builds.cjs',
    );
    process.exitCode = 1;
  } else if (check) {
    console.log('native/host/game_builds.generated.h is current');
  } else {
    console.log('generated native/host/game_builds.generated.h');
  }
}
