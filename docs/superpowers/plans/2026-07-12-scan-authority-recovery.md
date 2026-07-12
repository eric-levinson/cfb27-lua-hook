# Scan Authority Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate scanner-owned false matches, expose bounded allocation topology for read-only authority classification, and complete the guarded reversible live-write proof before publishing `v0.2.0-dev.2`.

**Architecture:** All scanner-owned binary storage moves to pagefile-backed `MEM_MAPPED` views outside the private-only scan domain. Allocation topology is an opt-in, capability-gated `scanMemory` extension; legacy protocol-v1 consumers retain their exact response shape. The live gate classifies authority through stable full-record neighborhoods and allocation lifecycle across a menu transition, never through address order, allocation size alone, the obsolete 40 MiB rule, or blind multi-copy writes.

**Tech Stack:** C++20, Win32 virtual memory/file mappings, nlohmann JSON, Node.js CommonJS SDK/CLI, TAP, CMake/MSBuild, PowerShell.

## Global Constraints

- CFB27 and MMC remain closed during implementation and automated verification.
- Explicitly notify the user before candidate installation, before relaunch, and before every later close or relaunch.
- Preserve the unstaged user modification to `docs/superpowers/plans/2026-07-11-guarded-memory-transactions.md`.
- Strict TDD: every production behavior change starts with a focused test observed failing for the expected reason.
- Use one fresh implementer per task and a different reviewer for specification compliance and code quality.
- Pattern, mask, staging, and retained-context bytes must never occupy scan-eligible `MEM_PRIVATE` storage.
- Do not broaden scanning beyond committed readable non-guarded `MEM_PRIVATE` regions.
- Allocation metadata is opt-in and capability-gated; absent/false retains the exact current response.
- Addresses and raw bytes remain opaque session-only values and are never persisted in evidence.
- Never select candidates by address order, allocation size alone, or the historical 40 MiB allocation.
- Never write all plausible duplicates. No transaction is sent without one read-only-classified authoritative permission candidate.
- Do not bump, push, open a PR, tag, or publish `v0.2.0-dev.2` until live apply and restore pass.

---

### Task 1: Move scanner-owned binary buffers outside `MEM_PRIVATE`

**Files:**
- Modify: `native/host/memory_reader.h`
- Modify: `native/host/memory_reader.cpp`
- Modify: `native/host/lua_host.cpp`
- Modify: `native/smoke/memory_reader_smoke.cpp`
- Modify: `native/smoke/protocol_smoke.cpp`

**Interfaces:**
- Produces: move-only `cfb27::memory::MappedBytes` with `Allocate`, `FromUpperHex`, `CopyFrom`, `data`, `size`, `empty`, `bytes`, and `mutable_bytes`.
- Produces: `ScanRequest.pattern`, `ScanRequest.mask`, scan staging, and `ScanMatch.context` backed by `MappedBytes`.
- Preserves: scan limits, cursors, errors, and the current wire response.

- [ ] **Step 1: Add deterministic failing native tests**

Add `RequireMappedStorage(pointer, message)`, using `VirtualQuery` to require committed readable `MEM_MAPPED` storage. Assert decoded pattern/mask, the `ScanReadFunction` destination, and produced match context all satisfy it.

Add the behavioral regression: put a unique sentinel in a controlled private allocation, scan it, retain the first result, erase/free the target, then scan starting at the retained context address. Require no second match at that address. Do not teach the test an exclusion list.

- [ ] **Step 2: Run RED**

```powershell
cmake --build native/build-release --config Release --target cfb27_memory_reader_smoke
native\build-release\Release\cfb27_memory_reader_smoke.exe
```

Expected: runtime failure because current scanner-owned storage is `MEM_PRIVATE` or the retained prior context is returned. A compile failure solely for an undeclared new type is not acceptable RED evidence.

- [ ] **Step 3: Implement mapped storage and direct decode**

Implement this exact public shape:

```cpp
class MappedBytes {
 public:
  MappedBytes() = default;
  ~MappedBytes();
  MappedBytes(MappedBytes&&) noexcept;
  MappedBytes& operator=(MappedBytes&&) noexcept;
  MappedBytes(const MappedBytes&) = delete;
  MappedBytes& operator=(const MappedBytes&) = delete;
  static std::optional<MappedBytes> Allocate(std::size_t size);
  static std::optional<MappedBytes> FromUpperHex(std::string_view text);
  static std::optional<MappedBytes> CopyFrom(std::span<const std::uint8_t> bytes);
  const std::uint8_t* data() const;
  std::uint8_t* data();
  std::size_t size() const;
  bool empty() const;
  std::span<const std::uint8_t> bytes() const;
  std::span<std::uint8_t> mutable_bytes();
 private:
  HANDLE mapping_{};
  std::uint8_t* view_{};
  std::size_t size_{};
};
```

Allocate with `CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, ...)` and `MapViewOfFile`; verify `MEM_MAPPED`; fail closed and clean up on every error. Destruction securely wipes, unmaps, and closes. Decode uppercase hex directly into the view without a binary vector. Use mapped storage for pattern, mask, staging, and every bounded context. Retain current pointer exclusions only as defense in depth.

- [ ] **Step 4: Run GREEN and regressions**

```powershell
cmake --build native/build-release --config Release --target cfb27_memory_reader_smoke cfb27_protocol_smoke cfb27_lua_host
native\build-release\Release\cfb27_memory_reader_smoke.exe
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try { native\build-release\Release\cfb27_protocol_smoke.exe native\build-release\Release\cfb27_lua_host.dll } finally { Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue }
npm test
```

Expected: mapped-storage and retained-context tests pass, protocol smoke passes, Node failures are zero, and the environment gate is unset afterward.

- [ ] **Step 5: Self-review, report, and commit**

Verify no scanner-owned binary vector remains, run `git diff --check`, record RED/GREEN evidence in `.superpowers/sdd/scan-recovery-task-1-report.md`, and commit only Task 1 files:

```powershell
git commit -m "Prevent memory scan self matches"
```

---

### Task 2: Add opt-in allocation topology through native, protocol, SDK, and CLI

**Files:**
- Modify: `native/host/memory_reader.h`
- Modify: `native/host/memory_reader.cpp`
- Modify: `native/host/lua_host.cpp`
- Modify: `native/smoke/memory_reader_smoke.cpp`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/test/client.test.cjs`
- Modify: `packages/cli/test/main.test.cjs`
- Modify: `docs/protocol.md`
- Modify: `docs/getting-started.md`

**Interfaces:**
- Consumes: Task 1 `MappedBytes` scan storage.
- Produces: request boolean `includeAllocationMetadata` and capability `memoryScanAllocationMetadata`.
- Produces when opted in: exact `allocationBase`, `allocationSize`, `allocationProtect`, and `offsetInAllocation` match properties.
- Preserves when not opted in: current exact SDK and CLI response.

- [ ] **Step 1: Add native/protocol RED tests**

Reserve three pages and commit them separately so multiple `VirtualQuery` regions share one `AllocationBase`. Put a sentinel in the middle region and opt in. Require exact base, complete three-page extent, initial protection, and checked offset. Inject a query failure at the extent boundary and require `MEMORY_ACCESS_DENIED` with no partial matches.

Require protocol hello to advertise `memoryScanAllocationMetadata`. Require extended keys only for `includeAllocationMetadata:true`; absent/false must retain legacy exact keys.

- [ ] **Step 2: Run native/protocol RED**

Run the focused build and both native smokes. Expected failure is missing capability/metadata or incomplete extent discovery, never malformed test setup.

- [ ] **Step 3: Implement checked allocation topology**

```cpp
struct AllocationMetadata {
  std::string base;
  std::size_t size{};
  DWORD protection{};
  std::size_t offset{};
};
```

Add `std::optional<AllocationMetadata>` to `ScanMatch`. When opted in, walk adjacent `VirtualQuery` entries from `AllocationBase` while they retain that allocation base. Check overflow and forward progress, cap at the system maximum, and cache one extent per allocation base per page. Query failure or inconsistent offset returns `MEMORY_ACCESS_DENIED` and discards results. Accept only the exact new request key, conditionally emit the four fields, and advertise the capability.

- [ ] **Step 4: Add SDK/CLI RED tests**

Require exact boolean cloning and a capability preflight. Require strict extended keys and hostile cases for missing/extra properties, noncanonical base, unsafe sizes, offset outside allocation, and failure of:

```js
BigInt(match.address) === BigInt(match.allocationBase) + BigInt(match.offsetInAllocation)
```

Require legacy tests to keep exact old requests/results. Require CLI JSON to preserve the validated extended result without persisting it.

- [ ] **Step 5: Run SDK/CLI RED**

```powershell
node --test packages/sdk/test/client.test.cjs
node --test packages/cli/test/main.test.cjs
```

Expected: opt-in behavior fails for the missing contract while legacy tests remain green.

- [ ] **Step 6: Implement SDK/CLI and documentation**

Clone the boolean exactly. Before an opt-in scan, negotiate hello and require `memoryScanAllocationMetadata`; fail closed with a stable public protocol/capability error if absent. Select legacy or extended exact match keys from the option and validate arithmetic with `BigInt`, never `Number` addresses.

Document the option, capability, both shapes, lifecycle semantics, session-only rule, and prohibition against using allocation size/order as authority.

- [ ] **Step 7: Run GREEN and full regressions**

```powershell
npm run check
npm test
cmake --build native/build-release --config Release
native\build-release\Release\cfb27_memory_reader_smoke.exe
native\build-release\Release\cfb27_telemetry_smoke.exe
native\build-release\Release\cfb27_memory_transaction_smoke.exe
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try { native\build-release\Release\cfb27_protocol_smoke.exe native\build-release\Release\cfb27_lua_host.dll } finally { Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue }
git diff --check
```

Expected: all tests/builds/smokes pass, the gate variable is unset, and the protected plan is unstaged.

- [ ] **Step 8: Self-review, report, and commit**

Record evidence in `.superpowers/sdd/scan-recovery-task-2-report.md` and commit only Task 2 files:

```powershell
git commit -m "Expose bounded scan allocation metadata"
```

---

### Task 3: Review, classify live authority, prove apply/restore, and release

**Files:**
- Modify only after live success: `docs/research/runtime-verification.md`
- Modify only after live success: `docs/development/release-checklist.md`
- Modify only after live success: `package.json`
- Modify only after live success: `package-lock.json`
- Modify only after live success: `packages/sdk/package.json`
- Modify only after live success: `packages/cli/package.json`
- Modify only after live success: `native/host/lua_host.cpp`

**Interfaces:**
- Consumes: reviewed Tasks 1–2 candidate and allocation metadata.
- Produces: sanitized evidence, `0.2.0-dev.2`, draft PR, immutable prerelease, verified downloads.

- [ ] **Step 1: Complete independent review gates**

Generate per-task review packages. Fresh reviewers must approve both specification compliance and code quality; fix and re-review every Critical/Important finding. Then obtain a different merge-base-to-head whole-branch approval. Do not install before approval.

- [ ] **Step 2: Run the complete candidate gate**

Run `npm ci`, check, all tests, clean x64 Release configure/build, every native smoke, package preview, manifest/checksum verification, and diff check. Record candidate SHA-256. Confirm both apps absent and both original active proxies hash to `3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454`.

- [ ] **Step 3: Explicit installation and relaunch checkpoint**

Tell the user both apps must remain closed. Install only via supported SDK/CLI and verify installed hashes. Then explicitly tell the user to launch MMC and CFB27 offline and return to Dynasty hub. Do not request Recruiting navigation yet.

- [ ] **Step 4: Read-only authority calibration**

Verify supported executable/PID/session/capability/write eligibility. Parse the selected save read-only and derive exact records for `LeagueSetting[0]`, `FranchiseUser[0]`, and a distinctive Player row. Opt-in scan, batch-read records/neighborhoods, and require stable samples. Record only hashes/counts/topology relationships.

Explicitly instruct hub-to-Recruiting-to-hub navigation. Rediscover from recipes. Exclude candidates that disappear with presentation state, retain stale neighborhoods, or fail relocation. Proceed only with exactly one authoritative permission candidate; unresolved replicas mean no write and another implementation cycle.

- [ ] **Step 5: Perform reversible controlled write**

Immediately revalidate the full record. Change only the byte containing the two-bit enum, preserving other bits. Verify transaction, full alternate image, responsiveness, and no lockdown. Immediately restore with a second transaction and verify the full original image, responsiveness, and writes remain enabled. Do not advance or write recruiting data.

- [ ] **Step 6: Explicit close and restore checkpoint**

Tell the user to close both apps. Confirm process absence, supported uninstall/restore, and both original proxy hashes. Do not relaunch for packaging.

- [ ] **Step 7: Evidence, versions, and release verification**

Only after live success, add sanitized evidence, set every version to `0.2.0-dev.2`, rerun the full gate, and commit `Prepare guarded write developer preview`.

- [ ] **Step 8: Push, draft PR, merge, and immutable prerelease**

Push the branch, open a draft PR against `main`, and complete review. After merge, tag the exact merge commit, publish immutable ZIP/checksum assets as a prerelease, download them afresh, and independently recompute SHA-256. Do not start Brooks integration before verification.
