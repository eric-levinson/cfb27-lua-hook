# 010 - Ability Ecosystem And Recruiting Presentation V3/V4

## Status

- Status: Draft
- Owner: Unassigned
- Last updated: 2026-07-03
- Source: Updated manifesto sections 13, 17, 18, 20, 21, 23, and 24
- Phase: V3 | V4

## Summary

After core generation, safe save output, body-mesh planning, and progression analysis are stable, the app should add ability ecosystems and richer recruiting presentation. Abilities must be scarce differentiators tied to position, archetype, ratings, thresholds, and profile distinction. Recruiting presentation fields such as NIL, motivations, offers, top schools, and production grade must remain preserved until decoded.

The generator should plan abilities before it writes them. Preview and reporting can explain ability intent while the underlying ability fields remain blocked by research gates.

## Manifesto Alignment

- Section 13: Ability badges communicate exceptional gameplay traits.
- Section 17: Appearance tokens remain paired and replaceable.
- Section 18: Identity/geography generation stays separate from talent generation.
- Section 20: Production grade and unknown fields remain observational until confirmed.
- Section 21: V3 adds abilities; V4 adds recruiting personality and presentation.
- Section 23: Ability and appearance validation must pass before writes.
- Section 24: Reports include ability-tier distribution once implemented.

## Problem

Abilities and recruiting presentation fields are high-impact but under-verified. Awarding abilities from OVR alone would violate the manifesto, and editing recruiting relationship fields blindly could damage dynasty behavior. The app needs a preview-first, research-gated plan for abilities and presentation instead of one-off direct writes.

## Goals

- Decode physical and mental ability identity/tier fields before writing.
- Build archetype-specific ability pools.
- Assign abilities based on position, archetype, ratings, thresholds, and profile distinction.
- Enforce scarce Platinum, Gold, Silver, and Bronze budgets.
- Explain why each planned ability was assigned.
- Decode production, offers, NIL, motivations, dealbreakers, and top-school logic before writes.
- Keep identity/geography generation separate from talent generation.

## Non-Goals

- Do not implement ability writes in V1.
- Do not assign abilities solely by overall rating.
- Do not independently randomize appearance token pairs.
- Do not write top-school, recruiting-board, offer, or motivation relationship fields before research.

## User Workflow

1. User enables preview-only ability or presentation planning.
2. App validates that relevant research gates are incomplete and marks writes as skipped.
3. Preview shows ability plans, reasons, budgets, and skipped fields.
4. After research gates pass, user enables verified writes in config.
5. Apply writes through the copy-first safe-save flow and report artifacts capture read-back and game-load evidence.

## Research Gates

| Gate | Question | Method | Evidence Required | Blocks |
| ---- | -------- | ------ | ----------------- | ------ |
| RG-10 | How are physical and mental ability identity/tier fields encoded? | Controlled ability edits, read-back, UI verification, and game-load tests. | Ability identity map, tier map, slot behavior, invalid value behavior. | V3 ability writes. |
| RG-11 | What do production, offers, NIL, motivations, dealbreakers, and top schools affect? | Correlation scans and controlled edits on disposable saves. | Field map, relationship integrity notes, read-back tests, and game-load results. | V4 recruiting presentation writes. |
| RG-16 | Which abilities are valid for each CFB27 position/archetype? | Schema/table inspection plus controlled gameplay/UI verification. | Archetype ability pools and invalid-combination notes. | Ability planning and validation. |
| RG-17 | How should appearance token pools avoid real-player assets and preserve diversity? | Scan existing generated recruits and validate token pairs. | Safe token-pair pool, duplicate rules, and real-player exclusion notes. | Expanded appearance classification. |

## Data Model

Ability plan:

```json
{
  "abilityPlan": [
    {
      "slot": 1,
      "ability": "Takeoff",
      "tier": "Gold",
      "reason": "WR deep-threat profile with elite speed and acceleration",
      "requiredRatings": {
        "speed": 95,
        "acceleration": 93
      },
      "writeState": "preview-only"
    }
  ]
}
```

Presentation plan:

```json
{
  "presentation": {
    "homeState": "GA",
    "pipeline": "Metro Atlanta",
    "dealbreaker": "PlayingTime",
    "motivations": [],
    "offerPlan": "preserve",
    "writeState": "preview-only"
  }
}
```

Sidecar records should preserve ability plans, skipped reasons, presentation intent, and write state.

## Field Safety

### Writable Now

- Preview/report/sidecar ability and presentation intent.
- Existing dealbreaker writes only where already verified by the manual editor path.

### Writable After Research

- `PhysicalAbility1-5` and related tier/identity fields after RG-10.
- `MentalAbility1-3` and related tier/identity fields after RG-10.
- Production grade, NIL, motivations, offers, top-school fields, and recruiting-board relationships after RG-11.
- Appearance token classification after RG-17.

### Preserve By Default

- Ability fields before RG-10.
- Recruiting presentation relationship fields before RG-11.
- `GenericHeadAssetName` plus `PLYR_PORTRAIT` unless reused as a proven pair.
- `CharacterVisuals` and portrait library paths.

## Config Contract

```json
{
  "abilities": {
    "enabled": false,
    "writeAbilities": "after-research",
    "budgets": {
      "Platinum": { "min": 0, "max": 3 },
      "Gold": { "min": 25, "max": 60 },
      "Silver": { "min": 150, "max": 300 },
      "Bronze": { "min": 400, "max": 750 }
    },
    "assignment": {
      "requireArchetypeFit": true,
      "requireRatingThresholds": true,
      "allowLowOverallGoldTrait": true
    }
  },
  "presentation": {
    "enabled": false,
    "writePresentation": "after-research",
    "preserveTopSchools": true,
    "preserveOffers": true
  }
}
```

## API Contract

Ability and presentation support should extend existing generator preview/apply/report endpoints.

Preview response additions:

- ability budget summary
- ability reason rows
- skipped unverified fields
- presentation plans and diffs
- invalid ability/archetype combinations

Apply response should continue to use requirement 007 source/target metadata.

## UI Requirements

- Preview summary shows ability-tier distribution and budget status.
- Inspector shows ability reasons per selected recruit.
- Validation panel shows invalid ability/archetype combinations.
- Presentation panel shows preserved versus generated recruiting fields.
- Skipped fields must name the blocking research gate.

## Algorithm Requirements

Ability assignment sequence:

1. Position.
2. Archetype.
3. Eligible ability pool.
4. Player ratings.
5. Rating thresholds.
6. Profile distinction.
7. Ability tier.
8. Class-level scarcity budget.
9. Write-state gate.

Presentation assignment sequence:

1. Home state.
2. Hometown.
3. Pipeline.
4. Name.
5. Dealbreaker.
6. Motivations, offers, NIL, top schools, and production only after research gates pass.

## Validation Requirements

- Ability must be valid for position and archetype.
- Ability tier must respect underlying ratings and distinction.
- Platinum count must stay within budget.
- Ability count must not simply track OVR.
- Geography must not rigidly determine player quality.
- Top-school and offer edits must preserve relationship integrity.
- Appearance token pairs must remain paired and avoid real-player assets.

## Error Handling

- Ability mapping missing: preserve all ability fields and warn.
- Presentation mapping missing: preserve all presentation fields and warn.
- Budget cannot be satisfied: warn or fail based on config severity.
- Invalid ability slot/tier: block apply.
- Relationship integrity uncertain: skip write and preserve original fields.

## Test Plan

### Unit Tests

- ability eligibility by position/archetype.
- tier budget enforcement.
- ability reason generation.
- presentation write-state gating.

### Integration Tests

- preview-only ability planning produces skipped fields before RG-10.
- controlled ability edits write/read back after RG-10.
- presentation fields write/read back after RG-11.

### Fixture/Research Tests

- ability identity/tier fixture matrix.
- recruiting relationship fixture matrix.
- appearance token-pair fixture pool.
- game-load results for ability-only and presentation-only copies.

### UI Tests

- report displays ability distribution and skipped research gates.
- selected recruit inspector shows ability reasons.

## Acceptance Criteria

- No V3/V4 field is written before its research gate passes.
- Abilities are scarce differentiators, not OVR badges.
- Preview explains ability plans and skipped fields.
- Recruiting presentation preserves relationship integrity.
- Apply uses copy-first safe save output and records source/target evidence.

## Dependencies

- Requirements 001 through 009.
- RG-10, RG-11, RG-16, and RG-17.
- V1 generator, reporting, sidecar, and safe save output.
- V2 sidecar/progression data for full long-term ability validation.

## Rollout Plan

1. Decode ability fields and build read-only reports.
2. Add preview-only ability planning.
3. Enable ability writes after RG-10 and RG-16.
4. Decode recruiting presentation fields.
5. Add V4 preview and writes after RG-11.
6. Expand appearance-token classification after RG-17.

## Open Questions

- Which abilities exist for every CFB27 position/archetype?
- Are ability tiers encoded separately from identity or inside the same field?
- How much should recruiting motivations influence generation versus remain game-owned?
- Which presentation fields are relationship pointers versus scalar display values?
