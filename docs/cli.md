# `cfb27lua` CLI

Run the local workspace CLI with:

```powershell
node packages/cli/bin/cfb27lua.cjs --help
```

## Commands

- `install` — checksum, back up, and install both proxies plus the Lua host.
- `uninstall` — restore both checksum-verified MMC proxies.
- `status` — read current host status.
- `run <file.lua>` — send the complete UTF-8 file with its chunk name.
- `eval <source>` — evaluate source assembled from the remaining arguments.
- `doctor` — perform read-only game, install, host, build, and write checks.
- `logs [--follow]` — read bounded logs or follow new log events.
- `events [--after N]` — read a cursor page.
- `memory scan` — scan bounded private readable memory through the validated SDK.
- `memory read` — read one or more bounded canonical address ranges through the validated SDK.
- `telemetry register <type...>` — register structured telemetry type names for the host session.

The memory commands are read-only developer diagnostics. A scan requires
`--pattern`, `--mask`, `--max-matches`, and `--context`; context is applied on
each side of a match. The CLI automatically follows native continuation pages,
uses a ten-second timeout for each scan page, and accepts `--max-pages` from 1
through 4,096 (default 4,096). Callers cannot supply raw cursors or start/stop
ranges. A read accepts one or more
`--range 0xUPPERCASE_ADDRESS:length` options. Addresses must be canonical (for
example, `0x7FF612340000`, not a lowercase or zero-padded form). Write-like
options are not accepted.

Use `--allow-unsupported-build` only when intentionally running a memory
diagnostic against an unsupported build. Without that explicit flag, the SDK
rejects an unsupported-build result. The flag does not enable writes.

Examples:

```powershell
node packages/cli/bin/cfb27lua.cjs memory scan `
  --pattern CFB27A1100A1B2C3D4E5F60718293A4B `
  --mask FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF `
  --max-matches 8 --context 32 --max-pages 4096 `
  --allow-unsupported-build --json

node packages/cli/bin/cfb27lua.cjs memory read `
  --range 0x7FF612340000:192 --allow-unsupported-build --json

node packages/cli/bin/cfb27lua.cjs telemetry register `
  recruiting.snapshot recruiting.stability --json
```

Human memory output reports bounded counts and the canonical addresses returned
by the SDK. JSON output keeps the validated SDK result unchanged under the
standard `{ "ok": true, "command": "...", "result": ... }` CLI envelope.
Only `memory scan` selects the ten-second per-page client timeout; all other
commands retain the SDK default timeout.

Directory options are `--game-dir`, `--mmc-dir`, and `--artifacts-dir`. Their
environment fallbacks are `CFB27_GAME_DIR`, `CFB27_MMC_DIR`, and
`CFB27_HOOK_ARTIFACTS`.

One-shot `--json` commands emit exactly one JSON object. `logs --follow --json`
emits JSON Lines, one object for each new log event.

## Exit families

- `0` — success
- `2` — usage or invalid CLI request
- `20`–`29` — game or host unavailable
- `30`–`39` — protocol, response, or script rejection
- `40`–`49` — installation or recovery failure
- `70` — unexpected internal failure
