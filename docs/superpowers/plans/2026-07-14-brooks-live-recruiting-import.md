# Brooks Live Recruiting Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small typed SDK service for Brooks-verified, existing-row live recruiting reads and writes without allocation or another in-game test session.

**Architecture:** Reuse the existing FrTk catalog, typed record reader, and guarded field transaction API. Promote only the four verified recruiting table mirrors at runtime, then expose decoded contact, NIL, pitch, visit, and board-hour operations through one CommonJS service; the caller continues resolving row numbers from its loaded save.

**Tech Stack:** Node.js 20 CommonJS, `node:test`, C++20, CMake/Visual Studio 2022, existing FrTk protocol v1.

## Global Constraints

- Pin imported evidence to Brooks commit `b2b5a7ce4216c5838f1dbd2fb5a76dba6d67e7fe` and layout version `1.2.0`.
- Do not commit a PID, process address, save path, player name, raw memory dump, fingerprint pattern, or mask from Brooks's repository.
- Keep profile files `discovery_only`; runtime discovery alone may promote exact verified table identities to `direct_verified`.
- Support existing rows only. Do not allocate, free, add, remove, or modify any FrTk freelist.
- Exclude `SendTheHouse`, scholarships, scouting, board membership, pitch-intensity changes, and pitch/visit creation or removal.
- Use RecruitingBoard Unique ID `220276943` for hours; never use the stale board-array mirror.
- A contact toggle and its assigned-hours delta must be one `transactFrtkFields` call.
- Run automated offline tests only. Do not launch CFB27, MMC, an installed host, an advance, or an autosave test.

---

### Task 1: Promote only the verified live recruiting mirrors

**Files:**

- Modify: `native/host/frtk_discovery.cpp`
- Modify: `native/smoke/frtk_discovery_smoke.cpp`

**Interfaces:**

- Consumes: resolved `TableProfile { table_id, unique_id, record_size }` from existing descriptor discovery.
- Produces: `TableDescriptor::direct_write_verified = true` only for the exact table triples listed below.

- [ ] **Step 1: Add a failing authority smoke test**

Add a fixture helper and test that run each table through the existing word-swapped descriptor discovery path:

```cpp
TableProfile EvidenceTable(std::string name, std::uint16_t table_id,
                           std::uint32_t unique_id,
                           std::uint32_t record_size) {
  auto table = Table(std::move(name), table_id, 10);
  table.unique_id = unique_id;
  table.record_size = record_size;
  for (auto& row : table.rows) {
    row.pattern.resize(record_size, static_cast<std::uint8_t>(row.row_index));
    row.mask.assign(record_size, 0xFF);
  }
  return table;
}

void TestEvidenceBackedDirectWriteAuthority() {
  const std::array verified{
      std::tuple{"Recruit", 4269u, 1873209313u, 24u},
      std::tuple{"ProspectTargetSchool", 5840u, 3789266353u, 4u},
      std::tuple{"UserRecruitTarget", 4168u, 3987156317u, 36u},
      std::tuple{"ActiveVisitInfo", 4176u, 3093586546u, 4u},
      std::tuple{"ActiveRecruitingPitch", 4190u, 1559900276u, 4u},
      std::tuple{"RecruitingBoard", 4251u, 220276943u, 12u},
  };
  for (const auto& [name, table_id, unique_id, record_size] : verified) {
    ProfileBundle bundle;
    bundle.tables = {EvidenceTable(name, table_id, unique_id, record_size)};
    LoadSchema(bundle);
    FakeBackend backend;
    InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                               48, 16);
    const auto result = DiscoverTables(bundle, backend);
    Require(State(result, unique_id).descriptor->direct_write_verified,
            "verified table did not receive direct authority");
  }

  ProfileBundle mismatch;
  mismatch.tables = {EvidenceTable("UserRecruitTarget", 4168, 3987156317, 35)};
  LoadSchema(mismatch);
  FakeBackend backend;
  InstallLiveDescriptorTable(mismatch.tables[0], backend, 0x700000, 0x800000,
                             48, 16);
  const auto result = DiscoverTables(mismatch, backend);
  Require(!State(result, 3987156317).descriptor->direct_write_verified,
          "wrong record size received direct authority");
}
```

Call `TestEvidenceBackedDirectWriteAuthority()` from `main()`.

- [ ] **Step 2: Build and run the test to verify it fails**

Run:

```powershell
cmake --build native/build-frtk --config Release --target cfb27_frtk_discovery_smoke
native/build-frtk/Release/cfb27_frtk_discovery_smoke.exe
```

Expected: build succeeds and the executable fails with `verified table did not receive direct authority` for the first new recruiting table.

- [ ] **Step 3: Replace the two-ID check with an exact evidence allowlist**

In `frtk_discovery.cpp`, replace the standalone Recruit and ProspectTargetSchool constants with:

```cpp
struct DirectWriteEvidence {
  std::uint16_t table_id;
  std::uint32_t unique_id;
  std::uint32_t record_size;
};

constexpr std::array kDirectWriteEvidence{
    DirectWriteEvidence{4269, 1873209313u, 24},
    DirectWriteEvidence{5840, 3789266353u, 4},
    DirectWriteEvidence{4168, 3987156317u, 36},
    DirectWriteEvidence{4176, 3093586546u, 4},
    DirectWriteEvidence{4190, 1559900276u, 4},
    DirectWriteEvidence{4251, 220276943u, 12},
};

bool HasDirectWriteEvidence(const TableProfile& table) {
  return std::ranges::any_of(kDirectWriteEvidence, [&](const auto& evidence) {
    return table.table_id == evidence.table_id &&
           table.unique_id == evidence.unique_id &&
           table.record_size == evidence.record_size;
  });
}
```

Set the descriptor member with `HasDirectWriteEvidence(table)`. Do not change file-profile authority parsing or the protocol.

- [ ] **Step 4: Re-run the focused native smoke**

Run the two commands from Step 2.

Expected: `frtk discovery smoke passed`.

- [ ] **Step 5: Commit the authority change**

```powershell
git add -- native/host/frtk_discovery.cpp native/smoke/frtk_discovery_smoke.cpp
git commit -m "feat: verify live recruiting table authority"
```

---

### Task 2: Add the sanitized layout and typed recruiting service

**Files:**

- Create: `packages/sdk/src/live-recruiting-layout.cjs`
- Create: `packages/sdk/src/live-recruiting.cjs`
- Create: `packages/sdk/test/live-recruiting.test.cjs`
- Modify: `packages/sdk/src/errors.cjs`
- Modify: `packages/sdk/index.cjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `client.inspectFrtkCatalog`, `client.readFrtkRecords`, `client.transactFrtkFields`, and a current positive catalog generation.
- Produces: `LIVE_RECRUITING_EVIDENCE`, `LIVE_RECRUITING_TABLES`, `CONTACT_ACTIONS`, and async `createLiveRecruitingService({ client, generation })`.
- The resolved service produces `readState`, `setContactAction`, `setNilOffer`, `rewritePitch`, and `rewriteVisit` methods.

- [ ] **Step 1: Write failing layout and service tests**

Build a fake client that records reads and transactions. Cover these exact cases:

```js
test('exports only sanitized verified table metadata', () => {
  assert.equal(LIVE_RECRUITING_EVIDENCE.upstreamCommit,
    'b2b5a7ce4216c5838f1dbd2fb5a76dba6d67e7fe');
  assert.deepEqual(Object.values(LIVE_RECRUITING_TABLES).map((t) => t.uniqueId),
    [3987156317, 3093586546, 1559900276, 220276943]);
  assert.doesNotMatch(JSON.stringify(LIVE_RECRUITING_TABLES),
    /address|patternHex|maskHex|recordHex|pid|savePath/i);
});

test('requires all four tables to have direct_verified authority', async () => {
  const client = fakeTypedClient({ authorityOverride: 'discovery_only' });
  await assert.rejects(createLiveRecruitingService({ client, generation: 7 }),
    (error) => error.code === 'FRTK_AUTHORITY_UNPROVEN');
});

test('reads decoded target, board, pitch, and visit state', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  const state = await service.readState({ targetRow: 12, boardRow: 33,
    pitchRow: 4, visitRow: 2 });
  assert.deepEqual(state.board, {
    row: 33, total: 550, processed: 15, assigned: 85, available: 465,
  });
  assert.deepEqual(state.contacts, {
    'dm-player': true, 'browse-social-media': false, 'friends-family': true,
  });
  assert.deepEqual(state.pitch, { row: 4, pitch: 3, intensity: 0 });
  assert.deepEqual(state.visit,
    { row: 2, weekNumber: 1, weekType: 1, activity: 3 });
});

test('toggles a contact and assigned hours in one transaction', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  await service.setContactAction({ transactionId: 'recruiting.dm.1',
    targetRow: 12, boardRow: 33, action: 'browse-social-media', enabled: true });
  assert.deepEqual(client.transactions[0].changes, [
    { uniqueId: 3987156317, row: 12, field: 'SearchSocialMedia', value: 1 },
    { uniqueId: 220276943, row: 33, field: 'RecruitingHoursAssigned', value: 90 },
  ]);
});

test('fails closed on insufficient hours and does not transact', async () => {
  const client = fakeTypedClient({ board: { total: 100, processed: 10, assigned: 95 } });
  const service = await createLiveRecruitingService({ client, generation: 7 });
  await assert.rejects(service.setContactAction({ transactionId: 'recruiting.dm.2',
    targetRow: 12, boardRow: 33, action: 'dm-player', enabled: true }),
  (error) => error.code === 'RECRUITING_HOURS_INSUFFICIENT');
  assert.equal(client.transactions.length, 0);
});

test('dry runs and no-op writes never send a transaction', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  const preview = await service.setNilOffer({ transactionId: 'recruiting.nil.1',
    targetRow: 12, amount: 200, dryRun: true });
  assert.equal(preview.status, 'dry_run');
  await service.setContactAction({ transactionId: 'recruiting.dm.3',
    targetRow: 12, boardRow: 33, action: 'dm-player', enabled: true });
  assert.equal(client.transactions.length, 0);
});

test('rewrites only an existing pitch enum and an existing visit row', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  await service.rewritePitch({ transactionId: 'recruiting.pitch.1', pitchRow: 4, pitch: 4 });
  await service.rewriteVisit({ transactionId: 'recruiting.visit.1', visitRow: 2,
    weekNumber: 2, weekType: 1, activity: 6 });
  assert.deepEqual(client.transactions[0].changes,
    [{ uniqueId: 1559900276, row: 4, field: 'Pitch', value: 4 }]);
  assert.deepEqual(client.transactions[1].changes, [
    { uniqueId: 3093586546, row: 2, field: 'WeekNumber', value: 2 },
    { uniqueId: 3093586546, row: 2, field: 'Activity', value: 6 },
  ]);
});
```

The fake responses must use the real typed shape: `{ generation, records: [{ uniqueId, row, values: [{ field, value }] }] }`. Also assert NIL accepts `0..1023`, pitch accepts `0..19`, week accepts `0..31`, week type accepts `0..6`, activity accepts `0..13`, and unsupported actions return `RECRUITING_ACTION_UNSUPPORTED`.

- [ ] **Step 2: Run the SDK test to verify it fails**

```powershell
node --test packages/sdk/test/live-recruiting.test.cjs
```

Expected: FAIL because `../src/live-recruiting.cjs` does not exist.

- [ ] **Step 3: Add the sanitized layout constants**

`live-recruiting-layout.cjs` must define the four exact identities and only the fields needed by this slice. Use the existing FrTk field-definition shape:

```js
'use strict';

const LIVE_RECRUITING_EVIDENCE = Object.freeze({
  upstreamCommit: 'b2b5a7ce4216c5838f1dbd2fb5a76dba6d67e7fe',
  layoutVersion: '1.2.0',
});

const LIVE_RECRUITING_TABLES = Object.freeze({
  userTarget: Object.freeze({ logicalName: 'UserRecruitTarget', tableId: 4168,
    uniqueId: 3987156317, capacity: 1120, recordSize: 36,
    fields: Object.freeze([
      { name: 'CurrentNILOffer', encoding: 'bitfield', byteOffset: 30,
        storageBytes: 2, bitOffset: 6, bitWidth: 10, minimum: 0, maximum: 1023,
        referenceTableId: null },
      { name: 'ContactFriendsAndFamily', encoding: 'bitfield', byteOffset: 34,
        storageBytes: 1, bitOffset: 4, bitWidth: 1, minimum: 0, maximum: 1,
        referenceTableId: null },
      { name: 'ContactHighSchoolCoaches', encoding: 'bitfield', byteOffset: 34,
        storageBytes: 1, bitOffset: 5, bitWidth: 1, minimum: 0, maximum: 1,
        referenceTableId: null },
      { name: 'SearchSocialMedia', encoding: 'bitfield', byteOffset: 34,
        storageBytes: 1, bitOffset: 6, bitWidth: 1, minimum: 0, maximum: 1,
        referenceTableId: null },
    ]) }),
  visit: Object.freeze({ logicalName: 'ActiveVisitInfo', tableId: 4176,
    uniqueId: 3093586546, capacity: 4830, recordSize: 4,
    fields: Object.freeze([
      { name: 'Activity', encoding: 'bitfield', byteOffset: 0, storageBytes: 3,
        bitOffset: 0, bitWidth: 23, minimum: 0, maximum: 15, referenceTableId: null },
      { name: 'WeekType', encoding: 'bitfield', byteOffset: 2, storageBytes: 2,
        bitOffset: 7, bitWidth: 4, minimum: 0, maximum: 8, referenceTableId: null },
      { name: 'WeekNumber', encoding: 'bitfield', byteOffset: 3, storageBytes: 1,
        bitOffset: 3, bitWidth: 5, minimum: 0, maximum: 31, referenceTableId: null },
    ]) }),
  pitch: Object.freeze({ logicalName: 'ActiveRecruitingPitch', tableId: 4190,
    uniqueId: 1559900276, capacity: 9380, recordSize: 4,
    fields: Object.freeze([
      { name: 'Intensity', encoding: 'bitfield', byteOffset: 0, storageBytes: 4,
        bitOffset: 0, bitWidth: 27, minimum: 0, maximum: 4, referenceTableId: null },
      { name: 'Pitch', encoding: 'bitfield', byteOffset: 3, storageBytes: 1,
        bitOffset: 3, bitWidth: 5, minimum: 0, maximum: 22, referenceTableId: null },
    ]) }),
  board: Object.freeze({ logicalName: 'RecruitingBoard', tableId: 4251,
    uniqueId: 220276943, capacity: 138, recordSize: 12,
    fields: Object.freeze([
      { name: 'RecruitingHoursProcessed', encoding: 'bitfield', byteOffset: 4,
        storageBytes: 3, bitOffset: 0, bitWidth: 20, minimum: 0, maximum: 4095,
        referenceTableId: null },
      { name: 'RecruitingHoursTotal', encoding: 'bitfield', byteOffset: 6,
        storageBytes: 2, bitOffset: 4, bitWidth: 12, minimum: 0, maximum: 4095,
        referenceTableId: null },
      { name: 'RecruitingHoursAssigned', encoding: 'unsigned', byteOffset: 8,
        storageBytes: 4, bitOffset: 0, bitWidth: 32, minimum: 0, maximum: 4095,
        referenceTableId: null },
    ]) }),
});

module.exports = { LIVE_RECRUITING_EVIDENCE, LIVE_RECRUITING_TABLES };
```

- [ ] **Step 4: Implement the service with strict decoded validation**

Use these public action definitions and exact method signatures:

```js
const CONTACT_ACTIONS = Object.freeze({
  'dm-player': Object.freeze({ field: 'ContactHighSchoolCoaches', hours: 10 }),
  'browse-social-media': Object.freeze({ field: 'SearchSocialMedia', hours: 5 }),
  'friends-family': Object.freeze({ field: 'ContactFriendsAndFamily', hours: 25 }),
});

async function createLiveRecruitingService({ client, generation }) {
  const catalog = await client.inspectFrtkCatalog({ generation });
  for (const table of Object.values(LIVE_RECRUITING_TABLES)) {
    const found = catalog.tables.find((candidate) => candidate.uniqueId === table.uniqueId);
    if (!found || found.authorityStatus !== 'direct_verified') {
      throw new Cfb27HookError('FRTK_AUTHORITY_UNPROVEN',
        'Live recruiting table authority is unproven');
    }
  }
  return Object.freeze({
    readState,
    setContactAction,
    setNilOffer,
    rewritePitch,
    rewriteVisit,
  });
}
```

Implementation rules:

- Convert ordered typed values with `Object.fromEntries(record.values.map(({ field, value }) => [field, value]))` and reject duplicate/missing/unexpected fields as `INVALID_RESPONSE`.
- `readState({ targetRow, boardRow, pitchRow, visitRow })` performs one read request. `pitchRow` and `visitRow` are optional; the other rows are required.
- Return `available = total - assigned`. `processed` is informational because immediate actions are already included in assigned hours.
- `setContactAction(...)` rereads target plus board, returns `unchanged` without a transaction when the bool already matches, and otherwise writes the bool plus the new assigned total in one transaction.
- On enable, reject `assigned + hours > total` with `RECRUITING_HOURS_INSUFFICIENT`. On disable, reject a negative assigned total as `INVALID_RESPONSE`.
- `setNilOffer(...)` rereads `CurrentNILOffer` and changes only that field.
- `rewritePitch(...)` rereads `Pitch` and `Intensity`, changes only `Pitch`, and returns the preserved intensity. It never accepts a new intensity.
- `rewriteVisit(...)` rereads all three visit fields, puts every differing value in one transaction, and returns `unchanged` when none differ.
- Every mutation accepts optional `dryRun: true`. A dry run returns `{ status: 'dry_run', changedFields, ...decodedSummary }` and never returns the internal `changes` array.
- Applied results return only `{ transactionId, status, changedFields, ...decodedSummary }`.
- Add `RECRUITING_ACTION_UNSUPPORTED` and `RECRUITING_HOURS_INSUFFICIENT` to `ERROR_CODES`; all other invalid public arguments use `INVALID_REQUEST` or `FRTK_FIELD_INVALID`.

Export the constants and factory from `packages/sdk/index.cjs`, and add both new source files to the root `npm run check` command.

- [ ] **Step 5: Run focused and full SDK verification**

```powershell
node --test packages/sdk/test/live-recruiting.test.cjs
npm run check
npm test
```

Expected: the focused file passes, syntax checks exit 0, and the full Node test suite reports zero failures.

- [ ] **Step 6: Commit the SDK service**

```powershell
git add -- package.json packages/sdk/index.cjs packages/sdk/src/errors.cjs packages/sdk/src/live-recruiting-layout.cjs packages/sdk/src/live-recruiting.cjs packages/sdk/test/live-recruiting.test.cjs
git commit -m "feat: add typed live recruiting service"
```

---

### Task 3: Document the app wiring and run the offline release gate

**Files:**

- Modify: `docs/frtk-table-api.md`
- Modify: `docs/research/runtime-verification.md`

**Interfaces:**

- Consumes: Task 2 exports from `@cfb27/lua-hook`.
- Produces: a copyable app integration example and an evidence/scope record.

- [ ] **Step 1: Add the minimal consumer example**

Add a `Live recruiting service` section to `docs/frtk-table-api.md` containing this flow:

```js
const { createClient, createLiveRecruitingService } = require('@cfb27/lua-hook');

const client = createClient({ pid });
await client.loadFrtkProfile({ profile, layout });
const { generation } = await client.discoverFrtkCatalog();
const recruiting = await createLiveRecruitingService({ client, generation });

const state = await recruiting.readState({
  targetRow: selected.userRecruitTargetRow,
  boardRow: selected.recruitingBoardRow,
  pitchRow: selected.activePitchRow,
  visitRow: selected.activeVisitRow,
});

await recruiting.setContactAction({
  transactionId: `recruiting.dm.${Date.now()}`,
  targetRow: selected.userRecruitTargetRow,
  boardRow: selected.recruitingBoardRow,
  action: 'dm-player',
  enabled: true,
});
```

State plainly that the save-backed app supplies row numbers and profile fingerprints, the hook supplies live discovery/guarded transactions, and this API does not allocate rows.

- [ ] **Step 2: Record the verified scope and exclusions**

In `docs/research/runtime-verification.md`, add a short table with the four Unique IDs, table IDs, record sizes, Brooks commit, and supported operation. Follow it with one sentence excluding allocation/freelists, `SendTheHouse`, scholarships, scouting, board membership, pitch-intensity changes, and all in-game validation for this delivery.

- [ ] **Step 3: Run the complete offline verification gate**

```powershell
npm run check
npm test
cmake --build native/build-frtk --config Release --target cfb27_frtk_discovery_smoke cfb27_frtk_catalog_smoke cfb27_frtk_record_access_smoke
native/build-frtk/Release/cfb27_frtk_discovery_smoke.exe
native/build-frtk/Release/cfb27_frtk_catalog_smoke.exe
native/build-frtk/Release/cfb27_frtk_record_access_smoke.exe
```

Expected: both npm commands exit 0 and each native executable prints its `passed` line. Do not perform an installed-host or game launch after this gate.

- [ ] **Step 4: Scan committed changes for prohibited evidence**

```powershell
git diff --check
git diff --cached --check
rg -n "43372|0x366|0x369|0x384|Orlando|Gerald|DYNASTY-TESTER|savePath|patternHex|maskHex|recordHex" packages/sdk native docs/frtk-table-api.md docs/research/runtime-verification.md
```

Expected: both diff checks are silent. The repository scan may find generic API documentation for `patternHex`/`maskHex`; inspect every hit and confirm no new live address, person, save path, raw fingerprint, or memory dump was added by this work.

- [ ] **Step 5: Commit documentation**

```powershell
git add -- docs/frtk-table-api.md docs/research/runtime-verification.md
git commit -m "docs: explain live recruiting SDK wiring"
```
