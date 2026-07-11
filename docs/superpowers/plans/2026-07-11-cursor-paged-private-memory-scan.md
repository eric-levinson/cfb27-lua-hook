# Cursor-Paged Private-Memory Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the non-deterministic whole-process scan with bounded cursor-paged scanning that can cover every eligible private-memory byte in the live CFB27 process.

**Architecture:** The native host scans at most 32 MiB of eligible memory per request using a dedicated 4 MiB chunk buffer and returns a canonical continuation cursor. Protocol and SDK layers validate exact page shapes; the SDK offers both one-page control and bounded automatic aggregation. The CLI uses the aggregate SDK method, after which the exact candidate is reinstalled and the offline live gate is repeated.

**Tech Stack:** Windows x64 C++20, Win32 `VirtualQuery`/`ReadProcessMemory`/`VirtualAlloc`, nlohmann JSON, Lua 5.4, CommonJS Node.js 20+, Node test runner, PowerShell, CMake/Visual Studio 2022.

## Global Constraints

- All memory operations in this plan are read-only.
- One native page scans at most 32 MiB of eligible bytes.
- Native read chunks are at most 4 MiB plus `patternLength - 1` lookahead.
- Cursors and addresses are canonical strings, never JavaScript numbers.
- `nextCursor` is canonical uppercase when `complete:false` and `null` when `complete:true`.
- Patterns crossing chunk or page boundaries are returned exactly once.
- Failed eligible reads never produce `complete:true` or silently skipped coverage.
- SDK automatic scanning accepts `maxPages` from 1 through 4,096 and defaults to 4,096, bounding eligible-byte work to 128 GiB.
- Raw addresses, patterns, masks, contexts, and bytes remain prohibited from Electron renderer exposure.
- No anticheat bypass, memory write, recruiting schema, or game-domain mutation is introduced.
- Do not edit `docs/research/runtime-verification.md`, bump versions, or commit the final Task 5 slice until the repeated manual gate succeeds.
- Do not install a new native candidate until the user confirms CFB27 and MMC are both closed; explicitly tell the user when to relaunch.

---

### Task 1: Implement the bounded native scan page

**Files:**
- Modify: `native/host/memory_reader.h`
- Modify: `native/host/memory_reader.cpp`
- Modify: `native/smoke/memory_reader_smoke.cpp`

**Interfaces:**
- Consumes: existing `ParseAddress`, `FormatAddress`, `ScanMatch`, and eligible-region policy.
- Produces: `ScanRequest::cursor`, `ScanResult::next_cursor`, `kScanChunkBytes`, `kMaxScanPageBytes`, and page-correct `ScanPrivateMemory(const ScanRequest&)`.

- [ ] **Step 1: Add failing large-region, continuation, and boundary tests**

Extend `memory_reader_smoke.cpp` before changing production code. Reserve one
contiguous private region larger than 64 MiB and place sentinels after the old
limit and across chunk/page boundaries:

```cpp
constexpr std::size_t kLargeBytes = 80ull * 1024 * 1024;
auto* large = static_cast<std::uint8_t*>(VirtualAlloc(
    nullptr, kLargeBytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
Expect(large != nullptr, "allocate large region");
std::copy(sentinel.begin(), sentinel.end(), large + (64ull * 1024 * 1024) + 128);
std::copy(sentinel.begin(), sentinel.end(), large + kScanChunkBytes - 4);

ScanRequest page{sentinel, exact_mask, 8, 4, 4, std::nullopt};
std::vector<ScanMatch> all;
std::optional<std::string> previous;
for (std::size_t pages = 0; pages < 4096; ++pages) {
  const auto result = ScanPrivateMemory(page);
  Expect(result.code.empty(), "page succeeds");
  Expect(result.scanned_bytes <= kMaxScanPageBytes, "page is bounded");
  all.insert(all.end(), result.matches.begin(), result.matches.end());
  if (result.complete) {
    Expect(!result.next_cursor.has_value(), "complete page has no cursor");
    break;
  }
  Expect(result.next_cursor.has_value(), "partial page has cursor");
  Expect(result.next_cursor != previous, "cursor advances");
  previous = result.next_cursor;
  page.cursor = result.next_cursor;
}
Expect(CountAddress(all, large + (64ull * 1024 * 1024) + 128) == 1,
       "large-region tail found once");
Expect(CountAddress(all, large + kScanChunkBytes - 4) == 1,
       "chunk-boundary match found once");
```

Add rejection cases for a cursor above the system maximum, an overflowing
cursor, and a repeated/non-advancing page. Retain the mask-buffer regression.
Replace the old test that expects `SCAN_LIMIT_EXCEEDED` after 512 MiB with one
that allocates at least 544 MiB before the target and proves later pages reach
the target. Add a deterministic read-failure case through the function-pointer
seam defined in Step 3:

```cpp
g_fail_read_at = reinterpret_cast<std::uintptr_t>(large);
const auto failed = ScanPrivateMemory(page, FailSelectedRead);
Expect(failed.code == "MEMORY_ACCESS_DENIED", "eligible read failure is explicit");
Expect(!failed.complete, "failed read is never complete");
Expect(!failed.next_cursor.has_value(), "failed read cannot advance cursor");
g_fail_read_at = 0;
```

- [ ] **Step 2: Run the native smoke and verify RED**

```powershell
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake --build native/build-pr-a --config Release --target cfb27_memory_reader_smoke
& native/build-pr-a/Release/cfb27_memory_reader_smoke.exe
```

Expected: compilation fails because `cursor`, `next_cursor`,
`kScanChunkBytes`, and `kMaxScanPageBytes` do not exist, or the old scanner
fails the first large-region continuation assertion.

- [ ] **Step 3: Define the native page contract**

In `memory_reader.h`, replace the old aggregate constants and extend the types:

```cpp
constexpr std::size_t kScanChunkBytes = 4ull * 1024 * 1024;
constexpr std::size_t kMaxScanPageBytes = 32ull * 1024 * 1024;
using ScanReadFunction = bool (*)(const void* source, void* destination,
                                  std::size_t length, std::size_t& copied);

struct ScanRequest {
  std::vector<std::uint8_t> pattern;
  std::vector<std::uint8_t> mask;
  std::size_t max_matches{};
  std::size_t context_before{};
  std::size_t context_after{};
  std::optional<std::string> cursor;
};

struct ScanResult {
  bool complete{};
  std::string code;
  std::size_t scanned_bytes{};
  std::optional<std::string> next_cursor;
  std::vector<ScanMatch> matches;
};

ScanResult ScanPrivateMemory(const ScanRequest& request,
                             ScanReadFunction read = nullptr);
```

`nullptr` selects the production `ReadProcessMemory` adapter. The smoke passes a
non-allocating function pointer only to force a selected eligible read to fail;
the protocol never accepts or exposes this seam.

- [ ] **Step 4: Implement chunked traversal with exact progress**

In `memory_reader.cpp`, allocate the scan buffer with `VirtualAlloc`, free it by
RAII, select the production reader when `read == nullptr`, and scan from the
parsed cursor or system minimum. The loop must:

```cpp
const auto unique_bytes = std::min({
    region_end - cursor,
    static_cast<std::uintptr_t>(kScanChunkBytes),
    static_cast<std::uintptr_t>(kMaxScanPageBytes - result.scanned_bytes),
});
const auto lookahead = std::min<std::uintptr_t>(
    request.pattern.size() - 1, region_end - (cursor + unique_bytes));
const auto read_bytes = static_cast<std::size_t>(unique_bytes + lookahead);
```

Read `read_bytes`, accept only matches whose start is below
`cursor + unique_bytes`, and advance by `unique_bytes`. When the eligible-byte
budget is exhausted, return `complete:false` and `next_cursor=FormatAddress(cursor)`.
When virtual-address traversal reaches the system maximum, return
`complete:true` and no cursor. Skip the dedicated buffer allocation without
counting it. A failed read of an eligible chunk returns
`MEMORY_ACCESS_DENIED` immediately.

- [ ] **Step 5: Verify native GREEN repeatedly**

```powershell
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake --build native/build-pr-a --config Release --target cfb27_memory_reader_smoke
1..5 | ForEach-Object {
  & native/build-pr-a/Release/cfb27_memory_reader_smoke.exe
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
git diff --check
```

Expected: five `memory reader smoke passed` messages and exit `0`.

- [ ] **Step 6: Commit the native page**

```powershell
git add -- native/host/memory_reader.h native/host/memory_reader.cpp native/smoke/memory_reader_smoke.cpp
git commit -m "Implement cursor-paged memory scanning"
```

---

### Task 2: Expose page cursors and SDK aggregation

**Files:**
- Modify: `native/host/lua_host.cpp`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/test/client.test.cjs`
- Modify: `docs/protocol.md`
- Modify: `docs/getting-started.md`

**Interfaces:**
- Consumes: Task 1 `ScanRequest::cursor` and `ScanResult::next_cursor`.
- Produces: protocol `scanMemory.params.cursor`, exact page results,
  `client.scanMemoryPage(options)`, and aggregate `client.scanMemory(options)`.

- [ ] **Step 1: Write failing protocol page tests**

Update `protocol_smoke.cpp` to require `nextCursor` in every successful result:

```cpp
Expect(page["complete"] == false, "first page is partial");
Expect(page["nextCursor"].is_string(), "partial page has cursor");
const auto cursor = page["nextCursor"].get<std::string>();
params["cursor"] = cursor;
Expect(Request(host, "scanMemory", params, page2), "resume page");
Expect(page2["nextCursor"].is_null() ||
       page2["nextCursor"].get<std::string>() != cursor,
       "cursor progresses");
```

Add unknown-field, lowercase, redundant-zero, numeric, overflowing, and
above-maximum cursor requests. Require `nextCursor:null` exactly when complete.

- [ ] **Step 2: Write failing SDK pagination tests**

Use the fake pipe server to return three pages and assert exact outbound cursors:

```js
const pages = [
  { supportedBuild: true, complete: false, nextCursor: '0x1000', scannedBytes: 32, matches: [] },
  { supportedBuild: true, complete: false, nextCursor: '0x2000', scannedBytes: 32, matches: [MATCH] },
  { supportedBuild: true, complete: true, nextCursor: null, scannedBytes: 8, matches: [] },
];
const result = await client.scanMemory({ ...VALID_SCAN_OPTIONS, maxPages: 3 });
assert.equal(result.complete, true);
assert.equal(result.scannedBytes, 72);
assert.deepEqual(result.matches, [MATCH]);
assert.deepEqual(seen.map((request) => request.params.cursor),
                 [undefined, '0x1000', '0x2000']);
```

Add hostile-response cases for missing/null mismatch, numeric/lowercase/repeated/
decreasing cursors, aggregate unsafe integer overflow, more than `maxMatches`,
and exhaustion of `maxPages`. Prove request validation occurs before socket
creation.

- [ ] **Step 3: Run protocol and SDK tests and verify RED**

```powershell
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake --build native/build-pr-a --config Release --target cfb27_lua_host cfb27_protocol_smoke
& native/build-pr-a/Release/cfb27_protocol_smoke.exe native/build-pr-a/Release/cfb27_lua_host.dll
node --test packages/sdk/test/client.test.cjs
```

Expected: protocol shape/cursor assertions fail and SDK tests fail because
`scanMemoryPage` and aggregation are absent.

- [ ] **Step 4: Implement strict protocol cursor handling**

Allow exactly optional `cursor` in `scanMemory` params. Parse it with the same
canonical uppercase address validator used for read ranges, move it into
`ScanRequest`, and serialize:

```cpp
Json result = {
    {"supportedBuild", supported_build},
    {"complete", scan.complete},
    {"nextCursor", scan.next_cursor ? Json(CanonicalAddress(*scan.next_cursor)) : Json(nullptr)},
    {"scannedBytes", scan.scanned_bytes},
    {"matches", std::move(matches)},
};
```

Retain strict unsupported-build gating and sanitized errors.

- [ ] **Step 5: Implement SDK page validation and aggregation**

Set `maxScanPageBytes` to 32 MiB and `maxPages` to 4,096. Keep `maxPages`
SDK-only; do not send it to the host. Implement:

```js
async function scanMemoryPage(options = {}) {
  const params = cloneScanPageOptions(options);
  return validateScanPageResult(await request('scanMemory', params), params);
}

async function scanMemory(options = {}) {
  const { maxPages = MEMORY_LIMITS.maxPages, ...base } = cloneAggregateScanOptions(options);
  const matches = [];
  const cursors = new Set();
  let cursor;
  let scannedBytes = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await scanMemoryPage(cursor ? { ...base, cursor } : base);
    scannedBytes = safeAddScanBytes(scannedBytes, page.scannedBytes);
    matches.push(...page.matches);
    if (matches.length > base.maxMatches) throw tooManyMatches();
    if (page.complete) return { supportedBuild: page.supportedBuild, complete: true,
                                scannedBytes, matches };
    if (cursors.has(page.nextCursor) ||
        (cursor && BigInt(page.nextCursor) <= BigInt(cursor))) {
      throw invalidResponse('Host returned a non-progressing scan cursor');
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Cfb27HookError('SCAN_LIMIT_EXCEEDED', 'scanMemory exceeded maxPages');
}
```

Do not expose either method to renderer code.

- [ ] **Step 6: Document and verify Task 2**

Document page and aggregate semantics, 32 MiB/4 MiB bounds, 4,096-page ceiling,
live-map non-atomicity, and required re-read validation.

```powershell
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake --build native/build-pr-a --config Release
& native/build-pr-a/Release/cfb27_memory_reader_smoke.exe
& native/build-pr-a/Release/cfb27_telemetry_smoke.exe
& native/build-pr-a/Release/cfb27_protocol_smoke.exe native/build-pr-a/Release/cfb27_lua_host.dll
node --test packages/sdk/test/client.test.cjs
npm run check
npm test
git diff --check
```

Expected: all native smokes pass and the full Node suite exits `0`.

- [ ] **Step 7: Commit protocol and SDK pagination**

```powershell
git add -- native/host/lua_host.cpp native/smoke/protocol_smoke.cpp packages/sdk/src/client.cjs packages/sdk/test/client.test.cjs docs/protocol.md docs/getting-started.md
git commit -m "Expose cursor-paged memory scans"
```

---

### Task 3: Integrate automatic paging into the developer CLI

**Files:**
- Modify: `packages/cli/src/args.cjs`
- Modify: `packages/cli/src/main.cjs`
- Modify: `packages/cli/test/main.test.cjs`
- Modify: `docs/cli.md`
- Modify: `docs/development/release-checklist.md`

**Interfaces:**
- Consumes: Task 2 aggregate `client.scanMemory(options)`.
- Produces: automatic bounded CLI paging and per-page scan timeout selection.

This task must preserve the existing uncommitted Task 5 CLI work already
verified at 18/18 focused tests. Do not discard or replace those user-approved
changes.

- [ ] **Step 1: Add failing multi-page CLI and timeout tests**

Extend the existing `memory scan` tests:

```js
assert.deepEqual(calls[0], ['createClient', { pid: 42, timeoutMs: 10_000 }]);
assert.deepEqual(calls[1], ['scanMemory', {
  patternHex: PATTERN,
  maskHex: MASK,
  maxMatches: 8,
  contextBefore: 32,
  contextAfter: 32,
  maxPages: 4096,
}]);
```

Return an aggregate result and assert JSON output is unchanged. Add
`--max-pages 0`, `4097`, unsafe integer, duplicate option, and attempts to use
`--cursor` directly; the CLI owns continuation and rejects raw cursor input.

- [ ] **Step 2: Run focused CLI tests and verify RED**

```powershell
node --test packages/cli/test/main.test.cjs
```

Expected: new timeout/max-pages assertions fail.

- [ ] **Step 3: Add bounded CLI parsing and dispatch**

In `args.cjs`, parse `--max-pages` as an integer from 1 through 4,096. In
`main.cjs`, construct only the scan client with a 10-second per-page timeout:

```js
const client = sdk.createClient({ pid: game.pid, timeoutMs: 10_000 });
result = await client.scanMemory({ ...scanOptions, maxPages: options.maxPages || 4096 });
```

Reads, telemetry, status, logs, and events retain the three-second SDK default.
Reject all raw `--cursor`, start/stop-range, and write-like options.

- [ ] **Step 4: Run the automated release gate without installing**

```powershell
npm ci
npm run check
npm test
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake -S native -B native/build-release -A x64
& $cmake --build native/build-release --config Release
& native/build-release/Release/cfb27_memory_reader_smoke.exe
& native/build-release/Release/cfb27_telemetry_smoke.exe
& native/build-release/Release/cfb27_protocol_smoke.exe native/build-release/Release/cfb27_lua_host.dll
$env:CFB27_NATIVE_ARTIFACTS = (Resolve-Path native/build-release/Release).Path
npm run pack:preview
git diff --check
```

Inspect the preview ZIP and SDK/CLI tarballs. Reject build directories, saves,
schemas, archives outside documented release contents, logs, or local game data.

- [ ] **Step 5: Stop at the installation checkpoint**

Do not install automatically. Tell the user to close CFB27 and MMC. Confirm both
processes are absent, restore the recognized original proxies if the installed
candidate hash differs, then install the exact `native/build-release/Release`
proxy and host through the supported CLI. Hash all installed files and only then
tell the user to relaunch MMC offline, launch a fresh CFB27 process, open the
correct Dynasty, and stop at the Dynasty hub.

---

### Task 4: Repeat the live gate, version, commit, and open the draft PR

**Files:**
- Modify: `docs/research/runtime-verification.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/sdk/package.json`
- Modify: `packages/cli/package.json`
- Commit the five Task 3 CLI/doc files after the live gate.

**Interfaces:**
- Consumes: exact installed Task 3 release candidate.
- Produces: verified `v0.2.0-dev.1` source state and a draft PR.

- [ ] **Step 1: Verify live capabilities and allocate the sentinel**

At the Dynasty hub, record the PID and SHA-256 of `CollegeFB27.exe`. Require
`hello.capabilities` to contain `memoryScan`, `memoryRead`, and `telemetry`.
Allocate the binary sentinel without embedding its raw bytes in the Lua source:

```powershell
node packages/cli/bin/cfb27lua.cjs eval "_G.__cfb27_manual_sentinel = string.char(199,91,39,161,14,210,76,147,184,6,253,113,42,229,56,143)" --json
```

- [ ] **Step 2: Prove paged scan and exact read**

```powershell
$scan = node packages/cli/bin/cfb27lua.cjs memory scan `
  --pattern C75B27A10ED24C93B806FD712AE5388F `
  --mask FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF `
  --max-matches 8 --context 8 --max-pages 4096 --json | ConvertFrom-Json
$match = $scan.result.matches | Where-Object {
  $_.contextHex -match 'C75B27A10ED24C93B806FD712AE5388F'
} | Select-Object -First 1
node packages/cli/bin/cfb27lua.cjs memory read --range "$($match.address):16" --json
```

Require the exact 16-byte value and no memory write attempt. If multiple matches
exist, re-read each and identify the persistent Lua allocation; do not claim
uniqueness without completing all pages.

- [ ] **Step 3: Prove telemetry and responsiveness**

Capture the current event cursor, register `probe.snapshot`, emit
`{sequence=1,stable=true}`, and require exactly one matching event with a larger
cursor. Observe the game for ten minutes, then enter one Dynasty sub-screen and
return to the hub. Require the process, pipe, ticks, status, and UI to remain
responsive.

- [ ] **Step 4: Record only observed evidence**

Append the date, executable hash, installed host/proxy hashes, exact commands,
page count, scanned bytes, sentinel match/read result, telemetry cursors,
ten-minute observation, and hub transition to
`docs/research/runtime-verification.md`. Record failures verbatim; never convert
a failed or incomplete check into a pass.

- [ ] **Step 5: Bump versions after the live gate**

Set root, SDK, CLI, and lockfile versions to `0.2.0-dev.1`. Do not change
dependency ranges or package contents.

- [ ] **Step 6: Repeat every automated gate after the bump**

```powershell
npm ci
npm run check
npm test
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake -S native -B native/build-release -A x64
& $cmake --build native/build-release --config Release
& native/build-release/Release/cfb27_memory_reader_smoke.exe
& native/build-release/Release/cfb27_telemetry_smoke.exe
& native/build-release/Release/cfb27_protocol_smoke.exe native/build-release/Release/cfb27_lua_host.dll
$env:CFB27_NATIVE_ARTIFACTS = (Resolve-Path native/build-release/Release).Path
npm run pack:preview
git diff --check
```

Expected: all commands exit `0`, all package contents are clean, and fresh
SHA-256 checksums match the staged artifacts.

- [ ] **Step 7: Commit the final developer preview slice**

```powershell
git add -- packages/cli/src/args.cjs packages/cli/src/main.cjs packages/cli/test/main.test.cjs docs/cli.md docs/development/release-checklist.md docs/research/runtime-verification.md package.json package-lock.json packages/sdk/package.json packages/cli/package.json
git commit -m "Prepare live discovery developer preview"
```

- [ ] **Step 8: Final review, push, and draft PR**

Run an independent whole-branch review from the approved design/plans baseline.
Fix and re-review all Critical and Important findings. Then:

```powershell
git push -u origin codex/live-memory-discovery-telemetry
```

Open a draft PR against `main`. Do not tag or publish `v0.2.0-dev.1` until the
draft is reviewed, made ready, merged, and the release checklist is rerun.
