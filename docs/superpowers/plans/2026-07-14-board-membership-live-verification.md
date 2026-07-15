# Board Membership Live Verification Plan

**Goal:** Get live board add/remove working through the game's own current-build
path with the minimum evidence needed to avoid shipping a table-only mutation.

**Scope:** Local offline `CollegeFB27.exe` only. Use a disposable dynasty or a
verified backup. The user performs vanilla UI actions when capture is armed; no
unannounced synthetic board mutation runs.

## Brooks inputs

These are research leads, not accepted conclusions:

| Commit | Useful input |
|---|---|
| `9f42cf13d1200da8212342c46d2a6b6fe6055d06` | Candidate table/header layouts. |
| `5d0a5748287cff0e8f9605fc51f6cf6c6f73a903` | Candidate ProspectInteraction footprint. |
| `b585faa5666245bbd8910a88646533b851b5a55a` | Data-breakpoint capture POC. |
| `cdcaafd01f6b47f52e2789070a4ed163e66cb820` | Execute capture and PE `.pdata` lookup POCs. |
| `9a37dba2bd1b53bc4ceb3f3872a192ad5efd79fd` | Candidate clean-chain RVAs. |
| `27dceed2fe9538fc977ae0b1e4ebc4c70c7bd932` | Six-runtime-object hypothesis. |
| `550274bd85dceec7f3c7d712d5d5fe687cfc5060` | Board add/remove dossier. |

## Gate 1: Capture the real UI path

Build only the tools needed to capture one clean vanilla sequence:

1. Snapshot the relevant board row, membership list, freelists, references,
   hours, ProspectInteraction state, and recruit-keyed runtime objects.
2. Arm bounded data/execute breakpoints using Brooks's POCs as starting points.
3. With the user, capture UI add A, UI add B, and UI remove A.
4. Accept a handler only when its arguments identify the selected recruit and
   its event produces the captured structural delta. Reject hot redraw and
   generic-container hits.

Implementation files:

- `scripts/board-verification/board-state.cjs`
- `scripts/board-verification/capture-handler.cjs`
- `scripts/board-verification/pe-functions.cjs`
- `native/host/research_watch.h`
- `native/host/research_watch.cpp`
- `native/smoke/research_watch_smoke.cpp`
- `tests/board-verification.test.cjs`

Private captures stay under `.frtk/board-verification/`. If the two adds
materially disagree, repeat only the conflicting action on a second dynasty
load. The observed runtime-object count wins; six is not the expected answer.

The reusable call primitive required for replay is already implemented:

- `native/host/native_call.h/.cpp`
- protocol capability and command `nativeCall`
- SDK `client.nativeCall({ address, arguments })`
- Lua `cfb.call(target, ...)`

It accepts a committed executable address, zero to eight Win64 integer/pointer
arguments, and a 64-bit return value. Calls are serialized and guarded for
structured exceptions. It does not schedule itself onto a game-owned UI thread.

Gate 1 passes when add and remove each have an attributable current-build
handler, argument shape, and thread requirement. Otherwise record the exact
unverified boundary and stop.

## Gate 2: Reproduce add and remove

After Gate 1 passes, announce the mutation test and use the disposable/backup
dynasty:

1. Invoke the captured add handler for an off-board recruit using the native
   call primitive and the verified thread/call path.
2. Compare the complete structural delta with the vanilla add delta.
3. Invoke the captured remove handler for that recruit and compare it with the
   vanilla remove delta.
4. Confirm the recruiting screen reflects both operations immediately or after
   the same ordinary screen transition vanilla needs.

Do not substitute direct table writes if a handler call fails. A table change
that appears only after a screen change or reload is recorded as such and does
not pass live reproduction.

Gate 2 passes only when both directions match vanilla structurally and render
live without destabilizing the game.

## Gate 3: Prove durability, then expose the API

For the hook-driven add and remove:

1. Save through the game UI, reload, and verify membership plus the captured
   table/runtime invariants.
2. Record immediate rendering, reload materialization, and save durability as
   separate results in `docs/research/runtime-verification.md`.
3. If both operations pass, implement guarded `addBoard` and `removeBoard`
   wrappers that resolve only the verified build handlers and validate board
   preconditions before dispatch.
4. If either direction fails, expose neither wrapper and document the boundary.

Before committing each implementation slice, run:

```powershell
npm run check
npm test
cmake --build native/build-release --config Release
```

No public board API exists until all three gates pass. Portable pitch, visit,
NIL, and contact-action work remains independent of this gate.
