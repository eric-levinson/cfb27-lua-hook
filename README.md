# CFB27 Save Editor

Local web app for inspecting and editing EA SPORTS College Football 27 save files.

The app runs on a Python stdlib HTTP server with a vanilla HTML/CSS/JS frontend. It handles the outer `FBCHUNKS` container in Python and uses `madden-franchise` for structured FrTk table reads/writes.

## Current Editing Support

- Top-level save files only; backup folders and nested paths are rejected.
- Timestamped backup before every write.
- Roster TLV string edits for known-safe player fields.
- Structured dynasty recruit editing through joined `Recruit` and `Player` tables:
  - national rank
  - position rank
  - state rank
  - first name
  - last name
  - position
  - height in inches
  - weight in pounds
  - head asset
  - verified player ratings: OVR, SPD, ACC, STR, AGI, AWR, JMP, INJ, STA, TGH, CAR, BTK, TRK, COD, BCV, SFA, SPM, JKM, BSK, RBK, PBK, IBL, RBP, RBF, PBP, PBF, LBK, THP, TUP, SAC, MAC, DAC, TOR, PAC, TAK, PMV, FMV, BSH, PUR, PRC, MCV, ZCV, POW, PRS, CTH, SPC, CIT, SRR, MRR, DRR, KPW, KAC, KRT
- Skin tone and hair hints are decoded from the head asset name when present, but remain read-only until the `CharacterVisuals.RawData` offsets are verified.

Rating mappings were checked against EA's launch ratings pages for Jelani McDonald and Charlie Becker, then matched to local `Player` table schema fields.

## Local Requirements

- Python 3.10+
- Node.js
- `npm install`
- Generated local schema files in `schema/`, especially `CFB27_schema_for_madden_franchise.gz`

Generated schema and save-derived files are intentionally ignored by Git. They come from the local game install and local saves, and should stay on the machine that owns them.

## Run

```powershell
npm install
python server.py --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

## Test

```powershell
python -m unittest -v test_editor.py
```
