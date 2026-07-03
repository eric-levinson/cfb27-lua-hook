# 009 - Ceilings, Progression, And Normalization V2

## Status

- Status: Draft
- Owner: Unassigned
- Last updated: 2026-07-03
- Source: Updated manifesto sections 8, 9, 10, 11, 14, 16, 21, 22, 23, and 25
- Phase: V2

## Summary

V2 should control career growth through decoded skill-group caps, freshman baseline sidecar data, career-growth budgets, weight development, and post-offseason normalization. Physical traits should remain relatively stable while technical and mental development account for most improvement.

This work must begin as read-only analysis. Cap writes and normalization writes stay blocked until the cap slots, value direction, offseason timing, and game-load behavior are proven.

## Manifesto Alignment

- Section 8: Rating categories have different career movement expectations.
- Section 9: Most players improve modestly; extreme growth is rare.
- Section 10: Development trait affects realization probability, not guaranteed superstardom.
- Section 11: Skill-group caps should prevent unrealistic career inflation.
- Section 14 and 16: Weight and frame development can improve power while reducing athleticism.
- Section 22: Sidecar records preserve original design intent for later analysis.
- Section 25: A player's freshman profile should remain recognizable through his career.

## Problem

The game may inflate too many players or push every attribute upward without preserving football identity. Without sidecar baselines and decoded caps, normalization would be blind and could erase the differences between polished prospects, raw athletes, frame projections, and generational freshmen.

## Goals

- Decode `SkillGroupCap1-6` slot mapping and value behavior.
- Store and consume freshman baselines from sidecar records.
- Define allowed growth budgets by rating category and profile type.
- Analyze current players against original generated intent.
- Detect unrealistic physical trait growth, excessive OVR gain, and weight-development conflicts.
- Preview normalization diffs before any write.
- Apply normalization only through safe-save copy mode until game-load evidence supports anything broader.

## Non-Goals

- Do not write cap fields before RG-9 passes.
- Do not guarantee deterministic in-game progression outcomes.
- Do not flatten player identities to hit OVR targets.
- Do not force every player upward; regression must be possible when justified.

## User Workflow

1. User loads a dynasty and the matching generated sidecar.
2. App matches current player rows to sidecar records.
3. App reports growth by category, physical drift, OVR gain, and weight-development conflicts.
4. User previews normalization suggestions.
5. App writes only verified corrections to a new modded save copy after validation.
6. User game-loads the copy and records the result.

## Research Gates

| Gate | Question | Method | Evidence Required | Blocks |
| ---- | -------- | ------ | ----------------- | ------ |
| RG-9 | How do `SkillGroupCap1-6` slots and values work? | Controlled edits plus offseason progression comparison. | Slot map, value direction, zero behavior, unused slot behavior, archetype interaction notes. | Cap generation and cap normalization writes. |
| RG-14 | Which offseason moment is safest for normalization? | Apply disposable copies before/after offseason events and load in game. | Timing notes, passing game-load evidence, and read-back fixtures. | Normalization apply UX. |
| RG-15 | How should transferred, graduated, cut, or recycled players match sidecar records? | Compare multi-season saves and sidecars. | Matching strategy and skipped-player rules. | Automated progression analysis. |

## Data Model

Sidecar baseline fields needed by V2:

- original player/recruit ids and rows
- original ratings by category
- original OVR, position, archetype, profile type, and rank
- original body composition, final body mesh, height, weight, and ideal playing-weight range
- original development trait and ceiling score
- cap plan once decoded
- career growth budget by category
- normalization history entries

## Field Safety

### Writable Now

- Read-only analysis output and reports.
- Future preview-only normalization suggestions.

### Writable After Research

- `SkillGroupCap1-6` after RG-9.
- Rating/body normalization writes after RG-14 and field-level write verification.

### Preserve By Default

- Any player without a trusted sidecar match.
- Any cap slot without decoded ownership.
- Any field that cannot be read back and game-loaded on a disposable copy.

## Config Contract

```json
{
  "progression": {
    "enabled": false,
    "physicalTraitGrowth": { "typical": [-1, 2], "rareMax": 3, "extremeMax": 4 },
    "moderatelyTrainableGrowth": { "typical": [0, 3], "strongMax": 5, "extremeMax": 6 },
    "strengthGrowth": { "typical": [2, 7], "strongMax": 11, "extremeMax": 15 },
    "technicalMentalGrowth": { "typical": [3, 8], "strongMax": 12, "extremeMax": 16 },
    "careerOverallGain": {
      "common": [0, 6],
      "strong": [7, 9],
      "rare": [10, 12],
      "extreme": [13, 15]
    }
  }
}
```

## API Contract

Future endpoints:

- `POST /api/progression/analyze`
- `POST /api/progression/preview-normalization`
- `POST /api/progression/apply-normalization`

Apply must use the same safe-save output contract from requirement 007.

## UI Requirements

- Show baseline vs current ratings.
- Group changes by physical, athletic, strength/power, technical, and mental categories.
- Show OVR gain distribution and outliers.
- Show weight changes and predicted athletic tradeoffs.
- Show cap plan versus actual growth once RG-9 passes.
- Display skipped players and match confidence.

## Algorithm Requirements

1. Load current dynasty and matching sidecar.
2. Match generated sidecar records to current player rows.
3. Categorize every rating.
4. Compute rating deltas and OVR deltas.
5. Compare deltas to profile-specific budgets.
6. Detect physical trait inflation and weight-development conflicts.
7. Generate read-only report first.
8. Generate normalization preview only after analysis is trusted.
9. Apply verified diffs through requirement 007 safe-save flow.

## Validation Requirements

- Sidecar fingerprint/version must be compatible with the save.
- Player identity match confidence must be high before any normalization write.
- Physical traits must not exceed configured limits without an outlier reason.
- Technical gains must concentrate in plausible weak areas.
- High starting OVR and large remaining ceiling should remain rare.
- Normalization diffs must not touch locked or skipped players.

## Error Handling

- Missing sidecar: limited read-only analysis only.
- Cap map missing: preserve all caps.
- Player no longer exists: report skipped.
- Ambiguous match: report skipped.
- Game-load evidence missing: keep apply hidden or copy-only.

## Test Plan

### Unit Tests

- rating category classification.
- growth-budget validation.
- sidecar/player match scoring.
- weight-development tradeoff calculations.

### Integration Tests

- analyze sidecar against later save fixture.
- preview normalization without writing.
- apply normalization to disposable copy after gates pass.

### Fixture/Research Tests

- cap slot/value controlled edits.
- offseason timing fixtures.
- game-load results for normalization copies.

## Acceptance Criteria

- V2 starts with read-only progression analysis.
- Cap writes do not start until RG-9 passes.
- Normalization preserves player identity and category-specific growth limits.
- Apply uses copy-first safe save output.
- Reports identify skipped, ambiguous, and outlier players.

## Dependencies

- Requirements 001, 002, 005, 007, and 008.
- V1 generated sidecar records.
- RG-9, RG-14, and RG-15 evidence.

## Rollout Plan

1. Build read-only progression analysis.
2. Decode and test skill caps.
3. Add preview-only normalization suggestions.
4. Add copy-mode apply after validation and game-load evidence.

## Open Questions

- Which player identifiers survive transfers and roster churn?
- Which offseason date produces the least game conflict?
- How much regression should be automatic versus user-reviewed?
