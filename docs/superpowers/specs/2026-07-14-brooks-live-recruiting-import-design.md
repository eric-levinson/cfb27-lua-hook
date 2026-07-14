# Brooks Live Recruiting Import Design

## Goal

Bring Brooks's game-verified live recruiting mappings into `cfb27-lua-hook` as a small experimental SDK service for reading and safely rewriting already-allocated recruiting state. Do not require another CFB27/MMC test session and do not claim support for unproven row creation or runtime-cache materialization.

## Evidence boundary

The implementation is based on Brooks's July 14, 2026 evidence through upstream commit `b2b5a7ce4216c5838f1dbd2fb5a76dba6d67e7fe`, especially:

- `recruiting-app/src/live-action-layout.json` version 1.2.0;
- `recruiting-app/src/live-action-write.js` guarded composers;
- the sanitized behavioral facts from the live action-map and pitch-reversal reports.

Committed hook artifacts must not contain Brooks's PID, absolute addresses, save paths, player names, or raw memory dumps. Test fixtures will retain only minimal synthetic bytes and expected decoded values.

## Architecture

Keep the native host and protocol unchanged. Add a focused CommonJS SDK module that composes the hook's existing `scanMemory`, `readMemory`, and `writeTransaction` calls behind typed recruiting operations. This is faster and lower risk than expanding the native FrTk protocol or pretending a generic record-allocation API already exists.

The module owns session calibration, codecs, validation, and expected-byte transactions. Consumers receive decoded recruiting values and stable sanitized errors, never addresses, masks, or byte buffers.

## Supported surface

The first delivery supports only operations backed by Brooks's completed evidence:

- locate and read a `UserRecruitTarget` record for a selected recruit;
- read RecruitingBoard total, processed, and assigned hours from table 4251;
- enable or disable DM the Player, Browse Social Media, and Contact Friends & Family while adjusting assigned hours in the same guarded transaction;
- change `CurrentNILOffer` in place;
- rewrite the content of an existing ActiveRecruitingPitch row without allocating or freeing a row;
- rewrite the content of an existing ActiveVisitInfo row without allocating or freeing a row.

`SendTheHouse` remains excluded until Brooks resolves the observed-bit versus schema-mask conflict. Scholarship offers, scouting, board membership changes, new pitch/visit creation, pitch/visit removal, and any operation that changes a FrTk freelist remain excluded.

## Session and transaction flow

1. Discover the current game and negotiate the existing memory and guarded-transaction capabilities.
2. Calibrate the authoritative live mirrors using the masked reference signatures from the upstream layout.
3. Reject zero or multiple authoritative candidates.
4. Bind calibration to the current PID and discard it when the game, host session, or selected save changes.
5. Read the current record and board-hour bytes immediately before composing a mutation.
6. Validate field ranges, action cost, available board hours, and existing pitch/visit references.
7. Submit one expected-byte `writeTransaction` containing every affected field and hours cell.
8. Return only decoded state or a stable sanitized error.

The service must use the table 4251 RecruitingBoard mirror for hours. The earlier board-array hours candidate was a stale copy and is prohibited.

## Failure behavior

Every uncertainty fails closed. Calibration ambiguity, PID drift, missing references, unsupported actions, insufficient hours, unexpected bytes, transaction rollback, or malformed host responses produce a stable error and no partial success result. Dry-run composition remains available for tests and diagnostics, but no raw operations are returned to consumer applications.

## Testing

Testing is fully automated and offline:

- pure codec tests for references, UserRecruitTarget fields, pitch values, visit values, and packed hours;
- calibration tests using a fake client and synthetic unique/ambiguous/no-match memory pages;
- composer tests derived from Brooks's verified before/after values;
- transaction tests proving contact bits and board hours are changed together;
- failure tests for stale PID, missing pitch/visit rows, insufficient hours, expected-byte mismatch, and rollback errors;
- boundary tests proving the public API returns no addresses, patterns, masks, or bytes.

Run the existing repository checks and test suite. No CFB27, MMC, installed-host, weekly-advance, or autosave gate is required for this delivery.

## Deferred work

Brooks's freelist header discovery and `composeAlloc`/`composeFree` algorithm are retained as research input and synthetic fixtures only. A public allocation capability may be designed later if his staged advance test proves synthetic rows are processed correctly and the derived runtime-cache behavior is understood. That work is not part of this implementation.
