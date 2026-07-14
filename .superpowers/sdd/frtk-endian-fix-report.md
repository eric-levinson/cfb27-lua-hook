# FrTk Endian and Bit-Order Correction Report

## Outcome

- Version-1 field storage now assembles bytes big-endian and interprets `bitOffset` from the MSB of the storage window in both JavaScript and native codecs.
- Decode and encode use `storageBytes * 8 - bitOffset - bitWidth`; writes preserve all bits outside the field mask.
- Storage windows accept one through five bytes, while packed references remain exactly four aligned bytes and retain `(tableId << 17) | row` numeric encoding.
- Native discovery and catalog relationship validation now decode packed-reference record bytes big-endian.
- Programmatic synthetic fixtures across field, discovery, catalog, record-access, Lua, and protocol smokes now match the version-1 physical layout. No private or real raw record bytes were added.
- Artifact, table API, and Lua documentation now state the physical byte/bit semantics, five-byte bound, packed-reference representation, canonical layout identity behavior, and discovery-only authority.

## Strict TDD evidence

- Focused JavaScript RED: aligned packed-reference decoding returned table `4736`/row `32801` instead of table `4288`/row `37`; unaligned golden vectors reversed window bytes; five-byte storage was rejected.
- Compiler RED: a synthetic 32-bit field at MSB offset 4 in a five-byte window was rejected.
- Native RED: field schema rejected the five-byte definition, big-endian packed-reference decode failed, and discovery/catalog rejected synthetic big-endian relationship records.
- GREEN: focused JavaScript field/profile tests passed 39/39; native field-schema, discovery, and catalog smokes passed.
- Full-gate fixture follow-up: record-access, Lua, and protocol smokes exposed remaining synthetic little-endian fixture construction. Those programmatic fixtures were converted to big-endian/MSB-first and each smoke was observed passing before the complete native rerun.

## Private exporter contract

- Ignored `.frtk/profile-export-layout-contract.test.cjs` passed using synthetic metadata only.
- The contract derives `byteOffset = floor(offset / 8)`, `bitOffset = offset % 8`, and `storageBytes = ceil((bitOffset + length) / 8)` from physical `offset`; a deliberately different `indexOffset` is ignored.
- `.frtk/` remained ignored and was not staged.

## Final verification

- `npm run check`: passed.
- `npm test`: 167/167 passed.
- Fresh Visual Studio CMake x64 Release configure/build in `native/build-frtk-endian`: passed using the full Visual Studio CMake path.
- Complete native Release smoke inventory passed: startup, memory reader, telemetry, memory transaction, FrTk profile, field schema, discovery, catalog, record access, Lua API, and gated protocol.
- `npm run pack:preview`: passed; ZIP SHA-256 `C0F6B14382B0435E1952A966DF498DE9F71C93A01AAB09BAA795E83504B33F7E`.
- `git diff --check`: passed.
- Game and MMC processes were absent. No install, game launch, or MMC launch occurred.
