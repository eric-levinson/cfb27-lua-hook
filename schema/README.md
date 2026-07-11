# Local Schema Files

This directory holds generated schema and research files used by the local editor.

Only this README is committed. The generated files themselves are ignored because they come from a local game install and local save data.

## Source

Current local source used for schema extraction:

```text
F:\EA SPORTS College Football 27\Data\Win32\superbundlelayout\football_installpackage_00\cas_62.cas
```

The CAS file contains a plaintext FranTk schema XML payload for:

```text
CollegeFB27_Gen5.CFB27_RL
```

## Generated Files

Expected generated files:

- `CollegeFB27_Gen5_CFB27_RL_schemas.xml`
  - Extracted FranTk XML schema payload.
- `recruiting_schema_index.json`
  - Compact schema/enum index used by the app's Schema tab.
- `CFB27_809_0.gz`
  - Converted schema bundle used by `madden-franchise` through `schemaOverride`.
- `DYNASTY-decompressed-FrTk.bin`
  - Optional local research artifact containing a decompressed dynasty payload. This is save-derived and should never be committed.

## How The App Uses This Directory

The structured dynasty editor depends on:

```text
schema/CFB27_809_0.gz
```

That file lets `madden-franchise` read tables with real names instead of anonymous fields. For example:

- `Player.FirstName`
- `Player.LastName`
- `Player.JerseyNum`
- `Player.SpeedRating`
- `Recruit.NationalRank`
- `Recruit.Player`

The Schema tab can also read:

```text
schema/recruiting_schema_index.json
```

That index is used for read-only schema inspection and occurrence search.

## Important Tables

Known useful tables include:

- `Player`
  - Player identity, position, archetype/player type, development trait, deal breaker, mental abilities, physical ability ranks, jersey number, body fields, visual references, and ratings.
- `Recruit`
  - Recruiting rank fields and a `Player` reference.
- `RecruitTarget`
  - Recruiting target data.
- `RecruitingBoard`
  - Board-level recruiting data.
- `UserRecruitTarget`
  - User/team-specific recruit targeting data.
- `CharacterVisuals`
  - Binary visual payloads. Not decoded into safe editable hair/skin fields yet.

## Trait Mapping Notes

Some trait fields are direct schema enum values:

- `Player.PlayerType`
- `Player.TraitDevelopment`
- `Player.MentalAbility1`
- `Player.MentalAbility2`
- `Player.MentalAbility3`
- `Player.MentalAbilityRank1`
- `Player.MentalAbilityRank2`
- `Player.MentalAbilityRank3`
- `Player.PhysicalAbility1` through `Player.PhysicalAbility5`

Physical abilities store rank slots on the player. The visible names are resolved by player type/archetype. For example:

- `QB_FieldGeneral`: Resistance, Step Up, Sleight of Hand, Dot!, On Time
- `S_Zone`: Ballhawk, Lay Out, House Call, Robber, Knockout

`Player.RecruitingDealbreaker` is typed as `RecruitingMotivationType`, but the current generated schema exposes it as a raw 32-bit field through `madden-franchise`. The app decodes the first 4 bits to map the deal breaker and preserves the remaining bits when writing a new deal breaker value.

## Git Policy

The following generated files are intentionally ignored:

```text
schema/*.xml
schema/*.json
schema/*.gz
schema/*.bin
```

Keep these files local. Do not publish game-extracted schemas or save-derived payloads unless the legal and privacy implications are explicitly reviewed.
