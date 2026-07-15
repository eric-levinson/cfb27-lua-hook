# Live Recruit Class Replacement POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one command that runs Brooks's recruit generator against a read-only dynasty save and replaces the existing live recruit class, including names, with automatic verification and rollback.

**Architecture:** A Brooks adapter converts the generator's `planApply` output into bit-masked Player/Recruit record patches plus fixed-slot Player strings. A locator finds the three contiguous live surfaces from save-derived anchors. A replacement service snapshots, applies, verifies, and rolls back guarded raw-memory batches; the CLI wires everything into one command.

**Tech Stack:** Node.js CommonJS, existing `@cfb27/lua-hook` SDK memory APIs, Brooks's CommonJS generator modules, Node test runner.

## Global Constraints

- Never modify or resave the dynasty input.
- Replace existing Recruit and Player rows only; do not allocate rows.
- FirstName, LastName, and HomeTown are mandatory and must preflight before any write.
- Portrait/head writes are best-effort; gear is reported as skipped in the POC.
- Use guarded expected/replacement transactions with no more than 32 operations per host transaction.
- Snapshot all targeted live bytes before the first write and roll back completed batches after any failure.
- No UI, daemon, database, or generalized allocation API.

---

### Task 1: Brooks Generator Adapter

**Files:**
- Create: `packages/sdk/src/live-class-generator.cjs`
- Create: `packages/sdk/test/live-class-generator.test.cjs`
- Modify: `packages/sdk/index.cjs`

**Interfaces:**
- Produces: `generateLiveClassPlan({ savePath, brooksRoot, seed }) -> Promise<LiveClassPlan>`
- `LiveClassPlan` contains `sourceRevision`, `classSize`, `playerRecordSize`, `recruitRecordSize`, `playerRows`, `recruitRows`, and `gearSkipped`.
- Each record row contains `{ row, beforeHex, maskHex, valueHex }`.
- Each player row also contains `strings: { FirstName, LastName, HomeTown, GenericHeadAssetName? }` and a 138-byte `beforeStringSlotHex`.

- [ ] **Step 1: Write the failing adapter tests**

Test injected Brooks dependencies that return two generated recruits. Assert that the adapter:

```js
assert.equal(plan.classSize, 2);
assert.deepEqual(plan.playerRows[0].strings, {
  FirstName: 'Marcus', LastName: 'Hill', HomeTown: 'Austin',
});
assert.equal(plan.playerRows[0].maskHex.length, plan.playerRows[0].beforeHex.length);
assert.equal(plan.recruitRows[0].row, 30);
assert.equal(await hashFile(savePath), originalHash);
```

Also assert rejection for a missing name, an out-of-range row, unequal record lengths, a Brooks planning error, and any before/after save hash difference.

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `node --test packages/sdk/test/live-class-generator.test.cjs`

Expected: failure because `live-class-generator.cjs` does not exist.

- [ ] **Step 3: Implement the adapter**

Implement these exports:

```js
async function generateLiveClassPlan({ savePath, brooksRoot, seed = 'default', dependencies = {} }) {}
function buildMaskedPatch(before, after) {}
function encodePlayerStringSlot(beforeSlot, strings) {}
```

The adapter must:

1. hash the save before work;
2. dynamically load `runPreview`, `loadRecruitPool`, `planApply`, `openCollegeSave`, and `setRecordField` from `brooksRoot`;
3. run preview output inside `fs.mkdtemp()`;
4. call `planApply` and reject all collected errors;
5. clone each source record, apply only fields present in Brooks's write plan, and calculate `maskHex` from bytes changed between the two offline records;
6. read each existing 138-byte Player table2 slot and encode mandatory strings at offsets FirstName `0/17`, LastName `50/21`, and HomeTown `112/26`; optionally encode GenericHeadAssetName at `17/33`;
7. hash the save again and reject if it changed;
8. remove the temporary preview directory in `finally`.

- [ ] **Step 4: Run focused and full SDK tests**

Run: `node --test packages/sdk/test/live-class-generator.test.cjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all repository tests pass.

- [ ] **Step 5: Commit the adapter**

```bash
git add packages/sdk/src/live-class-generator.cjs packages/sdk/test/live-class-generator.test.cjs packages/sdk/index.cjs
git commit -m "feat: adapt Brooks recruit classes for live writes"
```

### Task 2: Save-Derived Live Surface Locator

**Files:**
- Create: `packages/sdk/src/live-class-locator.cjs`
- Create: `packages/sdk/test/live-class-locator.test.cjs`

**Interfaces:**
- Consumes: record/string anchors from `LiveClassPlan`.
- Produces: `locateLiveClassSurfaces({ client, plan }) -> Promise<{ playerBase, recruitBase, playerStringsBase }>`.

- [ ] **Step 1: Write the failing locator tests**

Build a fake address space containing contiguous Player records, Recruit records, and 138-byte Player string slots. Assert:

```js
assert.deepEqual(await locateLiveClassSurfaces({ client, plan }), {
  playerBase: '0x10000000',
  recruitBase: '0x20000000',
  playerStringsBase: '0x30000000',
});
```

Cover relocated bases, more than one initial scan hit with only one cross-row-valid candidate, no candidate, two fully valid candidates, short reads, and a save/live verification mismatch.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `node --test packages/sdk/test/live-class-locator.test.cjs`

Expected: failure because the locator module does not exist.

- [ ] **Step 3: Implement exact-anchor location with cross-row verification**

Implement:

```js
async function locateContiguousSurface(client, {
  rows, recordSize, anchorRow, anchorHex, verificationRows,
}) {}
async function locateLiveClassSurfaces({ client, plan }) {}
```

For each surface, scan one exact save-derived anchor, calculate `base = match - anchorRow * stride`, then read and exactly verify at least four spread-out rows. Require exactly one fully verified base. Player and Recruit strides come from the plan; Player strings always use 138 bytes. Reject all ambiguity rather than guessing between stale mirror copies.

- [ ] **Step 4: Run locator and full tests**

Run: `node --test packages/sdk/test/live-class-locator.test.cjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all repository tests pass.

- [ ] **Step 5: Commit the locator**

```bash
git add packages/sdk/src/live-class-locator.cjs packages/sdk/test/live-class-locator.test.cjs
git commit -m "feat: locate live recruit class surfaces"
```

### Task 3: Guarded Replacement and Rollback

**Files:**
- Create: `packages/sdk/src/live-class-replace.cjs`
- Create: `packages/sdk/test/live-class-replace.test.cjs`
- Modify: `packages/sdk/index.cjs`
- Modify: `packages/sdk/src/errors.cjs`

**Interfaces:**
- Consumes: `LiveClassPlan`, located bases, and an SDK client.
- Produces: `replaceLiveClass({ client, plan, surfaces, generation, dryRun }) -> Promise<LiveClassResult>`.
- `LiveClassResult` contains `status`, `classSize`, `batchesApplied`, `playerRowsWritten`, `recruitRowsWritten`, `nameSlotsWritten`, `optionalSkipped`, and `rollbackStatus`.

- [ ] **Step 1: Write the failing replacement tests**

Assert that preflight reads all rows before the first transaction, combines masks with current live bytes, writes no more than 32 operations per batch, rereads every committed batch, and reports gear as skipped. Inject a failure in batch two and assert that batch one is restored from the snapshot. Inject a rollback failure and assert a stable `LIVE_CLASS_ROLLBACK_FAILED` error.

Core replacement rule:

```js
replacement[i] = (current[i] & ~mask[i]) | (value[i] & mask[i]);
```

- [ ] **Step 2: Run focused tests and confirm red**

Run: `node --test packages/sdk/test/live-class-replace.test.cjs`

Expected: failure because the replacement module does not exist.

- [ ] **Step 3: Implement preflight, batching, verification, and rollback**

Implement:

```js
async function replaceLiveClass({ client, plan, surfaces, generation, dryRun = false }) {}
function applyMask(current, mask, value) {}
function makeOperations(snapshot, plan, surfaces) {}
function chunkOperations(operations, maximum = 32) {}
```

Preflight must read every numeric record and Player string slot, validate row bounds and exact lengths, encode required names, and build an immutable rollback snapshot before any transaction. Each forward batch uses the snapshot bytes as `expectedHex`; each rollback batch uses the forward replacement as `expectedHex`. After every forward or rollback batch, reread and compare the complete written ranges.

- [ ] **Step 4: Run replacement and full tests**

Run: `node --test packages/sdk/test/live-class-replace.test.cjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all repository tests pass.

- [ ] **Step 5: Commit the replacement service**

```bash
git add packages/sdk/src/live-class-replace.cjs packages/sdk/test/live-class-replace.test.cjs packages/sdk/index.cjs packages/sdk/src/errors.cjs
git commit -m "feat: replace live recruit classes with rollback"
```

### Task 4: One-Command CLI and Documentation

**Files:**
- Modify: `packages/cli/src/main.cjs`
- Modify: `packages/cli/test/main.test.cjs`
- Modify: `docs/frtk-table-api.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `cfb27 live-class replace --save <path> --brooks-root <path> [--seed <value>] [--dry-run]`.

- [ ] **Step 1: Write failing CLI tests**

Assert exact parsing, required paths, dry-run propagation, one JSON result under `--json`, refusal of unknown flags, and sanitized errors. Use injected adapter/locator/replacer functions so tests never require a game or real save.

- [ ] **Step 2: Run CLI tests and confirm red**

Run: `node --test packages/cli/test/main.test.cjs`

Expected: the new command assertions fail.

- [ ] **Step 3: Wire the command**

The handler must execute only this sequence:

```js
const plan = await generateLiveClassPlan({ savePath, brooksRoot, seed });
const status = await client.status();
const surfaces = await locateLiveClassSurfaces({ client, plan });
return replaceLiveClass({ client, plan, surfaces, generation: status.generation, dryRun });
```

Document that the save is read-only, names are mandatory, gear is skipped in the POC, ambiguous live mirrors abort, and no in-game operation occurs unless the user invokes the command without `--dry-run`.

- [ ] **Step 4: Run complete verification**

Run: `npm run check`

Expected: exit code 0.

Run: `npm test`

Expected: all tests pass.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Commit the CLI POC**

```bash
git add packages/cli/src/main.cjs packages/cli/test/main.test.cjs docs/frtk-table-api.md package.json
git commit -m "feat: add live recruit class replacement command"
```
