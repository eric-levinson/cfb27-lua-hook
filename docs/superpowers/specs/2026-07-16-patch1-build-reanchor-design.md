# Patch 1 Build Re-Anchor Design

**Date:** 2026-07-16

## Goal

Restore the CFB27 Lua Hook on the July 16 Patch 1 executable and replace the
current one-off offset update process with a repeatable, fail-closed re-anchor
workflow for later game updates.

The repair covers the active hook only. It does not revive archived edit-player
hooks or modify Brooks's SPEX data. It must preserve the current offline-only
safety boundary and must not edit an active save during discovery.

## Confirmed Inputs

The previously supported executable is:

- size: `247845776` bytes;
- SHA-256: `9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8`.

The installed Patch 1 executable is:

- path: `F:\EA SPORTS College Football 27\CollegeFB27.exe`;
- size: `249801616` bytes;
- SHA-256: `A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD`.

The active board implementation contains four build-local values that cannot
be carried forward without new evidence:

- generic record-wrapper vtable RVA `0xB093F68`;
- recruiting-controller vtable RVA `0xB0B5BA8`;
- full board-add routine RVA `0x8109060`;
- full board-remove routine RVA `0x8166090`.

MMC 1.1.0.1 still supplies the recognized stock `CryptBase.dll`:

- size: `95744` bytes;
- SHA-256: `3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454`.

The new MMC folder is clean: its `ThirdParty\CryptBase.dll` is the stock proxy
and it has no `MMCBase.dll`. The old MMC folder was already hook-installed.
The existing reversible installer therefore remains compatible with MMC
1.1.0.1 and should create and verify the new folder's backup normally.

Brooks's post-patch static sweep found all six dynasty FTC files byte-identical,
including `dynasty-expression-binary.FTC`. His `live-action-layout.json` v1.5.0
is a consumer-side live table-anchor map, not an executable hook. SPEX is out of
scope for this repair. The unchanged FTC evidence makes the live table layout
likely stable, but it does not replace a live post-patch validation.

## Design Principles

1. An unknown executable is never write-enabled.
2. A known diagnostic build is not automatically a supported mutation build.
3. Session addresses are evidence, never configuration.
4. Production RVAs remain compiled into the host; an ignored calibration file
   cannot grant write authority.
5. Table anchors are rediscovered and structurally validated every session.
6. Native routines and vtables are accepted only after independent capture and
   postcondition evidence.
7. Previous build layouts remain available instead of being overwritten by the
   newest layout.

## Build Registry

Move executable identity and native layout values into one native build
registry. Each entry contains:

- executable size and uppercase SHA-256;
- build label;
- support state: `diagnostic` or `certified`;
- optional board layout containing the two vtable RVAs and two full-routine
  RVAs.

The existing July 11 build becomes a `certified` entry with its current values.
Patch 1 begins as `diagnostic`, with no board layout. The registry returns one
of three runtime states:

- `unknown`: executable identity is absent;
- `diagnostic`: exact identity is recognized for read-only research, but game
  writes and native calls remain blocked;
- `certified`: exact identity and board layout passed the complete acceptance
  gate.

The public `supportedBuild` field remains true only for `certified` builds so
existing SDK safety semantics do not weaken. `writesAllowed` also requires a
certified build, offline status, no real anticheat process, and no session
lockout.

Read-only memory scanning continues to require the caller's existing explicit
unsupported-build opt-in for non-certified builds. Research watches may run on
an exact `diagnostic` build because they install debug-register watches but do
not write game data or call game routines. Arbitrary native calls, memory
transactions, FrTk writes, live-class replacement, and board mutations remain
blocked while the build is diagnostic.

## Re-Anchor Workflow

Create one guided developer script under `scripts/board-verification/` that
coordinates the existing SDK, table-anchor logic, and research-watch API. It
writes all raw and derived evidence below `.frtk/board-reanchor/<sha256>/`,
which remains ignored and is never packaged.

### Phase 1: Preflight

The script must:

1. Hash `CollegeFB27.exe` and require the exact diagnostic registry entry.
2. Confirm the process executable matches the on-disk file.
3. Confirm the host is ready but reports `supportedBuild: false` and
   `writesAllowed: false`.
4. Confirm the real EA/Javelin anticheat process is absent.
5. Record the PID and reject evidence from another PID or later host session.

Any mismatch stops the run without arming watches.

### Phase 2: Table-Anchor Validation

Locate and structurally validate the six tables used by the live recruiting
layout:

- UserRecruitTarget `4168`;
- ActiveVisitInfo `4176`;
- ActiveRecruitingPitch `4190`;
- RecruitingBoard `4251`;
- ActiveRecruitingPitch array `5790`;
- RecruitTarget membership array `5847`.

Use the existing 16-byte header signature
`[table1Length][table1Length][recordWords][capacity]`, derive the data address
from the save-header geometry, and score freelist and content structure. A
table passes only when one candidate wins unambiguously and its record
references, capacity, stride, freelist head, and board relationships are
consistent. Re-read the winning headers and sample rows before accepting them.

This phase validates Brooks's v1.5.0 anchor constants as a consumer of the hook
and validates the subset embedded in `board_mutation.cpp`. It does not promote
the executable to certified status.

### Phase 3: Vanilla UI Capture

Use a disposable dynasty or a dynasty with a verified backup. Discovery never
performs a synthetic mutation.

For board add:

1. Select an off-board recruit while the script watches the validated 4168
   freelist head and first free 5847 membership slot.
2. Perform one vanilla UI add.
3. Collect write hits, RIPs, register snapshots, stack return addresses, and
   pointed-to qwords.
4. Re-anchor the tables and verify the vanilla allocation and compact
   membership postcondition.
5. Repeat with a second recruit to reject incidental call sites.

For board remove:

1. Select an on-board recruit with no pitch, visit, or assigned action that
   would make the capture ambiguous.
2. Watch the validated membership row and relevant freelist heads.
3. Perform one vanilla UI remove and collect the same evidence.
4. Verify membership compaction, cleared references, and both freelist returns.
5. Repeat once to reject incidental call sites.

Candidate full-routine entries must appear consistently in both captures of an
operation and must receive arguments shaped as the active controller plus
pointer cells containing Team and Recruit wrappers. Low-level allocation or
table-only routines are rejected even if they occur in every capture.

### Phase 4: Vtable Derivation

Derive vtable candidates from the captured, structurally verified objects:

- the controller must expose the expected membership row, descriptor table
  identity, and readable board store;
- the Recruit and Team wrappers must expose their expected descriptor table
  identities and row numbers;
- each first qword must lie inside the main module's readable image;
- every sampled vtable function pointer must target executable image memory.

Convert accepted module addresses to RVAs only after those checks. Repeat the
object discovery after a recruiting-screen transition; the object addresses
may change, but the vtable RVAs must remain identical.

### Phase 5: Candidate Artifact

Emit a candidate artifact containing:

- executable size and SHA-256;
- table-anchor validation summary;
- proposed four RVAs;
- capture counts and consistency checks;
- PE-section checks;
- PID/session identity;
- pass/fail status for every required evidence gate.

The artifact may retain raw process addresses because it is ignored local
research material. Committed documentation records only build identity, RVAs,
and sanitized verification results. The artifact is never loaded by the
production host and cannot enable writes.

## Promotion and Live Acceptance

After reviewing the candidate artifact, add the Patch 1 board layout to the
compiled registry and mark it certified only in the local acceptance build.
The branch is not releasable until all of these gates pass:

1. Full automated Node and native smoke suites.
2. Clean Windows x64 Release build.
3. Installer/doctor verification against MMC 1.1.0.1.
4. Host status: exact new build, ready, certified, and offline write-eligible.
5. Already-present add returns unchanged without a native call.
6. Already-absent remove returns unchanged without a native call.
7. One real guarded add on the disposable dynasty produces exactly one 4168
   allocation, one 5790 allocation, and one compact membership append.
8. One real guarded remove returns both rows to their freelists, clears the
   references, and compacts membership.
9. The board renders after a normal recruiting screen transition.
10. The result survives the game's normal autosave and dynasty reload.
11. Host ticks, status, and write eligibility remain healthy with no session
    lockout.
12. The verified backup remains byte-identical and recoverable.

A native fault, ambiguous discovery result, unexpected table change, or failed
postcondition disables further board mutations for the session. The build
returns to diagnostic state in source until the candidate is corrected and the
complete gate is rerun.

## MMC 1.1.0.1 Deployment

The existing installer remains the only supported deployment path. With the
game closed, it must:

1. recognize the game's preserved `MMCBase.dll` and installed forwarding
   `CryptBase.dll`;
2. recognize the new MMC folder's stock `ThirdParty\CryptBase.dll`;
3. create and verify `ThirdParty\MMCBase.dll` in MMC 1.1.0.1;
4. install the forwarding proxy in both locations;
5. install the rebuilt host and autorun script under `CFB27LiveEditor`;
6. verify every resulting hash.

No manual proxy copy is part of the design. Uninstall must restore both stock
proxies and verify the recognized stock hash.

## Failure Handling

- Unknown build: read-only diagnostics only with explicit opt-in; no research
  watches, native calls, or writes.
- Diagnostic build: table scans and research watches allowed; all game-data
  writes and native calls blocked.
- Table ambiguity: discard the session evidence and do not continue to capture.
- Capture inconsistency: keep the raw local evidence, emit a failed artifact,
  and require another vanilla capture.
- Vtable or PE-section mismatch: reject the candidate.
- Native-call fault or postcondition failure: lock board mutations for the
  session and instruct the operator to reload the disposable dynasty.
- Installer conflict: leave both locations unchanged or roll back both to
  their verified prior state.

## Future Update Procedure

For a later executable update, the intended recovery path is:

1. add the new exact executable identity as diagnostic;
2. build and install the diagnostic host;
3. run the guided re-anchor script;
4. perform the prompted vanilla add and remove actions;
5. review the generated candidate artifact;
6. add the reviewed RVAs to the compiled registry;
7. run the complete acceptance gate;
8. promote and release only after success.

Table anchors should normally revalidate automatically. Vtable discovery is
expected to be automatic once matching runtime objects exist. Native routine
recovery remains guided because arbitrary game updates may change call graphs,
argument conventions, or behavior. The workflow promises deterministic,
evidence-backed recovery and safe failure, not blind automatic promotion.

## Out of Scope

- Patching or decoding SPEX bytecode.
- Updating Brooks's repository or consumer-side hardcoded table IDs.
- Reviving archived `SubmitEditPlayerRequest` or edit-response hooks.
- Supporting online play or bypassing anticheat.
- Shipping raw process addresses, memory dumps, save files, or calibration
  artifacts.
- Automatically certifying a build solely because its old signatures still
  match.
