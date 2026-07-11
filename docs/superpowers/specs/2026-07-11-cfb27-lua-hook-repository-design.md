# CFB27 Lua Hook Repository Redesign

**Status:** Approved design

**Date:** 2026-07-11

**Product name:** CFB27 Lua Hook

**Repository name:** `cfb27-lua-hook`

**Initial release:** `0.1.0-dev.1` developer preview

**License:** MIT

## Purpose

Turn the merged `cfb27-save-editor` repository into the authoritative home of
the first persistent Lua hook and scripting SDK for EA SPORTS College Football
27 on PC. The product is the MMC-loaded runtime, its versioned local protocol,
and developer tooling—not the previous save editor.

The repository will remain public and research-friendly. Historical save
editing, injection experiments, diagnostics, and raw research stay searchable
under `archive/`, but they are excluded from supported packages, dependency
installation, CI, and release artifacts.

## Goals

1. Make the persistent CFB27 Lua runtime the unmistakable product at the
   repository root.
2. Provide a reusable CommonJS Node SDK that can be consumed by CLI tools and
   Electron main processes, including the future integration with
   `brooksg357-a11y/cfb27-dynasty-modding`.
3. Provide a developer-focused `cfb27lua` CLI for installation, restoration,
   diagnosis, status, logs, and Lua execution.
4. Replace the current ad hoc pipe command format with a versioned, framed JSON
   protocol while retaining a temporary legacy/debug endpoint.
5. Preserve exact-build, offline-only, compare-before-write, readback, and
   anticheat safety gates.
6. Produce reproducible Windows developer-preview release archives without
   committing native build output.
7. Preserve historical work without allowing it to define or destabilize the
   active product.

## Non-goals

- Rebuilding the old save editor as part of this migration.
- Shipping a second consumer-facing Electron application.
- Implementing recruiting logic or integrating Brooks's Electron UI in the
  restructuring PR.
- Supporting online play or bypassing anticheat.
- Claiming compatibility with unrecognized CFB27 executable builds.
- Exposing raw memory addresses or arbitrary Lua evaluation to an Electron
  renderer.
- Publishing the SDK to npm during the first developer-preview slice.

## Architecture and ownership

```text
MMC startup
  -> CryptBase proxy
  -> preserved MMCBase proxy
  -> CFB27 Lua host inside CollegeFB27.exe
  -> versioned local named-pipe protocol
  -> CommonJS Node SDK
     -> cfb27lua CLI
     -> external Electron main-process consumers
```

### Native host

The native host owns:

- the persistent Lua 5.4 VM;
- exact executable fingerprint validation;
- offline and real-anticheat write gates;
- memory validation, compare-before-write, rollback-friendly primitives, and
  readback;
- AOB scanning;
- lifecycle callbacks and the future typed CFB27 APIs;
- protocol request execution and structured native errors.

The host must remain usable without the CLI or any Electron process.

### Startup proxy

The startup proxy owns only MMC-compatible loading:

- forward all required `CryptBase.dll` exports to the preserved `MMCBase.dll`;
- load the host from `CFB27LiveEditor/cfb27_lua_host.dll` after normal game
  startup begins;
- avoid remote-thread injection and avoid embedding game-specific editing
  behavior.

### Node SDK

The CommonJS SDK is the sole supported client implementation. It owns:

- Windows game-process discovery;
- executable path and build verification;
- pipe connection, framing, timeouts, and reconnect behavior;
- protocol negotiation and capability checks;
- MMC proxy backup, installation, verification, and restoration;
- stable JavaScript errors and machine-readable error codes;
- log discovery and reading;
- typed wrappers for all supported host operations.

External applications use the SDK rather than implementing the pipe protocol.

### CLI

The CLI is a thin SDK consumer. It contains no duplicate process, installation,
or protocol logic. Human-readable output is the default, and `--json` produces
stable machine-readable output.

### External Electron applications

Only an Electron main process may import the SDK. A context-isolated preload
bridge exposes narrow application-specific operations. Renderers never receive
the unrestricted evaluation method, arbitrary addresses, or direct pipe access.

## Protocol design

### Discovery

The SDK discovers `CollegeFB27.exe` using Windows-native process enumeration,
validates its executable path and fingerprint, then connects to:

```text
\\.\pipe\CFB27LuaHost.v1.<pid>
```

The PID prevents stale or cross-process connections. The SDK reconnects when
the PID changes and clears cached capabilities when the game exits.

### Framing

Protocol v1 uses:

1. a four-byte unsigned little-endian payload length;
2. a UTF-8 JSON payload;
3. a one-MiB maximum request or response size.

The host reads fragmented frames until complete. It rejects zero-length,
oversized, truncated, invalid-UTF-8, and invalid-JSON frames without executing
them.

Request:

```json
{
  "protocol": 1,
  "id": "request-id",
  "command": "status",
  "params": {}
}
```

Response:

```json
{
  "protocol": 1,
  "id": "request-id",
  "ok": true,
  "result": {}
}
```

Errors use `ok: false` plus a stable `error.code`, human-readable
`error.message`, and optional structured `error.details`.

### Initial commands

- `hello`: protocol version, host version, build, and capability negotiation.
- `status`: runtime readiness, build support, write eligibility, counters, and
  the most recent command error.
- `runScript`: execute a UTF-8 `.lua` file payload supplied by the client.
- `evaluate`: execute inline Lua; explicitly developer-only and unsafe for
  renderer exposure.
- `events`: return paged events after a cursor; this provides polling without
  requiring a long-lived push connection.
- `logs`: return bounded recent host log entries.

The legacy `CFB27LuaHost.<pid>` text pipe remains temporarily available for
debugging and archived-client compatibility. It is not part of the public SDK
contract and is removed after migration evidence shows no supported consumers
remain.

### Future typed APIs

Recruiting and other domain operations will be added as typed commands after
their identities and layouts are verified. Bulk save data will stay in the
safe save reader; the host supplies live overlays, deltas, and guarded actions.
Large result sets must be paged rather than returned as one message.

## SDK API

The first SDK surface is:

```js
discoverGame(options)
getHostStatus(options)
installHook(options)
restoreMmcHook(options)
runScriptFile(path, options)
evaluateLua(source, options)
getEvents(cursor, options)
getLogs(options)
doctor(options)
```

`evaluateLua` is documented and named as a developer-only escape hatch. Future
Electron integrations expose only typed operations through preload bridges.

Stable SDK/CLI error codes include:

- `GAME_NOT_RUNNING`
- `GAME_PATH_MISMATCH`
- `HOST_NOT_INSTALLED`
- `HOST_NOT_READY`
- `UNSUPPORTED_BUILD`
- `ANTICHEAT_RUNNING`
- `PROTOCOL_MISMATCH`
- `PIPE_TIMEOUT`
- `INVALID_REQUEST`
- `INVALID_RESPONSE`
- `SCRIPT_ERROR`
- `INSTALLATION_CONFLICT`
- `BACKUP_VERIFICATION_FAILED`

## CLI contract

```text
cfb27lua install [options]
cfb27lua uninstall [options]
cfb27lua status [--json]
cfb27lua run <script.lua> [--json]
cfb27lua eval <source> [--json]
cfb27lua events [--after <cursor>] [--json]
cfb27lua logs [--follow] [--json]
cfb27lua doctor [--json]
```

Exit code `0` means success. Usage errors, unavailable runtime state, rejected
writes, script failures, and internal failures use distinct nonzero exit-code
families documented in `docs/cli.md`.

## Repository layout

```text
cfb27-lua-hook/
  native/
    host/
    proxy/
    smoke/
  packages/
    sdk/
    cli/
  examples/
    lua/
  docs/
    getting-started.md
    lua-api.md
    protocol.md
    cli.md
    safety.md
    research/
    development/
  archive/
    legacy-save-editor/
    legacy-hooks/
    research-tools/
  tests/
  package.json
  package-lock.json
  LICENSE
  README.md
```

The root is a private npm workspace containing `packages/sdk` and
`packages/cli`. The implementation uses plain CommonJS JavaScript with JSDoc
types to remain directly consumable by Brooks's CommonJS Electron application
without a TypeScript build layer.

Package identities:

- SDK: `@cfb27/lua-hook`
- CLI package: `cfb27-lua-hook`
- CLI binary: `cfb27lua`

## Archive policy

Files move with `git mv` so their history remains traceable.

### `archive/legacy-save-editor/`

Contains the Python HTTP server, save/franchise helpers, previous Electron
shell, static UI, save schemas, and their legacy tests.

### `archive/legacy-hooks/`

Contains the remote injector, MinHook request detours, response guards, submit
probes, request traces, and Lua scripts tied to those paths.

### `archive/research-tools/`

Contains raw schema/recruiting probes, imports, decoders, and one-off analysis
utilities that are not required to build or verify the active product.

Each archive directory has a README stating:

- what the material proved;
- why it is no longer active;
- that it is unsupported and excluded from releases;
- where maintained conclusions now live.

Validated findings are rewritten or moved into `docs/research/`. Archive code
does not participate in root dependency installation, workspaces, CI, or
release packaging.

## Packaging and releases

The developer preview requires Windows and Node.js 20 or later.

Windows CI:

1. installs Node dependencies;
2. runs SDK, CLI, installer, and protocol tests;
3. configures and builds the native host, proxy, and smoke harness with CMake;
4. runs the native smoke harness;
5. produces npm package tarballs without publishing them;
6. assembles a release archive;
7. emits SHA-256 checksums.

Release archive:

```text
cfb27-lua-hook-0.1.0-dev.1/
  native/
    cfb27_lua_host.dll
    CryptBase.dll
  packages/
    cfb27-lua-hook-*.tgz
    cfb27-lua-hook-sdk-*.tgz
  examples/
  docs/
  README.md
  LICENSE
  SHA256SUMS.txt
```

Native binaries and build directories remain ignored and are never committed.
The release notes label the package as an offline, exact-build developer
preview.

## Safety and recovery

- Installation and restoration are refused while CFB27 is running.
- The installer verifies the recognized MMC proxy before backing it up.
- Backups are verified by SHA-256 before the active proxy changes.
- Installation uses atomic replacement and verifies every installed artifact.
- Restoration replaces both game and MMC `ThirdParty` proxies from verified
  backups.
- The host permits writes only on a recognized executable build and while no
  real EA/Javelin anticheat process is present.
- Memory writes remain compare-before-write and require readback.
- The CLI's `doctor` command reports recovery actions without modifying state.
- No workflow recommends disabling or allowlisting antivirus protection.

## Testing strategy

Active release gates:

1. Native host build and one-MiB-stack startup smoke test.
2. Protocol unit tests covering complete, fragmented, multiline, oversized,
   malformed, mismatched-ID, and timeout cases.
3. SDK tests against a fake named-pipe server.
4. Process discovery and capability negotiation tests.
5. Installer backup, conflict, atomic-replacement, hash, and restoration tests
   using temporary directories.
6. CLI output, JSON schema, and exit-code tests.
7. Package-content tests proving archives and local/generated material are not
   shipped.
8. Windows CI build and artifact checksum verification.
9. Documented manual offline runtime smoke test for each supported game build.

Archived tests remain beside archived code but are not part of the active
release gate. The restructuring baseline is the existing 11-test fast suite;
the prior full suite has three known local schema/fixture failures unrelated to
the host.

## Migration sequence

1. Work from merged `origin/main` in the isolated
   `codex/restructure-cfb27-lua-hook` worktree.
2. Establish the new workspaces, SDK, CLI, protocol contract, and active tests.
3. Move the native host/proxy/smoke sources into their final active locations.
4. Move unsupported material into the three archive areas with archive READMEs.
5. Replace root package metadata, README, documentation navigation, and add the
   MIT license.
6. Build and inspect the local `0.1.0-dev.1` package and native artifacts.
7. Open and merge the restructuring PR while the repository still has its old
   GitHub name.
8. Rename the GitHub repository to `cfb27-lua-hook`, set its description and
   topics, update local remotes and documentation links, and verify GitHub
   redirects.
9. Create a separate design and implementation PR for Brooks recruiting-app
   integration.

## Repository metadata after rename

Description:

> Offline CFB27 Lua hook, scripting SDK, and MMC startup tooling for PC.

Topics:

- `college-football-27`
- `cfb27`
- `lua`
- `modding`
- `game-modding`
- `electron`
- `windows`

## Completion criteria

The repository redesign is complete when:

- active root documentation describes CFB27 Lua Hook rather than a save editor;
- the Node SDK and CLI consume one tested implementation of discovery,
  installation, and protocol behavior;
- framed protocol v1 passes fragmentation and multiline tests;
- native host, proxy, and smoke targets build from their new paths;
- legacy material is present only beneath documented archive directories;
- the active package and CI exclude all archive and local/generated content;
- the developer-preview release archive and checksums are reproducible;
- MIT licensing is present;
- the cleanup PR is merged;
- GitHub is renamed to `eric-levinson/cfb27-lua-hook` and redirects are verified;
- no user-owned local changes or third-party project contents are committed.
