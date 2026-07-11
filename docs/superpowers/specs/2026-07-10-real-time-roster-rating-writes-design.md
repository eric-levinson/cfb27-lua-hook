# Real-Time Roster Rating Writes

## Goal

Make a rating change from the Live Editor appear in the running game's roster UI without requiring the user to open Edit Player. The preferred result is an immediate repaint of the visible roster row. If the game cannot safely repaint an already-cached row, moving the roster cursor away and back is the only acceptable refresh action.

## Current behavior

The primary Apply flow derives a guarded player-record patch from the selected Dynasty save, arms the verified Edit Player response guard, unlocks Dynasty editing, and starts a guarded live-record monitor. The game persists the live record through its normal autosave path. The response guard applies the value when the game builds `EnterEditResponse`, so the user must currently enter Edit Player once. The project also contains a verified direct-memory rating writer, but the primary UI does not use it.

## Chosen design

Apply uses a layered write transaction:

1. Validate that the game is running offline, the executable build is recognized, the selected save contains the expected player and rating, and all candidate live objects still identify the same player.
2. Derive the exact before/after player-record patch from the selected Dynasty save and start the existing guarded authoritative-record monitor. Do not write the save file directly; let the game persist the live record through autosave.
3. Rediscover the player's live objects immediately before writing. Patch both verified rating bytes in every structurally valid live copy, including cache generations whose current rating differs from the selected save when their player identity and duplicate-byte integrity still match.
4. Arm the existing Edit Player response guard with the new value. This remains a regeneration fallback rather than the primary trigger.
5. Intercept the roster player-data response used to populate or refresh visible rows. For the target `PresentationId`, replace the requested rating before the UI consumes the response.
6. If a safe, build-specific roster-row invalidation function is identified, invoke it only after validating its call site and object identity. Otherwise report that a one-cursor-move refresh is required.

The direct writer and roster response hook share a single pending-change record keyed by game PID, player `PresentationId`, and rating field. Applying a newer value for the same key replaces the previous pending value.

## Components

### Live write service

The server coordinates validation, save patching, live rediscovery, direct memory writes, response-guard queuing, and monitoring. It returns a structured result identifying which layers succeeded:

- `directWrite`: verified object and byte counts
- `rosterGuard`: installed, queued, capture count, and apply count
- `editPlayerGuard`: installed and queued
- `persistenceMonitor`: active state
- `refresh`: `instant`, `cursor`, or `edit-player-fallback`

The transaction fails before any live mutation if offline/build/save/player validation fails. If direct writing begins and a byte verification fails, the existing rollback behavior restores every byte written by that attempt.

### Direct live-object writer

The writer accepts only objects returned by the verified player discovery path. Each object must have the requested `PresentationId` and internally consistent duplicate rating bytes. It writes both copies of the rating and verifies them by rereading the object.

Stale cache generations are not treated as unrelated objects merely because their rating differs. Identity and structural validation determine eligibility; the response hooks prevent regenerated copies from reintroducing the prior value.

### Roster response guard

The native hook observes roster-response construction without modifying requests for unrelated players. A queued change applies only when all of these match:

- recognized executable fingerprint
- expected roster response type or validated vtable/call site
- target `PresentationId`
- supported rating field
- payload bounds and duplicate-field integrity

The hook records captures and applies for status reporting. It must not call an unverified UI function or guess at an object layout.

### UI behavior

Apply shows a concise progression: writing live record, refreshing roster, and persistence armed. On success it reports one of:

- `Updated in the roster now.`
- `Updated live. Move the roster cursor away and back once to refresh.`
- `Updated and saved, but this screen still needs the Edit Player fallback.`

The UI refreshes its own detected-runtime and saved-value columns after Apply so it does not continue displaying the previous expected value.

## Failure handling

- Anticheat present, unknown game build, wrong save, missing player ID, or identity mismatch: block before writing.
- Direct-write verification failure: roll back that attempt and do not claim a live update.
- Roster hook unavailable: preserve the direct write and response-guard fallback, and report the required cursor or Edit Player refresh honestly.
- Game process exits or changes PID: clear pending writes and require reconnection.
- Conflicting Apply operations: serialize per player and field; the newest confirmed value becomes authoritative.
- Game crash during hook research: disable the experimental roster invalidation path by default and retain the already-verified layers.

## Testing

Automated tests cover:

- validation and rollback of direct writes across mixed cache generations
- pending-change replacement and PID scoping
- roster response matching by `PresentationId`
- unrelated players and unsupported fields remaining unchanged
- API status values for instant, cursor-refresh, and fallback outcomes
- UI messaging and refresh-state updates

Manual offline-Dynasty verification uses a reversible rating change:

1. Open the roster and keep the target player visible.
2. Apply a new rating from the Live Editor.
3. Confirm whether the visible cell repaints without input.
4. If not, move the cursor away and back and confirm the new value without entering Edit Player.
5. Open Edit Player to verify the fallback agrees.
6. Back out, allow autosave, rediscover the player, and confirm the selected save and live objects contain the new value.

## Scope boundaries

This change supports the existing verified player rating fields and recognized CFB27 build only. It does not add online support, bypass anticheat, generalize arbitrary memory writes, or call an unverified game UI function. Roster-row repaint work stops at the safest confirmed refresh boundary; the direct-write-plus-cursor-refresh behavior is the required fallback.
