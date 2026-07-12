# Developer-preview release checklist

This is the release ledger for `0.2.0-dev.2`, not a reusable blank template.
Checked items were completed for this release; unchecked items still require
external GitHub or post-merge work. For a later preview, copy the sequence and
reset every checkbox.

## Reviewed candidate gate

- [x] Complete independent task-level specification and quality reviews, then a
      different-reviewer whole-branch review, before candidate installation.
- [x] Run `npm ci`, `npm run check`, and `npm test`.
- [x] Configure and build all native targets with Windows x64 MSVC.
- [x] Run startup, memory-reader, telemetry, memory-transaction, and
      framed-protocol smoke executables from the full Release build.
- [x] Confirm CLI memory scans automatically follow continuation pages with a
      bounded `--max-pages` value and retain the scan-only timeout.
- [x] Set `CFB27_NATIVE_ARTIFACTS` to the absolute path of that exact Release
      directory, then run `npm run pack:preview`.
- [x] Run `git diff --check`.
- [x] Confirm the staged package and both npm tarballs contain no archive,
      game/save data, schema, logs, dependencies, or build intermediates.
- [x] Verify the external `dist/SHA256SUMS.txt` against the preview ZIP. The ZIP
      checksum cannot be embedded in documentation inside that same ZIP.

## Reversible offline live gate

- [x] With both applications closed, verify the original active proxies, install
      the exact reviewed candidate through the supported SDK or CLI, and
      independently verify the installed proxy and host hashes.
- [x] Relaunch MMC and CFB27 offline to the Dynasty hub. Confirm the supported
      executable, PID, session, capabilities, write eligibility, and exact
      selected-save recipes before opting into any read-only scan.
- [x] Calibrate authority with bounded scans, stable batch rereads, allocation
      topology, and a hub-to-Recruiting-to-hub lifecycle transition. Proceed
      only when exactly one authoritative permission record remains; reject
      presentation copies, stale neighborhoods, and unresolved replicas.
- [x] Immediately revalidate the complete record, change only the byte containing
      the two-bit enum through one guarded transaction, verify the complete
      alternate record and responsiveness, then restore through a second guarded
      transaction and verify the complete original record. Require no lockdown
      and continued write eligibility. Do not advance or write recruiting data.
- [x] Explicitly close both applications and confirm both processes are absent.
- [x] Use the supported uninstall and independently verify both original active
      proxy hashes. Keep both applications closed for release preparation.
- [x] Record the date, executable hash, observed commands and results in
      `docs/research/runtime-verification.md`. Retain hashes, counts, and topology
      relationships, never addresses or raw bytes.

## Final `0.2.0-dev.2` preparation

- [x] Only after live cleanup, set root, SDK, CLI, lockfile, release packager,
      SDK dependency, native hello, public documentation, CI artifact, and
      policy-test versions to `0.2.0-dev.2`.
- [x] Repeat `npm ci`, syntax checks, the full Node suite, a clean Windows x64
      Release build, every native smoke, package preview and inspection,
      internal and external checksum verification, and `git diff --check`.
- [x] Confirm the final bumped host was automated- and smoke-tested only. It was
      not installed or exercised in the live session; live evidence applies to
      the separately hashed reviewed recovery candidate.

## External publication and immutable verification

- [ ] Push the branch and open a draft PR against `main`; confirm Windows CI is
      green, including the memory-transaction smoke and `0.2.0-dev.2` artifact.
- [ ] Complete PR review and merge into `main`.
- [ ] Tag the exact merged commit as `v0.2.0-dev.2`.
- [ ] Publish a GitHub prerelease with the immutable preview ZIP and external
      checksum file. npm publication is not part of this preview.
- [ ] Download both published assets afresh and independently recompute the ZIP
      SHA-256; require an exact match to the downloaded checksum file.
- [ ] Only after the immutable download verification passes, begin the Brooks
      integration gate.
