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

The native version bump and final typed-parameter contract correction performed
after this manual gate necessarily change the final host binary hash. That
final packaged hash was verified by the automated release gate in the final
section, but was not the binary exercised by this manual live session.

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

After the manual gate, the final native rebuild and typed-parameter contract
correction passed the complete Node suite, Windows x64 release build, startup,
memory-reader, telemetry, and framed-protocol smokes, package preview, checksum
verification, and archive inspection. The packager was explicitly bound to that
build's absolute `Release` directory. Its retained SHA-256 values are:

- Forwarding proxy: `4638D7E54A6715538119254069B075C94EB7AB41A6914907AAD96750ABD0F756`
- Final host: `72C4CF08BA19F526F9E89F5B54F7EE70C3B5B630D9C7BA4658523F862AF5CB98`
- CLI tarball: `A8FA2C550FCC85A51070C3F937CB6CD3A6FC0DC0213037D55C0EDFABB6CB7494`
- SDK tarball: `94527FC3D1D832001647E176FEB0CA5D025C4451CACCF750376B3309627A92A8`

The ZIP checksum is generated externally in `dist/SHA256SUMS.txt` after the
archive is complete. It cannot be embedded in this document because this file
is itself included in the ZIP; embedding that value would change the archive
being hashed.

The final host above was automated- and smoke-tested after the version bump and
final contract correction, but it was not manually live-tested in CFB27. The
manual evidence in this document applies to host
`1420F4BCAA089153E671FD41D7B89F3162EFF8AAD94B4D1EFD18039E6590D3CE`.

## Guarded permission transaction verified on July 12, 2026

- The reviewed recovery candidate host SHA-256 was
  `D3111AF463E543D3108055A200AFE95B7015EF4ED702F7C6AA8429BA7CEA86BD`.
  The offline session used PID `25500`; hello, status, capability, and write
  eligibility checks were healthy before calibration.
- Two complete read-only hub rounds scanned approximately 10.688 GB per
  save-derived record with allocation metadata. Stable exact full-record
  counts were zero for `LeagueSetting`, `FranchiseUser`, and Player row 2070,
  and no scanner-owned self-match appeared.
- After the required hub-to-Recruiting-to-hub transition, one 75.985-second
  masked `LeagueSetting` pass returned exactly one candidate. Its reconstructed
  256-byte record matched the independent selected-save recipe, remained stable
  across three rereads, and its allocation and neighborhood lifecycle evidence
  classified it as the unique authoritative permission record. No address or
  raw byte was retained in this evidence.
- Exactly two SDK `writeTransaction` requests were sent. Each contained one
  operation for one byte and was not retried. The apply request SHA-256 was
  `9237D609A5F79A5F90E59077A0A7AB98EF23EE1C5E1CD14C6B7A12E85E914412`;
  it returned applied and verified, and the complete `COMMISHONLY` record image
  matched the selected-save recipe.
- The immediate restore request SHA-256 was
  `3D622B240C7B01A8893724274BC4751F495316419FECBBED9C6900E2CA438DE5`;
  it returned applied and verified, and the complete original `ANY` record
  image matched. The host stayed ready, supported, and write-eligible with no
  lockdown while ticks advanced from `14741` to `14744`.
- After both applications were closed and process absence was confirmed, the
  supported uninstall restored both original active proxies. Each independently
  verified as SHA-256
  `3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454`.
  Neither application was relaunched for release preparation.

### Final guarded developer-preview artifacts

After the live gate and cleanup, the `0.2.0-dev.2` version bump passed the full
Node suite, clean Windows x64 Release build, startup, memory-reader, telemetry,
memory-transaction, and framed-protocol smokes, package preview, checksum
verification, archive inspection, and diff check. The retained artifact
SHA-256 values are:

- Forwarding proxy: `09D38B111F6C84B196B0E960CA342860855FD3F92F5790969D6AE6E887FF15F1`
- Final host: `66203B75D53A698D7A6D6622D194AF97321C2524B05375ECBFF5DDDB0082D3AE`
- CLI tarball: `7DDF62F3774BDF3156EB274DC70E1A06031090C4DAD4376780093E4D7CA45B24`
- SDK tarball: `CDDA182B76DD9A0B4CEC40D23119A1F88095DD4D27E5DF2D152CEF61C7FBCAC6`

The final host above was automated- and smoke-tested after the version bump,
but was not installed or manually live-tested. The reversible live evidence
applies to the reviewed recovery candidate host recorded at the start of this
section. The final ZIP checksum remains external because this document is
included in the ZIP.
