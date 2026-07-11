# CFB27 live-hook research

Status: active reverse-engineering notes for the July 10, 2026 CFB27 PC build. A live rating change is **not yet proven end to end**. This document separates confirmed behavior from hypotheses.

## Supported build and safety boundary

- Executable: `CollegeFB27.exe`
- SHA-256: `9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8`
- `SubmitEditPlayerRequest` factory RVA: `0x08A15DE0`
- The injector refuses unknown executables, unknown builds, and sessions where a real EA/Javelin anticheat process is present.
- This project does not implement or distribute an anticheat bypass. Hook testing is limited to the user's separately launched offline session.

## Implemented hook surface

The native DLL uses MinHook and embeds Lua 5.4.8. Its local named-pipe commands are:

- `PING`, `STATUS`, `CLEAR`
- `QUEUE <field> <expected> <value>`
- `RUN <absolute-lua-path>`
- `PATCH <before-record-hex> <after-record-hex>`
- `PATCH_AT <decimal-address> <before-record-hex> <after-record-hex>`

Lua exposes `cfb.queue_rating`, `cfb.status`, and `cfb.patch_record`. `PATCH_AT` and `PATCH` require an exact before image and verify the full after image, preventing blind writes to an unexpected record.

## Schema source and confirmed fields

The full schema is `schema/CFB27_809_0.gz`, sourced from `seanpdwyer7/franchise-mcp-server`. It is loaded as major 809, minor 0, game year 27.

### Player

- Table: `Player`
- Record size in the selected Dynasty: 192 bytes
- Kaelan Chudzinski: row 2070, player ID 25130
- `SpeedRating`: bit offset 1035, length 7
- Saved value: 82
- Changing 82 to 86 changes record byte 129 from `0x54` to `0x55`.

The generated Blaze `PlayerInfo` payload uses byte offsets rather than the save-record bit offsets. Confirmed payload-relative offsets include overall `0x220`, speed `0x29D`, acceleration `0x10`, agility `0x12`, awareness `0x13`, and strength `0x2A1`. `SubmitEditPlayerRequest` has a `0x28`-byte TDF object header, so the request hook must write `request + 0x28 + ratingOffset`. The first hook build omitted the `0x28` header adjustment; that is corrected in the current build.

### League edit controls

- Table: `LeagueSetting`, active row 0
- Table ID 4310, unique ID 87558994, record size 256
- Field: `AbilityEditControls`, bit offset 1952, length 2
- Enum: `NONE=0`, `COMMISHONLY=1`, `ANY=2`, `MAX=3`
- Selected save value before the live test: `COMMISHONLY`
- `COMMISHONLY -> ANY` changes byte 244 from `0x46` to `0x86`.

### User admin controls

- Table: `FranchiseUser`, active row 0
- Table ID 4333, unique ID 3429237668, record size 88
- Field: `AdminLevel`, bit offset 288, length 2
- Enum: `Owner=0`, `Commissioner=1`, `None=2`
- Selected save value before the live test: `None`
- `None -> Owner` changes byte 36 from `0x80` to `0x00`.

The installed franchise library incorrectly expands this enum during parsing. The helper therefore writes only the two schema-defined bits and preserves the other six bits.

## What tests proved

1. Runtime cache objects can be found and modified with read-back verification, but they are presentation/cache copies. Their values are not authoritative.
2. The exact 192-byte live Player table record can be located in a private 40 MiB franchise-table arena and patched from speed 82 to 86. The game later restores it, and the UI remains 82. A direct record write does not execute the game's commit/request path.
3. `LeagueSetting.AbilityEditControls=ANY` and `FranchiseUser.AdminLevel=Owner` can both be applied and held in live table memory.
4. Dynasty menu transitions recycle and replace these table allocations. Fixed addresses are invalid. `live_dynasty.py` therefore re-locates exact records and runs a background repair monitor.
5. In the current test session the combined permission state held for 19 consecutive monitor passes with no errors or reverts.
6. The running game subsequently wrote both permission changes into the selected autosave. Reopening the save with the schema helper reports `AbilityEditControls=ANY` and `AdminLevel=Owner`, with no remaining byte change to apply. This proves that guarded writes to these two authoritative live records can be consumed by the game's normal autosave path.
7. The speed 82-to-86 Player record is now included in the same re-locating monitor. It reached the exact guarded after-state at the current live record address and held across repeated checks. At the time of writing, the already-open game UI still displayed its cached 82 view and the selected autosave still contained 82.
8. A resident `EnterEditResponse` was found with vtable RVA `0x0B230A78`. Its embedded `PlayerInfo` begins at response offset `0xE0`, has vtable RVA `0x0B037270`, contains player ID 25130 at payload offsets `0xD0` and `0x28C`, and reports speed 82 at payload offset `0x29D`. This validates the request payload layout without fabricating field locations.

## Invalid dispatcher experiment

The generated submit wrapper is at RVA `0x084755D0`, uses a `0x3F0`-byte request, and passes command ID `0x3A98` into a lower-level routine at RVA `0x07C597F0`. A validation-only probe successfully checked the response and embedded player identities.

Calling the lower-level routine directly with a cloned payload and null callback/context caused an immediate game process exit. This proves the generated wrapper requires additional game-owned asynchronous state. The probe's `SUBMIT` command was removed; it is now validation-only. Do not call `0x07C597F0` directly again. Future dispatch work must capture and replay the full generated-wrapper context or let the stock UI invoke the wrapper naturally.

## Current blocker

The factory detour has captured zero `SubmitEditPlayerRequest` objects because the stock Dynasty UI has not yet produced an editable-player submission. Permission flags and the visible player values may be cached by higher-level UI models. Permission records are now proven to persist through autosave; the Player rating still requires a menu-reload and autosave proof.

The next useful proof is one of:

1. Back out of the already-open player page and re-enter it while the three-record monitor is active; observe whether speed reloads as 86 and whether the rating controls are editable.
2. If still cached at 82 or locked, trace and invalidate the higher-level player/permission presentation model.
3. Capture a legitimate `SubmitEditPlayerRequest`, validate its field layout, then send the queued speed override through its normal dispatcher and verify the UI and autosave both show 86.

Do not describe the live editor as complete until the changed rating survives a menu reload and is present in a newly written Dynasty autosave.

## Hook allocation fallback

On a later game launch MinHook returned status 9 (`MH_ERROR_MEMORY_ALLOC`) while trying to allocate a near trampoline for RVA `0x08A15DE0`. The target prologue was still the expected 15 bytes. The current hook therefore has an exact-build fallback that:

1. verifies the complete 15-byte factory prologue;
2. allocates an out-of-range executable trampoline;
3. copies only the position-independent prologue instructions;
4. appends an absolute jump back to `factory + 15`; and
5. installs a 14-byte absolute jump to `FactoryDetour`.

The fallback installed successfully in PID 6228 and reported `requestHookReady=true` while the game remained responsive. No rating was queued during this validation.

## Schema/runtime pivot from related repositories

`seanpdwyer7/franchise-mcp-server` and
`brooksg357-a11y/cfb27-dynasty-modding` do not contain a ready live-process
hook, MinHook/Lua injection code, `SubmitEditPlayerRequest`, or verified native
request-object offsets. Their safe FBCHUNKS writer findings agree with this
editor's existing chunk-budget check and byte-preserved CharacterVisuals tail.

The full `CFB27_809_0` schema does expose a more plausible Dynasty edit path:

- `MyPlayerRequest` (asset 6495404) derives from `UIRequestForm`.
- Member 21 is `Player`; member 19 is `Issue`; member 23 is `Refresh`.
- Its constant `TypeName` is `MyPlayerRequest` and title is `Edit Player`.
- `UserRequestIssuer` (asset 6495405) owns member 6 `EditPlayerRequest` and
  member 26 `MyPlayerRequest`.
- The `Player` schema identifies `AccelerationRating` as member 2 and
  `SpeedRating` as member 244. These are schema ordinals, not byte offsets.

The exact supported executable contains `EditPlayerRequest`,
`MyPlayerRequest`, `UserRequestIssuer`, and `MyPlayerRequestStore` anchors. The
corresponding on-disk native code is encrypted, while its pages are decrypted
in the live process. `tools/find_string_xrefs.py` can scan the PE or live
decrypted executable memory with `--pid`.

The fallback pipe and embedded Lua runtime were subsequently verified end to
end on PID 6228: `speed_test.lua` executed and queued an 82-to-86 override.
The detour remained at zero captures during roster/player-card navigation.
This isolates the problem to the selected Blaze factory target, not the
Electron/Python/pipe/Lua transport. Future hook work should trace the FranTk
`MyPlayerRequest -> Request::Issue` path and its typed `Player` member rather
than fabricate or directly dispatch a Blaze payload.

## Verified response-guard edit

The transient `EnterEditResponse` is consumed before the ratings page finishes
loading, so neither the dead Blaze factory nor persistent table-cache objects
can update that page reliably. `cfb27_response_guard.dll` solves this with a
one-shot guard on the exact-build `EnterEditResponse` vtable page:

1. Lua arms a player-specific rating edit.
2. The vectored handler observes the response's first legitimate vtable use.
3. It validates the `EnterEditResponse` vtable, embedded `PlayerInfo` vtable,
   and player ID at both payload identity offsets.
4. It changes the requested rating before the UI consumes the response and
   immediately disarms the guard.

The first successful test ran injected `speed_guard_test.lua` for PresentationId
25130. The handler recorded 24 guarded page events, one fully validated capture,
one applied edit, and original speed 82. Re-entering Kaelan Chudzinski's Edit
Player page displayed speed 86. This proves the Lua-to-game UI path end to end.
The selected Dynasty autosave still contained 82 immediately after the UI proof;
after backing out of the Edit Player screen, the game rewrote the autosave at
22:36:49. Reopening Player row 2070 from disk reported `SpeedRating=86` with no
remaining record-byte change. This verifies the complete path: injected Lua,
guarded response edit, refreshed game UI, authoritative live Player record, and
normal Dynasty autosave persistence.
