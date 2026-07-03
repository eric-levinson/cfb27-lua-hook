# Requirements

This directory tracks planned product requirements for the CFB27 save editor.

The current app already edits dynasty recruits through the structured `Recruit` and linked `Player` tables. The next product direction is to rebuild recruit generation around the principles in [fb-manifesto.md](fb-manifesto.md): coherent football identities, rank-predictive talent, scarce elite traits, realistic body profiles, and validated write safety.

Use [_template.md](_template.md) as the frame for new requirement docs.

## Requirement Sets

- [001 - Field Research And Safety Gates](001-field-research-and-safety-gates.md)
  - Proves which fields can be safely read, written, and verified.
  - Prioritizes research gates for star rating, archetype, body type, gem/bust, appearance tokens, caps, abilities, and recruiting presentation fields.
- [002 - Joined Recruit Profile Model](002-joined-recruit-profile-model.md)
  - Defines the normalized `Recruit` plus linked `Player` object used by generation, diffs, validation, and sidecar records.
  - Ensures generation starts from football identity instead of unrelated random fields.
- [003 - Generation Config Contract](003-generation-config-contract.md)
  - Defines importable/exportable JSON configs aligned to class budgets, rank bands, profile types, archetypes, body rules, and development distributions.
  - Treats overall rating as a validation target, not the primary generator input.
- [004 - Core Talent Generation V1](004-core-talent-generation-v1.md)
  - Generates deterministic preview classes by rerolling existing recruit/player rows only.
  - Implements class-level scarcity, profile types, rank-derived stars, coherent ratings, and V1-safe writes.
- [005 - Validation, Reporting, Sidecar, And Apply](005-validation-reporting-and-apply.md)
  - Owns the preview-to-write safety boundary.
  - Adds validation reports, backups, read-back verification, and sidecar records.
- [006 - SPA Generator Workbench](006-spa-generator-workbench.md)
  - Makes the generator the default SPA workflow.
  - Keeps manual recruit editing, schema, and table tools as supporting views.
- [007 - Safe Save Output And Load Validation Hardening](007-ceilings-progression-and-normalization-v2.md)
  - Makes generator apply copy-first, keeps the selected save unchanged by default, and tracks game-load validation separately from local parser read-back.
- [008 - Visual Body Mesh Classifier V1.1](008-ability-and-presentation-v3-v4.md)
  - Updates body-type planning to the manifesto's constrained visual-mesh model with legal position pools, confidence, rarity caps, and sidecar metadata.
- [009 - Ceilings, Progression, And Normalization V2](009-ceilings-progression-and-normalization-v2.md)
  - Adds future read-only progression analysis, skill-cap decoding, career-growth budgets, weight development, and post-offseason normalization.
- [010 - Ability Ecosystem And Recruiting Presentation V3/V4](010-ability-and-recruiting-presentation-v3-v4.md)
  - Adds future ability planning, ability writes, recruiting presentation logic, and expanded appearance classification after required field research.

## Implementation Priority

1. Run early research gates for fields that affect V1 scope, especially `Recruit.Player` links, current writable fields, `ProspectStarRating`, `PlayerType`, `CharacterBodyType`, `QualityModifier`, appearance pairs, and state-rank ownership.
2. Build the joined recruit/player profile model and field capability metadata.
3. Define and validate the manifesto-aligned JSON config contract.
4. Build deterministic preview-only V1 generation from joined profiles and normalized configs.
5. Add validation reports, sidecar output, and safe apply with backups and read-back verification.
6. Rework the SPA so the generator is the default workflow.
7. Harden generator save output so apply writes a new modded copy by default and preserves game-load evidence.
8. Upgrade body-type planning to legal position pools, body confidence, rarity caps, and sidecar metadata before any `CharacterBodyType` writes.
9. Add V2 progression/normalization only after skill caps, offseason timing, and sidecar matching are decoded.
10. Add V3/V4 abilities and recruiting presentation only after ability and recruiting fields are decoded.

## Safety Constraint

The first implementation must reroll existing `Recruit` rows and linked `Player` rows. It must not create or delete rows until row allocation, references, recruiting boards, team targets, and dependent tables are proven safe to write.

Unknown fields are preserved by default. A field becomes writable only after a research gate produces evidence, notes, read-back tests, and, for save-level changes, game-load evidence on disposable modded copies.
