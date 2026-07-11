# CFB27 Save Editor

Reverse-engineering and live-hook findings are tracked in [docs/live-hook-research.md](docs/live-hook-research.md).
Persistent startup scripting, the Lua API, and recovery steps are documented in
[docs/live-lua-host.md](docs/live-lua-host.md).

Local web app for inspecting and editing EA SPORTS College Football 27 save files.

The app runs entirely on your machine. The backend is a Python stdlib HTTP server, the frontend is vanilla HTML/CSS/JS, and structured dynasty table edits are handled with `madden-franchise` using a locally extracted CFB27 FranTk schema.

## What This Edits

The app is intentionally conservative. It only edits top-level save files in the save directory and rejects backup folders, nested paths, and arbitrary filesystem paths.

Supported files discovered so far:

- `DYNASTY-*`: dynasty saves, including recruits and dynasty `Player` table records.
- `ROSTER-Official`: roster save, using the older TLV-style player scanner.
- `PROFILE-COLLEGE`: parsed as an `FBCHUNKS` file, but not currently a main player-edit target.

Manual editor writes create a timestamped backup in `cfb27-save-editor/backups/` before overwriting the original save. Generator apply is safer by default: it creates the backup, then writes a new top-level `*-MODDED-*` dynasty save copy and leaves the selected source save unchanged.

Development note: keep the repo/dev environment outside the live cloud-save folder, for example under `C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27-codex\saves\cfb27-save-editor`. It is still valid to output generated dynasty save copies to `C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves` for in-game loading. In-game validation is most reliable after using the default dynasty save naming shape, for example `DYNASTY-JUL02-07h43m00-AUTOSAVE`; keep long `*-MODDED-*` filenames as local artifacts unless they are known to load.

## Current Editing Support

### Dynasty Recruits

Recruit editing is backed by the structured FrTk tables inside the dynasty save.

The app joins:

- `Recruit`: recruiting-specific fields.
- `Player`: actual player identity, body, jersey, ratings, and visual references.
- `Recruit.Player`: the reference that points each recruit row to its player row.

Editable recruit fields:

- national rank
- position rank
- state rank

Editable linked player fields:

- first name
- last name
- position
- archetype display
- development trait
- deal breaker
- mental abilities and ranks
- physical ability names and ranks
- jersey number
- height in inches
- weight in pounds
- head asset

Editable verified ratings:

- General: `OVR`, `SPD`, `ACC`, `STR`, `AGI`, `AWR`, `JMP`, `INJ`, `STA`, `TGH`
- Ballcarrier: `CAR`, `BTK`, `TRK`, `COD`, `BCV`, `SFA`, `SPM`, `JKM`, `BSK`
- Blocking: `RBK`, `PBK`, `IBL`, `RBP`, `RBF`, `PBP`, `PBF`, `LBK`
- Passing: `THP`, `TUP`, `SAC`, `MAC`, `DAC`, `TOR`, `PAC`
- Defense: `TAK`, `PMV`, `FMV`, `BSH`, `PUR`, `PRC`, `MCV`, `ZCV`, `POW`, `PRS`
- Receiving: `CTH`, `SPC`, `CIT`, `SRR`, `MRR`, `DRR`
- Kicking/returns: `KPW`, `KAC`, `KRT`

Skin tone and hair hints are decoded from the head asset name when present, but direct skin/hair editing is still read-only until the `CharacterVisuals.RawData` offsets are verified.

Physical ability names are resolved from the player's archetype/player type when the mapping is verified. The rank slots are editable. The first verified mappings are:

- `QB_FieldGeneral`: Resistance, Step Up, Sleight of Hand, Dot!, On Time
- `S_Zone`: Ballhawk, Lay Out, House Call, Robber, Knockout

Mental abilities are stored directly on the player as three ability slots plus three rank slots. Examples:

- `TheNatural` -> The Natural
- `RoadFanFavorite` -> Road Dog
- `FieldGeneral` -> Field General
- `DBRally` -> Legion

Development trait is stored as `Player.TraitDevelopment`. CFB-specific values include:

- `College_Impact` -> Impact
- `College_Star` -> Star
- `College_Elite` -> Elite

Manual edits can read back these enum values, but generator-wide development-trait writes are held in preview-only mode until disposable modded dynasty copies are proven to load in game.

Deal breaker is stored in `Player.RecruitingDealbreaker`. In this schema it is exposed as a raw bit value, but the first 4 bits map to `RecruitingMotivationType`. Verified examples:

- `0111...` -> Conference Prestige
- `1001...` -> Playing Time

### Roster TLV Players

The roster file has a different layout from dynasty saves. The current TLV scanner supports known-safe string edits for:

- internal player id
- first name
- last name
- hometown

This route is separate from the dynasty FrTk table editor.

## How Field Mapping Works

The dynasty save acts like a database.

At a high level:

```text
Recruit row
  NationalRank
  PositionRank
  StateRank
  Player -> reference to a Player row

Player row
  FirstName
  LastName
  PlayerType
  TraitDevelopment
  RecruitingDealbreaker
  MentalAbility1
  PhysicalAbility1
  JerseyNum
  SpeedRating
  CatchingRating
  ...
```

The app reads the `Recruit.Player` reference, jumps to the matching `Player` row, and displays both records as one row in the UI.

Example:

```text
Recruit row 2792
  NationalRank = 1
  Player -> Player row 6457

Player row 6457
  FirstName = Isaac
  LastName = Bynum
  Position = LE
  PlayerType = DE_SmallerSpeedRusher
  TraitDevelopment = College_Impact
  JerseyNum = 96
  SpeedRating = 86
```

Displayed as:

```text
Rank 1 | Isaac Bynum | LE | #96 | SPD 86
```

The field names come from the locally extracted CFB27 schema. For example:

```text
Player.FirstName -> First
Player.LastName -> Last
Player.PlayerType -> Archetype display
Player.TraitDevelopment -> Dev
Player.RecruitingDealbreaker -> Deal
Player.JerseyNum -> #
Player.SpeedRating -> SPD
Player.ZoneCoverageRating -> ZCV
Recruit.NationalRank -> Nat Rank
```

The rating mappings were verified against EA's launch ratings pages for Jelani McDonald and Charlie Becker, then matched to local `Player` table fields. Their values matched exactly for the mapped rating fields.

Important note: raw field numbers from other tools may not match the generated schema index. For example, one external reference labels a raw field as jersey number, but the generated schema maps the verified jersey field to `Player.JerseyNum`.

Some display names are not stored directly. For physical traits, the player stores rank slots such as `PhysicalAbility1`, and the visible trait names are resolved from the player's archetype/player type. For deal breakers, the app decodes the first 4 bits of `RecruitingDealbreaker` and preserves the remaining raw bits when changing the selected deal breaker.

## Save Format Notes

The top-level save files are `FBCHUNKS` containers. Dynasty saves are not just one compressed blob: they contain a zlib-compressed FrTk database, zero slack, and a trailing non-database `CharacterVisuals` chunk that must stay at its original offset.

The Python backend:

1. Reads the `FBCHUNKS` header.
2. Decompresses the zlib payload.
3. Passes the decompressed FrTk payload to the structured editor.
4. Receives a rebuilt decompressed payload.
5. Recompresses the FrTk database.
6. Verifies the compressed database fits before the preserved tail.
7. Rebuilds the original `FBCHUNKS` container while preserving the zero slack and `CharacterVisuals` tail byte-for-byte.
8. Verifies the rebuilt file can be parsed again.
9. Creates a timestamped backup.
10. Writes the edited save atomically.
11. For generator apply, writes a new modded save copy by default, reloads that target, and compares intended generated writes against read-back joined profiles.

The Node helper intentionally does not write the outer save container. It only rebuilds the decompressed FrTk payload after `madden-franchise` updates table records. Python owns the outer container rebuild so the app avoids double-wrapping or corrupting the save.

Star rating writes are available as an explicit generator option. Use `Star Write -> Request Write` for controlled game-load validation; development trait generator writes remain preview-only until their enum behavior is verified in-game.

## Project Layout

```text
cfb27-save-editor/
  server.py                    Python HTTP server, FBCHUNKS handling, API routes
  franchise_helper.js          Node helper for structured FrTk Player/Recruit reads/writes
  static/
    index.html                 App shell
    app.js                     Frontend state, API calls, editable tables
    styles.css                 UI styling
  schema/
    README.md                  Notes about locally generated schema files
  tools/
    inspect_player_ratings.js  Research helper for checking Player rating values
  test_editor.py               Unit/integration tests using copied save files
  package.json                 Node dependency and npm scripts
```

Ignored local-only folders/files:

- `node_modules/`
- `backups/`
- `server.log`
- `server.err.log`
- `schema/*.xml`
- `schema/*.json`
- `schema/*.gz`
- `schema/*.bin`

The generated schema files and save-derived payloads are not committed because they come from the local game install and local saves.

## Local Requirements

- Windows
- Python 3.10+
- Node.js
- npm
- Local CFB27 save files
- Local schema file: `schema/CFB27_809_0.gz` (required for structured Dynasty editing and intentionally not committed)

Install Node dependencies:

```powershell
npm install
```

## Run

From `cfb27-save-editor/`:

```powershell
npm start
```

When the repo is outside the live game save folder, point the server at the real save directory:

```powershell
$env:CFB27_SAVE_DIR = "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves"
npm start
```

The server also reads `CFB27_SAVE_DIR` from a local ignored `.env` file in the repo root when the environment variable is not already set.

Equivalent direct command:

```powershell
python server.py --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

## Test

Run the fast default checks:

```powershell
npm test
```

Useful focused commands:

```powershell
npm run check
npm run test:recruiting
```

Run the full save-heavy suite only when you need full regression coverage:

```powershell
npm run test:full
```

Equivalent direct full-suite command:

```powershell
python -m unittest -v test_editor.py
```

The full suite takes several minutes on local dynasty fixtures. It uses temporary copies for write checks and verifies:

- all top-level `FBCHUNKS` saves parse and decompress
- no-edit rebuilds can be parsed again
- known roster TLV player strings can be patched
- high-confidence table string cells can be patched
- structured recruit/player fields can be patched
- recruit jersey number, weight, and ratings can be written on a copy
- development trait, deal breaker, mental trait, and physical trait rank can be written on a copy
- backups are created before writes
- nested paths and backup folders are rejected

## Working With Schema Files

The app expects generated schema files in `schema/` when using structured dynasty table editing.

Current local source:

```text
F:\EA SPORTS College Football 27\Data\Win32\superbundlelayout\football_installpackage_00\cas_62.cas
```

The extracted schema identifies tables and fields such as:

- `Player`
- `Recruit`
- `RecruitTarget`
- `RecruitingBoard`
- `UserRecruitTarget`
- `CharacterVisuals`

The app uses a local `schema/CFB27_809_0.gz` file for `madden-franchise` schema override support. This game-derived file is intentionally ignored by Git; provide it from your own local setup before using structured Dynasty editing.

## Safety Rules

The app follows these rules before writing a save:

- Only write top-level editable save files.
- Reject paths containing `/`, `\`, `..`, or nested directories.
- Reject unsupported fields.
- Validate text length and basic character constraints.
- Validate numeric ranges for ranks, body fields, jersey number, and ratings.
- Rebuild the save in memory first.
- Preserve the post-database tail, including `CharacterVisuals`, byte-for-byte.
- Refuse writes when the recompressed FrTk database would exceed the original chunk-1 budget.
- Re-parse the rebuilt `FBCHUNKS` output before writing.
- Create a timestamped backup before writing.
- Write bytes through a same-directory temporary file and atomic replace.
- For generator apply, write a new `*-MODDED-*` save copy by default so the selected save remains unchanged.
- Treat local parser/read-back success as necessary but not proof that the game will load the save; use disposable modded copies for game-load verification.

## Current Limitations

- Skin tone and hair are not directly editable yet.
- `CharacterVisuals.RawData` is visible as a reference/blob but not decoded into safe writable fields.
- Physical ability display-name mappings are verified for known archetypes first; unmapped archetypes show generic `Physical 1` through `Physical 5` names while still exposing rank slots.
- Changing archetype/player type itself is still read-only because it affects position-specific ability name resolution and likely other logic.
- Generator-wide `Player.TraitDevelopment` writes are preview-only until game-load validation proves they are safe at recruit scale.
- The generic table browser is useful for inspection, but low-confidence inferred groups are read-only.
- The roster file and dynasty file use different structures, so features do not automatically transfer between them.
- Rating mappings are verified for the structured dynasty `Player` table, not the older TLV roster scanner.

## Useful Research Helpers

Scan joined recruit/player link integrity and observed early-gate values from a decompressed FrTk payload:

```powershell
node franchise_helper.js research "$env:TEMP\cfb27-DYNASTY-JUL02-07h43m00-AUTOSAVE.frk" 1000
```

Write the same research scan to a durable JSON artifact:

```powershell
node franchise_helper.js research "$env:TEMP\cfb27-DYNASTY-JUL02-07h43m00-AUTOSAVE.frk" 1000 ".requirements\research\rg1-local-dynasty.json"
```

The research JSON includes RG-1 link integrity, observed values for early gated fields, field readability metadata, and a `missingFields` list for unsupported schema fields.

Normalize pinned upstream CFB27 research ZIPs into local provenance artifacts:

```powershell
python tools/upstream_import.py
```

By default this reads:

- `.requirements\upstream-cache\FB-Roster-Editor-main.zip`
- `.requirements\upstream-cache\My-CFB-Dynasty-Manager-main.zip`

The importer does not enable writes. It records archive hashes, declared pinned commits, selected source files, schema/tuning leads, OVR/archetype references, and team/workflow leads under `.requirements\research\upstream-*`. The current ZIPs include the `dynasty-tuning-binary` summary but not the referenced per-table JSON/CSV exports, so those table exports still need regeneration before upstream enum labels can become high-confidence UI labels.

Export the concrete CFB27 recruiting tuning tables after `FB-Roster-Editor` has been extracted under `.requirements\upstream-cache\FB-Roster-Editor`:

```powershell
python tools/upstream_tuning_export.py
python tools/upstream_import.py
python tools/upstream_decode_maps.py
python tools/upstream_label_confidence.py
```

The tuning exporter runs the upstream `madden_franchise_bridge.mjs` against `dynasty-tuning-binary.FTC`, batch-exports recruiting-related `FRANCHISE_*.json` tables, derives matching CSV files, and writes `.requirements\research\upstream-cfb27-recruiting-tuning-tables.json`. Run the importer afterward so `upstream-cfb27-tuning-summary.json` links to the local exported JSON/CSV files. The decode-map command builds `.requirements\research\upstream-cfb27-recruiting-decode-maps.json`, which the recruiting diff helper uses for read-only labels. The label-confidence command writes `.requirements\research\upstream-cfb27-recruiting-label-confidence.json` and `.md`, separating validated local fixture labels from upstream-only labels and unresolved reference windows.

Diff two full dynasty `FBCHUNKS` saves for weekly recruiting board/action research:

```powershell
python tools/recruiting_diff.py `
  --before ".requirements\ref-data\pre-season-0\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --after ".requirements\ref-data\week-0\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --before-label pre-season-0 `
  --after-label week-0 `
  --user-team Oregon `
  --output-json ".requirements\research\015-pre-season-0-to-week-0-recruiting-diff.json" `
  --output-md ".requirements\research\015-pre-season-0-to-week-0-recruiting-diff.md"
```

The recruiting diff helper is read-only. It decompresses each save into a temporary payload, reads the structured recruiting table family through the local schema, joins `UserRecruitTarget` rows to recruit/player rows, and writes compact JSON/Markdown reports. Reports include board-candidate counter reconciliation, scheduled-visit evidence, and raw `ProspectInteraction` byte notes where changed rows need bit-overlap review.

Create a copy-first live recruiting action probe from a full dynasty save:

```powershell
python tools/recruiting_probe.py `
  --source "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --user-target-row 1 `
  --action SearchSocialMedia `
  --board-row 87
```

The probe writer creates a new `*-MODDED-RECRUITING-PROBE-ACTION` save beside the source and refuses to overwrite an existing file. It supports one or more weekly action boolean toggles and can reconcile `RecruitingBoard.RecruitingHoursAssigned` for the known board row. `SendTheHouse` is treated as a validated weekly action mapping based on local probes plus matching upstream/schema/tuning sources.

```powershell
python tools/recruiting_probe.py `
  --source "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --user-target-row 9 `
  --action SendTheHouse `
  --board-row 87
```

Experimental field patches are also exposed for faster live checks. These are copy-first unless `--replace-active` is passed.

```powershell
python tools/recruiting_probe.py `
  --source "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --user-target-row 9 `
  --sway-pitch Aspirational `
  --commit `
  --committed-week 7 `
  --no-board-hours
```

For lower-level sell/sway experiments, omit `--active-pitch-row` to discover the row from the target's
`ActivePitches` list. `--active-pitch-index` defaults to `0`. Existing game-created active pitch rows
are validated for copy-first pitch/intensity probes, and the helper can encode pitch and intensity labels
into the packed `ActiveRecruitingPitch` bit window:

```powershell
python tools/recruiting_probe.py `
  --source "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --user-target-row 9 `
  --pitch Aspirational `
  --pitch-intensity Sway `
  --no-board-hours
```

If a specific `ActiveRecruitingPitch` row is already known, pass `--active-pitch-row` as an override.
Forced allocation of new `ActiveRecruitingPitch` rows or new `UserRecruitTarget.ActivePitches` references remains blocked.
Recruiting diff reports may show same-recruit `RecruitTarget.ActivePitches` rows as read-only evidence, but those
global rows do not expose a safe team/school owner field in this schema and should not be used as write targets.
Failed validation: `DYNASTY-JUL02-07h43m00-AUTOSAVE-MODDED-SEEDED-SWAY-016-20260705` parsed locally but did not load in game. Treat seeded `ActiveRecruitingPitch` row/list allocation as blocked unless the full allocation recipe is proven; only naturally existing linked active-pitch rows are eligible for future copy-first probes.
The helper now filters all-zero reference slots as empty, so `UserRecruitTarget.ActivePitches` discovery refuses empty list slots instead of treating them as valid pitch rows.
Load/week validation: the SwayPitch-only save loaded after being renamed to `DYNASTY-JUL02-07h43m00-AUTOSAVE` and survived a week advance. Stanley Herron is not a good functional sell/sway candidate because he already carries `SendTheHouse` at 50h. A row-only `ActiveRecruitingPitch[1164]` follow-up was refused because that row is empty/unavailable in the baseline, confirming that forced empty-row creation should remain blocked.
Manual candidate note: Kenyon Tabor looked clean in the save data but is locked out in the game UI, so save-field cleanliness is not enough. For sell/sway fixture capture, choose a target where the UI actually allows adding a sell or sway action; the current code cannot reliably infer that lock state yet.
Manual sell/sway fixture breakthrough: a user-created setup produced naturally linked `UserRecruitTarget.ActivePitches` rows for Stanley Herron, Jamie Martini, and Teddy Krenzel. The first safe follow-up candidate patches only Teddy Krenzel's existing `ActiveRecruitingPitch[1347].Pitch` from Coach Connection to College Experience while preserving Soft Sell intensity and the 20h cost: `DYNASTY-JUL02-07h43m00-AUTOSAVE-MODDED-NATURAL-PITCH-ONLY-016-20260705`. For in-game validation, prefer replacing/renaming to the default-style `DYNASTY-JUL02-07h43m00-AUTOSAVE` name.
The natural pitch-only probe loaded and survived a week advance. The next isolation candidate patches only Teddy Krenzel's existing `ActiveRecruitingPitch[1347].Intensity` from Soft Sell to Hard Sell while leaving the pitch as College Experience and leaving board-hour fields unchanged: `DYNASTY-JUL02-07h43m00-AUTOSAVE-MODDED-NATURAL-HARDSELL-ONLY-016-20260705`.
The natural Hard Sell intensity probe also loaded and survived a week advance. The follow-up Sway isolation candidate changed Teddy Krenzel's existing `ActiveRecruitingPitch[1347].Intensity` from Hard Sell to Sway while leaving the pitch as College Experience and leaving board-hour fields unchanged: `DYNASTY-JUL02-07h43m00-AUTOSAVE-MODDED-NATURAL-SWAY-ONLY-016-20260705`. The game displayed Sway correctly, so the natural sell/sway probe chain is complete; week-advance proof exists for pitch-only and Hard Sell, while Sway is accepted as UI-validated per the final 016 checkpoint.
Use `--patch-json` for lower-level experiments such as `ActivePitches` references or multi-row sell/sway chains.

For faster live validation, pass a JSON patch with multiple action toggles:

```powershell
python tools/recruiting_probe.py `
  --source "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL02-07h43m00-AUTOSAVE" `
  --patch-json ".requirements\research\live-probe-martini-max-actions.json"
```

The multi-toggle patch supports `patches[]` entries with `userRecruitTargetRow`, `actionField`, and `enabled`. The board hour counter is reconciled once from the net action-hour delta. Add `--replace-active` only when you want the tool to back up the active save and write the probe back to the original filename for faster in-game loading.

Inspect known player ratings from a decompressed FrTk payload:

```powershell
node tools/inspect_player_ratings.js "$env:TEMP\cfb27-DYNASTY-JUL02-07h43m00-AUTOSAVE.frk" Jelani McDonald
node tools/inspect_player_ratings.js "$env:TEMP\cfb27-DYNASTY-JUL02-07h43m00-AUTOSAVE.frk" Charlie Becker
```

This helper is for mapping work only. The app itself reads live saves through the Python server.

## Related References

- `madden-franchise`: structured FrTk table parsing/writing.
- EA public player ratings pages: used to verify player rating field mappings.
- Community CFB27 dynasty-modding research: useful cross-check for raw fields and writer safety.
