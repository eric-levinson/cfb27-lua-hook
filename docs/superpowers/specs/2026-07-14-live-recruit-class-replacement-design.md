# Live Recruit Class Replacement POC

## Goal

Prove that Brooks's external recruit generator can replace the game's already-generated recruit class directly in live FrTk data without modifying or resaving the dynasty file.

## Command

Expose one command:

```text
live-class replace --save <autosave> --brooks-root <path>
```

The command reads the save as a skeleton, runs Brooks's generator, and immediately applies the generated class to the running game. There is no user-reviewed intermediate plan.

## Scope

The POC must write:

- existing `Player` rows: position, archetype, height, weight, body type, development trait, stars, ratings, physical abilities, mental abilities, home state, and pipeline;
- existing `Recruit` rows: quality modifier, ranks, and alternate positions;
- first name, last name, and hometown through a verified live string path.

Portrait/head and gear/`CharacterVisuals` are best-effort. They may be reported as skipped without failing the core replacement. The POC does not add or remove recruit or player rows.

## Data Flow

1. Read the supplied save without writing it.
2. Use its existing recruit-to-player row pairs as Brooks's generation skeleton.
3. Run Brooks's generator from the existing local checkout, reset to a known `origin/main` revision before integration.
4. Normalize Brooks's generated writes in memory.
5. Discover the live `Player`, `Recruit`, and string surfaces and verify their identities, capacities, and generation.
6. Preflight every target row, field, value, and string before the first write.
7. Capture a rollback snapshot of all affected live records and strings.
8. Apply guarded batches, rereading each batch after it commits.
9. On any failure, stop and restore every completed batch from the snapshot.
10. Return a compact summary of generated recruits, fields written, optional surfaces skipped, and rollback status.

## Safety Boundary

- The save path is read-only; the command never calls a save writer.
- Names are mandatory. If the live string path cannot safely write all required names and hometowns, preflight fails before any mutation.
- All record changes carry expected old values and lifecycle generation guards.
- Player/Recruit row relationships must match the read-only save skeleton before writing.
- The operation is multi-batch rather than globally atomic, so rollback is mandatory.
- Managed or derived fields that fail reread verification abort the operation.

## MVP Architecture

- A thin Brooks adapter invokes the existing generator and converts `buildRecruitWrites` output into a normalized in-memory plan.
- A live-class service performs discovery, preflight, snapshot, guarded batching, verification, and rollback.
- A minimal CLI command wires the two together.
- No UI, daemon, persistent database, generalized allocation API, or recruit creation is included.

## Verification

Automated tests use synthetic Player, Recruit, and string mirrors to prove:

- Brooks output maps to the expected existing row pairs;
- the save is never opened for writing;
- names are a hard preflight gate;
- guarded batches stop on stale data;
- a mid-operation failure restores earlier batches;
- successful rereads match the normalized generated class;
- unsupported portrait or gear writes are reported but do not fail the core operation.

The POC is complete when one command can generate and transactionally replace a synthetic full class offline. Actual game execution is a separate user-controlled gate.
