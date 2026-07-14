'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/windows-ci.yml'),
  'utf8',
);
const building = fs.readFileSync(
  path.join(root, 'docs/development/building.md'),
  'utf8',
);

const standaloneSmokes = [
  'cfb27_memory_reader_smoke.exe',
  'cfb27_telemetry_smoke.exe',
  'cfb27_memory_transaction_smoke.exe',
  'cfb27_frtk_profile_smoke.exe',
  'cfb27_frtk_field_schema_smoke.exe',
  'cfb27_frtk_discovery_smoke.exe',
  'cfb27_frtk_catalog_smoke.exe',
  'cfb27_frtk_record_access_smoke.exe',
];
const hostSmokes = [
  'cfb27_startup_smoke.exe',
  'cfb27_frtk_lua_api_smoke.exe',
  'cfb27_protocol_smoke.exe',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireCompleteSmokeInventory(contents, commandPrefix, artifactPrefix) {
  for (const executable of standaloneSmokes) {
    assert.match(
      contents,
      new RegExp(`${escapeRegExp(commandPrefix)}${escapeRegExp(executable)}(?:\\r?\\n|$)`),
      `${executable} must run without arguments`,
    );
  }
  for (const executable of hostSmokes) {
    assert.match(
      contents,
      new RegExp(
        `${escapeRegExp(commandPrefix)}${escapeRegExp(executable)} ` +
        `${escapeRegExp(artifactPrefix)}cfb27_lua_host\\.dll(?:\\r?\\n|$)`,
      ),
      `${executable} must receive the Lua host DLL`,
    );
  }
}

test('Windows CI runs the complete native smoke inventory with required arguments', () => {
  requireCompleteSmokeInventory(
    workflow,
    '- run: native/build-release/Release/',
    'native/build-release/Release/',
  );
});

test('local build documentation runs the same complete native smoke inventory', () => {
  requireCompleteSmokeInventory(
    building,
    'native/build-release/Release/',
    'native/build-release/Release/',
  );
  assert.match(building, /CFB27_SMOKE_ALLOW_WRITES='1'/);
  assert.match(building, /Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES/);
});
