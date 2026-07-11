# Runtime verification

This document records verified behavior of the supported startup-loaded host,
not a promise that offsets or object layouts remain stable across game builds.

## Supported executable

- File: `CollegeFB27.exe`
- Size: `247845776` bytes
- SHA-256: `9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8`

## Verified on July 11, 2026

- MMC loaded the forwarding `CryptBase.dll`, preserved `MMCBase.dll`, and
  persistent `cfb27_lua_host.dll` during normal game startup.
- Host status reported ready, supported build, and writes allowed in the
  separately launched offline session with no real anticheat process present.
- Autorun, `game_ready`, and continuing tick callbacks executed.
- Multiline Lua ran through the local pipe, and module-base, guarded byte-read,
  and AOB-scan APIs returned the expected executable-header results.
- A reversible live player-rating transaction changed all validated speed-byte
  copies for player ID `25130`, read them back, restored every byte, and was
  independently confirmed after rollback while the game remained responsive.

The first startup test also found a deterministic `0xC00000FD` stack overflow:
a one-MiB hash buffer had been placed on the game's one-MiB worker stack. The
buffer now lives on the heap, and the native regression suite loads the host in
a smoke executable with the same one-MiB stack reserve.

Earlier request-detour and save-editor findings are retained separately in
`legacy-hook-findings.md` and the repository archive.

## Read-only discovery preview verified on July 11, 2026

- The manually tested process was PID `21900`; `CollegeFB27.exe` matched the
  supported SHA-256 above. The installed forwarding proxy SHA-256 was
  `4638D7E54A6715538119254069B075C94EB7AB41A6914907AAD96750ABD0F756`;
  the manually tested host SHA-256 was
  `1420F4BCAA089153E671FD41D7B89F3162EFF8AAD94B4D1EFD18039E6590D3CE`.
- The live hello response advertised `memoryScan`, `memoryRead`, and
  `telemetry` capabilities. No memory write was attempted during this gate.
- An initial automatic scan failed between pages with `ENOENT`. Retrying with
  the corrected SDK-only continuation handling completed the scan; this was a
  client retry correction, not a host reinstall.
- The complete scan covered `10,670,854,144` eligible bytes in `69,379` ms and
  returned three candidates. Under the 32 MiB page contract, that is exactly
  319 pages: 318 full pages plus one 544,768-byte terminal page. This count is
  derived from the retained completed-byte total rather than a separate live
  page counter. Batch re-read confirmed the exact 16-byte
  sentinel at `0x25DDC14D0` and `0x34CC50048`; the transient candidate at
  `0x273FEB930` had changed and was correctly rejected.
- Registered telemetry sequence `2` appeared exactly once while the event
  cursor advanced from `718` to `720`.
- After entering Recruiting and returning to the Dynasty hub, a 639-second
  responsiveness watch retained PID `21900`. Tick count advanced from `8632`
  to `14986`, the event cursor advanced from `871` to `1506`, and no error was
  observed.

The version-only native rebuild performed after this manual gate necessarily
changes the final host binary hash. That final packaged hash was verified by
the automated release gate in the final section, but was not the binary
exercised by this manual live session.

### Retained manual commands

The sentinel was allocated without embedding its byte sequence as a literal in
the Lua source:

```powershell
node packages/cli/bin/cfb27lua.cjs eval "_G.__cfb27_manual_sentinel = string.char(199,91,39,161,14,210,76,147,184,6,253,113,42,229,56,143)" --json
```

The complete paged scan used the exact pattern, mask, match, context, page, and
JSON controls below:

```powershell
$scan = node packages/cli/bin/cfb27lua.cjs memory scan `
  --pattern C75B27A10ED24C93B806FD712AE5388F `
  --mask FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF `
  --max-matches 8 --context 8 --max-pages 4096 --json | ConvertFrom-Json
```

All three returned addresses were batch re-read in one SDK request (the CLI
accepts one `--range` per address):

```powershell
node packages/cli/bin/cfb27lua.cjs memory read `
  --range "0x25DDC14D0:16" `
  --range "0x273FEB930:16" `
  --range "0x34CC50048:16" --json
```

Telemetry was registered, emitted once, and read using cursor pagination:

```powershell
node packages/cli/bin/cfb27lua.cjs events --after 718 --json
node packages/cli/bin/cfb27lua.cjs telemetry register probe.snapshot --json
node packages/cli/bin/cfb27lua.cjs eval "cfb.emit('probe.snapshot', {sequence=2, stable=true})" --json
node packages/cli/bin/cfb27lua.cjs events --after 718 --json
```

Responsiveness was checked by polling `status --json` and cursor-paged
`events --after <lastCursor> --json` throughout the 639-second watch, while
also confirming PID `21900` remained alive and the Dynasty UI remained usable:

```powershell
node packages/cli/bin/cfb27lua.cjs status --json
node packages/cli/bin/cfb27lua.cjs events --after 871 --json
```

### Final automated release artifacts

After the manual gate, the version-only native rebuild passed the complete
Node suite, Windows x64 release build, startup, memory-reader, telemetry, and
framed-protocol smokes, package preview, checksum verification, and archive
inspection. Its retained SHA-256 values are:

- Release ZIP: `8016A9959C66B61A68D7E075AD323F6E324021E5DF633788F2F77539A0179B69`
- Forwarding proxy: `4638D7E54A6715538119254069B075C94EB7AB41A6914907AAD96750ABD0F756`
- Final host: `9A2B34AC98964266FE072B3961AE1A914DB76B8E292D73C4A8A4C1A06101E0D8`
- CLI tarball: `A8FA2C550FCC85A51070C3F937CB6CD3A6FC0DC0213037D55C0EDFABB6CB7494`
- SDK tarball: `AF104E0514BB69A5C3ACCE1536E1A0BA77E9B73356B13FB8DB8032F778F2F64B`

The final host above was automated- and smoke-tested after the version-only
rebuild, but it was not manually live-tested in CFB27. The manual evidence in
this document applies to host
`1420F4BCAA089153E671FD41D7B89F3162EFF8AAD94B4D1EFD18039E6590D3CE`.
