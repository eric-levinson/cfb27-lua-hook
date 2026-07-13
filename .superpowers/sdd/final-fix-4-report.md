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
