# Board Mutation API Implementation Plan

> Execute in this workspace with the disposable dynasty backup retained until
> both live operations pass reload verification.

**Goal:** Implement screen-agnostic `addBoard` and `removeBoard` operations that
invoke verified full game routines while any supported recruiting screen is
loaded.

**Architecture:** A build-locked native service performs fresh runtime object
discovery, invokes the full game routines with host-owned pointer cells, and
validates table/runtime postconditions. The pipe protocol and CommonJS SDK add
typed board commands. No table-only fallback and no use of the unsafe inner
remove routine.

---

## 1. Capture and verify the full remove pathway

**Use:**
- `scripts/board-verification/live-anchor.cjs`
- `scripts/board-verification/live-table-snapshot.cjs`
- existing bounded research-watch protocol
- private output under `.frtk/board-verification/`

1. Re-anchor after the current reload and snapshot all six relevant tables.
2. Arm bounded execute watches on the caller region above the rejected inner
   remove call.
3. Ask the user to remove one known recruit through the vanilla UI.
4. Snapshot again and retain only hits whose timing and table diff match that
   UI event.
5. Disassemble the clean chain upward until finding the full routine that owns
   runtime/controller state and accepts a recruit identity or wrapper.
6. Reject generic containers, hot unrelated functions, and any entry observed
   only during synthetic activity.
7. Call the candidate with an already-absent recruit and require a no-op with
   byte-identical tables.
8. With the verified backup available, invoke it once for an on-board recruit,
   then verify compaction, freelists, references, runtime UI state, and reload
   durability.

## 2. Add native board-mutation fixtures and tests

**Create:**
- `native/host/board_mutation.h`
- `native/host/board_mutation.cpp`
- `native/smoke/board_mutation_smoke.cpp`

**Modify:**
- `native/CMakeLists.txt`

Write failing fixture tests for supported-build gating, unique runtime-object
resolution, recruit-row lookup, board-full/already-present/not-present guards,
compact add/remove validation, and postcondition mismatch lockout. Implement
bounded readable-memory scans and pure validation helpers until the smoke test
passes.

Run:

```powershell
cmake --build native/build --config Release --target cfb27_board_mutation_smoke
native/build/Release/cfb27_board_mutation_smoke.exe
```

## 3. Add host protocol commands

**Modify:**
- `native/host/lua_host.cpp`
- `native/host/protocol.*` if shared response helpers are required
- `native/smoke/protocol_smoke.cpp`
- `docs/protocol.md`

Add `boardMutationV1` capability plus `addBoard` and `removeBoard` commands.
Both accept exactly `{ recruitRow }`, serialize on the host write mutex, require
the supported build, and return a normalized result containing operation,
status, recruit row, board slot, and affected rows. Map discovery, state, and
postcondition failures to stable protocol error codes. Test malformed requests,
unsupported builds, capability advertisement, success, unchanged, and lockout.

## 4. Invoke verified full routines

**Modify:**
- `native/host/board_mutation.cpp`
- `native/smoke/board_mutation_smoke.cpp`

Resolve function addresses as supported-module RVAs. Discover the active
recruiting controller and record wrappers fresh per call. Place supporting and
recruit wrapper pointers in local host-owned cells matching the captured ABI.
Invoke add/remove through the existing guarded native-call machinery, then
validate the exact postcondition. Never cache session addresses. Disable board
mutations for the session after an ambiguous partial result.

## 5. Add the SDK surface

**Modify:**
- `packages/sdk/src/client.cjs`
- `packages/sdk/src/errors.cjs`
- `packages/sdk/index.cjs`

**Create:**
- `packages/sdk/test/board-mutation.test.cjs`

Add strict `client.addBoard({ recruitRow })` and
`client.removeBoard({ recruitRow })` methods with capability negotiation,
integer/range validation, cloned input, response validation, and stable error
translation. Test exact wire requests, malformed input, missing capability,
unchanged results, host errors, and malformed responses.

Run:

```powershell
node --test packages/sdk/test/board-mutation.test.cjs
```

## 6. Regression and live acceptance

1. Run the complete native smoke suite and `npm test`.
2. Build and reinstall the hook only while the game is closed.
3. From the Prospect List, add an off-board recruit without selecting them.
4. From the Recruiting Board, remove an on-board recruit by row without relying
   on current selection.
5. Confirm both screens agree immediately, membership remains compact, and the
   relevant allocation/reference state is correct.
6. Back out to materialize the save, reload the dynasty, and verify both changes
   persist.
7. Record the verified RVAs, build hash, behavior, and remaining recruiting-UI
   requirement in `docs/research/runtime-verification.md`.
