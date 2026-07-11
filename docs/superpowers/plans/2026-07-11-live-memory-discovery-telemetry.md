# Live Memory Discovery and Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `cfb27-lua-hook` v0.2.0-dev.1 with bounded private-memory discovery, batch reads, and registered structured telemetry for trusted main-process consumers.

**Architecture:** A new native `memory_reader` module owns current-process region enumeration, masked scanning, canonical address parsing, and bounded reads. Protocol v1 adds typed commands and the SDK validates their inputs/outputs. Lua gains `cfb.emit`, but only session-registered event names and bounded JSON-compatible payloads may enter the existing cursor-paged event ring.

**Tech Stack:** Windows C++20, Win32 `VirtualQuery`, nlohmann/json 3.11.3, Lua 5.4.8, CommonJS Node.js 20+, Node test runner, CMake 3.24+.

## Global Constraints

- Read only `MEM_COMMIT` + `MEM_PRIVATE` regions with readable protection and no `PAGE_GUARD`/`PAGE_NOACCESS`.
- Encode every address crossing JSON as uppercase canonical `0x[0-9A-F]+`; never use JavaScript numbers for addresses.
- `scanMemory` limits: pattern 8–4096 bytes, at most 64 requested matches, at most 512 context bytes on either side, at most 64 MiB per region, and at most 512 MiB aggregate scanning.
- `readMemory` limits: at most 64 ranges, 64 KiB per range, and 256 KiB aggregate bytes.
- Unsupported builds require `allowUnsupportedBuild:true` for reads and must return `supportedBuild:false`; writes remain unavailable.
- Telemetry limits: 16 registered names per host session, 64 characters per name, depth 4, 64 object keys, 128 array entries, 1024 bytes per string, and 16 KiB serialized payload.
- Reserve `game_ready`, `tick`, and `log`; custom names match `^[a-z][a-z0-9_.-]{0,63}$`.
- Do not expose any new operation to an Electron renderer.
- Preserve protocol v1 framing, existing commands, Lua APIs, legacy text pipe, and Node 20 compatibility.
- Do not commit `native/build-*`, native binaries, package tarballs, or local game data.

---

### Task 1: Extract bounded memory discovery into a testable native module

**Files:**
- Create: `native/host/memory_reader.h`
- Create: `native/host/memory_reader.cpp`
- Create: `native/smoke/memory_reader_smoke.cpp`
- Modify: `native/CMakeLists.txt`

**Interfaces:**
- Produces `ParseAddress(std::string_view): std::optional<std::uintptr_t>`.
- Produces `FormatAddress(std::uintptr_t): std::string`.
- Produces `IsEligiblePrivateReadableRegion(const MEMORY_BASIC_INFORMATION&): bool`.
- Produces `ScanPrivateMemory(const ScanRequest&): ScanResult`.
- Produces `ReadMemoryBatch(const std::vector<ReadRange>&): BatchReadResult`.

- [ ] **Step 1: Write the native smoke test before the implementation**

Create a 64 KiB `VirtualAlloc(..., MEM_PRIVATE, PAGE_READWRITE)` allocation containing two unique 16-byte sentinels. Assert:

```cpp
using cfb27::memory::ReadMemoryBatch;
using cfb27::memory::ScanPrivateMemory;

const auto scan = ScanPrivateMemory({
    .pattern = HexBytes("CFB27A1100A1B2C3D4E5F60718293A4B"),
    .mask = std::vector<std::uint8_t>(16, 0xFF),
    .max_matches = 2,
    .context_before = 4,
    .context_after = 4,
});
Require(scan.complete && scan.matches.size() == 1, "unique private match");
Require(scan.matches[0].context.size() == 24, "bounded context");

const auto read = ReadMemoryBatch({
    {FormatAddress(reinterpret_cast<std::uintptr_t>(allocation) + 128), 16},
});
Require(read.ok && read.ranges[0].bytes == sentinel, "batch read");
```

Also assert rejection of a 7-byte pattern, 65 requested matches, a cross-region read, `PAGE_NOACCESS`, `MEM_IMAGE`, invalid/overflowing hex addresses, and a scan that exceeds the aggregate limit.

- [ ] **Step 2: Add the smoke target and verify RED**

Add `cfb27_memory_reader_smoke` to `native/CMakeLists.txt`, link `host/memory_reader.cpp`, and run:

```powershell
cmake -S native -B native/build-memory -A x64
cmake --build native/build-memory --config Release --target cfb27_memory_reader_smoke
```

Expected: compile failure because `memory_reader.h/.cpp` do not exist.

- [ ] **Step 3: Define the native data contract**

In `memory_reader.h`, define:

```cpp
namespace cfb27::memory {
constexpr std::size_t kMinPatternBytes = 8;
constexpr std::size_t kMaxPatternBytes = 4096;
constexpr std::size_t kMaxMatches = 64;
constexpr std::size_t kMaxContextBytes = 512;
constexpr std::size_t kMaxRegionBytes = 64ull * 1024 * 1024;
constexpr std::size_t kMaxScanBytes = 512ull * 1024 * 1024;
constexpr std::size_t kMaxReadRanges = 64;
constexpr std::size_t kMaxReadRangeBytes = 64ull * 1024;
constexpr std::size_t kMaxReadBytes = 256ull * 1024;

struct ReadRange { std::string address; std::size_t length{}; };
struct ReadResult { std::string address; std::vector<std::uint8_t> bytes; };
struct BatchReadResult { bool ok{}; std::string code; std::vector<ReadResult> ranges; };
struct ScanRequest {
  std::vector<std::uint8_t> pattern;
  std::vector<std::uint8_t> mask;
  std::size_t max_matches{};
  std::size_t context_before{};
  std::size_t context_after{};
};
struct ScanMatch {
  std::string address;
  std::string region_base;
  std::size_t region_size{};
  DWORD protection{};
  std::string context_address;
  std::vector<std::uint8_t> context;
};
struct ScanResult {
  bool complete{};
  std::string code;
  std::size_t scanned_bytes{};
  std::vector<ScanMatch> matches;
};
std::optional<std::uintptr_t> ParseAddress(std::string_view text);
std::string FormatAddress(std::uintptr_t address);
bool IsEligiblePrivateReadableRegion(const MEMORY_BASIC_INFORMATION& info);
BatchReadResult ReadMemoryBatch(const std::vector<ReadRange>& ranges);
ScanResult ScanPrivateMemory(const ScanRequest& request);
}
```

- [ ] **Step 4: Implement region filtering, scanning, and batch reads**

Walk the current process address space with `VirtualQuery`. Accept only complete eligible regions, cap each scanned region to `kMaxRegionBytes`, and abort with `SCAN_LIMIT_EXCEEDED` before passing `kMaxScanBytes`. Search byte-by-byte using `(live & mask) == (pattern & mask)`. Continue until `max_matches + 1` matches so the host can return `TOO_MANY_MATCHES` instead of silently truncating.

For batch reads, parse and validate all ranges first, verify aggregate limits, then copy only after every range passes. Return `MEMORY_ACCESS_DENIED` on any invalid region and no partial range results.

- [ ] **Step 5: Build and run the native smoke test**

```powershell
cmake --build native/build-memory --config Release --target cfb27_memory_reader_smoke
native\build-memory\Release\cfb27_memory_reader_smoke.exe
```

Expected: `memory reader smoke passed` and exit `0`.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- native/host/memory_reader.h native/host/memory_reader.cpp native/smoke/memory_reader_smoke.cpp native/CMakeLists.txt
git commit -m "Add bounded live memory reader"
```

---

### Task 2: Add typed scan and batch-read protocol commands

**Files:**
- Modify: `native/host/lua_host.cpp`
- Modify: `native/CMakeLists.txt`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `docs/protocol.md`

**Interfaces:**
- Consumes `ScanPrivateMemory` and `ReadMemoryBatch` from Task 1.
- Produces protocol capabilities `memoryScan` and `memoryRead`.
- Produces commands `scanMemory` and `readMemory`.

- [ ] **Step 1: Extend protocol smoke with failing command tests**

Allocate a sentinel in `protocol_smoke.cpp`, then request:

```json
{"command":"scanMemory","params":{"patternHex":"CFB27A1100A1B2C3D4E5F60718293A4B","maskHex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","maxMatches":2,"contextBefore":4,"contextAfter":4}}
```

Assert one match with canonical address strings, `complete:true`, bounded `contextHex`, and `supportedBuild:false` in the smoke process only when `allowUnsupportedBuild:true` is supplied. Assert `UNSUPPORTED_BUILD` without that flag. Then call:

```json
{"command":"readMemory","params":{"allowUnsupportedBuild":true,"ranges":[{"address":"0x...","length":16}]}}
```

Assert exact uppercase `bytesHex`. Add malformed-hex, mismatched-mask, excessive-range, and unknown-field tests.

- [ ] **Step 2: Run protocol smoke and verify RED**

Expected: `INVALID_REQUEST`/unknown command for `scanMemory` and `readMemory`.

- [ ] **Step 3: Add strict JSON parsing helpers and command handlers**

In `lua_host.cpp`, add `HexToBytes`, `BytesToHex`, strict unsigned-limit readers, and canonical address validation. Reject extra params by comparing keys against per-command allowlists. Both commands must reject unsupported builds unless `allowUnsupportedBuild` is exactly `true`.

Return these stable shapes:

```json
{"supportedBuild":true,"complete":true,"scannedBytes":123,"matches":[{"address":"0x...","regionBase":"0x...","regionSize":41943040,"protection":4,"contextAddress":"0x...","contextHex":"..."}]}
```

```json
{"supportedBuild":true,"ranges":[{"address":"0x...","length":16,"bytesHex":"..."}]}
```

Map module failures to `MEMORY_ACCESS_DENIED`, `SCAN_LIMIT_EXCEEDED`, and `TOO_MANY_MATCHES` without including region dumps in error details.

- [ ] **Step 4: Advertise capabilities and link the module**

Add `memoryScan` and `memoryRead` to `hello.capabilities`; add `host/memory_reader.cpp` to `cfb27_lua_host` in `native/CMakeLists.txt`.

- [ ] **Step 5: Verify native targets**

```powershell
cmake --build native/build-memory --config Release --target cfb27_lua_host cfb27_protocol_smoke
native\build-memory\Release\cfb27_protocol_smoke.exe native\build-memory\Release\cfb27_lua_host.dll
```

Expected: protocol and memory smoke targets exit `0`.

- [ ] **Step 6: Document protocol commands and commit**

Document exact request/response shapes and limits in `docs/protocol.md`.

```powershell
git add -- native/host/lua_host.cpp native/CMakeLists.txt native/smoke/protocol_smoke.cpp docs/protocol.md
git commit -m "Expose bounded memory discovery protocol"
```

---

### Task 3: Add SDK validation and typed memory APIs

**Files:**
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/src/errors.cjs`
- Modify: `packages/sdk/test/client.test.cjs`
- Modify: `docs/getting-started.md`

**Interfaces:**
- Produces `client.scanMemory(options)`.
- Produces `client.readMemory(options)`.

- [ ] **Step 1: Write failing SDK contract tests**

Use the existing fake pipe server to assert exact outbound commands and validate returned shapes. Required calls:

```js
await client.scanMemory({
  patternHex: 'CFB27A1100A1B2C3D4E5F60718293A4B',
  maskHex: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
  maxMatches: 2,
  contextBefore: 4,
  contextAfter: 4,
});
await client.readMemory({ ranges: [{ address: '0x7FF612340000', length: 16 }] });
```

Assert local rejection before socket creation for noncanonical addresses, lowercase/odd/invalid hex, unequal pattern/mask lengths, unsupported keys, unsafe integers, and exceeded limits. Assert response rejection for numeric addresses, lowercase addresses, invalid byte lengths, missing `complete`, and oversized arrays.

- [ ] **Step 2: Run the SDK test and verify RED**

```powershell
node --test packages/sdk/test/client.test.cjs
```

Expected: failures because both client methods are absent.

- [ ] **Step 3: Implement request and response validators**

Add frozen local constants matching native limits. Clone inputs before sending. Normalize hex bytes to uppercase but require canonical address strings. Validate every host response field before returning it; throw `Cfb27HookError('INVALID_RESPONSE', ...)` on any mismatch.

- [ ] **Step 4: Add stable error codes**

Append `MEMORY_ACCESS_DENIED`, `SCAN_LIMIT_EXCEEDED`, and `TOO_MANY_MATCHES` to `ERROR_CODES`.

- [ ] **Step 5: Verify SDK tests and commit**

```powershell
node --test packages/sdk/test/client.test.cjs
npm run check
git add -- packages/sdk/src/client.cjs packages/sdk/src/errors.cjs packages/sdk/test/client.test.cjs docs/getting-started.md
git commit -m "Add typed memory discovery SDK"
```

---

### Task 4: Add registered structured telemetry

**Files:**
- Create: `native/host/telemetry.h`
- Create: `native/host/telemetry.cpp`
- Create: `native/smoke/telemetry_smoke.cpp`
- Modify: `native/host/lua_host.cpp`
- Modify: `native/CMakeLists.txt`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/test/client.test.cjs`
- Modify: `docs/lua-api.md`
- Modify: `docs/protocol.md`

**Interfaces:**
- Produces `registerTelemetry { types: string[] }` protocol command.
- Produces `client.registerTelemetryTypes(types)`.
- Produces Lua `cfb.emit(type, payload)`.
- Produces `telemetry` capability.

- [ ] **Step 1: Write failing native policy tests**

In `telemetry_smoke.cpp`, assert registration rejects reserved/invalid/duplicate names and more than 16 types. Assert payload validation accepts nested scalar JSON within limits and rejects depth 5, 65 object keys, 129 array entries, 1025-byte strings, binary/address-like keys (`address`, `addressHex`, `regionBase`, `bytesHex`), nonfinite numbers, and serialized output above 16 KiB.

- [ ] **Step 2: Define and implement telemetry policy**

`telemetry.h` exports:

```cpp
bool IsTelemetryTypeName(std::string_view type);
bool RegisterTelemetryTypes(const std::vector<std::string>& types, std::string& error);
bool IsTelemetryTypeRegistered(std::string_view type);
bool ValidateTelemetryPayload(const Json& payload, std::string& error);
```

Use a mutex-protected session set. Registration is additive and idempotent for an identical name. Reject the reserved event names and address/raw-byte keys at every object depth.

- [ ] **Step 3: Verify telemetry smoke GREEN**

Add/link `cfb27_telemetry_smoke`; run it and expect `telemetry smoke passed`.

- [ ] **Step 4: Add protocol registration and Lua conversion**

Add `registerTelemetry` with only a `types` array param. Register `cfb.emit` in the existing `cfb` table. Convert Lua nil/boolean/finite number/string/table values recursively to JSON with cycle detection and the same depth/count/string limits; reject functions, userdata, threads, mixed array/object tables, sparse arrays, and non-string object keys.

`cfb.emit(type, payload)` must verify the type was registered, validate the converted payload, call `AppendEvent(type, payload)`, and return `true`. It never writes to the file log.

- [ ] **Step 5: Extend protocol and SDK tests**

Register `probe.snapshot`, run a Lua script that emits `{sequence=1, stable=true}`, and assert exactly one cursor event. Assert an unregistered type returns `SCRIPT_ERROR`. Add SDK local/response validation for `registerTelemetryTypes`.

- [ ] **Step 6: Verify and commit**

```powershell
cmake --build native/build-memory --config Release --target cfb27_lua_host cfb27_protocol_smoke cfb27_telemetry_smoke
native\build-memory\Release\cfb27_telemetry_smoke.exe
native\build-memory\Release\cfb27_protocol_smoke.exe native\build-memory\Release\cfb27_lua_host.dll
node --test packages/sdk/test/client.test.cjs packages/sdk/test/logs.test.cjs
npm run check
git add -- native/host/telemetry.h native/host/telemetry.cpp native/smoke/telemetry_smoke.cpp native/host/lua_host.cpp native/CMakeLists.txt native/smoke/protocol_smoke.cpp packages/sdk/src/client.cjs packages/sdk/test/client.test.cjs docs/lua-api.md docs/protocol.md
git commit -m "Add registered structured telemetry"
```

---

### Task 5: Add developer CLI commands, release gates, and v0.2.0-dev.1 packaging

**Files:**
- Modify: `packages/cli/src/args.cjs`
- Modify: `packages/cli/src/main.cjs`
- Modify: `packages/cli/test/main.test.cjs`
- Modify: `docs/cli.md`
- Modify: `docs/development/release-checklist.md`
- Modify: `docs/research/runtime-verification.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/sdk/package.json`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Produces `cfb27lua memory scan` and `cfb27lua memory read` developer commands.
- Produces `cfb27lua telemetry register` developer command.
- Produces release `v0.2.0-dev.1` after manual runtime verification.

- [ ] **Step 1: Write failing CLI tests**

Assert parsing/output for:

```text
cfb27lua memory scan --pattern CFB27A1100A1B2C3D4E5F60718293A4B --mask FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF --max-matches 8 --context 32 --json
cfb27lua memory read --range 0x7FF612340000:192 --json
cfb27lua telemetry register recruiting.snapshot recruiting.stability --json
```

Require `--allow-unsupported-build` for unsupported diagnostic reads. Reject write-like arguments and noncanonical address ranges.

- [ ] **Step 2: Implement thin SDK-backed CLI handlers**

Keep parsing in `args.cjs`; handlers in `main.cjs` call only the new SDK client methods. Human output reports counts and canonical addresses; `--json` returns the untouched validated SDK result.

- [ ] **Step 3: Run the complete automated gate**

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-release -A x64
cmake --build native/build-release --config Release
native\build-release\Release\cfb27_memory_reader_smoke.exe
native\build-release\Release\cfb27_telemetry_smoke.exe
native\build-release\Release\cfb27_protocol_smoke.exe native\build-release\Release\cfb27_lua_host.dll
npm run pack:preview
git diff --check
```

Expected: all commands exit `0`; packaged file lists contain no build directories, saves, schemas, or archives outside the documented release contents.

- [ ] **Step 4: Perform the manual offline read-only gate**

Install the candidate host while the game is closed, launch through MMC offline, and record:

- `hello` advertises `memoryScan`, `memoryRead`, and `telemetry`;
- a bounded scan can find an intentionally allocated/session-known private sentinel;
- a bounded read returns its exact bytes;
- registered telemetry appears once with advancing cursor;
- no memory writes are attempted;
- the game remains responsive for ten minutes and through a Dynasty hub transition.

Append the date, executable hash, commands, and observed results to `docs/research/runtime-verification.md`.

- [ ] **Step 5: Bump versions only after the manual gate**

Set root, SDK, CLI, and lockfile versions to `0.2.0-dev.1`. Re-run `npm ci`, tests, native release build, and package inspection.

- [ ] **Step 6: Commit and publish a draft PR**

```powershell
git add -- packages/cli/src/args.cjs packages/cli/src/main.cjs packages/cli/test/main.test.cjs docs/cli.md docs/development/release-checklist.md docs/research/runtime-verification.md package.json package-lock.json packages/sdk/package.json packages/cli/package.json
git commit -m "Prepare live discovery developer preview"
git push -u origin codex/live-memory-discovery-telemetry
```

Open a draft PR against `main`. After review and merge, tag `v0.2.0-dev.1`, run the release checklist, publish immutable SDK/CLI/archive assets, and verify their SHA-256 checksums before starting Hook PR B.
