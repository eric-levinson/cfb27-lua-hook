# Safety boundary

Release documentation must not contain realistic-width process addresses unless
each synthetic token is immediately prefixed on the same line with the exact
marker `SYNTHETIC_ADDRESS:` (for example,
`SYNTHETIC_ADDRESS:0x7FF612340080`). Unmarked tokens are treated as private
runtime evidence and rejected from staged files, npm archives, and the release
ZIP.

CFB27 Lua Hook is for a separately launched offline game session. It does not
provide, distribute, or document an anticheat bypass.

## Installation safety

- Close the game before installing or restoring the MMC startup proxy.
- Both original MMC `CryptBase.dll` files are checksum-verified and preserved
  as `MMCBase.dll` before replacement.
- Unknown active proxies or backups are never overwritten.
- A failed install restores both verified MMC proxies.
- Do not disable or allowlist antivirus protection for this project.

## Runtime write gates

`cfb.write_u8` rejects a write unless all of these conditions hold:

1. The process is an exact registry-matched, certified CFB27 executable build.
2. No real EA anticheat or Javelin process is detected.
3. The address belongs to committed writable memory.
4. The current byte equals the caller's expected byte.
5. Readback equals the requested replacement byte.

An exact registry-matched diagnostic build may load the host for research, but
writes and native calls stay disabled. An unknown build has neither research-
watch nor write authority. The native `writeTransaction` command preserves the
exact-build and anticheat gates, validates and compares every operation before
writing, applies and verifies in request order, and rolls attempted operations
back in reverse order after an apply or verification failure.

Transaction sequencing is not game-thread atomicity. The host does not suspend
the game or provide a stable snapshot; callers must establish a stable window
for the targeted data. If rollback verification fails, the host permanently
sets `sessionWritesDisabled`, and both `writeTransaction` and `cfb.write_u8`
reject all further writes until the process restarts. Integrations should call
`hello`, inspect `writesAllowed`, check `status.sessionWritesDisabled`, and
handle the transaction's verified status explicitly.

The typed FrTk protocol is stricter than the raw memory surface. Profile and
layout load as one validated bundle, public table selectors use Unique IDs,
and discovery installs no partial catalog. Explicit transitions, save changes,
shutdown, and `game_ready:false` stale the catalog generation.

Typed responses omit process addresses, raw bytes, patterns, masks, offsets,
ranges, and transaction plans. Typed writes accept only logical
Unique-ID/row/field/value changes, reread live records, and use the existing
guarded engine. Non-`direct_verified` authority fails closed before planning;
rollback failure still disables raw, typed, and Lua writes for the session.

Research watches are allowed only when the running executable exactly matches
a diagnostic or certified registry identity and no real anticheat is present.
Writes, native calls, FrTk field transactions, live-class replacement, and
board mutations require a certified identity. A loaded `.frtk` profile,
discovered layout, runtime scan, or other evidence can validate data for the
matched build, but cannot create or elevate runtime authority.

`CFB27_SMOKE_ALLOW_WRITES=1` is a native test gate recognized only when the
hosting executable is exactly `cfb27_protocol_smoke.exe`. It does not enable
writes in the game, MMC, or any other executable, and it does not grant
research-watch authority.
