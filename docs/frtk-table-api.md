# FrTk typed table API

> **Current CFB27 status (verified July 13, 2026):** live scalar descriptors,
> four-byte word-swapped records, and indexed reference arrays are implemented
> in the catalog and covered by native tests. A guarded live Recruit write was
> applied, reread, restored, and reread successfully. The final Player-specific
> descriptor end-pointer variant is tested but still needs one installed-host
> catalog retest before the FrTk catalog, record, and Lua database entry points
> are declared live-ready. They continue to fail closed on any unresolved table.

Use `createClient({ pid })` from `@cfb27/lua-hook`. Every FrTk operation first
negotiates the corresponding protocol-v1 capability and fails closed with
`PROTOCOL_MISMATCH` when the host does not advertise it.

## Profile and catalog lifecycle

- `loadFrtkProfile({ profile, layout })` clones and loads an in-memory bundle.
- `loadFrtkProfileFromFile(path)` is the only SDK operation that reads raw
  profile JSON. Parse and file errors return `FRTK_PROFILE_INVALID` without the
  path or source text. Syntactically valid bundles rejected by local or host
  schema validation use the same sanitized error.
- `discoverFrtkCatalog()` returns `{ generation, tableCount }`.
- `inspectFrtkCatalog({ generation })` returns `{ generation, tables }` with
  sanitized summaries. A table has `uniqueId`, `logicalName`,
  `authorityStatus`, `capacity`, `profileId`, `generation`, and bounded
  evidence.
- `invalidateFrtkCatalog({ reason })` accepts `caller_transition`,
  `save_changed`, or `shutdown`.

Generations are lifecycle tokens. Loading, discovering, or invalidating clears
locally cached authority. Callers must use the latest generation; stale access
returns `FRTK_CATALOG_STALE`.

Version-1 layouts describe FrTk physical record storage: `byteOffset` selects
the first byte, `bitOffset` counts from the most-significant bit of a one- to
five-byte big-endian storage window, and writes preserve every unrelated bit.
Packed-reference numbers remain `(tableId << 17) | row`, stored in exactly four
big-endian bytes. These details stay inside the typed host; public callers pass
field names and typed values, not byte or bit positions.

The CLI is intentionally stateless: catalog inspection and record reads each
require a profile path, then load, discover, and operate within that invocation.
Every discovery creates a fresh generation and stales prior handles. CLI record
selectors are numeric Unique IDs; logical names appear only in output.

## Typed reads

`readFrtkRecords({ generation, records })` accepts 1–64 selectors. Each selector
has exactly `{ uniqueId, row, fields }`; public SDK calls never accept a logical
name or current-build table ID. A result preserves selector and field order:

```js
await client.readFrtkRecords({
  generation: 4,
  records: [{
    uniqueId: 900001,
    row: 7,
    fields: ['CommitScore', 'RecruitLink'],
  }],
});
```

Values are safe integers or packed references shaped exactly as
`{ uniqueId, row }`. Field names remain data in ordered `{ field, value }`
entries; they are not promoted to object keys.

## Typed transactions

`transactFrtkFields({ transactionId, generation, changes })` accepts 1–128
logical changes shaped exactly as `{ uniqueId, row, field, value }`. Before a
transaction, inspect the same generation using the same client. The SDK locally
rejects any selected table whose inspected authority is not `direct_verified`
with `FRTK_AUTHORITY_UNPROVEN`.

Successful output is limited to `{ transactionId, status, changedFields }`.
Addresses, byte buffers, masks, offsets, memory ranges, and guarded transaction
operations remain host-internal. Raw memory diagnostic methods are separate and
retain their existing contracts.

Stable FrTk errors are `FRTK_PROFILE_INVALID`, `FRTK_DISCOVERY_FAILED`,
`FRTK_DISCOVERY_TIMEOUT`,
`FRTK_CATALOG_STALE`, `FRTK_FIELD_INVALID`, and
`FRTK_AUTHORITY_UNPROVEN`. Branch on `error.code`; messages and hostile host
details are sanitized. A discovery timeout preserves only its exact allowlisted
progress object: phase, public Unique ID or `null`, zero-based fingerprint
ordinal or `null`, completed fingerprint count, elapsed milliseconds, and
bounded cumulative page, chunk, scanned-byte, candidate-window, and capped-match
counters. It never exposes private memory or fingerprint material.
