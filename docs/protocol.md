# Local protocol v1

The supported Node SDK communicates with the in-process host through the local
named pipe `\\.\pipe\CFB27LuaHost.v1.<pid>`. Consumers should use the SDK
instead of implementing the transport directly.

## Framing

Every message is a four-byte little-endian unsigned body length followed by one
UTF-8 JSON object. Frames must be between 1 byte and 1 MiB. Reads and writes may
be fragmented; a connection carries exactly one request and one response.

Request:

```json
{"protocol":1,"id":"uuid","command":"status","params":{}}
```

Success response:

```json
{"protocol":1,"id":"uuid","ok":true,"result":{}}
```

Error response:

```json
{"protocol":1,"id":"uuid","ok":false,"error":{"code":"INVALID_REQUEST","message":"...","details":{}}}
```

## Commands

- `hello` — host version, protocol version, supported-build state,
  write-eligibility state, and capabilities.
- `status` — readiness, build/write state, script and tick counters, last error.
- `runScript { name, source }` — execute one complete named Lua buffer.
- `evaluate { source }` — execute one complete multiline Lua buffer.
- `logs { limit }` — return up to 256 recent bounded log entries.
- `events { after, limit }` — return an ordered cursor page and `nextCursor`.
- `scanMemory { patternHex, maskHex, maxMatches, contextBefore,
  contextAfter, allowUnsupportedBuild? }` — scan bounded readable private memory.
- `readMemory { ranges, allowUnsupportedBuild? }` — read a bounded batch of
  readable private-memory ranges.

`hello.capabilities` advertises the memory commands as `memoryScan` and
`memoryRead`. They are read-only host operations and do not expose a write API.

### Memory scan

`patternHex` and `maskHex` are equal-length uppercase hexadecimal byte strings.
The pattern is 8–4,096 bytes. A mask byte selects significant bits using
`(live & mask) == (pattern & mask)`. `maxMatches` is an integer from 1 through
64. `contextBefore` and `contextAfter` are nonnegative integers no greater than
512, with at most 512 context bytes requested in total. Each scanned region is
capped at 64 MiB and aggregate scanning is capped at 512 MiB.

Request:

```json
{"protocol":1,"id":"scan-1","command":"scanMemory","params":{"patternHex":"CFB27A1100A1B2C3D4E5F60718293A4B","maskHex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","maxMatches":2,"contextBefore":4,"contextAfter":4,"allowUnsupportedBuild":true}}
```

Result:

```json
{"supportedBuild":false,"complete":true,"scannedBytes":67108864,"matches":[{"address":"0x7FF612340080","regionBase":"0x7FF612340000","regionSize":65536,"protection":4,"contextAddress":"0x7FF61234007C","contextHex":"00000000CFB27A1100A1B2C3D4E5F60718293A4B00000000"}]}
```

### Memory read

`ranges` contains 1–64 objects with exactly `address` and `length` keys.
Addresses use canonical uppercase `0x[0-9A-F]+` strings without redundant
leading zeroes. Each length is an integer from 1 through 65,536 bytes, and the
aggregate request is capped at 262,144 bytes. Every range is validated before
any bytes are copied, so a failure never returns partial results.

Request:

```json
{"protocol":1,"id":"read-1","command":"readMemory","params":{"allowUnsupportedBuild":true,"ranges":[{"address":"0x7FF612340080","length":16}]}}
```

Result:

```json
{"supportedBuild":false,"ranges":[{"address":"0x7FF612340080","length":16,"bytesHex":"CFB27A1100A1B2C3D4E5F60718293A4B"}]}
```

Both commands reject unknown parameter keys; range objects also reject unknown
keys. On an unsupported executable, `allowUnsupportedBuild` must be the JSON
boolean `true` or the command returns `UNSUPPORTED_BUILD`. Successful diagnostic
requests then return `supportedBuild:false`. This override never enables writes.

The host retains at most 512 log entries and 1,024 events. Event cursors are
monotonic for one host session. Tick events are coalesced to at most one per
second; Lua tick callbacks still run at their normal cadence.

## Errors

Stable SDK error families include runtime availability, protocol mismatch,
timeout, invalid request/response, script failure, installation conflict, and
backup-verification failure. Consumers should branch on `error.code`, not error
message text.

Memory commands additionally return `MEMORY_ACCESS_DENIED` when a requested
range is not wholly readable private memory, `SCAN_LIMIT_EXCEEDED` when the
aggregate scan bound would be crossed, and `TOO_MANY_MATCHES` rather than
silently truncating a scan. These errors do not include memory or region dumps.

The unversioned legacy text pipe remains temporarily available for migration,
but it is not the integration contract for new tools.
