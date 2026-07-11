# Developer-preview release checklist

- [ ] Complete the read-only memory and telemetry automated gate before changing
      the preview version.
- [ ] Run `npm ci`, `npm run check`, and `npm test`.
- [ ] Configure and build all native targets with Windows x64 MSVC.
- [ ] Run startup, memory-reader, telemetry, and framed-protocol smoke
      executables from the full Release build.
- [ ] Confirm CLI memory scans automatically follow continuation pages with a
      bounded `--max-pages` value and retain the scan-only timeout.
- [ ] Set `CFB27_NATIVE_ARTIFACTS` to the absolute path of that exact Release
      directory, then run `npm run pack:preview`.
- [ ] Run `git diff --check`.
- [ ] Confirm the staged package and both npm tarballs contain no archive,
      game/save data, schema, logs, dependencies, or build intermediates.
- [ ] Verify the external `dist/SHA256SUMS.txt` against the preview zip. The ZIP
      checksum cannot be embedded in documentation inside that same ZIP.
- [ ] Confirm Windows CI is green.
- [ ] With the game closed, install the exact automated-gate candidate host and
      relaunch MMC offline so no previous DLL remains loaded.
- [ ] Perform the documented offline read-only runtime checklist: confirm hello
      capabilities, bounded sentinel scan/read, advancing registered telemetry,
      ten minutes of responsiveness, and a Dynasty hub transition. Do not use or
      attempt a memory write.
- [ ] Record the date, executable hash, exact commands, and observed results in
      `docs/research/runtime-verification.md` only after observing them.
- [ ] After the manual gate succeeds, set root, SDK, CLI, lockfile, release
      packager, and native hello versions to `0.2.0-dev.1`, then repeat every
      automated build, test, smoke, package-inspection, and diff-check step.
- [ ] Close the game and verify uninstall restores both known MMC hashes.
- [ ] Publish GitHub artifacts only; npm publication is not part of this preview.
