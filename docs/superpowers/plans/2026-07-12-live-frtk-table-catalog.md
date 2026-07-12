# Live FrTk Table Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bulk-calibrated, lifecycle-safe live FrTk table catalog with typed Lua/SDK reads and authority-gated guarded field transactions, then prove discovery of the CFB27 recruiting graph without calibrating fields individually.

**Architecture:** A local-only profile compiler turns a normalized save/schema snapshot into deterministic discovery and field-layout artifacts. Native discovery locates at least three records per table, derives base/stride, validates allocations and packed-reference relationships, and installs generation-scoped descriptors. Typed protocol, SDK, CLI, and Lua APIs resolve logical tables and fields through the catalog; the existing guarded transaction engine remains the only writer.

**Tech Stack:** Windows C++20, Win32 virtual memory APIs, nlohmann/json, Lua 5.4.8, CommonJS Node.js 20+, Node test runner, CMake 3.24+, MSBuild.

## Global Constraints

- CFB27 and MMC remain closed during implementation, automated verification, and independent review.
- Explicitly notify the user before CFB27 or MMC must be launched, closed, or relaunched. Never manipulate either application automatically.
- Strict TDD: every production behavior starts with a focused test observed failing for the expected reason.
- Use a fresh implementer for each task, then a different reviewer for specification compliance and code quality. Fix and re-review every Critical or Important finding before continuing.
- The user must not perform field-by-field calibration. Profiles load all supported fields for a table together; live gates validate the system, not each field.
- Generated profiles, schema files, save files, raw record bytes, process addresses, and memory dumps remain local under ignored `.frtk/` and are never committed or packaged.
- Commit only synthetic FrTk fixtures. Active code must not import `archive/`.
- The table header Unique ID is the only persistent table identity and is always required. Logical names are display labels, and table IDs are current-build/session routing values used only to decode packed references. Neither name nor table ID may select a table across builds.
- Every discovered table requires at least three distinct occupied row fingerprints and consistent pairwise stride/base derivation.
- Validate packed references as `(tableId << 17) | rowIndex`; follow the encoded target table, including the valid 5840/5841 overflow pair.
- Never infer authority from address order, allocation size alone, or the historical 40 MiB observation.
- Raw addresses are session-only and remain inside the native host. Typed SDK/CLI/Lua catalog responses do not expose them.
- Catalog handles carry a lifecycle generation. Explicit invalidation, `game_ready:false`, discovery replacement, allocation loss, sentinel mismatch, or relationship failure advances the generation and makes old handles unusable.
- Authority statuses are exactly `discovery_only`, `commit_adapter_required`, and `direct_verified`. Recruiting starts `discovery_only` and refuses field transactions.
- Existing scan, read, transaction limits, build gates, rollback behavior, and session write lockdown remain unchanged.

---

### Task 1: Build deterministic bulk profile and field-layout artifacts

**Files:**
- Create: `packages/sdk/src/validation.cjs`
- Create: `packages/sdk/src/frtk-fields.cjs`
- Create: `packages/sdk/src/frtk-profile.cjs`
- Create: `packages/sdk/test/validation.test.cjs`
- Create: `packages/sdk/test/frtk-fields.test.cjs`
- Create: `packages/sdk/test/frtk-profile.test.cjs`
- Create: `packages/sdk/test/fixtures/frtk/synthetic-snapshot.cjs`
- Create: `scripts/build-frtk-profile.cjs`
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/index.cjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `docs/frtk-profile-format.md`

**Interfaces:**
- Produces `compileFrtkArtifacts({ snapshot, layout }): { profile, layout }`.
- Produces `decodePackedReference(value)` and `encodePackedReference({ tableId, rowIndex })`.
- Produces `decodeField(record, definition)` and `encodeField(record, definition, value)` for unsigned, signed, bitfield, and packed-reference fields.
- Produces local CLI `node scripts/build-frtk-profile.cjs --snapshot X --layout Y --output .frtk/profile.json`.

- [ ] **Step 1: Write failing validator and field-codec tests**

Extract wished-for generic validators from `client.cjs` and test exact keys, bounded safe integers, uppercase even-length hex, deterministic key ordering, cross-byte bitfields, signed 11-bit values, unrelated-bit preservation, and packed refs:

```js
assert.deepEqual(decodePackedReference(encodePackedReference({ tableId: 4288, rowIndex: 37 })), {
  tableId: 4288,
  rowIndex: 37,
});
const definition = {
  name: 'CrossByte', encoding: 'bitfield', byteOffset: 0,
  storageBytes: 2, bitOffset: 5, bitWidth: 7, minimum: 0, maximum: 127,
};
const updated = encodeField(Buffer.from('A55A', 'hex'), definition, 73);
assert.equal(decodeField(updated, definition), 73);
assert.equal(updated[0] & 0x1F, 0x05);
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --test packages/sdk/test/validation.test.cjs packages/sdk/test/frtk-fields.test.cjs
```

Expected: module-not-found failures for the new production modules.

- [ ] **Step 3: Implement shared validators and codecs, then verify GREEN**

Implement exact-key helpers and canonical serialization in `validation.cjs`. Move current client validation onto these helpers without changing existing requests or responses. Implement little-endian bit extraction/insertion with `BigInt`; reject record overflow, width zero/above 32, illegal signed ranges, mismatched reference target, and values outside declared bounds.

Run the focused tests plus `packages/sdk/test/client.test.cjs`; all must pass.

- [ ] **Step 4: Write failing deterministic profile compiler tests**

The synthetic fixture must programmatically construct arbitrary, non-game-derived records for:

| Logical table | ID | Record bytes | Capacity |
|---|---:|---:|---:|
| Player | 4244 | 192 | 16500 |
| Recruit | 4269 | 24 | 7600 |
| RecruitingBoard | 4251 | 12 | 138 |
| RecruitTarget | 4288 | 28 | 4870 |
| UserRecruitTarget | 4168 | 36 | 1120 |
| ProspectTargetSchoolArray | 5842 | 40 | 7600 |
| RecruitTargetArray | 5847 | 140 | 138 |
| ProspectTargetSchool | 5840 | 4 | 41010 |
| ProspectTargetSchoolOverflow | 5841 | 4 | 41010 |

Assert two shuffled inputs compile to byte-identical canonical JSON and identical `profileId`. Reject fewer than three distinct occupied rows, duplicate row indexes, wrong record length, masks with fewer than 64 selected bits, duplicate table IDs, duplicate Unique IDs, logical-name-only Team selection, unknown relationship targets, and layout/profile identity mismatch.

- [ ] **Step 5: Verify profile RED, implement minimal compiler, then verify GREEN**

```powershell
node --test packages/sdk/test/frtk-profile.test.cjs
```

Expected RED: `compileFrtkArtifacts` is missing.

Produce exact version-1 artifacts:

```js
profile = {
  formatVersion: 1, profileId, schemaIdentity, buildIdentity,
  tables: [{ logicalName, tableId, uniqueId, capacity, recordSize,
    rows: [{ rowIndex, patternHex, maskHex }],
    relationships: [{ sourceRow, fieldName, targetTableId, targetRow }],
  }],
};
layout = {
  formatVersion: 1, schemaIdentity, buildIdentity,
  tables: [{ logicalName, tableId, uniqueId, capacity, recordSize, authorityStatus,
    fields: [{ name, encoding, byteOffset, storageBytes, bitOffset, bitWidth,
      minimum, maximum, referenceTableId }],
  }],
};
```

Sort tables by table ID, fields by byte/bit offset then name, rows by row index, and relationships by source row/field. Hash only canonical content; never hash timestamps, paths, addresses, or generated-at values.

- [ ] **Step 6: Add the local-only CLI and privacy gates**

Require snapshot/layout JSON inputs, resolve output inside repository `.frtk/`, use exclusive creation unless `--force`, and refuse unknown arguments or paths outside `.frtk/`. Add `.frtk/` to `.gitignore` and packaging/privacy tests asserting `.frtk`, saves, schemas, and raw dump extensions are absent from release files.

- [ ] **Step 7: Run complete Task 1 verification and commit**

```powershell
npm run check
npm test
git diff --check
git add -- .gitignore package.json packages/sdk/index.cjs packages/sdk/src/client.cjs packages/sdk/src/validation.cjs packages/sdk/src/frtk-fields.cjs packages/sdk/src/frtk-profile.cjs packages/sdk/test/validation.test.cjs packages/sdk/test/frtk-fields.test.cjs packages/sdk/test/frtk-profile.test.cjs packages/sdk/test/fixtures/frtk/synthetic-snapshot.cjs scripts/build-frtk-profile.cjs docs/frtk-profile-format.md
git commit -m "Add deterministic FrTk profile compiler"
```

---

### Task 2: Parse profiles and field layouts in the native host core

**Files:**
- Create: `native/host/frtk_profile.h`
- Create: `native/host/frtk_profile.cpp`
- Create: `native/host/frtk_field_schema.h`
- Create: `native/host/frtk_field_schema.cpp`
- Create: `native/smoke/frtk_profile_smoke.cpp`
- Create: `native/smoke/frtk_field_schema_smoke.cpp`
- Modify: `native/CMakeLists.txt`

**Interfaces:**
- Produces `ParseProfile(const nlohmann::json&): ProfileValidationResult`.
- Produces `SchemaRegistry::Load(const nlohmann::json&)`, `FindTable`, and `FindField`.
- Produces native `DecodeField`, `EncodeField`, `DecodePackedReference`, and `EncodePackedReference` matching Task 1 exactly.

- [ ] **Step 1: Write native smoke tests before adding host sources**

Cover exact-key enforcement, version 1, schema/build identity equality, three distinct rows, uppercase pattern/mask length equality, bounds, deterministic duplicate rejection, known/unknown relationships, every field encoding, bit preservation, signed limits, packed refs, and unsupported encodings.

- [ ] **Step 2: Configure/build and verify RED**

```powershell
cmake -S native -B native/build-frtk -A x64
cmake --build native/build-frtk --config Release --target cfb27_frtk_profile_smoke cfb27_frtk_field_schema_smoke
```

Expected: compilation fails because the FrTk headers/implementations are absent.

- [ ] **Step 3: Implement exact artifact parsing and field codecs**

Use focused types under `cfb27::frtk`:

```cpp
enum class AuthorityStatus { kDiscoveryOnly, kCommitAdapterRequired, kDirectVerified };
struct RowFingerprint { std::uint32_t row_index; std::vector<std::uint8_t> pattern, mask; };
struct TableProfile { std::string logical_name; std::uint16_t table_id; std::uint32_t unique_id;
  std::uint32_t capacity, record_size; std::vector<RowFingerprint> rows;
  std::vector<RelationshipConstraint> relationships; };
struct ProfileBundle { std::string profile_id, schema_identity, build_identity;
  std::vector<TableProfile> tables; SchemaRegistry schema; };
```

Reject rather than normalize malformed JSON. Keep the core free of process memory and host globals.

- [ ] **Step 4: Run GREEN/full regression and commit**

```powershell
cmake --build native/build-frtk --config Release --target cfb27_frtk_profile_smoke cfb27_frtk_field_schema_smoke
native\build-frtk\Release\cfb27_frtk_profile_smoke.exe
native\build-frtk\Release\cfb27_frtk_field_schema_smoke.exe
npm test
git diff --check
git add -- native/host/frtk_profile.h native/host/frtk_profile.cpp native/host/frtk_field_schema.h native/host/frtk_field_schema.cpp native/smoke/frtk_profile_smoke.cpp native/smoke/frtk_field_schema_smoke.cpp native/CMakeLists.txt
git commit -m "Parse FrTk profiles and field layouts"
```

---

### Task 3: Discover complete table layouts from synthetic allocations

**Files:**
- Create: `native/host/frtk_discovery.h`
- Create: `native/host/frtk_discovery.cpp`
- Create: `native/smoke/frtk_discovery_smoke.cpp`
- Modify: `native/CMakeLists.txt`

**Interfaces:**
- Consumes Task 2 `ProfileBundle` and the existing memory-reader substrate.
- Produces `DiscoverTables(const ProfileBundle&, DiscoveryBackend&): DiscoveryResult`.
- Produces structured table states `resolved`, `missing`, `ambiguous`, `unstable`, `relationship_failed`, and `allocation_invalid`.

- [ ] **Step 1: Write the fake-backend discovery smoke tests**

Implement a fake allocation backend with scan/read counters. Test valid Player/Recruit/Board/Target graph discovery, relocation to a new allocation, duplicated full tables, stale fingerprint copies, truncated capacity, cross-allocation rows, inconsistent row spacing, stride different from record size, changed reread bytes, broken packed refs, and 5841 overflow references.

Require one scan operation per distinct row fingerprint and batch rereads after candidate derivation. No test may supply a preselected address.

- [ ] **Step 2: Build and verify RED**

Expected: compilation failure for missing `frtk_discovery.h`.

- [ ] **Step 3: Implement the injectable discovery engine**

```cpp
class DiscoveryBackend {
 public:
  virtual ~DiscoveryBackend() = default;
  virtual ScanObservationResult Scan(const RowFingerprint&, std::size_t max_matches) = 0;
  virtual bool ReadBatch(std::span<const ReadRequest>, std::vector<std::vector<std::uint8_t>>& out) = 0;
  virtual bool AllocationExists(std::uintptr_t base, std::size_t size) = 0;
};
DiscoveryResult DiscoverTables(const ProfileBundle&, DiscoveryBackend&);
```

For every combination of three row matches, require each address delta to divide by its signed row delta, all resulting strides to agree, stride to equal `record_size`, base subtraction not to underflow, and `base + capacity * stride` not to overflow or escape one allocation. Reread all fingerprint ranges, apply masks, then validate relationships only after every participating table is independently resolved. Preserve evidence/rejection codes but no raw bytes.

- [ ] **Step 4: Run GREEN, regressions, and commit**

```powershell
cmake --build native/build-frtk --config Release --target cfb27_frtk_discovery_smoke cfb27_memory_reader_smoke
native\build-frtk\Release\cfb27_frtk_discovery_smoke.exe
native\build-frtk\Release\cfb27_memory_reader_smoke.exe
git diff --check
git add -- native/host/frtk_discovery.h native/host/frtk_discovery.cpp native/smoke/frtk_discovery_smoke.cpp native/CMakeLists.txt
git commit -m "Discover FrTk table layouts"
```

---

### Task 4: Add lifecycle-safe catalog and typed record access

**Files:**
- Create: `native/host/frtk_catalog.h`
- Create: `native/host/frtk_catalog.cpp`
- Create: `native/host/frtk_record_access.h`
- Create: `native/host/frtk_record_access.cpp`
- Create: `native/smoke/frtk_catalog_smoke.cpp`
- Create: `native/smoke/frtk_record_access_smoke.cpp`
- Modify: `native/CMakeLists.txt`

**Interfaces:**
- Produces `SessionCatalog::Install`, `GetHandle`, `Resolve`, `Invalidate`, `AdvanceLifecycle`, and `Revalidate`.
- Produces `RecordAccessor::ReadFields(handle, row, fields)`.
- Produces `RecordAccessor::PlanFieldWrites(handle, row, changes)` returning existing `memory::TransactionOperation` objects only for `direct_verified` tables.

- [ ] **Step 1: Write catalog lifecycle RED tests**

Assert install advances generation, handles resolve only in their generation, public lookup uses Unique ID, current-build table ID remains internal, explicit invalidation stales every handle, `game_ready:false` invalidation is idempotent, allocation loss/sentinel mismatch quarantines the table, and relationship failure quarantines dependent descriptors. Catalog summaries must omit base/allocation addresses.

- [ ] **Step 2: Write record-access RED tests**

Using a fake catalog/backend, assert full-table field definitions load in one operation, rows are bounds checked, unknown/unsupported fields fail closed, packed-reference target rows are checked, bitfield writes preserve adjacent bits, changes collapse into minimal contiguous byte runs, and `discovery_only`/`commit_adapter_required` produce `AUTHORITY_UNPROVEN` before transaction planning.

- [ ] **Step 3: Build and verify RED**

Expected: missing catalog/access modules.

- [ ] **Step 4: Implement generation-scoped descriptors and record access**

```cpp
struct TableHandle { std::uint32_t unique_id; std::uint64_t generation; };
struct TableDescriptor { std::uint32_t unique_id; std::uint16_t session_table_id; std::uintptr_t base_address;
  std::uint32_t stride, capacity; std::uintptr_t allocation_base; std::size_t allocation_size;
  std::string profile_id; std::uint64_t lifecycle_generation; Evidence evidence; };
```

Resolve addresses only after validating handle generation and checked `row * stride`. Read the full record once, decode all requested fields from the same snapshot, and never accept a caller-provided address. Revalidation batches sentinels and relationships before allowing the next operation.

- [ ] **Step 5: Run GREEN and commit**

```powershell
cmake --build native/build-frtk --config Release --target cfb27_frtk_catalog_smoke cfb27_frtk_record_access_smoke
native\build-frtk\Release\cfb27_frtk_catalog_smoke.exe
native\build-frtk\Release\cfb27_frtk_record_access_smoke.exe
git diff --check
git add -- native/host/frtk_catalog.h native/host/frtk_catalog.cpp native/host/frtk_record_access.h native/host/frtk_record_access.cpp native/smoke/frtk_catalog_smoke.cpp native/smoke/frtk_record_access_smoke.cpp native/CMakeLists.txt
git commit -m "Add lifecycle-safe FrTk catalog"
```

---

### Task 5: Expose typed FrTk host protocol commands

**Files:**
- Modify: `native/host/lua_host.cpp`
- Modify: `native/CMakeLists.txt`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `native/smoke/startup_host_smoke.cpp`
- Modify: `docs/protocol.md`
- Modify: `docs/safety.md`

**Interfaces:**
- Produces capabilities `frtkProfileV1`, `frtkCatalogV1`, `frtkRecordReadV1`, and `frtkFieldTransactionV1`.
- Produces commands `loadFrtkProfile`, `discoverFrtkCatalog`, `inspectFrtkCatalog`, `readFrtkRecords`, `transactFrtkFields`, and `invalidateFrtkCatalog`.

- [ ] **Step 1: Add failing named-pipe protocol cases**

Cover exact request keys, wrong identity, unsupported build, missing profile, synthetic successful discovery, ambiguous discovery, sanitized inspection, typed multi-record/multi-field read, stale generation, explicit invalidation, authority-unproven transaction, and `game_ready:false` invalidation. Assert no typed response key matches `/address|hex|bytes|mask|offset|range|operation/i`.

- [ ] **Step 2: Run protocol smoke and verify RED**

Expected: unknown-command failure for `loadFrtkProfile`.

- [ ] **Step 3: Wire the native core into the host**

Keep parsing/dispatch in `lua_host.cpp` and all catalog logic in the new focused modules. Load profile and layout together. `discoverFrtkCatalog` always advances generation and replaces the previous catalog atomically only when all required tables resolve. `invalidateFrtkCatalog` requires a bounded public reason enum: `caller_transition`, `save_changed`, or `shutdown`.

`transactFrtkFields` accepts logical table/row/field/value objects, resolves and rereads through the catalog, plans guarded operations, and calls `RunTransaction`; it never accepts raw addresses or bytes. Preserve rollback lockdown.

- [ ] **Step 4: Run GREEN/full native regression and commit**

```powershell
cmake --build native/build-frtk --config Release
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try { native\build-frtk\Release\cfb27_protocol_smoke.exe native\build-frtk\Release\cfb27_lua_host.dll } finally { Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue }
native\build-frtk\Release\cfb27_startup_smoke.exe native\build-frtk\Release\cfb27_lua_host.dll
git diff --check
git add -- native/host/lua_host.cpp native/CMakeLists.txt native/smoke/protocol_smoke.cpp native/smoke/startup_host_smoke.cpp docs/protocol.md docs/safety.md
git commit -m "Expose typed FrTk host protocol"
```

---

### Task 6: Add strict SDK and CLI catalog clients

**Files:**
- Modify: `packages/sdk/src/client.cjs`
- Modify: `packages/sdk/src/errors.cjs`
- Modify: `packages/sdk/test/client.test.cjs`
- Modify: `packages/cli/src/args.cjs`
- Modify: `packages/cli/src/main.cjs`
- Modify: `packages/cli/src/output.cjs`
- Modify: `packages/cli/test/main.test.cjs`
- Modify: `docs/cli.md`
- Create: `docs/frtk-table-api.md`

**Interfaces:**
- Produces SDK methods `loadFrtkProfile`, `discoverFrtkCatalog`, `inspectFrtkCatalog`, `readFrtkRecords`, `transactFrtkFields`, and `invalidateFrtkCatalog`.
- Produces CLI groups `frtk profile`, `frtk catalog`, and `frtk records`.

- [ ] **Step 1: Write failing SDK tests**

Require capability negotiation before each operation family, clone-before-I/O, exact keys, bounded table names/IDs/rows/field lists, typed values, exact sanitized response shapes, stale-generation errors, hostile extra host properties, and local authority rejection. Assert raw profile files are read only by `loadFrtkProfileFromFile` and never included in logs/errors.

- [ ] **Step 2: Run SDK RED, implement, and verify GREEN**

```powershell
node --test packages/sdk/test/client.test.cjs
```

Add stable public codes `FRTK_PROFILE_INVALID`, `FRTK_DISCOVERY_FAILED`, `FRTK_CATALOG_STALE`, `FRTK_FIELD_INVALID`, and `FRTK_AUTHORITY_UNPROVEN`. Keep raw memory methods backward compatible and separate.

- [ ] **Step 3: Write failing CLI tests**

Test:

```text
cfb27lua frtk profile validate .frtk/profile.json
cfb27lua frtk catalog discover .frtk/profile.json
cfb27lua frtk catalog inspect
cfb27lua frtk records read Recruit --row 7 --field CommitScore --field RecruitStage
```

Refuse profile paths outside `.frtk/` unless the existing explicit external-file override is supplied. Human and JSON typed output must omit addresses, raw bytes, patterns, masks, and transaction operations.

- [ ] **Step 4: Implement CLI, run full Node verification, and commit**

```powershell
npm run check
npm test
git diff --check
git add -- packages/sdk/src/client.cjs packages/sdk/src/errors.cjs packages/sdk/test/client.test.cjs packages/cli/src/args.cjs packages/cli/src/main.cjs packages/cli/src/output.cjs packages/cli/test/main.test.cjs docs/cli.md docs/frtk-table-api.md
git commit -m "Add FrTk SDK and CLI clients"
```

---

### Task 7: Add the generic Lua database API

**Files:**
- Create: `native/host/frtk_lua_api.h`
- Create: `native/host/frtk_lua_api.cpp`
- Create: `native/smoke/frtk_lua_api_smoke.cpp`
- Modify: `native/host/lua_host.cpp`
- Modify: `native/CMakeLists.txt`
- Modify: `docs/lua-api.md`

**Interfaces:**
- Produces `CFB27.db:GetTableByUniqueId(uniqueId)`, `table:GetRecord(row)`, `record:GetField(name)`, and `CFB27.db:Transaction(callback)`.
- Produces transaction method `tx:SetField(record, fieldName, value)` but refuses non-`direct_verified` tables.

- [ ] **Step 1: Write failing embedded-Lua smoke cases**

With a synthetic installed catalog, assert table lookup only by Unique ID, rejection of name/table-ID selectors, record and field reads, full-table field availability from one layout load, stale userdata after invalidation, row/field/type errors, forbidden raw-address access, successful synthetic `direct_verified` transaction, and recruiting `discovery_only` rejection.

- [ ] **Step 2: Build and verify RED**

Expected: missing `CFB27.db` global/module.

- [ ] **Step 3: Implement catalog-backed userdata**

Store only `TableHandle`, row, and generation in Lua userdata. Resolve through `SessionCatalog` on every operation. The transaction callback records typed changes, rejects nested transactions and duplicate field changes, rereads complete records, then submits one guarded transaction. Do not implement Lua wrappers around `read_u8`, `write_u8`, or `aob_scan`.

- [ ] **Step 4: Run GREEN/full regression and commit**

```powershell
cmake --build native/build-frtk --config Release --target cfb27_frtk_lua_api_smoke cfb27_lua_host
native\build-frtk\Release\cfb27_frtk_lua_api_smoke.exe native\build-frtk\Release\cfb27_lua_host.dll
npm run check
npm test
git diff --check
git add -- native/host/frtk_lua_api.h native/host/frtk_lua_api.cpp native/smoke/frtk_lua_api_smoke.cpp native/host/lua_host.cpp native/CMakeLists.txt docs/lua-api.md
git commit -m "Add generic FrTk Lua database API"
```

---

### Task 8: Complete whole-branch review and discovery-only live gate

**Files:**
- Modify only after successful evidence: `docs/research/runtime-verification.md`
- Modify: `.github/workflows/windows-ci.yml`
- Modify: `docs/development/building.md`

**Interfaces:**
- Produces a reviewed candidate and sanitized evidence that Player, Recruit, RecruitingBoard, and RecruitTarget-family tables can be cataloged together.

- [ ] **Step 1: Add every new smoke to CI and local build documentation**

Require CI to run profile, field-schema, discovery, catalog, record-access, protocol, and Lua API smokes. Run the same list locally.

- [ ] **Step 2: Complete independent whole-branch review**

Generate a merge-base-to-head review package. Dispatch a fresh reviewer who did not implement any task. Fix and re-review all Critical/Important findings. Do not install a candidate before approval.

- [ ] **Step 3: Run the complete closed-app automated gate**

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-frtk-final -A x64
cmake --build native/build-frtk-final --config Release
Get-ChildItem native\build-frtk-final\Release\cfb27_*_smoke.exe | ForEach-Object {
  if ($_.Name -notin @('cfb27_protocol_smoke.exe','cfb27_startup_smoke.exe','cfb27_frtk_lua_api_smoke.exe')) { & $_.FullName }
}
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try { native\build-frtk-final\Release\cfb27_protocol_smoke.exe native\build-frtk-final\Release\cfb27_lua_host.dll } finally { Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue }
npm run pack:preview
git diff --check
```

Expected: every build/test/smoke exits zero; preview packaging contains no `.frtk`, profile, schema, save, address, or dump artifact.

- [ ] **Step 4: Stop at the explicit installation/relaunch checkpoint**

Tell the user CFB27 and MMC must remain closed. Confirm both processes are absent, install only the reviewed candidate through the supported CLI workflow, and verify installed hashes. Then explicitly tell the user to launch MMC and CFB27 offline, open the correct Dynasty, and stop at the Dynasty Hub.

- [ ] **Step 5: Build one bulk local profile and run discovery-only validation**

Use the local schema-aware save seam to export one normalized snapshot into ignored `.frtk/`; compile all targeted tables and fields at once. Do not ask the user to inspect individual values. Load the profile, discover the catalog, and batch-read typed control fields and packed-reference relationships for Player 4244, Recruit 4269, RecruitingBoard 4251, RecruitTarget 4288, UserRecruitTarget 4168, arrays 5842/5847, and target-school stores 5840/5841.

Commit only counts, table IDs, strides, relationship pass/fail results, profile/schema/build hashes, and rejection codes—never paths, addresses, patterns, masks, bytes, or player likeness data.

- [ ] **Step 6: Explicit transition/relaunch validation**

Tell the user to navigate to Recruiting and back to the Dynasty Hub. Explicitly invalidate the catalog with `caller_transition`, rediscover in bulk, and require new generation handles with the same graph relationships. If a relaunch is required, tell the user before it occurs. Do not perform any recruiting write in this task.

- [ ] **Step 7: Explicit close/restore checkpoint and evidence commit**

Tell the user CFB27 and MMC must be closed. Confirm both processes are absent, uninstall/restore through the supported workflow, verify original proxy hashes, add sanitized discovery evidence, and commit:

```powershell
git add -- .github/workflows/windows-ci.yml docs/development/building.md docs/research/runtime-verification.md
git commit -m "Verify live FrTk catalog discovery"
```

Do not claim recruiting writing is enabled. The next milestone is one reversible authority probe using the catalog; it requires a separately reviewed live-write gate and explicit user approval.
