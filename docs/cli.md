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
