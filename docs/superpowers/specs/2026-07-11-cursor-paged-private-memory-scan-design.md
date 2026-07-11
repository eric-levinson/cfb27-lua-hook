# Cursor-Paged Private-Memory Scan Design

**Date:** 2026-07-11
**Status:** Approved for implementation
**Scope:** Correct the read-only private-memory discovery path exposed by the CFB27 Lua host, SDK, and developer CLI.

## Problem

The first live CFB27 runtime gate proved that the original whole-process scan
contract is not viable for a multi-gigabyte game process:

- scanning proceeds from low to high virtual addresses and aborts before the
  aggregate would exceed 512 MiB;
- only the first 64 MiB of a larger eligible region is inspected, while the
  result can still report `complete:true`;
- an arbitrary live allocation after either boundary is therefore unreachable;
- a 512 MiB scan approaches or exceeds the SDK's three-second timeout;
- destroying the timed-out client socket does not cancel the synchronous native
  scan, so later protocol requests wait for the scan to finish;
- internal scan buffers themselves create private allocations in the address
  space being scanned.

Increasing the timeout or changing address order would not correct deterministic
coverage. The scan must be resumable and must cover large region tails.

## Goals

- Cover every byte of eligible committed, readable `MEM_PRIVATE` memory without
  one unbounded request.
- Keep each native request bounded in bytes, allocation size, and latency.
- Return explicit progress that the trusted SDK can resume without rescanning
  earlier memory.
- Preserve patterns that cross native chunk and page boundaries.
- Never claim completion after a failed read or skipped eligible byte.
- Keep all operations read-only and all raw addresses inside trusted host,
  SDK, CLI, or Electron main-process code.

## Non-goals

- Snapshot-atomic coverage while the game mutates its heaps.
- Cancellation of an already executing protocol request in this PR.
- Parallel or multi-core scanning.
- Memory writes, recruiting schemas, or renderer-facing memory APIs.
- A host-owned test-only sentinel that would conceal general scan limitations.

## Native page contract

`ScanRequest` gains an optional canonical continuation address named `cursor`.
When omitted, traversal begins at the system minimum application address. The
cursor identifies the first virtual byte not covered by preceding pages.

One native request scans at most 32 MiB of eligible bytes. Native reads use a
dedicated 4 MiB `VirtualAlloc` buffer plus at most `patternLength - 1` bytes of
lookahead. The dedicated buffer's allocation is excluded from traversal and
does not consume the page budget.

The scanner walks `VirtualQuery` regions from the supplied cursor. An eligible
region larger than the remaining page budget is split; the response cursor
lands inside that region and the next page resumes its tail. Ineligible regions
are skipped without consuming the eligible-byte budget.

For each chunk, the scanner reads enough lookahead to detect a pattern beginning
before the unique page boundary and ending after it. Matches whose first byte is
at or beyond the next cursor are deferred to the next page. This prevents gaps
and duplicate boundary matches.

The result contains:

```json
{
  "supportedBuild": true,
  "complete": false,
  "nextCursor": "0x1F4A8000000",
  "scannedBytes": 33554432,
  "matches": []
}
```

`nextCursor` is a canonical uppercase address string when `complete:false` and
is `null` when `complete:true`. `complete:true` means traversal reached the
maximum application address during this host process session. It does not mean
the game was paused or that all pages formed an atomic snapshot.

An eligible-region query or read failure returns a stable error and no
`complete:true` result. The client may retry that page; the host never silently
skips a failed eligible range. Arithmetic overflow, noncanonical cursors, and a
cursor above the maximum application address are rejected.

## Match limits

`maxMatches` remains the caller's global maximum. A native page detects
`maxMatches + 1` within that page and returns `TOO_MANY_MATCHES` as before.

The SDK convenience scan carries the remaining global allowance into each page
and rejects as soon as accumulated matches exceed the original maximum. It does
not silently truncate matches. A caller that needs only a validated first match
may use the page API and stop early; a caller claiming uniqueness must continue
until `complete:true` or `TOO_MANY_MATCHES`.

## Protocol and SDK

`scanMemory` becomes the native page operation and accepts optional `cursor`.
Every response must contain the exact `complete`, `nextCursor`, `scannedBytes`,
and `matches` shape. The existing build gate and all pattern, mask, context, and
match limits remain enforced.

The SDK exposes two levels:

- `client.scanMemoryPage(options)` validates one page request and response.
- `client.scanMemory(options)` repeatedly calls the page operation, aggregates
  matches and scanned bytes, and returns only after completion, overflow, or a
  caller-supplied `maxPages` ceiling from 1 through 4,096.

The convenience method defaults to 4,096 pages, bounding eligible-byte work to
128 GiB. It rejects non-progressing or repeated cursors immediately as
`INVALID_RESPONSE`. It is bound to one PID; a game restart naturally invalidates
the pipe and continuation state.

The CLI `memory scan` uses the convenience method. Human output may report page
progress without exposing it to an Electron renderer. JSON output returns the
validated aggregate SDK result. The CLI uses a scan-appropriate timeout for
each page; status, events, reads, and telemetry keep their shorter default.

## Safety and consistency

- The API remains read-only.
- Cursors and matches are strings, never JavaScript numbers.
- Raw addresses, patterns, contexts, and bytes remain prohibited from an
  Electron renderer.
- Found candidates must be re-read and validated before later interpretation or
  any future write transaction.
- A live memory-map change may invalidate a candidate between pages; downstream
  calibration treats PID, host session, failed validation, and relevant game
  transitions as invalidation events.
- The scanner does not pause the game or bypass anticheat.

## Verification

Native tests must demonstrate:

1. a sentinel after offset 64 MiB in one large eligible region is found across
   pages;
2. a sentinel after more than 512 MiB of earlier eligible memory is reachable;
3. a pattern crossing a 4 MiB chunk boundary and a 32 MiB page boundary is
   returned exactly once;
4. cursors advance monotonically and terminate with `complete:true`;
5. internal scan storage does not appear as a match or consume page budget;
6. a failed eligible read cannot produce `complete:true`;
7. invalid, overflowing, repeated, and non-progressing cursors are rejected.

Protocol and SDK tests must validate exact request/response shapes, hostile
numeric or noncanonical cursors, multi-page aggregation, global match limits,
page ceilings, and repeated-cursor rejection. CLI tests must prove automatic
pagination, scan-specific timeout selection, JSON aggregation, and continued
rejection of write-like arguments.

The manual offline gate must be repeated with a fresh installed candidate. It
must find the deliberately allocated Lua sentinel, read back its exact 16 bytes,
emit registered telemetry exactly once with an advancing cursor, remain
responsive for ten minutes, and survive a Dynasty hub transition without any
memory write.
