## Summary

Restructures the repository around CFB27 Lua Hook `0.1.0-dev.1`: a persistent
offline Lua runtime, CommonJS Node SDK, developer CLI, reversible MMC installer,
and reproducible Windows package.

## Architecture

MMC loads a forwarding `CryptBase.dll`, which preserves the original proxy as
`MMCBase.dll` and loads `cfb27_lua_host.dll`. The in-process Lua 5.4 host exposes
a local versioned framed-JSON pipe consumed by the SDK and CLI.

## Archive scope

The previous save editor, Electron/browser UI, remote-injection hooks, schemas,
and one-off research tools move under `archive/`. They remain in Git history for
provenance, are explicitly unsupported, and are excluded from builds/releases.

## Protocol, SDK, and CLI

Protocol v1 supports hello, status, complete multiline script execution,
bounded logs, and cursor events. `@cfb27/lua-hook` owns discovery, transport,
errors, install/recovery, doctor, and event polling. `cfb27lua` is a thin tested
consumer with stable JSON and exit behavior.

## Safety

The project remains offline-only and provides no anticheat bypass. Writes
require the exact build, no real anticheat process, writable committed memory,
compare-before-write, and readback. Installation preserves and verifies both
MMC proxies, rejects unknown DLLs, and rolls back failed installs.

## Packaging

Windows CI builds the native targets, runs both smoke harnesses, packs the SDK
and CLI without publishing, and uploads an allowlisted preview zip plus SHA-256
checksums. Archive content and local/generated material are denied.

## Verification

- `npm ci`
- `npm run check`
- `npm test`
- x64 CMake configure/build
- startup smoke with one-MiB stack
- framed protocol smoke covering fragmented, invalid, oversized, multiline,
  logs, and cursor events
- `npm run pack:preview` plus content inspection

## Runtime evidence

The startup-loaded host was verified in the supported offline retail process:
ready/build/write status, autorun and callbacks, multiline Lua, executable `MZ`
read, AOB scan, advancing events, and a previously completed reversible player
rating transaction with independent rollback confirmation.

## Follow-up

Brooks's Electron recruiting integration is a separate PR. It will use the SDK
from Electron main, expose a narrow read-only preload API, negotiate capabilities,
and keep raw eval/memory access out of the renderer.
