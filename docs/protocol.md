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

The host retains at most 512 log entries and 1,024 events. Event cursors are
monotonic for one host session. Tick events are coalesced to at most one per
second; Lua tick callbacks still run at their normal cadence.

## Errors

Stable SDK error families include runtime availability, protocol mismatch,
timeout, invalid request/response, script failure, installation conflict, and
backup-verification failure. Consumers should branch on `error.code`, not error
message text.

The unversioned legacy text pipe remains temporarily available for migration,
but it is not the integration contract for new tools.
