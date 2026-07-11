# CFB27 persistent Lua host

The live editor includes a persistent Lua 5.4 host that runs inside the offline
`CollegeFB27.exe` process. Unlike the earlier diagnostic loader, the persistent
host does not use `CreateRemoteThread`. MMC loads the host during normal game
startup through its existing `CryptBase.dll` proxy chain.

## Startup chain

```text
CollegeFB27.exe
  -> CryptBase.dll              CFB27 startup proxy
     -> MMCBase.dll             preserved original MMC proxy and exports
     -> CFB27LiveEditor/
        cfb27_lua_host.dll      persistent Lua state and local named pipe
```

`startup_hook.py` keeps the original MMC proxy as `MMCBase.dll` in both the
game directory and MMC's `ThirdParty` directory. Installation and removal are
refused while `CollegeFB27.exe` is running. Removal restores both original
proxies.

The current host recognizes only this exact game build:

- executable size: `247845776` bytes
- SHA-256: `9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8`

Lua can still load on an unrecognized build, but memory writes remain disabled.

## Using Lua from the editor

Open **Live Editor**, expand **Lua scripting**, enter a script, and select
**Run Script**. The button is enabled only after the running game reports that
the persistent host is ready.

The local HTTP API exposes the same transport:

- `GET /api/live/lua/status`
- `POST /api/live/lua/eval` with JSON `{ "script": "cfb.log('hello')" }`

The older `POST /api/live/hook/run-script` route prefers the persistent startup
host when it is available.

## Lua API

```lua
-- Return the base address of CollegeFB27.exe.
local base = cfb.module_base()

-- Read one byte after validating that the address is committed and readable.
local value = cfb.read_u8(base)

-- Scan the main executable image. ?? is a wildcard; the second argument caps
-- the number of returned addresses.
local matches = cfb.aob_scan("4D 5A ?? ??", 8)

-- Write one byte only when the live byte still equals the expected value.
-- This also requires the exact supported build and no real EA anticheat process.
local changed = cfb.write_u8(address, expected, replacement)

-- Append a line to CFB27LiveEditor/cfb27_lua_host.log.
cfb.log("script loaded")

-- Persistent callbacks. The host fires tick approximately every 100 ms.
cfb.on("game_ready", function()
  cfb.log("game ready")
end)

cfb.on("tick", function()
  -- Keep callback work short; callbacks share the Lua state.
end)
```

Supported events are `game_ready` and `tick`. Scripts run in one persistent Lua
state, so globals and callbacks remain registered for the current game session.

## Safety gates

`cfb.write_u8` rejects a write unless all of these are true:

1. The process is the exact recognized CFB27 build.
2. No real EA anticheat or Javelin process is detected.
3. The target address belongs to committed writable memory.
4. The current byte equals the script's expected byte.
5. Readback equals the requested replacement byte.

The included `scripts/autorun.lua` is a harmless lifecycle proof. It logs the
autorun, `game_ready`, and one tick event; it performs no writes.

## Installation and recovery

Build `cfb27_lua_host` and `cfb27_cryptbase_proxy`, then call
`install_startup_hook` while the game is closed. The local installation uses:

```python
from pathlib import Path
from startup_hook import install_startup_hook

root = Path.cwd()
install_startup_hook(
    Path(r"F:\EA SPORTS College Football 27"),
    Path(r"C:\Users\Eric Levinson\Downloads\MMC_Modding_Tools_v1.1.0.0 (1)\MMC_ModManager_v1.1.0.0"),
    root / "native/build-final/Release/cfb27_cryptbase_proxy.dll",
    root / "native/build-final/Release/cfb27_lua_host.dll",
    autorun_script=root / "scripts/autorun.lua",
)
```

To restore MMC's original startup proxies, close the game and run:

```python
from pathlib import Path
from startup_hook import uninstall_startup_hook

uninstall_startup_hook(
    Path(r"F:\EA SPORTS College Football 27"),
    Path(r"C:\Users\Eric Levinson\Downloads\MMC_Modding_Tools_v1.1.0.0 (1)\MMC_ModManager_v1.1.0.0"),
)
```

The first real-game startup test revealed a deterministic `0xC00000FD` stack
overflow: the executable hash routine placed a 1 MiB buffer on CFB27's 1 MiB
default thread stack. The buffer now lives on the heap. The regression suite
includes a source guard and a dedicated 1 MiB-stack smoke process that verifies
host readiness, inline evaluation, and advancing tick callbacks.

## Corrected-build runtime verification

The corrected host was verified inside the supported retail game process on
July 11, 2026:

- `CryptBase.dll`, preserved `MMCBase.dll`, and `cfb27_lua_host.dll` were all
  present in the live module list.
- Host status returned `ready=true`, `supportedBuild=true`, and
  `writesAllowed=true`, with no real anticheat process detected.
- `scripts/autorun.lua` ran, `game_ready` fired, and tick callbacks continued to
  advance.
- Inline Lua ran through both the direct pipe client and the browser HTTP API.
- `cfb.module_base()` returned the live executable base.
- `cfb.read_u8(base)` returned `77` (`0x4D`, the first byte of `MZ`).
- `cfb.aob_scan("4D 5A", 1)` returned one executable-header match.
- The game remained running and responsive after all checks.

A reversible live player-rating write was then verified after the Boston
College roster loaded Kaelan Chudzinski's runtime objects:

- Three independent live objects matched player ID `25130`.
- All three matched all 53 expected ratings and had valid primary/duplicate
  rating-byte pairs.
- A multiline Lua transaction changed both speed bytes in every object from
  `82` to `83` and read all six bytes back as `83`.
- The same transaction restored all six bytes from `83` to `82` before
  returning.
- A fresh external process scan independently reported speeds `82/82/82` and
  valid duplicate pairs after rollback.
- The host log recorded the completed transaction and the game remained
  responsive.

This also exposed and fixed an earlier parser defect: `EVAL` originally read
only the first line of a Lua payload. The pipe parser now preserves the entire
multiline payload, with source-level and native smoke regressions covering it.
