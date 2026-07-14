# Live FrTk Table Catalog Design

**Date:** 2026-07-12
**Status:** Proposed for implementation
**Baseline:** The tree merged to `origin/main` by `7051a5a`

## Objective

Turn the verified CFB27 Lua hook into a reusable live Dynasty data bridge. A session must be able to locate, validate, read, and transactionally edit whole FrTk tables without calibrating one field at a time.

The first delivery is the generic discovery and table-access substrate. Recruiting is the first proving domain, but recruiting policy, UI, Electron integration, and engine tuning are outside this delivery.

### Operator-effort constraint

The user must not become a manual field-by-field calibration mechanism. Table discovery, stride derivation, field-layout loading, and relationship validation operate in bulk from saved profiles, schema data, and batched memory observations.

Live participation is limited to a small number of explicit gates: launch at a known screen, perform a requested screen transition, and approve one reversible authority probe. If bulk discovery cannot resolve a layout, development returns to offline fixtures or improved discovery instrumentation; it does not fall back to asking the user to inspect or change a long sequence of individual fields.

## Evidence and Constraints

- CFB27 save research identifies the relevant table graph and IDs: `Recruit` 4269, `RecruitingBoard` 4251, CPU `RecruitTarget` 4288, `UserRecruitTarget` 4168, board arrays 5847, and top-school arrays 5842.
- Packed record references use `(tableId << 17) | rowIndex`.
- The hook already provides bounded private-memory scans, allocation metadata, batch reads, guarded transactions, rollback, and SDK/CLI access.
- Exact live records can relocate after lifecycle changes. An address is never authority by itself.
- No audited repository proves a stable CFB27 FrTk table-manager pointer or runtime metadata root.
- Recruit and RecruitTarget physical field offsets and record strides are not yet authoritative.
- FC26 Live Editor demonstrates the desired generic Lua interaction model, but its native implementation and title-specific offsets are not reusable.
- Direct Player-table writes have failed to update authoritative state, while a response-path hook persisted edits. Discovery and mutation authority therefore remain separate questions.
- Franchise table names and table IDs are not stable identities across game updates. The table header Unique ID is the persistent identity; table IDs are current-build routing values used by packed references only.

## Selected Approach

Use save-derived multi-record fingerprints to bootstrap a session catalog, then validate candidates using table structure, relationships, allocation lifecycle, and rereads. Treat a future native FrTk root as an optimization, not a prerequisite.

This is preferred over:

1. **One-field calibration:** proven but too slow and not reusable.
2. **Guessing a global table-manager pointer first:** potentially elegant, but no current evidence establishes the root or object layout.
3. **Raw generic scanning exposed to applications:** flexible but unsafe, difficult to version, and incompatible with the established process boundary.

## Architecture

### 1. Offline profile builder

The profile builder consumes a known save snapshot plus schema-derived table information. For each requested table it emits a versioned profile containing:

- schema/build identity;
- required table Unique ID, current-build table ID, capacity, and known record size when available;
- at least three independently selected occupied rows;
- row indexes and exact or masked byte fingerprints;
- stable-field masks that exclude volatile or unknown bytes;
- expected packed-reference relationships to rows in other profiles;
- optional neighborhood invariants.

Profiles must be deterministic, serializable, size-bounded, and rejected when they lack enough independent evidence.

### 2. Session discovery engine

Discovery scans eligible private allocations using the existing safe scan substrate. It groups matches by allocation and derives candidate table layouts from multiple row matches.

A candidate becomes cataloged only when:

- at least three independently fingerprinted rows match;
- `(addressB - addressA) / (rowB - rowA)` agrees across the rows;
- the derived stride is positive, bounded, and agrees with a known record size when one exists;
- the derived table base and capacity remain inside one readable allocation;
- required packed-reference relationships resolve to independently discovered candidates;
- batched rereads remain stable.

Ambiguous, incomplete, stale, or contradictory candidates fail closed. Discovery returns structured rejection reasons instead of choosing the first match.

### 3. Session table catalog

The catalog owns validated, session-scoped descriptors:

```text
TableDescriptor {
  uniqueId, sessionTableId, baseAddress, stride, capacity,
  allocationBase, allocationSize,
  profileId, evidence, lifecycleGeneration
}
```

Descriptors are invalidated when lifecycle generation changes, an allocation disappears, a sentinel reread fails, or relational validation no longer holds. Consumers cannot retain raw addresses across invalidation.

### 4. Generic table API

The initial host-facing interface mirrors the useful FC26 concepts while preserving CFB27 safeguards:

```lua
local recruits = CFB27.db:GetTableByUniqueId(1873209313)
local record = recruits:GetRecord(row)
local value = record:GetField("CommitScore")

CFB27.db:Transaction(function(tx)
    tx:SetField(record, "CommitScore", value + 100)
end)
```

The implementation may initially support numeric primitives, packed references, and fixed-width bitfields. Unsupported field encodings return explicit errors.

Field access resolves through a versioned schema layout supplied to the host; callers never calculate process addresses. Public table lookup uses the table Unique ID. Logical names are display labels only, and the current-build table ID remains internal for packed-reference routing and validation.

The host loads all supported field definitions for a cataloged table together. Adding a table may require one schema/profile artifact, but must not require a separate live calibration pass for every field.

### 5. Guarded writes and authority

All writes use the existing guarded-transaction engine:

- validate lifecycle generation and descriptor evidence;
- reread and compare expected bytes;
- validate field type, width, range, and packed-reference target;
- apply the complete write set atomically;
- reread to verify;
- roll back on failure.

A successful memory write is reported separately from an authoritative game commit. Each domain adapter can declare one of:

- `direct_verified`: direct table writes are proven authoritative;
- `commit_adapter_required`: a request/response or engine callback is required;
- `discovery_only`: reads are supported, writes are refused.

Recruiting begins as `discovery_only` until a reversible live test proves the correct authority path.

### 6. SDK and application boundary

The SDK receives typed operations for profile loading, discovery, catalog inspection, batch record reads, and guarded field transactions. Raw addresses, arbitrary Lua evaluation, unrestricted scans, and raw memory writes are not added to renderer-facing APIs.

Applications should use domain services in their privileged main process and return sanitized DTOs to a web or Electron renderer.

## Failure Handling

- Unknown build/profile mismatch: refuse discovery.
- Fewer than three independent row matches: refuse catalog entry.
- Multiple equally valid layouts: return ambiguity with evidence for each candidate.
- Lifecycle transition: invalidate catalog before further reads or writes.
- Broken packed-reference relationship: quarantine all dependent descriptors.
- Transaction precondition mismatch: write nothing.
- Post-write verification failure: roll back and report both primary and rollback outcomes.
- Authority unproven: permit reads but refuse writes.

## Testing Strategy

Development follows strict red-green-refactor TDD.

### Pure unit tests

- deterministic profile generation and masking;
- three-row stride and base derivation;
- capacity/allocation bounds;
- packed-reference encode/decode and relationship checks;
- ambiguity and rejection reporting;
- lifecycle invalidation;
- schema field resolution and bitfield operations.

### Host integration tests

- synthetic allocations containing valid, stale, duplicated, truncated, and relocated tables;
- scan self-match resistance;
- batch-read and transaction precondition behavior;
- rollback after injected post-write failure;
- protocol and SDK capability negotiation.

### Independent review gates

Each implementation task receives an independent specification-and-quality review. Critical or important findings are fixed and re-reviewed before the next task. A final whole-branch review runs before live testing.

### Live gates

Live gates occur only after offline and synthetic verification is clean:

1. Launch CFB27 at Dynasty Hub with MMC active; perform discovery-only catalog validation.
2. Navigate to Recruiting and back; prove relocation/invalidation and rediscovery.
3. With explicit warning and a reversible target, perform a guarded recruiting write and determine whether direct mutation is authoritative.
4. Relaunch as required to prove the result does not depend on stale session addresses.

The user must be told explicitly before CFB27 or MMC needs to be closed, launched, or relaunched. Neither application is manipulated automatically.

These gates validate the catalog and authority model as a system. They are not repeated once per field.

## Delivery Boundary

This delivery is complete when:

- profiles can identify at least Player, Recruit, RecruitingBoard, and RecruitTarget-family tables in synthetic fixtures;
- the session catalog rejects ambiguous and stale candidates;
- typed Lua/SDK reads work through catalog descriptors;
- all supported fields for a cataloged table load from one versioned schema/profile without field-by-field live calibration;
- guarded field transactions exist but remain policy-gated by authority status;
- all automated tests and independent reviews pass;
- a discovery-only live gate catalogs the targeted recruiting graph in CFB27.

Proving authoritative recruiting writes is the next explicit milestone. It may complete during the reversible live gate, but failure to prove it must not be misreported as successful generic writing.
