# Screen-Agnostic Board Mutation API Design

**Date:** 2026-07-15

## Goal

Expose guarded `addBoard` and `removeBoard` operations that use the current
game build's own recruiting runtime pathways. The caller identifies a recruit;
the operation must not depend on that recruit being selected or on the Prospect
List being the active screen. Keeping the broader recruiting UI loaded is an
acceptable first-release requirement.

## Evidence Boundary

The full UI add routine at module RVA `0x8109060` is independently verified.
It produced the same table allocations and compact membership append as a
vanilla UI add, rendered in the UI, and survived a dynasty reload.

The low-level remove routine at RVA `0x80116B0` is explicitly rejected. Calling
it alone left stale runtime state and caused a membership hole on a later UI
add. `removeBoard` will not call or wrap that routine. Its full UI entry point
and postconditions must be captured from another real removal before exposure.

## Architecture

Add a build-locked native board-mutation service in the injected host. Each
request performs fresh runtime discovery rather than caching session pointers:

1. Resolve the supported module and current recruiting runtime objects.
2. Resolve the requested recruit by stable recruit row/reference, independent
   of UI selection.
3. Require one unambiguous controller, recruit wrapper, and supporting runtime
   object set. Fail closed when recruiting is not loaded or discovery is
   ambiguous.
4. Invoke the verified full game routine using host-owned pointer cells.
5. Re-read the relevant board membership, allocation rows, references, and
   freelists and accept the operation only when its complete postcondition is
   present.

The SDK exposes recruit-row-based methods and translates host failures into
clear errors such as recruiting-not-loaded, already-on-board, not-on-board,
board-full, runtime-discovery-ambiguous, and postcondition-failed.

## Operations

### `addBoard({ recruitRow })`

Use the verified full add routine. Require an off-board recruit, a compact free
membership slot, and available allocation rows before invocation. Success must
show exactly one membership append and the expected linked rows/references.
An already-boarded recruit returns an unchanged result.

### `removeBoard({ recruitRow })`

First capture the full remove entry point from a real UI removal and validate it
with a no-op plus one backed-up synthetic invocation. Success must show compact
membership removal, correct freelist returns, cleared recruit/active-pitch
references, consistent runtime state, immediate rendering, and reload
durability. Only then expose it through the same host and SDK surface.

## Safety and Scope

- Supported executable hash only.
- Recruiting UI may be required to be loaded, but no specific recruiting
  screen or selected row is required.
- No table-only board mutation fallback.
- No cached runtime pointer reuse across requests or dynasty loads.
- Serialize board mutations and reject concurrent requests.
- A postcondition mismatch disables further board mutations for the session and
  instructs the caller to reload the dynasty.

## Verification

Native smoke tests cover locator uniqueness, argument validation, state guards,
postcondition validation, and failure paths using synthetic memory fixtures.
SDK tests cover request validation and error mapping. Live acceptance covers
add and remove from more than one recruiting screen, immediate UI state, board
compaction, and reload durability using a verified backup.
