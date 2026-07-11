# Brooks Live Recruiting Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Brooks's recruiting Electron app to `cfb27-lua-hook` v0.2.0-dev.2, locate authoritative live recruiting records, prove relocation and safe timing, and complete one reversible plus one advance/autosave CPU-influence test.

**Architecture:** A read-only profile builder opens the selected save through `openCollegeSave`, resolves an existing active CPU suitor, and produces private record fingerprints and public labels. A main-process-only calibration service uses typed SDK scan/read/transaction methods, never raw renderer calls. Absolute addresses remain in memory for one host session and are invalidated on PID/session/data changes.

**Tech Stack:** Electron 31, CommonJS Node.js 20+, `@cfb27/lua-hook` v0.2.0-dev.2 release tarball, madden-franchise through `franchise-lab/college-franchise.js`, Node test runner.

## Global Constraints

- Implement in `brooksg357-a11y/cfb27-dynasty-modding` from the merged read-only hook integration; use the user's fork for the branch and open an upstream draft PR.
- Never call madden-franchise `file.save()` or `franchise.save()`.
- Never modify the selected save directly; create a byte-identical backup before the first live write proof.
- Use only an existing active CPU suitor. Do not allocate/retarget rows, add schools, change references, stage, score, offer, action, visit, pitch, or commitment state.
- Exact full-record matching is attempted first. Masked fingerprints are allowed only when their bit masks are derived from schema metadata and verified against empirical `_data` mutations.
- A content fingerprint is not “layout agnostic”; failure to match returns `LAYOUT_UNVERIFIED` and performs no write.
- Confirm at least three rows per table before accepting a stride/layout inference.
- Store addresses only in main-process memory and clear them on PID change, host event-cursor regression, game-ready false, failed validation, menu/allocation transition, or weekly change.
- Stable window default: eight identical complete snapshots at 250 ms intervals (two seconds); any changed byte resets the counter.
- The renderer receives no address, bytes, masks, scan requests, memory ranges, transaction operations, logs, Lua source, SDK object, or raw host error.
- Stage explicit paths only; never use `git add -A` or `git add .`.
- Before any host installation, explicitly tell the user to close MMC and CFB27. Explicitly tell the user when to relaunch MMC/game and which Dynasty screen to open.

---

### Task 1: Build private save-derived calibration profiles

**Files (Brooks repo):**
- Create at execution start: `docs/plans/live-recruiting-calibration.md` (copy this plan into Brooks's active-plan location)
- Create: `recruiting-app/src/live-recruiting-profile.cjs`
- Create: `recruiting-app/src/build-live-recruiting-profile.js`
- Create: `recruiting-app/test/live-recruiting-profile.test.cjs`
- Modify: `recruiting-app/package.json`

**Interfaces:**
- Produces `buildLiveRecruitingProfile(savePath, recruitRow): Promise<PrivateCalibrationProfile>`.
- Produces CLI `build-live-recruiting-profile.js SAVE_PATH RECRUIT_ROW .live-profiles/profile.json`.
- Produces `publicSummary(profile)` without raw records or schema metadata.

- [ ] **Step 1: Write pure failing selection and fingerprint tests**

Use fake tables matching madden-franchise's `records[].fieldsArray`, `_fields`, and `_data` shapes. Prove the selector traverses:

```text
Team.RecruitingBoard
  -> RecruitingBoard.Recruits[]
  -> RecruitTarget[] slots
  -> RecruitTarget.Recruit == selected Recruit row
```

and chooses the highest-influence existing CPU suitor. Reject the user team's `UserRecruitTarget` table, empty refs, missing board ownership, zero active CPU suitors, and duplicate ownership.

Test `recordProfile(record, fields)` returns full uppercase `recordHex`, field metadata, decoded expected values, and a field mask. For each masked field, mutate a legal alternate value on a cloned record and assert every changed `_data` bit is covered by the schema-derived mask; restore the original and assert exact bytes.

- [ ] **Step 2: Run and verify RED**

```powershell
cd recruiting-app
node --test test/live-recruiting-profile.test.cjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement ref decoding and active-suitor selection**

Reuse the existing 32-bit reference rule from `build-recruiting-data.js`. Add `RecruitTarget` table ID `4288`. Load `Recruit`, `Player`, `Team`, `RecruitingBoard`, the board target-array table, `RecruitTarget`, `UserRecruitTarget`, `ProspectTargetSchool[]`, and `ProspectTargetSchool` read-only.

The selected target must have a nonempty `RecruitTarget`, `ProspectInfluenceTotal > 0`, and a matching team board. Return team index/name, recruit row, target row, board row, influence, last-week influence, delta, scholarship state, and related refs in the private profile.

- [ ] **Step 4: Implement raw-record profiles and three-row controls**

Read `Buffer.from(record._data)`. Capture metadata from `record._fields[field]._offset` using the archived helper's keys: `type`, `isReference`, `offset`, `indexOffset`, `length`, `minValue`, and `maxValue`.

Profile:

- primary selected `Recruit`;
- two additional nonempty Recruit control rows with distinctive multi-field values;
- selected `RecruitTarget`;
- two additional active target control rows from the same owning board or other known CPU boards;
- the owning `RecruitingBoard` record.

For Recruit use `Player`, `CommitScore`, `RecruitStage`, `NationalRank`, `PositionRank`, and `TopSchoolsList`. For RecruitTarget use `Recruit`, `ProspectInfluenceTotal`, `ProspectInfluenceTotalLastWeek`, `ProspectInfluenceDelta`, and `ScholarshipStatus`. Include exact `recordHex`, schema mask, field values, record size, table ID/unique ID, and save row only in the private profile.

- [ ] **Step 5: Implement the CLI wrapper without writing the save**

The CLI opens with `{useSchema:true}`, writes only the output JSON, and refuses an output path outside `recruiting-app/.live-profiles/`. Add `.live-profiles/` to `recruiting-app/.gitignore`.

- [ ] **Step 6: Verify and commit**

```powershell
node --test test/live-recruiting-profile.test.cjs
npm run check
git add -- recruiting-app/src/live-recruiting-profile.cjs recruiting-app/src/build-live-recruiting-profile.js recruiting-app/test/live-recruiting-profile.test.cjs recruiting-app/package.json recruiting-app/.gitignore
git commit -m "Build live recruiting calibration profiles"
```

---

### Task 2: Implement main-process calibration and relocation

**Files (Brooks repo):**
- Create: `recruiting-app/src/live-recruiting-calibration.cjs`
- Create: `recruiting-app/test/live-recruiting-calibration.test.cjs`
- Modify: `recruiting-app/src/live-hook-service.cjs`
- Modify: `recruiting-app/test/live-hook-service.test.cjs`
- Modify: `recruiting-app/package.json`
- Modify: `recruiting-app/package-lock.json`

**Interfaces:**
- Produces `new LiveRecruitingCalibration({ liveHook, profileBuilder, sampleMs?, stableSamples? })`.
- Produces `calibrate({ savePath, recruitRow }): Promise<PublicCalibrationStatus>`.
- Produces `invalidate(reason): void`, `getPublicStatus()`, and `stop()`.
- Keeps `PrivateCalibrationProfile` and canonical addresses private.

- [ ] **Step 1: Pin v0.2.0-dev.2 and write failing capability tests**

Install the immutable SDK release tarball. Extend fake SDK clients with `scanMemory`, `readMemory`, and `writeTransaction`. Require capabilities `memoryScan`, `memoryRead`, `memoryWriteTransaction`, `status`, and `events`; do not require renderer access to any method.

- [ ] **Step 2: Write failing calibration tests**

Assert exact-record scans run for all six control records. Calibration accepts only one match per record, then batch-reads every complete record and validates record size plus all expected fields. Cover:

- no match -> `LAYOUT_UNVERIFIED`;
- multiple matches -> `AMBIGUOUS_LIVE_RECORD`;
- one field mismatch -> `LIVE_VALIDATION_FAILED`;
- controls that do not produce a constant stride -> `STRIDE_UNVERIFIED`;
- PID/session change during calibration -> `SESSION_CHANGED`;
- success returns only public recruit/team labels, state `ready`, layout/stride booleans, and sample counts.

Assert public objects do not contain keys matching `/address|hex|bytes|mask|offset|range|operation/i`.

- [ ] **Step 3: Implement exact matching before any masked fallback**

Call `scanMemory` with the full `recordHex`, an all-`FF` mask, `maxMatches:2`, and zero context. If every record matches uniquely, batch-read and validate them.

If exact matching fails, try the schema-derived multi-field mask only when `maskVerified === true` from Task 1. A masked hit must pass a full batch-read field decode. If neither method passes, stop with `LAYOUT_UNVERIFIED`; never broaden to a value-only or single-field scan.

- [ ] **Step 4: Confirm stride and packed-ref relationships**

For each table, sort the three `(saveRow,address)` pairs and require `(addressB-addressA)/(rowB-rowA)` to be the same positive integer record size for all pairs. Confirm it equals the record byte length before marking `layoutVerified`.

Use the already confirmed field metadata to check `Recruit.Player` packed refs and `RecruitTarget.Recruit` refs. These relationships classify candidates; they are not used to assume addresses before validation.

- [ ] **Step 5: Add invalidation and reconnect behavior**

`LiveHookService` must expose a main-only connection/session identity `{pid, hostVersion, protocolVersion}` and notify calibration on PID changes, event-cursor regression, disconnected status, or `game_ready:false`. Do not add these details to preload beyond existing sanitized status.

- [ ] **Step 6: Verify and commit**

```powershell
npm test
npm run check
git add -- recruiting-app/package.json recruiting-app/package-lock.json recruiting-app/src/live-hook-service.cjs recruiting-app/src/live-recruiting-calibration.cjs recruiting-app/test/live-hook-service.test.cjs recruiting-app/test/live-recruiting-calibration.test.cjs
git commit -m "Calibrate live recruiting records"
```

---

### Task 3: Add stable-window sampling and a domain-only proof action

**Files (Brooks repo):**
- Create: `recruiting-app/src/live-recruiting-stability.cjs`
- Create: `recruiting-app/test/live-recruiting-stability.test.cjs`
- Modify: `recruiting-app/src/live-recruiting-calibration.cjs`
- Modify: `recruiting-app/test/live-recruiting-calibration.test.cjs`

**Interfaces:**
- Produces `new StabilityWindow({requiredSamples:8})`.
- Produces `observe(snapshotHash): {stable, count, changed}`.
- Produces calibration method `runReversibleInfluenceProof({delta}): Promise<PublicProofResult>`.

- [ ] **Step 1: Write failing stability tests**

Assert eight identical hashes become stable, any change resets count to one, invalidation resets to zero, and no proof can start while disconnected, unsupported, uncalibrated, unstable, already running, or outside delta range `-5..5` excluding zero.

- [ ] **Step 2: Implement complete-snapshot polling**

Every 250 ms, `readMemory` the primary Recruit, primary RecruitTarget, owning RecruitingBoard, and control records in one batch. Hash the complete validated response after decoding all expected fields. Any read/validation failure invalidates calibration instead of incrementing stability.

The initial proof requires eight identical snapshots. The advance observation later treats the first changed snapshot as an advance/allocation transition, invalidates addresses, then relocates and requires a new stable window.

- [ ] **Step 3: Build a single-field guarded transaction privately**

Clone the target record bytes and assign `ProspectInfluenceTotal = current + delta` on an in-memory schema record to derive exact changed bytes. Construct one `writeTransaction` operation per contiguous changed-byte run, using current live bytes as expected bytes. Do not let the renderer select values beyond the bounded delta.

After `applied_verified`, poll until the changed value is observed. Then construct the reverse transaction from freshly read live bytes and restore the original immediately. Return only:

```js
{
  ok: true,
  state: 'restored_verified',
  recruit: 'Public Name',
  team: 'Public Team',
  beforeInfluence: 178,
  testInfluence: 180,
  restoredInfluence: 178,
}
```

- [ ] **Step 4: Test failure and rollback paths**

Cover mismatch-before-write, SDK `rolled_back_verified`, SDK `rollback_unverified`, changed session, changed snapshot, restore failure, and response objects containing forbidden private keys. `rollback_unverified` permanently sets public state `writes_disabled` until restart.

- [ ] **Step 5: Verify and commit**

```powershell
npm test
npm run check
git add -- recruiting-app/src/live-recruiting-stability.cjs recruiting-app/src/live-recruiting-calibration.cjs recruiting-app/test/live-recruiting-stability.test.cjs recruiting-app/test/live-recruiting-calibration.test.cjs
git commit -m "Add guarded recruiting influence proof"
```

---

### Task 4: Expose a minimal user-facing Live Lab workflow

**Files (Brooks repo):**
- Modify: `recruiting-app/electron-main.cjs`
- Modify: `recruiting-app/electron-preload.cjs`
- Modify: `recruiting-app/index.html`
- Modify: `recruiting-app/src/renderer.js`
- Modify: `recruiting-app/src/renderer.css`
- Modify: `recruiting-app/test/live-hook-boundary.test.cjs`
- Create: `recruiting-app/test/live-recruiting-ui.test.cjs`

**Interfaces:**
- IPC `recruiting:live-calibrate` consumes only `{recruitRow}`.
- IPC `recruiting:live-proof` consumes only `{delta}`.
- Preload exposes only `calibrateLiveRecruiting(recruitRow)`, `runLiveInfluenceProof(delta)`, and `onLiveRecruitingUpdate(callback)`.

- [ ] **Step 1: Write failing boundary tests**

Assert preload does not contain `scanMemory`, `readMemory`, `writeTransaction`, addresses, bytes, masks, operations, Lua, logs, SDK, or generic IPC send. Assert main stores the currently loaded save path privately and refuses calibration unless that exact save is still selected.

- [ ] **Step 2: Add main-owned IPC orchestration**

Instantiate one calibration service. On successful save load, record the resolved save path and invalidate any old calibration. On file/folder change, generator failure, disconnect, or shutdown, invalidate/stop. IPC validates integer recruit rows and delta bounds, then calls only domain methods.

- [ ] **Step 3: Add a compact collapsed Live Lab panel**

Place it under the existing Advanced area or selected-recruit detail, collapsed by default. User copy is limited to:

- `Calibrate live recruiting`;
- progress states `Finding record`, `Validating`, `Watching for stability`, `Ready`;
- chosen existing CPU suitor label;
- `Run reversible +2 influence test`;
- result or a stable public error code.

Do not display addresses, rows, masks, record sizes, capabilities, logs, or engineering diagnostics.

- [ ] **Step 4: Verify renderer isolation and commit**

```powershell
npm test
npm run check
git add -- recruiting-app/electron-main.cjs recruiting-app/electron-preload.cjs recruiting-app/index.html recruiting-app/src/renderer.js recruiting-app/src/renderer.css recruiting-app/test/live-hook-boundary.test.cjs recruiting-app/test/live-recruiting-ui.test.cjs
git commit -m "Add live recruiting calibration workflow"
```

---

### Task 5: Run the live calibration, reversible write, and advance/autosave gates

**Files (Brooks repo):**
- Modify: `recruiting-app/SETUP.md`
- Modify: `docs/MAP.md`
- Create: `docs/reports/live-recruiting-calibration-v1.md`
- Move after shipping: `docs/plans/live-recruiting-calibration.md` to `docs/archive/plans/live-recruiting-calibration.md`

**Interfaces:**
- Produces recorded evidence for one verified `Recruit` and one active CPU `RecruitTarget` relationship.

- [ ] **Step 1: Run all automated checks before involving the game**

```powershell
cd recruiting-app
npm ci
npm run check
npm test
cd ..
git diff --check
git status --short
```

Expected: no generated profiles, saves, schemas, assets, `node_modules`, or memory diagnostics are tracked.

- [ ] **Step 2: Stop at the installation/relaunch checkpoint**

**USER RELAUNCH CHECKPOINT:** Tell the user to close CFB27, MMC, and the recruiting Electron app. Confirm all three are closed. Install the v0.2.0-dev.2 host with the supported CLI. Then explicitly tell the user to relaunch MMC, launch CFB27 offline, open the correct Dynasty, stop at the Dynasty hub, and relaunch the recruiting app.

- [ ] **Step 3: Create the safety backup and run read-only calibration**

Copy the selected save beside itself with timestamp and SHA-256 before any write. Load the original save in the app. Choose a recruit with at least one existing active CPU suitor. Run calibration and record:

- exact vs masked discovery method;
- unique candidate counts;
- three-row stride checks for Recruit and RecruitTarget;
- packed-ref validation results;
- relocation after backing out/re-entering relevant menus;
- two-second stability result.

Do not record addresses, raw bytes, player likeness data, or full save paths in the committed report.

- [ ] **Step 4: Run the reversible influence proof**

Tell the user exactly which recruit/team/value is being tested and where to look in game. Apply `+2` or the nearest legal delta, confirm the UI if it exposes the value, restore immediately, and confirm restoration. If the UI does not display the exact influence, verify through typed reread and note that limitation without claiming UI proof.

On any crash, mismatch, unexpected autosave, or rollback issue: stop, preserve logs locally, disable session writes, and do not proceed to the weekly advance.

- [ ] **Step 5: Run one advance/autosave proof**

After a fresh calibration and stable window, apply a second small influence change and leave it for one weekly advance. Tell the user when to advance. Detect changed snapshots, invalidate/relocate, re-establish stability, and read the resulting value. Wait for autosave completion, then parse the newly written save read-only and compare the CPU target/influence relationship with the live result.

The engine may transform the influence during advance; success requires a consistent documented transformation across live state, UI where visible, and autosave—not necessarily preservation of the pre-advance number.

- [ ] **Step 6: Verify reload and recovery**

Tell the user when to return to the Dynasty hub or relaunch the Dynasty if required. Recalibrate after reload and confirm the autosaved state. Finally verify the timestamped backup remains byte-identical to its recorded SHA-256 and can be parsed. Do not overwrite the user's active save with the backup unless the user explicitly requests restoration.

- [ ] **Step 7: Document, archive, and open the draft PR**

Record the supported build hash, hook version, public recruit/team identifiers, proof steps, sanitized outcomes, and all limitations in `docs/reports/live-recruiting-calibration-v1.md`. Update SETUP/MAP. Move the active implementation plan to `docs/archive/plans/` with a SHIPPED banner only after all gates pass.

```powershell
git add -- recruiting-app/SETUP.md docs/MAP.md docs/reports/live-recruiting-calibration-v1.md docs/archive/plans/live-recruiting-calibration.md
git commit -m "Document live recruiting calibration proof"
git push -u origin codex/live-recruiting-calibration
```

Open a draft upstream PR against Brooks's `main`. Link both hook releases and their checksums. Do not start governor policy work until Brooks reviews the domain assumptions and the complete live proof is repeatable.
