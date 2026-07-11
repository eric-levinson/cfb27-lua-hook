# Getting started

CFB27 Lua Hook `0.2.0-dev.1` is a Windows x64 developer preview. It requires
Node.js 20 or later, CMake 3.24 or later, Visual Studio 2022 C++ build tools,
MMC, and a separately launched offline CFB27 session.

The project does not include an anticheat bypass. Do not disable or allowlist
antivirus protection for it.

## Build and test

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-active -A x64
cmake --build native/build-active --config Release
```

## Configure local paths

Set these values to your own installation directories:

```powershell
$env:CFB27_GAME_DIR = 'F:\EA SPORTS College Football 27'
$env:CFB27_MMC_DIR = 'C:\path\to\MMC_ModManager'
$env:CFB27_HOOK_ARTIFACTS = (Resolve-Path 'native\build-active\Release').Path
```

The CLI never guesses the game or MMC directories.

## Install, launch, and verify

Close CFB27 before installing:

```powershell
node packages/cli/bin/cfb27lua.cjs install
```

The installer verifies and preserves both MMC proxies before replacing either.
Launch the game through MMC in your offline configuration. At the Dynasty hub,
run the read-only diagnostics and status checks:

```powershell
node packages/cli/bin/cfb27lua.cjs doctor
node packages/cli/bin/cfb27lua.cjs status --json
node packages/cli/bin/cfb27lua.cjs run examples/lua/read-image-header.lua
node packages/cli/bin/cfb27lua.cjs events --after 0 --json
```

`doctor` should report the game, installation, host, supported build, and write
eligibility separately. A failed write-eligibility check does not prevent safe
read-only scripts.

## Read live memory from a trusted Node process

The SDK exposes bounded, read-only memory discovery for trusted Node.js and
Electron main-process code. Do not expose these methods or their raw byte and
address results to an Electron renderer.

```js
const { createClient } = require('@cfb27/lua-hook');

const client = createClient({ pid: gamePid });
// scanMemory automatically follows validated continuation cursors.
const scan = await client.scanMemory({
  patternHex: 'CFB27A1100A1B2C3D4E5F60718293A4B',
  maskHex: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
  maxMatches: 2,
  contextBefore: 4,
  contextAfter: 4,
  maxPages: 4096,
});

const read = await client.readMemory({
  ranges: [{ address: scan.matches[0].address, length: 16 }],
});
```

Hex byte strings must be uppercase and addresses must use canonical uppercase
`0x[0-9A-F]+` strings; JavaScript numbers are never accepted as addresses. A
scan pattern is 8–4096 bytes, requests at most 64 matches, and allows at most
512 total context bytes before and after each match. Each native scan page is
bounded to 32 MiB of eligible memory using 4 MiB read chunks. Automatic scans
accept 1–4,096 pages and default to the 4,096-page, 128 GiB ceiling. Use
`client.scanMemoryPage(options)` when a trusted main-process caller needs manual
page control; its `nextCursor` may be passed only to the next page request.
A batch read contains at most 64 ranges of 64 KiB each and at most 256 KiB
total. Unsupported game builds
require `allowUnsupportedBuild: true` and report `supportedBuild: false`.

All memory methods validate requests before opening the pipe and every host
response field before returning it. A multi-page scan observes a live,
non-atomic memory map, so re-read and validate every selected candidate before
interpreting it. The methods can report `MEMORY_ACCESS_DENIED`,
`SCAN_LIMIT_EXCEEDED`, or `TOO_MANY_MATCHES`; malformed host results report
`INVALID_RESPONSE`. The SDK does not provide a memory-write API.

## Restore MMC

Close the game, then restore both verified original proxies:

```powershell
node packages/cli/bin/cfb27lua.cjs uninstall
```

If installation state is unclear, run `doctor` first and inspect the reported
paths. Never manually overwrite an unknown `CryptBase.dll` or `MMCBase.dll`.
