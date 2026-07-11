# Real-Time Roster Rating Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Live Editor Apply update all verified live player objects immediately, retain the Edit Player response guard as a fallback, and report whether the roster refreshed instantly or needs one cursor move.

**Architecture:** Extend the verified memory writer so each structurally valid cache generation is updated and individually rollback-safe. Wire that writer into the existing `/api/live/hook/apply-rating` transaction before queuing the response guard, then refresh the browser model from a new discovery result. Use the resulting in-game behavior to determine whether a separate roster-response hook is still required.

**Tech Stack:** Python 3 standard library and `ctypes`, JavaScript browser UI, C++/CMake native hooks, Python `unittest`.

## Global Constraints

- Support only the existing verified player rating fields and recognized CFB27 executable fingerprint.
- Block writes when a real EA anticheat/Javelin process is present.
- Require matching player `PresentationId` and duplicate-byte integrity for every written object.
- Preserve rollback for every byte written during a failed attempt.
- Do not call an unverified game UI function.
- Keep the Edit Player response guard and autosave monitor as fallbacks.

---

### Task 1: Patch every verified live cache generation safely

**Files:**
- Modify: `live_process.py:581-716`
- Test: `test_editor.py:20-185`

**Interfaces:**
- Consumes: `decode_live_player_object(data: bytes, address: int) -> dict` and `live_rating_write_addresses(object_address: int, field: str) -> tuple[int, int]`
- Produces: `plan_live_rating_object_writes(objects: list[dict], player_id: int, field: str, value: int) -> list[dict]`
- Updates: `write_live_player_rating(pid, object_addresses, player_id, field, expected_before, value) -> dict`

- [ ] **Step 1: Write failing plan tests**

Add tests proving that objects with current values 86, 87, and 82 all receive the requested value when identity and duplicate integrity match, that rollback metadata retains each object's own prior value, and that a player-ID or duplicate-integrity mismatch raises before writing.

```python
def test_live_rating_write_plan_accepts_verified_mixed_generations(self) -> None:
    objects = [
        {"address": 0x1000, "playerId": 25130, "ratings": {"speed": 86}, "duplicateRatingBytesValid": True},
        {"address": 0x2000, "playerId": 25130, "ratings": {"speed": 87}, "duplicateRatingBytesValid": True},
        {"address": 0x3000, "playerId": 25130, "ratings": {"speed": 82}, "duplicateRatingBytesValid": True},
    ]
    plan = plan_live_rating_object_writes(objects, 25130, "speed", 90)
    self.assertEqual([item["before"] for item in plan], [86, 87, 82])
    self.assertTrue(all(item["after"] == 90 for item in plan))
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `python -m unittest -v test_editor.EditorTests.test_live_rating_write_plan_accepts_verified_mixed_generations test_editor.EditorTests.test_live_rating_write_plan_rejects_identity_or_integrity_mismatch`

Expected: failure because `plan_live_rating_object_writes` does not exist.

- [ ] **Step 3: Implement the pure write planner and use it in the writer**

The planner validates every decoded object and records its own prior value:

```python
def plan_live_rating_object_writes(objects, player_id, field, value):
    plan = []
    for item in objects:
        if int(item["playerId"]) != player_id:
            raise RuntimeError("Player ID changed; rediscover the player")
        if not item["duplicateRatingBytesValid"]:
            raise RuntimeError("Rating duplicate integrity failed; rediscover the player")
        plan.append({"address": int(item["address"]), "before": int(item["ratings"][field]), "after": value})
    return plan
```

Update `write_live_player_rating` to decode all requested addresses, build the plan, write both bytes for each object, and roll each target back to that plan entry's `before` value. Keep `expected_before` for save/UI concurrency reporting but do not exclude structurally valid stale cache generations solely because their current rating differs.

- [ ] **Step 4: Run focused and syntax tests**

Run: `python -m unittest -v test_editor.EditorTests.test_live_rating_write_plan_accepts_verified_mixed_generations test_editor.EditorTests.test_live_rating_write_plan_rejects_identity_or_integrity_mismatch`

Expected: both pass.

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add live_process.py test_editor.py
git commit -m "Write all verified live player copies"
```

### Task 2: Make direct writing the primary Apply path

**Files:**
- Modify: `server.py:5648-5688`
- Modify: `static/app.js:502-536`
- Test: `test_editor.py`

**Interfaces:**
- Consumes: `discover_live_player_objects(pid, player_id, ratings)` and the updated `write_live_player_rating(...)`
- Produces: `apply_live_rating_layers(pid: int, save_path: Path, row: int, field: str, expected: int, value: int) -> dict`
- API result keys: `directWrite`, `queued`, `unlocked`, `patch`, `monitor`, `discovery`, and `refresh`

- [ ] **Step 1: Write failing transaction tests**

Patch the discovery, writer, response-guard, unlock, and monitor dependencies. Assert call order and a result with `refresh="instant-pending-verification"`. Add a failure test proving discovery or direct-write failure prevents a success result and does not claim the guard completed the transaction.

```python
@patch("server.start_dynasty_unlock_monitor")
@patch("server.unlock_dynasty_player_editing")
@patch("server.queue_response_rating")
@patch("server.write_live_player_rating")
@patch("server.discover_live_player_objects")
def test_apply_live_rating_layers_writes_before_arming_fallback(self, discover, write, queue, unlock, monitor):
    result = apply_live_rating_layers(PID, SAVE_PATH, 100, "speed", 87, 82)
    self.assertTrue(result["directWrite"]["verified"])
    self.assertEqual(result["refresh"], "instant-pending-verification")
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `python -m unittest -v test_editor.EditorTests.test_apply_live_rating_layers_writes_before_arming_fallback`

Expected: failure because `apply_live_rating_layers` does not exist.

- [ ] **Step 3: Implement the transaction helper and endpoint wiring**

The helper must:

1. derive `player_rating_patch` from the selected save;
2. validate `expectedBefore` and `PresentationId`;
3. rediscover live objects using the save-derived rating map;
4. call `write_live_player_rating` with every discovered object address;
5. queue the response guard;
6. unlock editing and start the persistence monitor;
7. rediscover once after writing for browser readback.

Replace the endpoint's inline orchestration with this helper and return its structured result.

- [ ] **Step 4: Refresh browser state and honest status copy**

After Apply, merge the returned post-write discovery and patched saved value into `state.live.playerResult`, rerender the player table, and report:

```javascript
const refreshMessage = response.refresh === "instant"
  ? "Updated in the roster now."
  : "Updated live. If the roster still shows the old value, move the cursor away and back once.";
setStatus(`${player.firstName} ${player.lastName} ${field} ${before} → ${next}. ${refreshMessage}`);
```

Do not instruct the user to open Edit Player unless the API explicitly returns `edit-player-fallback`.

- [ ] **Step 5: Run focused UI/API tests and checks**

Run: `python -m unittest -v test_editor.EditorTests.test_apply_live_rating_layers_writes_before_arming_fallback test_editor.EditorTests.test_live_apply_ui_prefers_direct_write_message`

Expected: pass.

Run: `npm run check && npm test`

Expected: exit 0 and 11 fast tests pass.

- [ ] **Step 6: Commit**

```bash
git add server.py static/app.js test_editor.py
git commit -m "Apply live ratings without Edit Player"
```

### Task 3: Verify roster repaint and add only the required fallback hook

**Files:**
- Modify if required: `native/response_guard.cpp`
- Modify if required: `native/CMakeLists.txt`
- Modify if required: `native_hook.py`
- Modify if required: `server.py`
- Modify if required: `static/app.js`
- Modify: `docs/live-hook-research.md`
- Test: `test_editor.py`

**Interfaces:**
- Consumes: Task 2's `directWrite`, post-write `discovery`, and response-guard status
- Produces if needed: roster guard status with `loaded`, `ready`, `captures`, `applies`, and `lastPlayerId`

- [ ] **Step 1: Build the existing native targets and run the automated baseline**

Run the repository's configured Visual Studio CMake build for `native/`, then run `npm run check && npm test`.

Expected: native build exit 0, checks exit 0, and fast tests pass.

- [ ] **Step 2: Perform the reversible in-game direct-write test**

With Chudzinski visible on the roster, apply Speed 82 to 83 through the UI. Record whether the visible roster cell changes with no controller input. If not, move the cursor away and back once and record whether it changes without entering Edit Player.

- [ ] **Step 3: Classify the observed refresh boundary**

- Immediate repaint: return `refresh="instant"`; no new native hook is added.
- Cursor movement refresh: return `refresh="cursor"`; keep the direct-write fallback and update UI copy accordingly.
- Still requires Edit Player: extend native tracing to identify the roster player-data response before implementing a write hook.

- [ ] **Step 4: If tracing is required, add a read-only roster response probe first**

Clone the proven response-guard pipe/status pattern but record only validated response vtable/call-site, player ID, payload size, and rating offsets. Do not mutate a roster response until repeated captures for the selected player show stable identity and bounds.

- [ ] **Step 5: Add a guarded roster response mutation only after validation**

Queue by PID, `PresentationId`, field, and value. Apply only at the validated response boundary and expose capture/apply counters. Preserve the Edit Player response guard separately.

- [ ] **Step 6: Re-run verification**

Run: `npm run check && npm test`

Expected: exit 0 and fast tests pass.

Repeat the reversible roster test. Expected: immediate repaint or cursor-only refresh, with no Edit Player visit. Back out to trigger autosave, rediscover, and confirm the selected save contains the new value.

- [ ] **Step 7: Document and commit the verified boundary**

Record the exact executable fingerprint, response identity evidence, observed refresh behavior, and fallback mode in `docs/live-hook-research.md`.

```bash
git add native native_hook.py server.py static/app.js test_editor.py docs/live-hook-research.md
git commit -m "Refresh roster ratings from live writes"
```
