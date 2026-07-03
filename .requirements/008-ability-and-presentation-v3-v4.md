# 008 - Visual Body Mesh Classifier V1.1

## Status

- Status: Draft
- Owner: Unassigned
- Last updated: 2026-07-03
- Source: Updated manifesto sections 14, 15, 17, 21, 23, and 24
- Phase: V1.1

## Summary

The updated manifesto makes `CharacterBodyType` a constrained visual-mesh classification problem. The generator must stop treating body type as a loose BMI or label mapping and instead choose only from legal position pools using position-relative mass, movement, and strength evidence. It must store both internal body composition and final game mesh in sidecar data.

This requirement is preview-first until RG-5 proves the exact value-to-visual mapping and disposable modded copies load in game.

## Manifesto Alignment

- Section 14: Height, weight, archetype, body type, and physical ratings are one connected system.
- Section 15: Body type is a constrained visual-mesh selection system with legal pools, indices, confidence, and rarity controls.
- Section 17: Appearance tokens remain paired and preserved.
- Section 21: V1 includes body composition and character body type.
- Section 23: Football validation must reject invalid body meshes.
- Section 24: Reports must include body-type distributions and outliers.

## Problem

The current config/body-rule model is too coarse for the updated manifesto. It can keep height and weight inside plausible ranges, but it does not yet prove that the final in-game body mesh is legal for the player's position or believable for his movement and strength profile.

Writing `CharacterBodyType` before RG-5 is complete remains risky. Even preview-only body decisions should be upgraded so the future write path is based on the correct visual model.

## Goals

- Define position groups and legal body-type pools.
- Compute position-relative Mass Index, Movement Index, and Strength Index.
- Score only legal body meshes for the player's position group.
- Apply hard overrides and rarity caps.
- Return body type, confidence, internal body composition, and decision reason.
- Store internal body composition separately from final `CharacterBodyType` in sidecar records.
- Validate that line/front-seven/ball-carrier/QB/TE restrictions are enforced.
- Keep body-type writes blocked until RG-5 passes.

## Non-Goals

- Do not write `CharacterBodyType` until RG-5 has value-to-visual proof and read-back tests.
- Do not implement skill-cap writes before RG-9.
- Do not implement ability writes before RG-10.
- Do not implement production, NIL, motivations, offers, or top-school writes before RG-11.
- Do not randomize appearance token fields independently.

## User Workflow

1. User generates a preview.
2. Preview shows each recruit's internal body composition, final body mesh plan, confidence, and any body validation warnings.
3. User reviews body-type distribution by position.
4. Apply writes only currently verified fields; unverified `CharacterBodyType` decisions stay preview-only until RG-5 passes.
5. After RG-5, user can enable body-type writes in config and apply them through the normal safe-save workflow.

## Research Gates

| Gate | Question | Method | Evidence Required | Blocks |
| ---- | -------- | ------ | ----------------- | ------ |
| RG-5 | Which `CharacterBodyType` values map to the actual in-game visual presets? | Controlled edits on disposable save copies plus screenshots/notes. | Value-to-visual map, position examples, read-back tests, and game-load results. | Body-type writes. |

## Data Model

Body classifier output:

```json
{
  "bodyComposition": "FUNCTIONALLY_MASSIVE",
  "characterBodyTypePlan": "Muscular",
  "bodyTypeConfidence": 0.84,
  "bodyTypeReason": "OL with high strength and acceptable movement; Heavy not required",
  "bodyMetrics": {
    "massIndex": 0.42,
    "movementIndex": 0.61,
    "strengthIndex": 0.78
  },
  "bodyTypeWriteState": "preview-only"
}
```

Sidecar records must preserve:

- generated height and display weight
- encoded weight
- position group
- internal body composition
- final body mesh plan
- confidence and decision reason
- Mass/Movement/Strength indices
- future ideal playing-weight range

## Field Safety

### Writable Now

- Height and encoded/display weight when existing V1 capability gates allow it.
- Ratings that feed body metrics when already V1 writable.
- Preview/report/sidecar body classifier metadata.

### Writable After Research

- `Player.CharacterBodyType`: after RG-5.

### Preserve By Default

- Appearance token pairs unless reused as a proven pair.
- `CharacterVisuals`, portrait library paths, and generic-head flags.
- Any unknown field not covered by a research gate.

## Config Contract

Body classifier config should be explicit and exportable:

```json
{
  "bodyClassifier": {
    "enabled": true,
    "writeCharacterBodyType": "after-research",
    "defaultConfidenceFloor": 0.65,
    "rarityCaps": {
      "WR.Muscular": { "min": 0, "maxShare": 0.015 },
      "CB.Muscular": { "min": 0, "maxShare": 0.015 },
      "QB.Muscular": { "min": 0, "maxShare": 0.02 },
      "TE.Thin": { "min": 0, "maxShare": 0.06 }
    }
  }
}
```

The existing `writeFields.bodyType` state remains preview-only until RG-5 passes.

## API Contract

Body classifier metadata should extend existing preview/apply/report responses rather than creating a separate write path.

Preview response additions per recruit:

- `generationIntent.bodyComposition`
- `generationIntent.characterBodyTypePlan`
- `generationIntent.bodyTypeConfidence`
- `generationIntent.bodyTypeReason`
- `gameFields.generatedDiffs` only after RG-5 and config opt-in

Report additions:

- body-type distribution
- body-type distribution by position group
- invalid body mesh count
- low-confidence body decision samples
- rarity cap warnings

## UI Requirements

- Inspector must show internal body composition and final mesh plan separately.
- Preview summary must include body-type distribution and invalid/low-confidence counts.
- Validation report must call out illegal body type plans such as OL `Standard`, RB `Heavy`, EDGE `Freshman`, QB `Heavy`, and TE `Freshman`.
- Config UI should expose body classifier confidence and rarity caps after the data model stabilizes.

## Algorithm Requirements

1. Determine position group.
2. Load legal body-type pool for the position group.
3. Generate height, weight, archetype, physical ratings, and strength profile.
4. Calculate Mass Index from position-relative height/weight expectations.
5. Calculate Movement Index from position-relative speed, acceleration, and agility percentiles.
6. Calculate Strength Index from position-relative strength percentile.
7. Score only legal body types.
8. Apply hard overrides:
   - OL/IDL: `Muscular` or `Heavy` only.
   - EDGE/LB: `Standard` or `Muscular` only.
   - RB/FB: never `Heavy`.
   - QB: never `Heavy`.
   - TE: never `Freshman` or `Heavy`.
9. Apply rarity caps for uncommon body-position combinations.
10. Return best mesh, confidence, internal composition, and reason.
11. Preserve write as preview-only until RG-5 passes.

## Validation Requirements

- Chosen body type must be in the legal position pool.
- Low-confidence decisions must be reportable.
- Rarity caps must not be exceeded without warning or blocking severity.
- Encoded weight must equal displayed pounds minus 160.
- Internal body composition and final mesh must both be present in sidecar records.
- `CharacterBodyType` diffs must be absent while body type is research-gated.

## Error Handling

- Missing movement or strength ratings: fall back to common legal mesh and emit warning.
- Unknown position group: preserve current body type and emit warning.
- Rarity cap cannot be satisfied: keep legal fallback and report the conflict.
- RG-5 incomplete: show body plan as preview-only and skip writes.

## Test Plan

### Unit Tests

- legal body pool selection by position group.
- Mass/Movement/Strength index normalization.
- hard override enforcement.
- confidence fallback behavior.
- rarity cap enforcement.

### Integration Tests

- preview includes body classifier metadata and no body-type diffs before RG-5.
- report includes body-type distribution by position.
- RG-5-enabled fixture writes `CharacterBodyType` and reads it back on a disposable copy.

### Fixture/Research Tests

- controlled screenshots or notes for every decoded `CharacterBodyType` value.
- game-load tests for body-type-only generated copies.

### UI Tests

- inspector shows body composition and final mesh separately.
- validation panel shows illegal body mesh samples.

## Acceptance Criteria

- Preview body planning follows legal position pools.
- Internal body composition is not treated as the same thing as final game mesh.
- Body-type writes remain blocked until RG-5 passes.
- Reports surface invalid, low-confidence, and rarity-capped body decisions.
- Future progression and ability/presentation writes are covered by requirements 009 and 010.

## Dependencies

- Requirements 001 through 007.
- Position and archetype generation from V1.
- Rating generation for speed, acceleration, agility, and strength.
- RG-5 evidence before any body-type write.

## Rollout Plan

1. Add preview-only body classifier and validation/reporting.
2. Gather RG-5 visual and game-load evidence.
3. Promote `CharacterBodyType` to verified generator write when safe.
4. Reuse sidecar body data for requirement 009 weight development and progression analysis.

## Open Questions

- Which exact enum values correspond to the five visual meshes?
- What position-relative roster baseline should drive Mass Index?
- Should body-type rarity caps be class-level hard errors or warnings?
- Does changing body mesh alone contribute to game-load crashes?
