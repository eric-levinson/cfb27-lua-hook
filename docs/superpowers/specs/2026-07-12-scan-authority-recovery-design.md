# Scan Authority Recovery Design

**Status:** Approved for recovery implementation

**Date:** 2026-07-12

## Purpose

Repair the read-only discovery contract that prevented the guarded-memory
transaction branch from proving a reversible write in a live offline CFB27
session. The guarded transaction engine remains unchanged unless a regression
test proves a defect in it.

## Failure being corrected

The live gate relied on an exact full-record scan to rediscover one previously
verified authoritative Dynasty permission record. Repeated in-process scans
materialized decoded patterns, masks, 4 MiB scan chunks, and returned match
contexts in ordinary private storage. Those stale or retained copies were
eligible targets on later pages and requests and eventually caused
`TOO_MANY_MATCHES`. An external read-only scan removed those host-created
matches but still found two plausible game-owned `FranchiseUser` copies. The
current response exposes region identity but not allocation identity, so the
gate could not relate candidates across different verified franchise tables.

No live transaction was sent. The safety refusal was correct, but the
end-to-end writing objective was not met.

## Considered approaches

### Add more pointer exclusions

Exclude the current `std::vector` buffers and any result contexts from the
scan. This is insufficient because freed heap blocks can retain earlier
decoded patterns after their owning pointers are gone. It treats observed
addresses rather than the source of the defect.

### Move scanning to a separate process

An external process naturally avoids in-process pattern copies and already
demonstrated clean candidate enumeration. It would, however, create a second
shipping executable, duplicate build and safety negotiation, and break the
existing startup-loaded host ownership boundary. This is disproportionate for
the prerequisite release.

### Use non-private pattern storage and expose allocation identity

This is the selected approach. Decode scan patterns and masks directly into
pagefile-backed mapped views and use the same non-private storage class for the
scan staging buffer and retained match contexts. `VirtualQuery` reports these
views as `MEM_MAPPED`, while the scanner accepts only `MEM_PRIVATE`, so
scanner-owned binary data cannot become a candidate on a later page or request.
Return bounded allocation identity for each real match so the live gate can
group exact records from independent tables and reject ambiguous groups
without guessing.

## Native design

Add a move-only RAII byte buffer backed by `CreateFileMappingW` with
`INVALID_HANDLE_VALUE` and `MapViewOfFile`. It must:

- reject zero length and lengths above the existing 4096-byte pattern limit;
- decode uppercase hexadecimal directly into the mapped view without first
  creating a binary `std::vector`;
- expose an immutable byte span to the scan engine;
- securely clear and unmap the view on destruction; and
- close every mapping handle on success and failure paths.

`ScanRequest.pattern`, `ScanRequest.mask`, the scan staging buffer, and every
`ScanMatch.context` use this mapped storage. Mapped buffers must remain movable
without copying their contents and contexts must remain serializable as bounded
byte spans. The existing scanner remains restricted to complete committed
readable `MEM_PRIVATE` regions. It must not rely on current-buffer pointer
exclusions for correctness; those checks may remain only as defense in depth.

For each match, return:

- the existing address, region base, region size, protection, and bounded
  context;
- `allocationBase`, taken from `MEMORY_BASIC_INFORMATION.AllocationBase`; and
- `allocationSize`, computed as the bounded contiguous virtual extent whose
  regions report that same allocation base;
- `allocationProtect`, taken from the allocation's initial protection; and
- `offsetInAllocation`, computed as the checked difference between the match
  address and allocation base.

Allocation sizes must be overflow checked. Failure to establish allocation
identity fails the scan page rather than returning partial or fabricated
metadata.

## Protocol and SDK design

Add an opt-in `includeAllocationMetadata` boolean to `scanMemory`. When absent
or false, the existing exact response shape is unchanged. When true, every
match additionally requires exact `allocationBase`, `allocationSize`,
`allocationProtect`, and `offsetInAllocation` properties. The host advertises
the `memoryScanAllocationMetadata` capability so an updated SDK fails closed
against an older host.

Addresses remain canonical opaque session values. The SDK strictly validates
the legacy shape when the option is false and the extended shape when it is
true, clones results, and does not persist them. The CLI continues to pass
through the validated JSON result and must not add a write option or
domain-specific classifier.

## Evidence-based live authority rule

The hook remains game-domain neutral. The live gate begins with independently
parsed exact full-record recipes for:

1. `LeagueSetting[0]`;
2. `FranchiseUser[0]`; and
3. one distinctive `Player` row with multiple independently checked identity
   and rating fields.

For every permission candidate, the gate records only in-memory session state:
complete record bytes, a bounded schema-derived neighborhood, allocation
topology, and relationships to the other independently verified records. It
requires a stable candidate set across consecutive samples, then observes a
Dynasty hub to Recruiting screen to Dynasty hub transition and rediscovers from
the save-derived recipes rather than cached addresses.

A candidate may be classified authoritative only when its validated table
neighborhood remains current or relocates with the game-owned Dynasty table
topology. A candidate that disappears with presentation state, retains stale
neighboring data, or fails relocation is excluded as cache/stale. Candidates
that remain indistinguishable are an unresolved replica set and do not permit a
write. Allocation size, address order, and the historical 40 MiB observation
are never authority signals. Every full record must be read and compared again
after the transition and immediately before a transaction. Absolute addresses
are never reused after a PID, host session, allocation, or validation change.

If zero or multiple allocation groups satisfy the rule, the live gate remains
open and no write is sent. Writing every plausible duplicate is explicitly not
an acceptable substitute for authority classification.

## Reversible live-write proof

After unique authority is established in an offline supported-build session:

1. Re-read and validate the complete selected permission record.
2. Send one guarded transaction changing only the byte containing the selected
   two-bit enum field, preserving the other six bits.
3. Read and verify the complete alternate record image.
4. Immediately send a second guarded transaction restoring the original byte.
5. Read and verify the complete original record image.
6. Verify the game remains responsive and the session has not entered write
   lockdown.

No week advance, recruiting write, reference edit, autosave claim, or blind
retry belongs in this prerequisite gate.

## TDD and review gates

- Native RED must prove pattern, mask, staging, and retained match-context
  storage all report `MEM_MAPPED` and that a second scan does not find a
  retained prior-result context.
- Native RED must prove allocation base/size are exact for controlled
  multi-region allocations and fail closed on invalid extent discovery.
- Protocol and SDK RED tests must preserve the legacy response without the
  option, negotiate the capability, and reject missing, noncanonical,
  overflowing, inconsistent, or extra allocation metadata when opted in.
- Existing pagination, response-size, scan-limit, read, transaction, rollback,
  Lua, packaging, and CI gates must remain green.
- A fresh implementer performs each task through RED/GREEN TDD.
- A different subagent reviews specification compliance and code quality after
  each task; Critical and Important findings block progress.
- A whole-branch reviewer gates candidate installation.

## Release boundary

CFB27 and MMC stay closed during implementation and automated verification.
The user receives explicit instructions before candidate installation and again
before relaunch. `0.2.0-dev.2`, a push, pull request, tag, or release is allowed
only after the reversible live-write proof passes and downloaded release assets
verify against their published SHA-256 checksums.

## Completion criteria

This recovery is complete only when:

- repeated host scans no longer return host-created binary pattern copies;
- genuine matches contain strict opt-in allocation identity through native,
  protocol, SDK, and CLI layers;
- one authoritative permission record is uniquely classified using stable
  neighborhoods, allocation lifecycle, three independent full-record recipes,
  and the transition rule;
- the alternate and restoration transactions both apply and verify in CFB27;
- the game remains responsive with writes still enabled; and
- the independently reviewed `v0.2.0-dev.2` prerelease is published immutable
  and its freshly downloaded assets pass SHA-256 verification.
