# FrTk profile and field-layout format

The local profile builder converts a normalized snapshot and a complete field layout into a deterministic version-1 bundle. It selects whole tables in bulk; it is not a field-by-field calibration workflow.

## Privacy boundary

Snapshot JSON, schema JSON, generated profiles, save files, raw records, addresses, and memory dumps are local material. Keep all builder inputs and outputs under the repository's ignored `.frtk/` directory. They are not release artifacts. Only the programmatically generated synthetic fixtures under `packages/sdk/test/fixtures/frtk/` may be committed.

The builder refuses any input or output path outside `.frtk/`, refuses unknown arguments, and creates output exclusively unless `--force` is supplied:

```powershell
node scripts/build-frtk-profile.cjs `
  --snapshot .frtk/snapshot.json `
  --layout .frtk/layout.json `
  --output .frtk/profile.json
```

The output file contains `{ "profile": ..., "layout": ... }` in canonical JSON key order.

## Compiler inputs

The snapshot root has exactly `schemaIdentity`, `buildIdentity`, and `tables`. Each table supplies `logicalName`, `tableId`, `uniqueId`, `capacity`, `recordSize`, `rows`, and `relationships`. A row contains `rowIndex`, uppercase `recordHex`, and an equal-length uppercase `maskHex`. Each table needs at least three distinct occupied row patterns and at least 64 selected mask bits across its rows.

A relationship contains `sourceRow`, `fieldName`, `targetTableId`, and `targetRow`. Every target table ID must be present in the same build-specific snapshot and must resolve through that profile to one required Unique ID. Unique ID is the persistent table identity. Logical names are display labels only, and table IDs are current-build routing values for packed references; neither may be used as a persistent/public selector.

The layout root has the same identity keys and a `tables` array. Table identity and dimensions must exactly match the snapshot. Each table adds an `authorityStatus` and all of its `fields`. Authority is one of `discovery_only`, `commit_adapter_required`, or `direct_verified`.

Fields contain `name`, `encoding`, `byteOffset`, `storageBytes`, `bitOffset`, `bitWidth`, `minimum`, `maximum`, and `referenceTableId`. Encodings are `unsigned`, `signed`, `bitfield`, and `packed-reference`. Non-reference fields use `null` for `referenceTableId`. Packed references occupy 32 bits and encode `(tableId << 17) | rowIndex`.

## Determinism

Profile and layout tables are sorted by table ID. Rows are sorted by row index, fields by byte offset, bit offset, then name, and relationships by source row then field name. Name tie-breakers use ascending UTF-8 bytewise ordinal order, independent of locale (so uppercase ASCII sorts before lowercase ASCII). Patterns are masked before emission so unselected record bits cannot affect output.

`profileId` is the uppercase SHA-256 digest of canonical version-1 profile content before the ID is inserted. Paths, timestamps, process addresses, generated-at values, and raw unmasked records are neither emitted nor hashed.
