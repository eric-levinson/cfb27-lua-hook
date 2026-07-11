# Live Recruiting Memory Bridge Design

**Status:** Approved design

**Date:** 2026-07-11

**Repositories:**

- `eric-levinson/cfb27-lua-hook`
- `brooksg357-a11y/cfb27-dynasty-modding`

## Purpose

Build the smallest safe bridge from the existing CFB27 Lua host to verified
live Dynasty recruiting data. The work must first prove that recruiting records
can be discovered, validated, and relocated in the running game, then add one
bounded guarded write transaction and verify its behavior through the game UI,
weekly advance, autosave, reload, and recovery.

This is the foundation for a later CPU recruiting governor. It is not the
governor itself.

## Goals

1. Discover recruiting records in committed readable private memory without
   assuming save-file offsets equal live-memory offsets.
2. Batch-read candidate memory without performing one `VirtualQuery` call per
   byte.
3. Emit bounded structured telemetry without treating log messages as a data
   protocol.
4. Validate live `Recruit` and `RecruitTarget` candidates against multiple
   independent save and UI values.
5. Relocate candidates after menu transitions, weekly advances, and game
   restarts instead of persisting absolute addresses.
6. Add bounded guarded write transactions with complete expected-byte
   validation, readback, and automatic rollback.
7. Prove one reversible influence edit, followed by one advance/autosave
   persistence test.
8. Keep the Electron renderer isolated from addresses, raw memory primitives,
   unrestricted Lua evaluation, and SDK internals.

## Non-goals

- Implementing league-wide parity, anti-hoarding, storyline, pitching, scouting,
  RNG, or generator policies in this slice.
- Assuming arbitrary zero-interest school placement works. Initial tests use an
  existing active CPU suitor.
- Allocating or retargeting recruiting rows, pitches, visits, references, or
  arrays.
- Forcing commits or changing `RecruitStage` in the first write proof.
- Exposing heap scanning or write transactions through an Electron preload or
  renderer.
- Supporting online play, bypassing anticheat, or writing on an unrecognized
  executable build.
- Claiming a game-thread-atomic transaction. The host can validate and roll back
  its own writes but cannot pause every game thread.

## Repository ownership

### `cfb27-lua-hook`

The hook repository owns game-domain-neutral runtime facilities:

- bounded readable-region discovery;
- bounded masked scanning across eligible regions;
- bounded batch reads;
- registered structured telemetry types and payload limits;
- guarded batch-write transactions;
- exact-build and offline safety gates;
- complete expected-byte validation, readback, and rollback;
- protocol, SDK, CLI, native smoke, and package documentation.

The hook does not contain recruit, team, board, influence, or policy knowledge.

### `cfb27-dynasty-modding`

Brooks's repository owns recruiting-domain behavior:

- read-only parsing of the selected Dynasty save;
- selection of calibration records with distinctive values;
- conversion of schema fields into candidate patterns and validation rules;
- classification of authoritative, cached, duplicate, and stale objects;
- session-relative discovery recipes;
- weekly-transition and stable-window detection;
- construction of domain-approved write requests in Electron main;
- UI, diagnostics, policies, and later governor behavior.

The renderer never receives addresses, memory bytes, write operations, or the
unrestricted hook SDK.

## Delivery sequence

### Hook PR A: read-only discovery and telemetry

Add region discovery, masked scanning, batch reads, and structured telemetry.
Publish a developer release after native, SDK, protocol, CLI, and package gates
pass.

### Hook PR B: guarded write transactions

Add bounded transactional write requests, complete preflight comparison,
readback, rollback, and stable error contracts. Publish a second developer
release after live reversible-write verification.

### Brooks integration PR

Update the pinned SDK, implement recruiting calibration, perform the reversible
influence proof, and document UI/advance/autosave/reload results. The existing
read-only connection PR remains independently mergeable and is the base
integration layer.

Governor work begins only after all proof gates in this design pass.

## Read-only host contract

### Eligible memory regions

Discovery considers only regions that are:

- `MEM_COMMIT`;
- readable and not `PAGE_GUARD` or `PAGE_NOACCESS`;
- private memory unless an explicitly registered future use case adds another
  type;
- within configured per-region and aggregate byte limits;
- inside the current CFB27 process.

Requests must bound total regions, total scanned bytes, pattern length, result
count, surrounding-byte length, and encoded response size. Hitting a limit
returns a stable error rather than a partial result presented as complete.

### Masked scanning

A scan request contains a byte pattern plus a same-length mask. The host returns
only bounded candidate metadata: address, region base/size/protection, and the
requested bounded match context. It does not dump complete regions.

The SDK treats addresses as opaque session values. They are never serialized to
application settings, save metadata, logs, renderer messages, or long-lived
caches.

### Batch reads

A batch read accepts bounded `{ address, length }` ranges. The host validates
each complete range before reading and returns one result per requested range.
No range may cross an unreadable region boundary. A failed range fails the whole
request so consumers cannot mistake an incomplete snapshot for a consistent
one.

### Structured telemetry

The host exposes a bounded custom telemetry operation separate from `cfb.log`.
Only registered event type names are accepted. Payloads use JSON-compatible
scalars and bounded objects/arrays, reject addresses and oversized strings, and
enter the existing cursor-paged event ring. Recruiting-specific event names are
registered by the consuming integration contract, not hardcoded into the memory
implementation.

## Recruiting calibration

The Electron main process opens the selected Dynasty save read-only. It selects
one recruit and one already-active CPU `RecruitTarget` pairing with distinctive,
visible, and independently checkable values.

Candidate validation uses multiple fields. A single influence, stage, rank, or
identifier match is insufficient. Recruit validation should combine identity,
stage, score, ranks, and linked values. Target validation should combine its
recruit relationship, influence values, offer/action state, and board context.

Calibration passes only when:

1. the candidate set is uniquely identified or all duplicates are explicitly
   classified;
2. decoded values agree with both the read-only save parse and visible game
   state;
3. authoritative candidates can be relocated after leaving and re-entering the
   relevant Dynasty views;
4. candidates can be relocated after a weekly advance;
5. stale or presentation-only copies are excluded; and
6. the entire calibration run performs no writes.

The integration stores a session-relative discovery recipe made from patterns,
masks, validation fields, and relationships. It does not store addresses. Every
game launch, PID change, host-session change, failed validation, or relevant
allocation transition invalidates the current candidates and forces relocation.

## Stable-window detection

Lua callbacks run on the host thread, not the game's recruiting transaction
thread. A 100 ms tick does not by itself prove that an advance is finished.

The Brooks integration observes the Dynasty week plus a small verified set of
recruiting counters and target values. A pending write becomes eligible only
after the week transition is observed and all watched values remain unchanged
for a configured number of consecutive samples. Any change resets the stability
counter. Candidate relocation and full expected-byte validation occur after the
stable window is established and immediately before the transaction.

The exact watched fields and required consecutive sample count are empirical
outputs of the read-only calibration. They are not guessed in the hook.

## Guarded write contract

A write request contains:

```text
transactionId
operations[]:
  address
  expectedBytes
  replacementBytes
```

The host enforces bounded operation count, per-operation length, aggregate byte
count, nonempty equal-length byte arrays, and non-overlapping address ranges.

Before the first write, the host:

1. verifies the exact supported executable build;
2. verifies that real EA/Javelin anticheat is absent;
3. validates every complete range as committed and writable;
4. compares every complete live range with its expected bytes; and
5. captures every original byte in a rollback image.

If any preflight check fails, zero bytes are written. After preflight, the host
applies operations in request order and reads every complete replacement range
back. If any application or verification step fails, it attempts to restore all
original ranges and verifies the restoration. The result distinguishes:

- rejected before write;
- applied and verified;
- application failed but rollback verified; and
- rollback could not be verified.

A rollback-verification failure disables further writes for that host session.
No failed transaction is automatically retried.

This contract is atomic with respect to host validation and recovery, not with
respect to arbitrary game threads. Stable-window gating and minimal operation
size remain mandatory.

## First live write proof

The first write uses one existing active CPU suitor and one already-allocated,
verified influence field. It does not modify references, board membership,
offers, actions, stage, score, or commitment state.

Proof sequence:

1. Calibrate and capture the authoritative expected bytes.
2. Establish the stable window.
3. Change the influence by a small nearby amount.
4. Verify transaction readback and the visible game UI.
5. Restore the original value with a second guarded transaction.
6. Verify readback, UI restoration, game responsiveness, and that the restored
   recruiting field is present in any newly written autosave.
7. Repeat with a second controlled value and advance one week.
8. Verify the post-advance UI and newly written autosave independently.
9. Reload the Dynasty and confirm the expected value or documented engine
   transformation.
10. Restore from the known-good backup and verify recovery.

Any mismatch disables writes for the session and produces a sanitized
diagnostic bundle.

## Electron boundary

Only Electron main imports `@cfb27/lua-hook`. The preload remains limited to
recruiting-domain methods such as connection state, calibration progress, and a
specific approved test action. It does not expose region discovery, batch reads,
addresses, raw bytes, arbitrary transactions, logs, `evaluate`, or `runScript`.

Electron main validates that the selected save, current game session, calibrated
records, and requested recruiting relationship still match before constructing
a host transaction. Renderer input cannot choose addresses, expected bytes,
replacement bytes, or operation count.

## Error handling

Every layer fails closed:

- unsupported builds may report diagnostics but cannot write;
- ambiguous or missing candidates prevent calibration;
- PID, host-session, week, or validation changes invalidate cached candidates;
- an unstable window cancels the pending transaction;
- any expected-byte mismatch produces zero writes;
- any readback failure triggers rollback;
- any rollback-verification failure disables session writes;
- no write failure is retried automatically; and
- renderer messages use stable public codes and locally defined text, not raw
  native, SDK, path, memory, or Lua errors.

## Verification strategy

### Hook PR A gates

- Native tests cover region protection/type filtering, boundary handling,
  aggregate limits, masked matches, result truncation errors, and bounded
  context reads.
- Protocol and SDK tests cover malformed ranges, excessive requests, fragmented
  frames, invalid payload types, and response-size limits.
- Telemetry tests cover registered types, rejected unknown types, payload depth,
  string/array/object limits, address-field rejection, cursor ordering, and ring
  rollover.
- Native smoke proves discovery and batch reads against controlled private
  allocations without touching the game.
- A manual offline game smoke exercises region enumeration and bounded reads
  without interpreting recruiting fields or performing writes.

### Hook PR B gates

- Preflight mismatch tests prove zero-write behavior.
- Overlap, range, count, and aggregate-size tests prove request rejection.
- Injected application/readback failures prove full rollback.
- Injected rollback failure proves that session writes become disabled.
- Build and anticheat tests prove whole-transaction refusal.
- Existing Lua `write_u8` behavior and protocol v1 consumers remain compatible.
- Native smoke uses controlled memory to verify apply, readback, rollback, and
  sanitized results.

### Brooks integration gates

- Save-to-live values match for the chosen recruit and target.
- Relocation succeeds after menu transitions and a weekly advance.
- Duplicate/cache classification is repeatable.
- Stable-window detection never reports eligible during the observed advance.
- The reversible influence edit appears and restores without a crash.
- The advance/autosave/reload proof produces the expected verified result.
- The original backup remains byte-identical and recoverable.
- Preload source and behavior tests prove no raw hook capability reaches the
  renderer.

## Completion criteria

This design is complete when:

- Hook PR A and its developer release provide verified bounded discovery,
  batch-read, and telemetry contracts;
- Hook PR B and its developer release provide verified guarded transaction and
  rollback contracts;
- Brooks's integration can locate and relocate one authoritative `Recruit` and
  one authoritative `RecruitTarget` relationship;
- one reversible influence edit passes UI and restoration checks;
- one controlled edit passes advance, autosave, reload, and recovery checks;
- no raw address, memory primitive, Lua execution, or unrestricted transaction
  reaches the renderer; and
- the next governor design can rely on measured live layout and timing evidence
  rather than save-layout assumptions.
