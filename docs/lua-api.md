# Lua API

The host embeds Lua 5.4 in the offline `CollegeFB27.exe` process. One Lua state
persists for the game session, so globals and callbacks registered by one
script remain available to later scripts.

## Catalog database API

The typed database API resolves tables only by their persistent profile Unique
ID. Logical names are display labels and current-build table IDs are not public
lookup selectors.

```lua
local recruits = CFB27.db:GetTableByUniqueId(1873209313)
local recruit = recruits:GetRecord(7)
local score = recruit:GetField("CommitScore")

CFB27.db:Transaction(function(tx)
  tx:SetField(recruit, "CommitScore", score + 100)
end)
```

Table and record values retain only a Unique-ID handle, row, and catalog
generation. Every method resolves that handle again, so lifecycle invalidation
makes retained values stale instead of retaining a process address. Rows are
zero-based and bounds checked. Fields come from the table's complete installed
schema layout; numeric primitives and bitfields return Lua integers, while a
packed reference returns `{ uniqueId = ..., row = ... }`. Packed references
accept that exact public shape on write; current-build table IDs are resolved
only inside typed decoding and write planning and are never accepted from Lua.
References whose Unique ID or decoded build-local target is not active in the
current catalog fail closed.

The installed version-1 layout maps each field from its first physical byte and
an MSB-first bit offset within a one- to five-byte big-endian storage window.
Field writes preserve bits outside that window's field mask. Packed references
use `(tableId << 17) | row` in exactly four big-endian bytes; Lua continues to
see only `{ uniqueId = ..., row = ... }`, never those build-local bits or IDs.

`Transaction` records typed changes during its callback, rejects nesting and
duplicate changes to the same record field, rereads complete records, and
submits one guarded transaction. Writes are available only when the installed
table declares `direct_verified` authority and the host's offline write-safety
gates permit them. `discovery_only` and `commit_adapter_required` tables remain
read-only. A callback error or failed guard applies no partial typed change.

The `CFB27` table exposes no raw-address read, write, or scan methods. The typed
database API never returns table addresses, record bytes, or transaction
operations.

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

The lowercase `cfb` functions above are the legacy host scripting surface and
are separate from `CFB27.db`; no raw-memory wrapper is added to the database
API.

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
