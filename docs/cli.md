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
- `memory transact <file.json>` — apply one guarded transaction from a JSON request file.
- `telemetry register <type...>` — register structured telemetry type names for the host session.
- `frtk profile validate <file.json>` — validate and load a profile bundle.
- `frtk catalog discover <file.json>` — load a profile, discover tables, and print the sanitized catalog.
- `frtk catalog inspect <file.json>` — load a profile, discover, and inspect the catalog.
- `frtk records read <file.json> <uniqueId> --row N --field <name>...` — load a profile and read typed fields using only the numeric Unique ID selector.

FrTk profile inputs must resolve beneath the current workspace's `.frtk/`
directory. Junction and symlink targets are checked after resolution. Use
`--allow-external-file` only for an intentional existing external profile. Raw
profile JSON is read only by the SDK profile-file loader and is never printed.

```powershell
node packages/cli/bin/cfb27lua.cjs frtk profile validate .frtk/profile.json
node packages/cli/bin/cfb27lua.cjs frtk catalog discover .frtk/profile.json
node packages/cli/bin/cfb27lua.cjs frtk catalog inspect .frtk/profile.json
node packages/cli/bin/cfb27lua.cjs frtk records read .frtk/profile.json 900001 `
  --row 7 --field CommitScore --field RecruitStage --json
```

FrTk output contains typed catalog identity, capacities, authority status,
evidence, rows, field names, and typed values. It never exposes addresses, raw
bytes, patterns, masks, field offsets, memory ranges, or transaction operations.
Logical names are output text only and are never accepted as selectors. Every
catalog or record invocation loads its explicit profile and performs a fresh
discovery, creating a new generation and staling all prior catalog handles.

The memory scan and read commands are read-only developer diagnostics. A scan requires
`--pattern`, `--mask`, `--max-matches`, and `--context`; context is applied on
each side of a match. The CLI automatically follows native continuation pages,
uses a ten-second timeout for each scan page, and accepts `--max-pages` from 1
through 4,096 (default 4,096). Callers cannot supply raw cursors or start/stop
ranges. A read accepts one or more
`--range 0xUPPERCASE_ADDRESS:length` options. Addresses must be canonical (for
example, `0x1234ABCD`, not a lowercase or zero-padded form). Write-like
options are not accepted.

A guarded transaction accepts exactly one `.json` file containing the SDK request
object with `transactionId` and `operations`; it does not accept stdin. The CLI resolves
the current directory and existing input through the filesystem before containment
checks, so links cannot escape the current directory. An outside target requires the
explicit `--allow-external-file` flag. `--json` and `--allow-external-file` are the only
transaction controls; scan, read, follow, cursor, and directory controls are rejected.
The SDK validates and clones the request before opening a host connection.

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
  --range 0x1234ABCD:192 --allow-unsupported-build --json

node packages/cli/bin/cfb27lua.cjs memory transact `
  proof-transaction.json --json

node packages/cli/bin/cfb27lua.cjs telemetry register `
  recruiting.snapshot recruiting.stability --json
```

Human memory output reports bounded counts and the canonical addresses returned
by the SDK. Scan and read JSON output keep the validated SDK result unchanged under
the standard `{ "ok": true, "command": "...", "result": ... }` CLI envelope.
Transaction `--json` output is the validated SDK result object itself, without an
envelope.
Human transaction output is narrower: it reports only the transaction ID, status,
and operation/applied/verified counts, never addresses or byte values. Transaction
errors use constant code-derived messages and omit host details in both output modes.
Only `memory scan` selects the ten-second per-page client timeout; all other
commands retain the SDK default timeout.

Directory options are `--game-dir`, `--mmc-dir`, and `--artifacts-dir`. Their
environment fallbacks are `CFB27_GAME_DIR`, `CFB27_MMC_DIR`, and
`CFB27_HOOK_ARTIFACTS`.

One-shot `--json` commands emit exactly one JSON object. `logs --follow --json`
emits JSON Lines, one object for each new log event.

FrTk errors normally omit details. For `frtk catalog discover --json`, a native
`FRTK_DISCOVERY_TIMEOUT` includes only the SDK-validated timeout progress
schema documented in the protocol. Human output remains the stable code and
message, and hostile or extra native properties are never printed.

## Exit families

- `0` — success
- `2` — usage or invalid CLI request
- `20`–`29` — game or host unavailable
- `30`–`39` — protocol, response, or script rejection
- `40`–`49` — installation or recovery failure
- `70` — unexpected internal failure
