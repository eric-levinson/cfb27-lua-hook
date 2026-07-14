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

Keep the protocol unchanged and reuse the hook's existing typed FrTk catalog: `readFrtkRecords` for reads and `transactFrtkFields` for guarded writes. Add a focused CommonJS SDK service that accepts the discovered catalog generation plus caller-resolved row numbers. Brooks's app already resolves the selected target, board, pitch, and visit rows from the loaded save, so rebuilding his raw-address calibration layer inside the hook would duplicate work and expose more failure modes.

The only host-side authority change is to promote the four Brooks-verified table mirrors after normal profile discovery identifies their persistent Unique IDs and expected layouts: UserRecruitTarget `3987156317`, ActiveVisitInfo `3093586546`, ActiveRecruitingPitch `1559900276`, and RecruitingBoard `220276943`. File profiles remain `discovery_only`; runtime discovery performs the evidence-backed promotion exactly as it already does for Recruit and ProspectTargetSchool.

The SDK service owns action-cost accounting, enum/range validation, and transaction composition. Consumers receive decoded recruiting values and stable sanitized errors, never addresses, masks, or byte buffers.

## Supported surface

The first delivery supports only operations backed by Brooks's completed evidence:

- read the caller-resolved `UserRecruitTarget` row for a selected recruit;
- read RecruitingBoard total, processed, and assigned hours from table 4251;
- enable or disable DM the Player, Browse Social Media, and Contact Friends & Family while adjusting assigned hours in the same guarded transaction;
- change `CurrentNILOffer` in place;
- change the pitch enum in an existing ActiveRecruitingPitch row while preserving its current intensity and cost;
- rewrite the content of an existing ActiveVisitInfo row without allocating or freeing a row.

`SendTheHouse` remains excluded until Brooks resolves the observed-bit versus schema-mask conflict. Scholarship offers, scouting, board membership changes, pitch-intensity changes, new pitch/visit creation, pitch/visit removal, and any operation that changes a FrTk freelist remain excluded.

## Session and transaction flow

1. Load a caller-built FrTk profile, discover the catalog, and retain its generation.
2. Require all four recruiting tables to be present with `direct_verified` runtime authority.
3. Accept the target and board row numbers already resolved by the save-backed consumer; accept an existing pitch or visit row only for the corresponding content rewrite.
4. Read the current typed fields immediately before composing a mutation.
5. Validate field ranges, action cost, available board hours, and existing pitch/visit row selection.
6. Submit one `transactFrtkFields` call containing every affected field, including RecruitingBoard assigned hours for contact-action changes.
7. Return only decoded state or a stable sanitized error.

The service must use the table 4251 RecruitingBoard mirror for hours. The earlier board-array hours candidate was a stale copy and is prohibited.

## Failure behavior

Every uncertainty fails closed. Missing or stale catalog generations, unverified table authority, missing rows, unsupported actions, insufficient hours, transaction rollback, or malformed host responses produce a stable error and no partial success result. Dry-run composition remains available for tests and diagnostics, but no raw field-operation list is returned to consumer applications.

## Testing

Testing is fully automated and offline:

- service tests using a fake typed client and synthetic decoded records;
- discovery smoke tests proving only the four pinned Unique IDs receive runtime write authority;
- composer tests derived from Brooks's verified before/after values;
- transaction tests proving contact bits and board hours are changed together;
- failure tests for stale generation, unverified authority, missing pitch/visit rows, insufficient hours, field-transaction failure, and rollback errors;
- boundary tests proving the public API returns no addresses, patterns, masks, bytes, or raw changes.

Run the existing repository checks and test suite. No CFB27, MMC, installed-host, weekly-advance, or autosave gate is required for this delivery.

## Deferred work

Brooks's freelist header discovery and `composeAlloc`/`composeFree` algorithm are retained as research input and synthetic fixtures only. A public allocation capability may be designed later if his staged advance test proves synthetic rows are processed correctly and the derived runtime-cache behavior is understood. That work is not part of this implementation.
