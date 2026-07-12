'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('active native tree contains only host, proxy, and smoke entry points', () => {
  for (const file of [
    'native/host/lua_host.cpp',
    'native/proxy/cryptbase_proxy.cpp',
    'native/proxy/cryptbase_proxy.def',
    'native/smoke/startup_host_smoke.cpp',
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }

  const cmake = fs.readFileSync(path.join(root, 'native/CMakeLists.txt'), 'utf8');
  assert.match(cmake, /add_library\(cfb27_lua_host/);
  assert.match(cmake, /add_library\(cfb27_cryptbase_proxy/);
  assert.match(cmake, /add_executable\(cfb27_startup_smoke/);
  assert.doesNotMatch(cmake, /hook\.cpp|injector\.cpp|response_guard\.cpp/);
  assert.doesNotMatch(cmake, /archive[\\/]/);
});

test('Windows CI enables writes only for the protocol smoke step', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github/workflows/windows-ci.yml'),
    'utf8',
  );
  const lines = workflow.split(/\r?\n/);
  const command = '      - run: native/build-release/Release/cfb27_protocol_smoke.exe ' +
    'native/build-release/Release/cfb27_lua_host.dll';
  const stepStart = lines.indexOf(command);
  assert.notEqual(stepStart, -1, 'protocol smoke command must remain exact');
  const nextStep = lines.findIndex((line, index) => index > stepStart && line.startsWith('      - '));
  const step = lines.slice(stepStart, nextStep === -1 ? lines.length : nextStep);
  assert.deepEqual(step, [
    command,
    '        env:',
    "          CFB27_SMOKE_ALLOW_WRITES: '1'",
  ]);
  assert.equal(lines.filter((line) => line.includes('CFB27_SMOKE_ALLOW_WRITES')).length, 1);
});
