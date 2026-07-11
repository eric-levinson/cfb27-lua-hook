# Developer-preview release checklist

- [ ] Confirm version `0.1.0-dev.1` in the root, SDK, CLI, and native hello.
- [ ] Run `npm ci`, `npm run check`, and `npm test`.
- [ ] Configure and build all native targets with Windows x64 MSVC.
- [ ] Run the one-MiB-stack startup smoke and framed protocol smoke.
- [ ] Run `npm run pack:preview`.
- [ ] Confirm the staged package and both npm tarballs contain no archive,
      game/save data, schema, logs, dependencies, or build intermediates.
- [ ] Verify `dist/SHA256SUMS.txt` against the preview zip.
- [ ] Confirm Windows CI is green.
- [ ] Perform the documented offline runtime checklist without an additional
      game-data write.
- [ ] Close the game and verify uninstall restores both known MMC hashes.
- [ ] Publish GitHub artifacts only; npm publication is not part of this preview.
