# 007 - Safe Save Output And Load Validation Hardening

## Status

- Status: In Progress
- Owner: Codex
- Last updated: 2026-07-03
- Source: User crash report; updated manifesto sections 1, 21, 22, 23, and 24
- Phase: Safety | MVP hardening

## Summary

Generator apply must treat the selected dynasty save as recoverable source material, not as the only write target. The default apply workflow should write a new top-level modded save copy, keep the selected save unchanged, preserve a timestamped backup, and prove the written output can be parsed and read back before presenting it as usable.

This requirement exists because a syntactically valid rebuilt save can still crash the game. Until game-load validation is proven, copy-first output and explicit overwrite semantics are the safest workflow.

## Manifesto Alignment

- Section 1: Recruit and linked Player rows are written only after the complete profile passes validation.
- Section 21: V1 manipulates existing rows and preserves unknown fields.
- Section 22: Sidecar records preserve generated intent outside the game database.
- Section 23: Every generated class must pass validation before database writeback.
- Section 24: Reports must make outliers and validation state visible.

## Problem

The current V1 apply path creates a backup, rebuilds the save, parses it, writes it, reloads it, and compares read-back values. That is necessary but not sufficient. A game crash on load means we need a workflow that protects the original save even when all local parser checks pass.

The app must distinguish between "the editor can parse this" and "the game can load this." The first can be automated now. The second needs a manual or future automated game-load confirmation loop.

## Goals

- Make generator apply write a new `*-MODDED-*` save copy by default.
- Keep the selected source save unchanged during generator apply.
- Require explicit `writeMode: "overwrite"` for any future in-place generator overwrite.
- Write save bytes atomically through a same-directory temporary file.
- Continue creating backups, sidecars, reports, and read-back mismatch results.
- Record source file, target file, write mode, and fingerprints in apply responses and reports.
- Add a manual game-load verification checklist to reports or progress notes.

## Non-Goals

- Do not claim local parser read-back proves game-load safety.
- Do not create or delete dynasty rows.
- Do not broaden writable fields while investigating crash causes.
- Do not remove existing backup behavior.

## User Workflow

1. User generates and reviews a preview.
2. User selects Apply Preview.
3. App confirms that it will write a new modded save copy and keep the selected save unchanged.
4. App regenerates the preview server-side, validates hashes/fingerprints, rebuilds the save in memory, parses rebuilt bytes, creates a backup, atomically writes the new copy, reloads the written copy, compares read-back diffs, and writes artifacts.
5. User loads the new modded save in game.
6. User records pass/fail and crash notes against the report artifact.

## Research Gates

| Gate | Question | Method | Evidence Required | Blocks |
| ---- | -------- | ------ | ----------------- | ------ |
| RG-12 | Which generated output patterns crash on game load despite local parser success? | Apply to disposable copies, load in game, and correlate failures with report artifacts. | Report id, source fingerprint, target fingerprint, write fields, config hash, and manual game-load result. | Enabling overwrite as a normal UI path. |
| RG-13 | Does the game require additional container metadata or external save metadata beyond current `FBCHUNKS` parseability? | Compare original, no-op rebuilt, and generated-copy saves with binary/container metadata inspection and game-load tests. | Notes plus fixtures showing which variants load. | Any broader write-field rollout. |

## Data Model

Apply responses and report artifacts should include:

- `writeMode`: `copy` or `overwrite`
- `sourceFile`
- `targetFile`
- `targetPath`
- `sourceUnchanged`
- `saveFingerprintBefore`
- `saveFingerprintAfter`
- backup metadata
- sidecar/report artifact metadata
- read-back mismatch rows
- future manual `gameLoadStatus`

## Field Safety

### Writable Now

- Existing V1 verified field groups only, after preview validation.

### Writable After Research

- Any currently research-gated generator field.
- Any in-place generator overwrite workflow exposed as a normal UI option.

### Preserve By Default

- Unknown fields, unsupported fields, and all fields not present in the verified generated patch set.

## Config Contract

Generator apply accepts an operational write mode outside the generation config:

```json
{
  "writeMode": "copy"
}
```

Valid values:

- `copy`: default; write a new modded save copy.
- `overwrite`: explicit advanced mode; overwrite the selected save after backup.

## API Contract

### Apply Generator Preview

`POST /api/generator/apply`

Request:

```json
{
  "file": "DYNASTY-JUL02-07h43m00-AUTOSAVE",
  "previewId": "ABC",
  "configHash": "DEF",
  "config": {},
  "seed": "2026-class-1",
  "confirm": true,
  "writeMode": "copy",
  "locks": {}
}
```

Response additions:

```json
{
  "writeSucceeded": true,
  "writeMode": "copy",
  "sourceFile": "DYNASTY-JUL02-07h43m00-AUTOSAVE",
  "targetFile": "DYNASTY-JUL02-07h43m00-AUTOSAVE-MODDED-20260703-173000",
  "sourceUnchanged": true
}
```

Errors:

- `400`: missing confirmation, invalid write mode, invalid payload.
- `409`: selected save changed after preview.
- `422`: preview or validation report has blocking errors.
- `500`: rebuild, parse, backup, write, or read-back failure.

## UI Requirements

- Apply confirmation must say the selected save stays unchanged in copy mode.
- Apply result must show target save name, write mode, backup, sidecar, report, and read-back state.
- Save Tools should make it easy to inspect the report tied to the target copy.
- Future overwrite UI must require a stronger confirmation than copy mode and should remain hidden until RG-12 has enough passing evidence.

## Algorithm Requirements

1. Load and fingerprint the selected save.
2. Rebuild joined profiles from current bytes.
3. Regenerate preview from config, seed, and locks.
4. Verify preview id, config hash, and save fingerprint.
5. Reject blocking validation errors.
6. Build verified generated patches only.
7. Rebuild the `FBCHUNKS` output in memory.
8. Parse rebuilt output before any disk write.
9. Create backup.
10. Select target path:
    - copy mode: new top-level `*-MODDED-*` file.
    - overwrite mode: selected file.
11. Atomically write target bytes through a temp file.
12. Parse and read back the target.
13. Compare intended diffs against read-back joined profiles.
14. Write sidecar and report artifacts.

## Validation Requirements

- Source file must be a top-level editable `FBCHUNKS` save.
- Preview fingerprint must match the current source fingerprint.
- Config hash must match the preview.
- Rebuilt bytes must parse as `FBCHUNKS` before write.
- Target bytes must parse and joined profiles must be readable after write.
- Source file bytes must remain unchanged in copy mode.

## Error Handling

- Backup failure: do not write target bytes.
- Rebuild parse failure: do not create backup and do not write target bytes.
- Target write failure: report no write success and leave source unchanged in copy mode.
- Artifact failure after successful write: report `writeSucceeded: true` and `artifactWriteSucceeded: false`.
- Read-back mismatch: keep output but mark apply as not fully applied.

## Test Plan

### Unit Tests

- invalid write mode is rejected.
- modded output names are unique.
- atomic write helper does not leave temp files on success.

### Integration Tests

- default generator apply writes a new copy and leaves source bytes unchanged.
- non-empty generated apply changes target bytes only.
- explicit overwrite mode still creates backup and overwrites only after parse.
- backup failure leaves source and target unchanged.
- rebuild parse failure prevents backup and write.

### Fixture/Research Tests

- no-op rebuilt copy game-load test.
- development-trait-only generated copy game-load test.
- broader V1 field generated copy game-load test.

### UI Tests

- confirmation says copy mode keeps the selected save unchanged.
- apply result displays target file and write mode.

## Acceptance Criteria

- Generator apply defaults to copy mode.
- The selected source save is unchanged after default apply.
- The output copy is parsed and read back before success is shown.
- Apply responses include source and target metadata.
- Requirements and README document that local read-back is not the same as game-load proof.

## Dependencies

- Requirements 001 through 006.
- Existing backup, preview, read-back, report, and sidecar support.
- Manual game-load testing for RG-12 and RG-13.

## Rollout Plan

1. Ship copy-first generator apply.
2. Gather game-load evidence from disposable modded save copies.
3. Keep overwrite as API-only advanced mode until enough evidence supports exposing it.
4. Add manual game-load status tracking to report artifacts.

## Open Questions

- Does CFB27 enumerate arbitrary `DYNASTY-*-MODDED-*` files in the save list?
- Does the game care about modified time, companion metadata, or save-name text inside the payload?
- Which V1 write group, if any, causes the reported crash?
