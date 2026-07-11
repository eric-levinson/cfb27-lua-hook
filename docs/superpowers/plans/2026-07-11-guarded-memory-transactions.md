# Guarded Memory Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `cfb27-lua-hook` v0.2.0-dev.2 with bounded whole-request memory transactions, complete preflight comparison, readback, rollback, and session write lockdown after an unverifiable rollback.

**Architecture:** A standalone transaction engine operates through an injectable memory backend so all failure paths are deterministic in native tests. The production backend accesses only validated current-process writable memory. Protocol and SDK layers use canonical hex-string addresses and hex byte sequences; the existing one-byte Lua API remains compatible but observes the same session-lockdown flag.

**Tech Stack:** Windows C++20, Win32 memory APIs, nlohmann/json, CommonJS Node.js 20+, Node test runner, CMake 3.24+.

## Global Constraints

- This plan starts only after v0.2.0-dev.1 discovery/telemetry assets and checksums are published.
- Transaction limits: 32 operations, 4096 bytes per operation, 64 KiB aggregate replacement bytes, and a 64-character transaction ID matching `^[A-Za-z0-9._-]+$`.
- Every operation uses canonical uppercase hex-string address, equal-length nonempty `expectedHex` and `replacementHex`, and a non-overlapping address range.
- Preflight every operation before writing the first byte; any mismatch causes zero writes.
- Apply and verify in request order; rollback every applied operation in reverse order.
- A rollback verification failure permanently disables all host writes until the game/host restarts.
- Preserve exact-build, writable-memory, expected-byte, anticheat, and readback gates.
- Do not claim game-thread atomicity and do not expose the command through an Electron renderer.
- Preserve `cfb.write_u8` behavior for successful requests; add only the session-lockdown rejection.
- No native build output, packages, game files, addresses, or diagnostic memory dumps may be committed.

---

### Task 1: Implement a backend-driven transaction engine

**Files:**
- Create: `native/host/memory_transaction.h`
- Create: `native/host/memory_transaction.cpp`
- Create: `native/smoke/memory_transaction_smoke.cpp`
- Modify: `native/CMakeLists.txt`

**Interfaces:**
- Produces abstract `MemoryBackend`.
- Produces production `ProcessMemoryBackend`.
- Produces `RunTransaction(const TransactionRequest&, MemoryBackend&): TransactionResult`.

- [ ] **Step 1: Write the fake-backend smoke tests**

Define a fake 256-byte backend that records write calls and can fail a chosen write, verification read, restore write, or restore read. Cover:

```cpp
Require(RunTransaction(valid, backend).status == Status::kAppliedVerified, "happy path");
Require(backend.bytes == expected_after, "replacement present");

backend.Reset(); backend.bytes[expected_offset] ^= 1;
const auto mismatch = RunTransaction(valid, backend);
Require(mismatch.status == Status::kRejected && backend.write_calls == 0,
        "preflight mismatch writes nothing");

backend.Reset(); backend.fail_write_index = 1;
const auto rolled_back = RunTransaction(valid, backend);
Require(rolled_back.status == Status::kRolledBackVerified, "failed apply rolls back");
Require(backend.bytes == original, "all originals restored");

backend.Reset(); backend.fail_write_index = 1; backend.fail_restore = true;
Require(RunTransaction(valid, backend).status == Status::kRollbackUnverified,
        "rollback failure is explicit");
```

Also reject empty operations, 33 operations, 4097-byte operations, aggregate bytes above 64 KiB, unequal lengths, overflowed ranges, duplicate/overlapping ranges, invalid transaction IDs, and operations submitted out of ascending address order only if they overlap (order itself remains caller-defined).

- [ ] **Step 2: Add the smoke target and verify RED**

```powershell
cmake -S native -B native/build-transaction -A x64
cmake --build native/build-transaction --config Release --target cfb27_memory_transaction_smoke
```

Expected: compile failure because the transaction module is absent.

- [ ] **Step 3: Define the engine types**

In `memory_transaction.h`:

```cpp
namespace cfb27::memory {
constexpr std::size_t kMaxTransactionOperations = 32;
constexpr std::size_t kMaxOperationBytes = 4096;
constexpr std::size_t kMaxTransactionBytes = 64ull * 1024;

struct TransactionOperation {
  std::string address;
  std::vector<std::uint8_t> expected;
  std::vector<std::uint8_t> replacement;
};
struct TransactionRequest {
  std::string transaction_id;
  std::vector<TransactionOperation> operations;
};
enum class TransactionStatus {
  kRejected,
  kAppliedVerified,
  kRolledBackVerified,
  kRollbackUnverified,
};
struct OperationResult { std::size_t index{}; bool applied{}; bool verified{}; };
struct TransactionResult {
  TransactionStatus status{};
  std::string code;
  std::vector<OperationResult> operations;
};
class MemoryBackend {
 public:
  virtual ~MemoryBackend() = default;
  virtual bool Validate(std::uintptr_t address, std::size_t size, bool writable) = 0;
  virtual bool Read(std::uintptr_t address, std::span<std::uint8_t> output) = 0;
  virtual bool Write(std::uintptr_t address, std::span<const std::uint8_t> input) = 0;
};
class ProcessMemoryBackend final : public MemoryBackend { /* three overrides */ };
TransactionResult RunTransaction(const TransactionRequest& request, MemoryBackend& backend);
}
```

- [ ] **Step 4: Implement validation, preflight, apply, verify, and rollback**

Parse addresses once, sort copies of ranges only for overlap detection, and retain request order for application. Preflight validates all ranges and reads all originals before comparing all expected bytes. Do not call `Write` during preflight.

On any apply/write/readback failure, restore every operation whose write was attempted, in reverse order, from the captured originals; then read and compare every restored range. Return `kRollbackUnverified` if any restore or verification fails.

- [ ] **Step 5: Verify the engine and commit**

```powershell
cmake --build native/build-transaction --config Release --target cfb27_memory_transaction_smoke
native\build-transaction\Release\cfb27_memory_transaction_smoke.exe
git add -- native/host/memory_transaction.h native/host/memory_transaction.cpp native/smoke/memory_transaction_smoke.cpp native/CMakeLists.txt
git commit -m "Add guarded memory transaction engine"
```

---

### Task 2: Expose write transactions through the native host

**Files:**
- Modify: `native/host/lua_host.cpp`
- Modify: `native/CMakeLists.txt`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `native/smoke/startup_host_smoke.cpp`
- Modify: `docs/protocol.md`
- Modify: `docs/safety.md`

**Interfaces:**
- Consumes `RunTransaction` from Task 1.
- Produces `writeTransaction` protocol command and `memoryWriteTransaction` capability.
- Produces status field `sessionWritesDisabled`.

- [ ] **Step 1: Add failing protocol smoke cases**

Allocate two writable buffers in the smoke process. Submit:

```json
{
  "command":"writeTransaction",
  "params":{
    "transactionId":"smoke.apply-1",
    "operations":[
      {"address":"0x...","expectedHex":"1020","replacementHex":"1121"},
      {"address":"0x...","expectedHex":"3040","replacementHex":"3141"}
    ]
  }
}
```

The smoke executable is not the supported game build, so introduce a test-only host environment variable `CFB27_SMOKE_ALLOW_WRITES=1` honored only when the executable name is `cfb27_protocol_smoke.exe`. Assert no other executable can use it.

Cover applied/verified, complete preflight mismatch with unchanged memory, overlapping operations, malformed hex, invalid address, unsupported build without the smoke gate, and status/capability reporting.

- [ ] **Step 2: Run protocol smoke and verify RED**

Expected: unknown-command failure for `writeTransaction`.

- [ ] **Step 3: Add request parsing and the session lockdown**

Add `std::atomic<bool> g_session_writes_disabled{false}`. Parse only `transactionId` and `operations`; reject extra fields. Map results as:

```json
{"transactionId":"smoke.apply-1","status":"applied_verified","operations":[{"index":0,"applied":true,"verified":true}]}
```

Use stable error codes `MEMORY_MISMATCH`, `MEMORY_ACCESS_DENIED`, `TRANSACTION_LIMIT_EXCEEDED`, `TRANSACTION_APPLY_FAILED`, `ROLLBACK_VERIFICATION_FAILED`, and `SESSION_WRITES_DISABLED`.

When result is `kRollbackUnverified`, set the lockdown before returning. Add `sessionWritesDisabled` to `status`. `writeTransaction` and `LuaWriteU8` check this flag before all other write work.

- [ ] **Step 4: Link the transaction engine and advertise capability**

Add `host/memory_transaction.cpp` to `cfb27_lua_host`; add `memoryWriteTransaction` to `hello.capabilities`.

- [ ] **Step 5: Verify native host behavior**

```powershell
cmake --build native/build-transaction --config Release --target cfb27_lua_host cfb27_protocol_smoke cfb27_startup_smoke
$env:CFB27_SMOKE_ALLOW_WRITES='1'
native\build-transaction\Release\cfb27_protocol_smoke.exe native\build-transaction\Release\cfb27_lua_host.dll
Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES
```

Expected: all smokes exit `0`; the test-only gate source test proves the executable-name restriction.

- [ ] **Step 6: Document and commit**

Document non-game-thread atomicity, rollback statuses, lockdown behavior, and the fact that callers must establish a stable window.

```powershell
git add -- native/host/lua_host.cpp native/CMakeLists.txt native/smoke/protocol_smoke.cpp native/smoke/startup_host_smoke.cpp docs/protocol.md docs/safety.md
git commit -m "Expose guarded memory transactions"
```

---

### Task 3: Add SDK and developer CLI transaction clients

**Files:**
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/src/errors.cjs`
- Modify: `packages/sdk/test/client.test.cjs`
- Modify: `packages/cli/src/args.cjs`
- Modify: `packages/cli/src/main.cjs`
- Modify: `packages/cli/test/main.test.cjs`
- Modify: `docs/cli.md`

**Interfaces:**
- Produces `client.writeTransaction({ transactionId, operations })`.
- Produces `cfb27lua memory transact proof-transaction.json --json`.

- [ ] **Step 1: Write failing SDK tests**

Assert the SDK sends exactly:

```js
await client.writeTransaction({
  transactionId: 'recruiting.influence-proof-1',
  operations: [{
    address: '0x7FF612340000',
    expectedHex: '1020',
    replacementHex: '1121',
  }],
});
```

Assert local rejection before connection for invalid IDs, numeric/lowercase addresses, odd/invalid hex, unequal byte lengths, overlaps, limits, unknown keys, and caller-provided result/status fields. Validate every response property and reject host-supplied addresses/raw bytes in result objects.

- [ ] **Step 2: Verify SDK RED and implement GREEN**

Run `node --test packages/sdk/test/client.test.cjs`, implement frozen-clone input validation and strict response validation, add the six stable error codes, and rerun until green.

- [ ] **Step 3: Write failing CLI tests**

The JSON file contains only the SDK request object. Assert the CLI refuses stdin, absolute paths outside the current working directory unless `--allow-external-file` is passed, non-JSON extensions, and human output that prints addresses or bytes. Human output may print only transaction ID, status, and operation counts; `--json` returns the validated SDK result.

- [ ] **Step 4: Implement the thin CLI handler and verify**

```powershell
node --test packages/cli/test/main.test.cjs
npm run check
npm test
```

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- packages/sdk/src/client.cjs packages/sdk/src/errors.cjs packages/sdk/test/client.test.cjs packages/cli/src/args.cjs packages/cli/src/main.cjs packages/cli/test/main.test.cjs docs/cli.md
git commit -m "Add guarded transaction SDK and CLI"
```

---

### Task 4: Complete controlled-memory and live reversible-write gates

**Files:**
- Modify: `docs/development/release-checklist.md`
- Modify: `docs/research/runtime-verification.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/sdk/package.json`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Produces immutable release `v0.2.0-dev.2`.

- [ ] **Step 1: Run the complete automated gate**

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-release -A x64
cmake --build native/build-release --config Release
native\build-release\Release\cfb27_memory_reader_smoke.exe
native\build-release\Release\cfb27_telemetry_smoke.exe
native\build-release\Release\cfb27_memory_transaction_smoke.exe
$env:CFB27_SMOKE_ALLOW_WRITES='1'
native\build-release\Release\cfb27_protocol_smoke.exe native\build-release\Release\cfb27_lua_host.dll
Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES
npm run pack:preview
git diff --check
```

- [ ] **Step 2: Stop at the user relaunch checkpoint**

**USER RELAUNCH CHECKPOINT:** Tell the user to close CFB27 and MMC. Do not install or replace the host while either process is running. Confirm both are closed, install the candidate DLL through the supported SDK/CLI workflow, then explicitly tell the user when to relaunch MMC and CFB27 offline and return to the Dynasty hub.

- [ ] **Step 3: Perform only a reversible controlled live write**

Use one of the previously verified authoritative Dynasty permission records
(`LeagueSetting.AbilityEditControls` or `FranchiseUser.AdminLevel`), rediscovered
from the selected save's exact full record and revalidated immediately before
the transaction. Do not use a recruiting field yet. Apply the alternate enum
value, read it back, restore the original immediately, read it back again, and
verify game responsiveness. Do not advance a week during this host-only gate.

- [ ] **Step 4: Record evidence and bump the version**

Record executable hash, PID, transaction request hash (not addresses/bytes), statuses, rollback/restoration results, and game responsiveness in `docs/research/runtime-verification.md`. Set root, SDK, CLI, and lockfile versions to `0.2.0-dev.2` only after the gate passes.

- [ ] **Step 5: Re-run release verification and commit**

```powershell
npm ci
npm run check
npm test
cmake --build native/build-release --config Release
npm run pack:preview
git diff --check
git add -- docs/development/release-checklist.md docs/research/runtime-verification.md package.json package-lock.json packages/sdk/package.json packages/cli/package.json
git commit -m "Prepare guarded write developer preview"
```

- [ ] **Step 6: Push a draft PR and release after merge**

```powershell
git push -u origin codex/guarded-memory-transactions
```

Open a draft PR against `main`. After review and merge, tag `v0.2.0-dev.2`, publish immutable assets and checksums, and verify a fresh SDK install before starting the Brooks integration implementation.
