# CFB27 Save Editor

Local web app for inspecting and editing EA SPORTS College Football 27 save files.

The app runs entirely on your machine. The backend is a Python stdlib HTTP server, the frontend is vanilla HTML/CSS/JS, and structured dynasty table edits are handled with `madden-franchise` using a locally extracted CFB27 FranTk schema.

## What This Edits

The app is intentionally conservative. It only edits top-level save files in the save directory and rejects backup folders, nested paths, and arbitrary filesystem paths.

Supported files discovered so far:

- `DYNASTY-*`: dynasty saves, including recruits and dynasty `Player` table records.
- `ROSTER-Official`: roster save, using the older TLV-style player scanner.
- `PROFILE-COLLEGE`: parsed as an `FBCHUNKS` file, but not currently a main player-edit target.

Every write creates a timestamped backup in `cfb27-save-editor/backups/` before overwriting the original save.

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

The top-level save files are `FBCHUNKS` containers.

The Python backend:

1. Reads the `FBCHUNKS` header.
2. Decompresses the zlib payload.
3. Passes the decompressed FrTk payload to the structured editor.
4. Receives a rebuilt decompressed payload.
5. Recompresses it into the original `FBCHUNKS` container.
6. Verifies the rebuilt file can be parsed again.
7. Creates a timestamped backup.
8. Writes the edited save.

The Node helper intentionally does not write the outer save container. It only rebuilds the decompressed FrTk payload after `madden-franchise` updates table records. Python owns the outer container rebuild so the app avoids double-wrapping or corrupting the save.

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
- Generated schema file: `schema/CFB27_schema_for_madden_franchise.gz`

Install Node dependencies:

```powershell
npm install
```

## Run

From `cfb27-save-editor/`:

```powershell
npm start
```

Equivalent direct command:

```powershell
python server.py --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

## Test

Run:

```powershell
npm test
```

Equivalent direct command:

```powershell
python -m unittest -v test_editor.py
```

The tests use temporary copies for write checks. They verify:

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

The app currently uses the generated `CFB27_schema_for_madden_franchise.gz` file for `madden-franchise` schema override support.

## Safety Rules

The app follows these rules before writing a save:

- Only write top-level editable save files.
- Reject paths containing `/`, `\`, `..`, or nested directories.
- Reject unsupported fields.
- Validate text length and basic character constraints.
- Validate numeric ranges for ranks, body fields, jersey number, and ratings.
- Rebuild the save in memory first.
- Re-parse the rebuilt `FBCHUNKS` output before writing.
- Create a timestamped backup before overwrite.

## Current Limitations

- Skin tone and hair are not directly editable yet.
- `CharacterVisuals.RawData` is visible as a reference/blob but not decoded into safe writable fields.
- Physical ability display-name mappings are verified for known archetypes first; unmapped archetypes show generic `Physical 1` through `Physical 5` names while still exposing rank slots.
- Changing archetype/player type itself is still read-only because it affects position-specific ability name resolution and likely other logic.
- The generic table browser is useful for inspection, but low-confidence inferred groups are read-only.
- The roster file and dynasty file use different structures, so features do not automatically transfer between them.
- Rating mappings are verified for the structured dynasty `Player` table, not the older TLV roster scanner.

## Useful Research Helpers

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
