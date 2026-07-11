# Lua API

The host embeds Lua 5.4 in the offline `CollegeFB27.exe` process. One Lua state
persists for the game session, so globals and callbacks registered by one
script remain available to later scripts.

## Runtime functions

```lua
local base = cfb.module_base()
local byte = cfb.read_u8(base)
local matches = cfb.aob_scan("4D 5A ?? ??", 8)

-- Writes require the supported build, offline safety gates, an exact expected
-- byte, writable committed memory, and successful readback.
local changed = cfb.write_u8(address, expected, replacement)

cfb.log("script loaded")

-- The trusted main-process client must register this type first with
-- client.registerTelemetryTypes(["probe.snapshot"]).
cfb.emit("probe.snapshot", { sequence = 1, stable = true })

cfb.on("game_ready", function()
  cfb.log("game ready")
end)

cfb.on("tick", function()
  -- Keep callbacks short because all callbacks share the Lua state.
end)
```

Supported callback names are `game_ready` and `tick`. The host runs `tick`
callbacks approximately every 100 ms. The event protocol coalesces observable
tick events to at most one per second.

## Structured telemetry

`cfb.emit(type, payload)` appends exactly one structured event to the existing
cursor-paged event ring and returns `true`. It does not write to the host log.
The type must first be registered for the host session through the
`registerTelemetry` protocol command or SDK `registerTelemetryTypes(types)`.
Custom types use `^[a-z][a-z0-9_.-]{0,63}$`; `game_ready`, `tick`, and `log` are
reserved, and no more than 16 distinct custom types may be registered per
session.

Payloads may contain Lua nil, booleans, finite numbers, strings, dense arrays,
and string-keyed objects. Tables are converted recursively and must not be
cyclic, sparse, mixed between array and object keys, or contain unsupported Lua
values. Limits are depth 4, 64 keys per object, 128 entries per array, 1,024
bytes per string, and 16 KiB after JSON serialization. Address and raw-byte
fields are rejected at every depth, including `address`, `addressHex`,
`regionBase`, `bytesHex`, `contextAddress`, and `contextHex`.

## Script execution

Protocol v1 accepts complete UTF-8 source buffers through `evaluate` and
`runScript`; multiline scripts are not split on newlines. `runScript` also
accepts a chunk name so Lua errors identify the source file. Use the Node SDK
or `cfb27lua run <file>` instead of writing directly to the named pipe.

Lua errors return the stable `SCRIPT_ERROR` code. Recent logs and cursor-based
events are available through the SDK and CLI without reading the host log file.
