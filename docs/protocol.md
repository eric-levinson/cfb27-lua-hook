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
- `registerTelemetry { types }` — add trusted structured event names for the
  current host session.
- `scanMemory { patternHex, maskHex, maxMatches, contextBefore,
  contextAfter, allowUnsupportedBuild?, cursor?, includeAllocationMetadata? }`
  — scan one bounded page of readable private memory and optionally resume from
  a continuation cursor.
- `readMemory { ranges, allowUnsupportedBuild? }` — read a bounded batch of
  readable private-memory ranges.
- `writeTransaction { transactionId, operations }` — apply a bounded guarded
  batch with complete preflight comparison, readback, and rollback.
- `loadFrtkProfile { profile, layout }` — atomically validate and load a
  matching version-1 bundle.
- `discoverFrtkCatalog {}` — resolve every required table into a new catalog.
- `inspectFrtkCatalog { generation }` — return sanitized table summaries.
- `readFrtkRecords { generation, records }` — read typed fields from
  `{ uniqueId, row, fields }` selectors.
- `transactFrtkFields { transactionId, generation, changes }` — submit logical
  `{ uniqueId, row, field, value }` changes.
- `invalidateFrtkCatalog { reason }` — stale all handles. Reasons are
  `caller_transition`, `save_changed`, and `shutdown`.

`hello.capabilities` advertises the memory commands as `memoryScan` and
`memoryRead`, allocation-aware scans as `memoryScanAllocationMetadata`, guarded
writes as `memoryWriteTransaction`, and structured event registration as
`telemetry`. `status.sessionWritesDisabled` reports whether an
unverifiable rollback has permanently disabled writes for the current host
session.

The FrTk families are advertised as `frtkProfileV1`, `frtkCatalogV1`,
`frtkRecordReadV1`, and `frtkFieldTransactionV1`. Public table selectors always
use `uniqueId`; logical names are display text and current-build table IDs stay
host-internal.

### Typed FrTk catalog

Profile and layout identity are validated together against the running build.
Discovery advances generation on every attempt and installs no partial catalog
when a required table is unresolved. Inspection returns sanitized identity,
capacity, authority, generation, and bounded evidence only.

Typed reads accept 1–64 record selectors. Each result has fixed keys
`uniqueId`, `row`, and `values`; `values` is an ordered array of fixed-shape
`{ field, value }` entries. A value is a number or a packed reference represented
as `{ uniqueId, row }`. Field names are data values and are never JSON property
names, including names such as `address`, `bytesHex`, `mask`, `offset`, `range`,
`operation`, and `tableId`. For example:

```json
{"generation":4,"records":[{"uniqueId":900001,"row":0,"values":[{"field":"CommitScore","value":123},{"field":"RecruitLink","value":{"uniqueId":900002,"row":7}}]}]}
```

Typed transactions accept
1–128 logical changes, revalidate the catalog, reread complete records, encode
fields through the layout, and pass the host-internal plan to the existing
guarded engine. Only `direct_verified` tables may proceed; other authority
states return `FRTK_AUTHORITY_UNPROVEN`.

Typed responses never expose addresses, byte buffers, masks, field offsets,
memory ranges, or transaction operations. Explicit invalidation and a
`game_ready:false` transition advance generation; stale requests return
`FRTK_CATALOG_STALE` and must rediscover.

### Structured telemetry

`registerTelemetry` accepts exactly one parameter, `types`, containing 1–16
unique strings. Names match `^[a-z][a-z0-9_.-]{0,63}$`; `game_ready`, `tick`,
and `log` are reserved. Registration is additive for the session and repeating
an already registered name in a later request is idempotent. At most 16
distinct custom names may be registered in total.

Request:

```json
{"protocol":1,"id":"telemetry-1","command":"registerTelemetry","params":{"types":["probe.snapshot"]}}
```

Result:

```json
{"types":["probe.snapshot"]}
```

The SDK method is `client.registerTelemetryTypes(types)`. Both the SDK and host
strictly validate the request and response contract. Registered Lua code may
call `cfb.emit(type, payload)` to append exactly one event to the cursor ring;
emission never writes to the file log.

Payloads are JSON-compatible and limited to depth 4, 64 keys per object, 128
entries per array, 1,024 bytes per string, and 16 KiB serialized. Numbers must
be finite. Address and raw-byte keys are rejected at every object depth,
including `address`, `addressHex`, `regionBase`, `bytesHex`, `contextAddress`,
and `contextHex`. Lua conversion additionally rejects cycles, functions,
userdata, threads, mixed or sparse tables, and non-string object keys.

### Memory scan

`patternHex` and `maskHex` are equal-length uppercase hexadecimal byte strings.
The pattern is 8–4,096 bytes. A mask byte selects significant bits using
`(live & mask) == (pattern & mask)`. `maxMatches` is an integer from 1 through
64. `contextBefore` and `contextAfter` are nonnegative integers no greater than
512, with at most 512 context bytes requested in total. One request scans at
most 32 MiB of eligible memory in chunks no larger than 4 MiB plus boundary
lookahead. An optional `cursor` is a canonical uppercase address identifying
the first virtual byte not covered by the preceding page.

Request:

```json
{"protocol":1,"id":"scan-1","command":"scanMemory","params":{"patternHex":"CFB27A1100A1B2C3D4E5F60718293A4B","maskHex":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF","maxMatches":2,"contextBefore":4,"contextAfter":4,"allowUnsupportedBuild":true}}
```

Result:

```json
{"supportedBuild":false,"complete":false,"nextCursor":"0x2234ABCD","scannedBytes":33554432,"matches":[{"address":"0x1234AB80","regionBase":"0x1234AB00","regionSize":65536,"protection":4,"contextAddress":"0x1234AB7C","contextHex":"00000000CFB27A1100A1B2C3D4E5F60718293A4B00000000"}]}
```

When `includeAllocationMetadata` is absent or the JSON boolean `false`, each
match has exactly the six legacy properties shown above. When it is `true`, the
host adds exactly four properties to every match:

```json
{"address":"0x1234AB80","regionBase":"0x1234AB00","regionSize":4096,"protection":4,"contextAddress":"0x1234AB7C","contextHex":"00000000CFB27A1100A1B2C3D4E5F60718293A4B00000000","allocationBase":"0x12340000","allocationSize":4194304,"allocationProtect":4,"offsetInAllocation":43904}
```

`allocationBase` is the allocation identity reported by the operating system.
`allocationSize` is the checked contiguous extent of adjacent virtual-memory
regions that retain that identity. `allocationProtect` is the allocation's
initial protection, while `protection` remains the current protection of the
matched region. `offsetInAllocation` is the checked byte difference from the
allocation base, and therefore
`BigInt(address) === BigInt(allocationBase) + BigInt(offsetInAllocation)`.
Failure to discover a complete consistent extent fails the whole page with
`MEMORY_ACCESS_DENIED`; partial matches are not returned.

Every successful page contains exactly `complete`, `nextCursor`,
`scannedBytes`, `matches`, and `supportedBuild`. A partial page has
`complete:false` and a canonical string `nextCursor`; a terminal page has
`complete:true` and `nextCursor:null`. Completion means the address-space walk
reached the process maximum, not that the game was paused or that multiple
pages form an atomic snapshot. Eligible read failures return an error instead
of silently advancing the cursor.

The SDK exposes `client.scanMemoryPage(options)` for one protocol request and
`client.scanMemory(options)` for automatic aggregation. The aggregate method
owns continuation cursors, accepts `maxPages` from 1 through 4,096 (default
4,096), applies `maxMatches` globally, and rejects repeated or decreasing
cursors. The default bounds total eligible-byte work to 128 GiB. Before using a
candidate for interpretation, re-read it and validate its expected structure;
the live memory map can change between pages.

Before an opt-in request, the SDK negotiates `hello` and requires
`memoryScanAllocationMetadata`; older hosts fail closed with
`PROTOCOL_MISMATCH`. Allocation addresses and topology are opaque, session-only
observations. They must not be persisted or reused after a PID, host session,
allocation lifecycle, or validation change. Allocation size and address order
are never authority signals: use independently validated content and lifecycle
behavior to distinguish authoritative state from replicas, caches, or stale
allocations.

### Memory read

`ranges` contains 1–64 objects with exactly `address` and `length` keys.
Addresses use canonical uppercase `0x[0-9A-F]+` strings without redundant
leading zeroes. Each length is an integer from 1 through 65,536 bytes, and the
aggregate request is capped at 262,144 bytes. Every range is validated before
any bytes are copied, so a failure never returns partial results.

Request:

```json
{"protocol":1,"id":"read-1","command":"readMemory","params":{"allowUnsupportedBuild":true,"ranges":[{"address":"0x1234AB80","length":16}]}}
```

Result:

```json
{"supportedBuild":false,"ranges":[{"address":"0x1234AB80","length":16,"bytesHex":"CFB27A1100A1B2C3D4E5F60718293A4B"}]}
```

Both commands reject unknown parameter keys; range objects also reject unknown
keys. On an unsupported executable, `allowUnsupportedBuild` must be the JSON
boolean `true` or the command returns `UNSUPPORTED_BUILD`. Successful diagnostic
requests then return `supportedBuild:false`. This override never enables writes.

### Memory write transactions

`transactionId` is 1–64 ASCII letters, digits, dots, underscores, or hyphens.
`operations` contains 1–32 objects with exactly `address`, `expectedHex`, and
`replacementHex`. Addresses use the same canonical uppercase format as memory
reads. Hex strings are nonempty uppercase byte sequences of equal length. One
operation is limited to 4,096 bytes and the request is limited to 65,536 bytes.

```json
{"protocol":1,"id":"write-1","command":"writeTransaction","params":{"transactionId":"recruiting.proof-1","operations":[{"address":"0x1234AB80","expectedHex":"1020","replacementHex":"1121"}]}}
```

A successful result records the verified outcome for every operation:

```json
{"transactionId":"recruiting.proof-1","status":"applied_verified","operations":[{"index":0,"applied":true,"verified":true}]}
```

The host validates every range and compares every expected byte before the
first write. It then applies and verifies operations in request order. If an
apply or readback step fails, it restores attempted operations in reverse order
and verifies the originals. A verified rollback is returned as
`TRANSACTION_APPLY_FAILED`, with `rolled_back_verified` transaction details. An
unverifiable rollback returns `ROLLBACK_VERIFICATION_FAILED`, with
`rollback_unverified` details, and permanently rejects subsequent transaction
and Lua writes with `SESSION_WRITES_DISABLED` until the host restarts.

This is request-level host sequencing, not game-thread atomicity: the game may
mutate memory while preflight, apply, verification, or rollback is running.
Callers must establish a stable window appropriate to the target data before
submitting a transaction.

The host retains at most 512 log entries and 1,024 events. Event cursors are
monotonic for one host session. Tick events are coalesced to at most one per
second; Lua tick callbacks still run at their normal cadence.

## Errors

Stable SDK error families include runtime availability, protocol mismatch,
timeout, invalid request/response, script failure, installation conflict, and
backup-verification failure. Consumers should branch on `error.code`, not error
message text.

`FRTK_DISCOVERY_TIMEOUT` is the only typed FrTk error that carries public
progress details. Its `details` object has exactly these keys:

```json
{"stage":"scan","tableUniqueId":900001,"fingerprintOrdinal":2,"completedFingerprintCount":7,"elapsedMilliseconds":1999,"pagesScanned":3,"chunksScanned":24,"scannedBytes":100663296,"candidateWindows":24576,"cappedMatches":8}
```

`stage` is one of `scan`, `allocation`, `relationship`, or `reread`.
`tableUniqueId` is the public table Unique ID, or `null` outside a
table-specific phase. `fingerprintOrdinal` is zero-based during `scan` and is
`null` for the other phases. All counters are nonnegative safe integers,
saturate instead of overflowing, and `cappedMatches` is at most 8. No address,
allocation, pattern, mask, raw byte, table-name, row-index, protection, or
memory-topology data is included. Unknown or malformed detail keys make the SDK
reject the response as `INVALID_RESPONSE`.

Memory commands additionally return `MEMORY_ACCESS_DENIED` when a requested
range is not wholly readable private memory, `SCAN_LIMIT_EXCEEDED` when the
aggregate scan bound would be crossed, and `TOO_MANY_MATCHES` rather than
silently truncating a scan. These errors do not include memory or region dumps.
Guarded writes additionally return `MEMORY_MISMATCH`,
`TRANSACTION_LIMIT_EXCEEDED`, `TRANSACTION_APPLY_FAILED`,
`ROLLBACK_VERIFICATION_FAILED`, and `SESSION_WRITES_DISABLED`. Malformed
transaction shapes, addresses, hex, and overlapping operations return
`INVALID_REQUEST`.
Typed FrTk commands additionally return `FRTK_PROFILE_INVALID`,
`FRTK_DISCOVERY_FAILED`, `FRTK_CATALOG_STALE`, `FRTK_FIELD_INVALID`, and
`FRTK_AUTHORITY_UNPROVEN`.

The unversioned legacy text pipe remains temporarily available for migration,
but it is not the integration contract for new tools.
