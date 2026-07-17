# Building the developer preview

Requirements are Windows x64, Node.js 20 or later, CMake 3.24 or later, and
Visual Studio 2022 with the C++ desktop workload.

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-release -A x64
cmake --build native/build-release --config Release
```

Verify all native harnesses. Only the protocol smoke receives write authority, and
the environment variable is removed immediately afterward:

```powershell
native/build-release/Release/cfb27_startup_smoke.exe native/build-release/Release/cfb27_lua_host.dll
native/build-release/Release/cfb27_memory_reader_smoke.exe
native/build-release/Release/cfb27_telemetry_smoke.exe
native/build-release/Release/cfb27_memory_transaction_smoke.exe
native/build-release/Release/cfb27_native_call_smoke.exe
native/build-release/Release/cfb27_board_mutation_smoke.exe
native/build-release/Release/cfb27_research_watch_smoke.exe
native/build-release/Release/cfb27_frtk_profile_smoke.exe
native/build-release/Release/cfb27_frtk_field_schema_smoke.exe
native/build-release/Release/cfb27_frtk_discovery_smoke.exe
native/build-release/Release/cfb27_frtk_catalog_smoke.exe
native/build-release/Release/cfb27_frtk_record_access_smoke.exe
native/build-release/Release/cfb27_frtk_lua_api_smoke.exe native/build-release/Release/cfb27_lua_host.dll
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try {
  native/build-release/Release/cfb27_protocol_smoke.exe native/build-release/Release/cfb27_lua_host.dll
} finally {
  Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue
}
```

Create the allowlisted preview bundle and checksum from that exact build:

```powershell
$env:CFB27_NATIVE_ARTIFACTS = (Resolve-Path native/build-release/Release).Path
npm run pack:preview
```

`CFB27_NATIVE_ARTIFACTS` is required; the packager never guesses which build
directory to use. Set `SOURCE_DATE_EPOCH` to normalize staged file timestamps.
The packager rejects archive content, game/save data, logs, dependencies, and
build intermediates.

## Re-anchor after a game executable update

Add the exact executable size and SHA-256 to `native/host/game_builds.json` as
`diagnostic`, regenerate the header, build, and install the diagnostic host.
With the game offline and a disposable dynasty selected, run:

```powershell
node scripts/board-verification/reanchor-build.cjs preflight --game-dir "F:\EA SPORTS College Football 27" --save "C:\path\to\disposable-dynasty"
node scripts/board-verification/reanchor-build.cjs validate --game-dir "F:\EA SPORTS College Football 27" --save "C:\path\to\disposable-dynasty"
```

Stop after preflight and inspect the printed source/backup paths and matching
hashes before allowing normal game UI actions. Capture two vanilla write traces
per operation, rank them, and confirm one full execute entry:

```powershell
node scripts/board-verification/reanchor-build.cjs capture-add-write --capture 1 --recruit-row 100 --team-row 22 --game-dir "F:\EA SPORTS College Football 27" --save "C:\path\to\disposable-dynasty"
node scripts/board-verification/reanchor-build.cjs capture-add-write --capture 2 --recruit-row 101 --team-row 22 --game-dir "F:\EA SPORTS College Football 27" --save "C:\path\to\disposable-dynasty"
node scripts/board-verification/reanchor-build.cjs analyze --stage rank --operation add --game-dir "F:\EA SPORTS College Football 27" --save "C:\path\to\disposable-dynasty"
node scripts/board-verification/reanchor-build.cjs capture-add-execute --recruit-row 102 --team-row 22 --game-dir "F:\EA SPORTS College Football 27" --save "C:\path\to\disposable-dynasty"
```

Repeat the sequence with `remove`, then run `transition-check` with an
operation and valid recruit/team rows after leaving and re-entering Recruiting.
Final `analyze` writes the ignored, identity-bound `candidate.json`. The host
never loads that file; only explicit source promotion can enable writes.
