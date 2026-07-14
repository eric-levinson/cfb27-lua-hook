# Final Fix 4 Report

## Result

- `SessionCatalog::Revalidate` now partitions evidence reads deterministically at 64 ranges and 256 KiB per backend call, rejects invalid individual ranges before I/O, preserves flattened evidence order, and performs two complete bounded passes.
- Revalidation requires the second pass to match both the first snapshot and the installed fingerprint/relationship expectations. Failed chunks and between-pass mutations quarantine affected catalog entries; successful snapshots retain every guard without truncation.
- The shared release/archive path policy now rejects `.frtk` segments, `.sav`, `.dmp`, `.dump`, and raw schema/profile JSON artifact names in stage, ZIP, and TGZ scans.
- Compiler and SDK FrTk strings now share strict Unicode-scalar and UTF-8 byte validation for identities, logical names, field names, response strings, and typed field selectors.

## Strict TDD Evidence

Tests were added before production changes and observed failing for the intended reasons:

- Native catalog smoke failed because the existing revalidation made one unbounded pass rather than two bounded passes.
- SDK tests failed because identities/selectors used UTF-16 code-unit bounds and accepted lone surrogates or UTF-8 overflow.
- Real archive tamper tests failed because `.frtk` and the raw artifact path classes were not denied by the shared policy.

After the minimal implementations, the focused native, SDK, and release-package tests passed.

## Verification

- Full Visual Studio CMake Release build using `C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`: passed.
- Native smoke matrix: memory reader, telemetry, memory transaction, FrTk profile, field schema, discovery, catalog, record access, startup, Lua API, and protocol: all 11 passed.
- `npm run check`: passed.
- `npm test`: 161 tests passed, 0 failed.
- `npm run pack:preview`: passed.
- Independent staged-package, release ZIP, and both npm TGZ rescans: passed.
- Release ZIP SHA-256: `7D371D142B08BF407D6D08EF36535622EF46417F72C699C45584151F40B9D54C`.
- `git diff --check`: passed.

No installation, game launch, or MMC launch was performed.

## Reviewer Important Follow-up

- `loadFrtkProfile` now validates the complete cloned version-1 artifact string surface before capability negotiation or socket I/O: fixed uppercase profile ID, profile/layout schema and build identities, table logical names, relationship field names, layout field names, row hex strings, authority status, and field encoding.
- Every bounded public artifact name/identity uses strict Unicode-scalar validation and the native-compatible 1..128 UTF-8 byte limit. Malformed direct bundles return `INVALID_REQUEST`; `loadFrtkProfileFromFile` continues to map them to sanitized `FRTK_PROFILE_INVALID`.
- Valid 128-byte multibyte strings remain accepted, and the valid-artifact caller mutation tests confirm the transmitted clone is isolated from post-call changes.
- Both native `Identity` helpers now call strict `IsValidUtf8`; profile parsing and direct `SchemaRegistry::Load` reject programmatically constructed UTF-8 surrogate byte sequences.

Follow-up strict TDD evidence: the new SDK test first reached the unused pipe instead of returning `INVALID_REQUEST`, while both native smokes first accepted invalid identity bytes. After implementation, the focused suite passed. The fresh full gate then passed the Visual Studio Release build, all 11 native smokes, `npm run check`, all 163 Node tests, package preview, and independent stage/ZIP/two-TGZ rescans. The refreshed ZIP SHA-256 is `4892C124D8997B545D27BA3E71C4EAB9939E86AD37B5EB94DAE28129B1CE6BC3`.

## Raw Record Artifact Follow-up

- The shared private-extension policy now rejects `.raw` files in staging, npm TGZ payloads, and release ZIP payloads.
- Strict TDD reproduced the gap with a real TGZ containing `nested/record.raw`, then confirmed stage parity and real TGZ/ZIP rejection after the one-token policy extension.
- Fresh verification passed `npm run check`, all 163 Node tests, package preview, and independent stage/ZIP/two-TGZ rescans. The refreshed ZIP SHA-256 is `77F5D81C7938D0465FA40E3EE99559D5058406AD2B3CB6E49982C3D67CFEEC5C`.
