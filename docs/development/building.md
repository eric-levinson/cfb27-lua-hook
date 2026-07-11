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

Verify all four native harnesses:

```powershell
native/build-release/Release/cfb27_startup_smoke.exe native/build-release/Release/cfb27_lua_host.dll
native/build-release/Release/cfb27_memory_reader_smoke.exe
native/build-release/Release/cfb27_telemetry_smoke.exe
native/build-release/Release/cfb27_protocol_smoke.exe native/build-release/Release/cfb27_lua_host.dll
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
