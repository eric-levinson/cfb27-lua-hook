# Board Membership Live Verification Design

## Goal

Expose live board add/remove only after the current game build demonstrates that
the hook can reproduce the game's own board-membership path. Keep the gate small
enough to reach a functional result quickly.

## Selected approach

Use one disposable dynasty or a dynasty with a verified backup and two off-board
recruits. Capture vanilla UI behavior first, identify the real add/remove path
from those events, then invoke that path and compare the result with vanilla.
Use another dynasty load only when the first load produces conflicting evidence.

Two alternatives are rejected:

- An exhaustive matrix across many recruits, saves, weeks, and dynasty modes is
  too expensive for the initial feature gate.
- Synthetic table writes are not a prerequisite for the live API. They may be
  tested later as an explicitly announced fallback, never as an unannounced live
  mutation.

## Safety boundary

- The user performs every vanilla UI add/remove action after capture is armed.
- Before any mutation, use a disposable dynasty or confirm a restorable backup.
- Capture and inspection may be automated; no synthetic board mutation may run
  without a separate announcement.
- Existing pitch, visit, NIL, and contact-action work may continue through
  automated tests because it does not change board membership or freelists.
- `addBoard` and `removeBoard` remain absent until all three gates below pass.

## Gate 1: establish the vanilla delta

Within one live dynasty load:

1. Capture state before and after adding recruit A through the game UI.
2. Repeat the UI add with recruit B.
3. Capture state before and after removing recruit A through the game UI.

Each capture records the relevant board row, membership array, allocated target
rows, freelist headers, packed references, hours, `ProspectInteraction` rows and
list membership, and recruit-keyed runtime heap objects. The comparison derives
the observed object count and table changes; it does not assume Brooks's
six-object conclusion is correct.

Row numbers and heap addresses may vary. The invariant is the structure and
meaning of the delta: allocation or release, references, membership order,
hours, interaction state, and runtime objects. If the two adds disagree in a
material way, repeat on a second dynasty load before proceeding.

## Gate 2: identify and reproduce the real path

Validate breakpoint evidence only against the vanilla events from Gate 1. A
candidate handler must be attributable to one add or remove event, carry the
selected recruit or slot identity, and produce the observed vanilla delta.
Discard generic hot functions, redraw floods, and hits seen only after synthetic
writes.

After the add and remove signatures are captured, invoke the game's own handlers
on the correct game thread for an off-board/on-board recruit pair. Do not expose
an SDK method yet. The proof passes only when the hook-driven operation matches
the structural vanilla delta from Gate 1 and the game remains responsive.

If no attributable handler or safe call site can be established, stop with the
boundary documented as unverified. Do not substitute Brooks's call-chain or
runtime-object conclusions for this capture.

## Gate 3: render and durability check

For both hook-driven add and remove:

1. Confirm the recruiting UI reflects the change immediately or after the same
   ordinary screen transition required by vanilla.
2. Save the dynasty through the game UI and reload it.
3. Confirm board membership and the relevant table/runtime invariants still
   match the intended state.

Screen-change rendering and reload durability are recorded separately. A state
that appears only after reload is not a successful live board mutation.

## Pass and fail outcomes

| Result | Outcome |
|---|---|
| All three gates pass for add and remove | Design and implement guarded `addBoard` and `removeBoard` APIs using the verified game pathway. |
| Add passes but remove fails, or vice versa | Expose neither operation; document the asymmetric evidence and continue focused investigation. |
| Handler invocation changes tables but does not render live | Keep the API closed; classify it as table-only behavior. |
| Live rendering works but save/reload loses the state | Keep the API closed; classify it as non-durable runtime behavior. |
| Evidence conflicts between recruits | Repeat the conflicting action on a second dynasty load before deciding. |
| Capture cannot attribute a real UI handler | Record the exact unverified boundary and stop. |

## Deliverables

- A compact capture report for recruit A add, recruit B add, and recruit A
  remove, with before/after structural deltas.
- Attributable add/remove handler captures with arguments and safe-thread call
  evidence, or an explicit unverified-boundary report.
- Hook-driven render and save/reload results kept separate.
- Only after a full pass, an implementation plan for guarded public board APIs.

