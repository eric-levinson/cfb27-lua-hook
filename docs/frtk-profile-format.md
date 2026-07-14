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

Fields contain `name`, `encoding`, `byteOffset`, `storageBytes`, `bitOffset`, `bitWidth`, `minimum`, `maximum`, and `referenceTableId`. Encodings are `unsigned`, `signed`, `offset-binary`, `bitfield`, and `packed-reference`. Non-reference fields use `null` for `referenceTableId`.

`offset-binary` fields store an unsigned raw bit pattern. Decoding produces `raw + minimum`; encoding stores `value - minimum`. Their declared span, `maximum - minimum`, must fit within the field's unsigned bit width. `signed` remains a separate two's-complement encoding.

Version 1 uses the FrTk physical record layout. `byteOffset` is the first physical byte containing the field, and `bitOffset` counts from the most-significant bit of the `storageBytes` window. The window is assembled in big-endian byte order. For a window of `storageBytes * 8` bits, extraction shifts right by `storageBytes * 8 - bitOffset - bitWidth`; encoding uses the same position and preserves every bit outside the field mask. `storageBytes` is from 1 through 5 so an unaligned field of up to 32 bits can cross five bytes.

Schema export maps schema `s_int` fields to `offset-binary` and derives layout only from the field's physical `offset`, never `indexOffset`: `byteOffset = floor(offset / 8)`, `bitOffset = offset % 8`, and `storageBytes = ceil((bitOffset + length) / 8)`. Packed references remain exactly four bytes with `bitOffset: 0` and `bitWidth: 32`; their numeric encoding is `(tableId << 17) | rowIndex`, stored as four big-endian record bytes.

## Determinism

Profile and layout tables are sorted by table ID. Rows are sorted by row index, fields by byte offset, bit offset, then name, and relationships by source row then field name. Name tie-breakers use ascending UTF-8 bytewise ordinal order, independent of locale (so uppercase ASCII sorts before lowercase ASCII). Patterns are masked before emission so unselected record bits cannot affect output.

`profileId` is the uppercase SHA-256 digest of the canonical version-1 profile and complete field-layout artifact before the ID is inserted. Layout changes therefore change profile identity naturally while JS and native loaders retain canonical digest parity. Paths, timestamps, process addresses, generated-at values, and raw unmasked records are neither emitted nor hashed. File artifacts remain `discovery_only`; digest identity never promotes write authority.
