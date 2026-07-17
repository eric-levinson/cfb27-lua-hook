# Patch 1 Build Re-Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the offline CFB27 Lua Hook on the July 16 Patch 1 executable and leave behind a deterministic, fail-closed workflow for re-anchoring later game builds.

**Architecture:** A tracked JSON manifest is the authoritative list of exact game identities and board layouts. Deterministic code generation compiles that data into the native host, whose runtime gates distinguish unknown, diagnostic, and certified builds. A guided Node CLI reuses tested table discovery, captures vanilla UI actions with research watches, validates PE sections and object shapes, and emits ignored evidence; only an explicit source promotion can compile candidate RVAs into a certified acceptance build.

**Tech Stack:** Node.js 20/CommonJS, `node:test`, C++20/MSVC, CMake 3.24+, existing CFB27 SDK framed protocol, Windows hardware debug-register watches, MMC 1.1.0.1.

## Global Constraints

- Preserve `hello.supportedBuild` and `status.supportedBuild` semantics: true means exact **certified** build only.
- Unknown builds require `allowUnsupportedBuild: true` for public reads/scans and cannot use research watches, native calls, or writes.
- Exact diagnostic builds may use explicit-opt-in reads/scans and research watches, but cannot use native calls or any game-data write path.
- `CFB27_SMOKE_ALLOW_WRITES=1` remains restricted to `cfb27_protocol_smoke.exe` and must not become a general bypass.
- Production code must never read `.frtk/board-reanchor/**`; only reviewed manifest data may enable board mutation.
- Raw addresses, memory samples, saves, and candidate artifacts remain under ignored `.frtk/` paths and are never packaged or committed.
- The guided workflow may observe vanilla game actions, but it must not synthesize a mutation while Patch 1 is diagnostic.
- Do not revive archived edit-player hooks, alter Brooks's SPEX data, or add online/anticheat bypass behavior.
- Use the installer for both game and MMC locations; do not manually replace proxy DLLs.
- Stop immediately on an identity mismatch, ambiguous table, inconsistent capture, PE-section mismatch, native fault, or failed postcondition.

---

### Task 1: Add the authoritative build manifest and deterministic generator

**Files:**

- Create: `native/host/game_builds.json`
- Create: `scripts/game-build-manifest.cjs`
- Create: `scripts/generate-game-builds.cjs`
- Create: `native/host/game_builds.generated.h`
- Create: `tests/game-build-manifest.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing manifest-validation tests**

Cover exact SHA normalization, duplicate size/SHA rejection, diagnostic entries rejecting a board layout, certified entries requiring all four nonzero RVAs, deterministic ordering, and generated-header stability.

```js
test('diagnostic builds cannot carry a board layout', () => {
  assert.throws(() => parseManifest({
    version: 1,
    builds: [{
      label: 'patch-1-2026-07-16',
      size: 249801616,
      sha256: PATCH1_SHA,
      support: 'diagnostic',
      board: { genericRecordWrapperVtableRva: '0x1' },
    }],
  }), /diagnostic.*board/i);
});

test('the checked-in generated header is current', () => {
  const manifest = parseManifest(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')));
  assert.equal(fs.readFileSync(HEADER, 'utf8'), generateHeader(manifest));
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --test tests/game-build-manifest.test.cjs
```

Expected: `ERR_MODULE_NOT_FOUND` or missing-export failure for `scripts/game-build-manifest.cjs`.

- [ ] **Step 3: Implement strict manifest parsing and header generation**

Export `parseManifest(raw)`, `generateHeader(manifest)`, `loadManifest(path)`, and `writeGeneratedHeader({ manifestPath, headerPath, check })`. Parse RVAs to `BigInt` internally, reject unknown keys, require uppercase 64-character SHA-256 values, and emit stable C++ entries ordered as they appear in the manifest.

The generated header must contain only literals and a `constexpr` array; it must not contain filesystem access:

```cpp
inline constexpr std::array<GeneratedBuild, 2> kGeneratedBuilds{{
    {"july-11-2026", 247845776ULL,
     "9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8",
     Support::kCertified,
     BoardLayout{0xB093F68ULL, 0xB0B5BA8ULL, 0x8109060ULL, 0x8166090ULL}},
    {"patch-1-2026-07-16", 249801616ULL,
     "A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD",
     Support::kDiagnostic, std::nullopt},
}};
```

- [ ] **Step 4: Add the two confirmed builds to `game_builds.json`**

The July 11 entry is `certified` with the four current RVAs. Patch 1 is `diagnostic` with `"board": null`. Do not invent version metadata beyond the labels, sizes, and hashes confirmed in the design.

- [ ] **Step 5: Add generator CLI and package checks**

`node scripts/generate-game-builds.cjs` writes the header. `--check` compares bytes and exits nonzero without changing files. Extend `npm run check` with syntax checks for the new scripts and `node scripts/generate-game-builds.cjs --check`.

- [ ] **Step 6: Generate the header and make the tests pass**

Run:

```powershell
node scripts/generate-game-builds.cjs
node --test tests/game-build-manifest.test.cjs
npm run check
```

Expected: the focused test passes and the generator reports the header is current.

- [ ] **Step 7: Commit the manifest foundation**

```powershell
git add -- native/host/game_builds.json native/host/game_builds.generated.h scripts/game-build-manifest.cjs scripts/generate-game-builds.cjs tests/game-build-manifest.test.cjs package.json
git commit -m "feat: add compiled game build manifest"
```

---

### Task 2: Introduce the native build registry and inject board layouts

**Files:**

- Create: `native/host/game_builds.h`
- Create: `native/host/game_builds.cpp`
- Create: `native/smoke/game_builds_smoke.cpp`
- Modify: `native/host/board_mutation.h`
- Modify: `native/host/board_mutation.cpp`
- Modify: `native/smoke/board_mutation_smoke.cpp`
- Modify: `native/CMakeLists.txt`

- [ ] **Step 1: Write a failing native registry smoke**

Assert that exact size/hash lookup returns the July 11 certified entry and Patch 1 diagnostic entry, an incorrect size or one changed hash nibble returns null, and only the certified entry exposes a board layout.

```cpp
const auto* patch1 = FindBuild(
    249801616ULL,
    "A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD");
if (!patch1 || patch1->support != Support::kDiagnostic || patch1->board) return 1;
```

- [ ] **Step 2: Add the smoke target and confirm it fails to build**

Run:

```powershell
cmake -S native -B native/build-patch1 -A x64
cmake --build native/build-patch1 --config Release --target cfb27_game_builds_smoke
```

Expected: compilation fails because `game_builds.h/.cpp` do not exist yet.

- [ ] **Step 3: Implement the registry API**

Define a single shared layout type and exact lookup helpers:

```cpp
namespace cfb27::game_builds {
enum class Support { kDiagnostic, kCertified };
struct BoardLayout {
  std::uintptr_t generic_record_wrapper_vtable_rva{};
  std::uintptr_t recruiting_controller_vtable_rva{};
  std::uintptr_t full_add_rva{};
  std::uintptr_t full_remove_rva{};
};
struct Build {
  std::string_view label;
  std::uintmax_t executable_size{};
  std::string_view executable_sha256;
  Support support{Support::kDiagnostic};
  std::optional<BoardLayout> board;
};
const Build* FindBuild(std::uintmax_t size, std::string_view uppercase_sha256);
bool IsCertified(const Build* build);
bool IsDiagnosticOrCertified(const Build* build);
}
```

`game_builds.cpp` includes the generated header and performs exact size plus hash matching.

- [ ] **Step 4: Remove board RVAs from `board_mutation.cpp`**

Change `Invoke` to accept `const game_builds::BoardLayout&`. Use only the supplied layout when locating objects and selecting add/remove targets.

```cpp
Result Invoke(const game_builds::BoardLayout& layout, Operation operation,
              std::uint32_t recruit_row, std::uint32_t team_row);
```

Update `board_mutation_smoke.cpp` to pass a nonzero synthetic layout and preserve the invalid-argument and unloaded-module assertions.

- [ ] **Step 5: Build and run both native smokes**

Run:

```powershell
cmake --build native/build-patch1 --config Release --target cfb27_game_builds_smoke cfb27_board_mutation_smoke
native\build-patch1\Release\cfb27_game_builds_smoke.exe
native\build-patch1\Release\cfb27_board_mutation_smoke.exe
```

Expected: both output a line containing `smoke passed` and return exit code 0.

- [ ] **Step 6: Commit the native registry**

```powershell
git add -- native/host/game_builds.h native/host/game_builds.cpp native/host/board_mutation.h native/host/board_mutation.cpp native/smoke/game_builds_smoke.cpp native/smoke/board_mutation_smoke.cpp native/CMakeLists.txt
git commit -m "refactor: route board offsets through build registry"
```

---

### Task 3: Enforce unknown, diagnostic, and certified runtime gates

**Files:**

- Create: `native/host/build_policy.h`
- Create: `native/host/build_policy.cpp`
- Create: `native/smoke/build_policy_smoke.cpp`
- Modify: `native/host/lua_host.cpp`
- Modify: `native/smoke/protocol_smoke.cpp`
- Modify: `native/smoke/startup_host_smoke.cpp`
- Modify: `native/CMakeLists.txt`
- Modify: `docs/protocol.md`
- Modify: `docs/lua-api.md`
- Modify: `docs/safety.md`

- [ ] **Step 1: Extend smoke assertions before changing the host**

Keep the public hello/status key sets unchanged. Add assertions that the protocol smoke still reports `supportedBuild: false` yet can use its executable-name-restricted smoke override, while the normal startup smoke cannot. Add `build_policy_smoke.cpp` to exercise the policy matrix without relying on the host executable hash:

| Identity | Research watch | Native calls/writes |
|---|---:|---:|
| unknown | false | false |
| diagnostic | true | false |
| certified, offline | true | true |
| certified, anticheat present | false | false |

- [ ] **Step 2: Build the smokes and confirm the new assertions fail**

Run:

```powershell
cmake --build native/build-patch1 --config Release --target cfb27_build_policy_smoke cfb27_lua_host cfb27_protocol_smoke cfb27_startup_smoke
native\build-patch1\Release\cfb27_build_policy_smoke.exe
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try {
  native\build-patch1\Release\cfb27_protocol_smoke.exe native\build-patch1\Release\cfb27_lua_host.dll
} finally {
  Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue
}
```

Expected: `cfb27_build_policy_smoke` fails to compile because the policy module is absent.

- [ ] **Step 3: Replace the single supported-build atomic with matched-build state**

At startup, compute the executable size and SHA once, resolve it through `game_builds::FindBuild`, and store the matched immutable `Build*` in `std::atomic<const Build*>`. Remove `kSupportedExecutableSize`, `kSupportedExecutableSha256`, and `VerifySupportedBuild()`.

Implement pure policy functions in `build_policy.h/.cpp`, then thin host predicates, so call sites cannot conflate research and write authority:

```cpp
namespace cfb27::build_policy {
bool ResearchWatchesAllowed(const game_builds::Build* build,
                            bool real_anticheat_running);
bool WritesAllowed(const game_builds::Build* build,
                   bool real_anticheat_running,
                   bool session_writes_disabled,
                   bool smoke_override);
}

bool CertifiedBuild() { return game_builds::IsCertified(g_game_build.load()); }
bool DiagnosticOrCertifiedBuild() {
  return game_builds::IsDiagnosticOrCertified(g_game_build.load());
}
bool ResearchWatchesAllowed() {
  return DiagnosticOrCertifiedBuild() && !RealAnticheatIsRunning();
}
bool WriteEnvironmentAllowed() {
  return (CertifiedBuild() || SmokeWritesAllowed()) && !RealAnticheatIsRunning();
}
```

- [ ] **Step 4: Apply the gates to every sensitive path**

- `supportedBuild` calls `CertifiedBuild()`.
- Public scan/read behavior remains unchanged and continues requiring explicit opt-in when `supportedBuild` is false.
- `cfb.watch_*` and watch clearing use `ResearchWatchesAllowed()`, not `NativeCallsAllowed()`.
- Native calls, transactions, FrTk writes, live-class replacement, and board mutations remain behind `NativeCallsAllowed()` or `WriteEnvironmentAllowed()`.
- `addBoard/removeBoard` require a certified matched build with a board layout and pass that layout to `board_mutation::Invoke`.
- `loadFrtkProfile` compares a supported production profile to the matched certified build hash; preserve the synthetic protocol-smoke exception.

- [ ] **Step 5: Preserve protocol compatibility and improve errors**

Do not add keys to `hello` or `status`. Update denial text to distinguish `UNKNOWN_BUILD`, `DIAGNOSTIC_BUILD_WRITE_BLOCKED`, and `RESEARCH_WATCH_NOT_ALLOWED` internally without weakening existing public validation.

- [ ] **Step 6: Document the policy**

Update the protocol, Lua API, and safety docs to state that research watches are allowed only for an exact diagnostic/certified offline identity, while writes/native calls require certification. Explicitly state that `.frtk` evidence cannot grant authority.

- [ ] **Step 7: Run native protocol verification**

Run:

```powershell
cmake --build native/build-patch1 --config Release --target cfb27_build_policy_smoke cfb27_lua_host cfb27_protocol_smoke cfb27_startup_smoke cfb27_board_mutation_smoke cfb27_game_builds_smoke
native\build-patch1\Release\cfb27_build_policy_smoke.exe
native\build-patch1\Release\cfb27_game_builds_smoke.exe
native\build-patch1\Release\cfb27_board_mutation_smoke.exe
native\build-patch1\Release\cfb27_startup_smoke.exe native\build-patch1\Release\cfb27_lua_host.dll
$env:CFB27_SMOKE_ALLOW_WRITES='1'
try {
  native\build-patch1\Release\cfb27_protocol_smoke.exe native\build-patch1\Release\cfb27_lua_host.dll
} finally {
  Remove-Item Env:CFB27_SMOKE_ALLOW_WRITES -ErrorAction SilentlyContinue
}
```

Expected: every executable exits 0; hello/status shapes remain compatible.

- [ ] **Step 8: Commit runtime gating**

```powershell
git add -- native/host/build_policy.h native/host/build_policy.cpp native/host/lua_host.cpp native/smoke/build_policy_smoke.cpp native/smoke/protocol_smoke.cpp native/smoke/startup_host_smoke.cpp native/CMakeLists.txt docs/protocol.md docs/lua-api.md docs/safety.md
git commit -m "feat: add diagnostic build safety state"
```

---

### Task 4: Extract and strengthen reusable table-anchor validation

**Files:**

- Create: `scripts/board-verification/reanchor-lib.cjs`
- Create: `tests/board-reanchor.test.cjs`
- Modify: `scripts/board-verification/live-anchor.cjs`
- Modify: `scripts/board-verification/live-table-snapshot.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write fixture-based failing tests**

Build small in-memory fixtures for all six table definitions. Test signature generation, reference decoding, header-to-data geometry, freelist/content scoring, ambiguous-top-score rejection, compact membership discovery, header reread mismatch, and scan/read requests carrying `allowUnsupportedBuild: true`.

```js
test('selectTableCandidate rejects tied structural winners', () => {
  assert.throws(
    () => selectTableCandidate(TABLES.get(4168), [winnerA, winnerB]),
    /ambiguous/i,
  );
});
```

- [ ] **Step 2: Confirm the test fails before extraction**

Run:

```powershell
node --test tests/board-reanchor.test.cjs
```

Expected: missing module failure for `reanchor-lib.cjs`.

- [ ] **Step 3: Extract pure helpers and async discovery**

Export frozen `TABLES`, `canonical`, `signature`, `decodeRef`, `scoreCandidate`, `deriveDataAddress`, `selectTableCandidate`, `locateTable`, `findUserBoard`, `readRange`, and `validateAnchorReread`.

Strengthen selection: the highest score must be positive and strictly greater than the runner-up; reread the 16-byte header, freelist head, and representative content/free rows before acceptance. All reads and scan pages used by this diagnostic tool must pass `allowUnsupportedBuild: true` explicitly.

- [ ] **Step 4: Convert the existing scripts to consumers**

Remove duplicate constants/helpers from `live-anchor.cjs`. Keep its current output shape for compatibility, but add executable SHA/session identity and the six validation summaries. Update `live-table-snapshot.cjs` to use opt-in reads and reject a mismatched PID or executable hash.

- [ ] **Step 5: Add syntax checks and run tests**

Extend `npm run check` for all three board-verification scripts.

Run:

```powershell
node --test tests/board-reanchor.test.cjs
npm run check
npm test
```

Expected: the focused fixtures and full Node suite pass.

- [ ] **Step 6: Commit the reusable anchor layer**

```powershell
git add -- scripts/board-verification/reanchor-lib.cjs scripts/board-verification/live-anchor.cjs scripts/board-verification/live-table-snapshot.cjs tests/board-reanchor.test.cjs package.json
git commit -m "refactor: make board anchors reusable and strict"
```

---

### Task 5: Implement evidence storage, PE validation, and capture analysis

**Files:**

- Create: `scripts/board-verification/reanchor-evidence.cjs`
- Create: `tests/board-reanchor-evidence.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing analyzer tests with sanitized fixtures**

Test:

- output root is exactly `.frtk/board-reanchor/<uppercase-sha>/`;
- atomic JSON writes use a temporary sibling then rename;
- evidence from another PID, host session token, or executable SHA is rejected;
- PE parsing classifies `.text` as executable and `.rdata` as readable/non-executable;
- module addresses convert to RVAs only inside the image;
- common stack-return candidates are ranked across two captures;
- wrapper/controller object shapes derive the two stable vtable RVAs;
- a low-level routine with wrong argument shapes is rejected;
- candidate output lists every gate with an explicit boolean and overall pass only when all pass.

- [ ] **Step 2: Confirm the focused test fails**

Run:

```powershell
node --test tests/board-reanchor-evidence.test.cjs
```

Expected: missing module failure.

- [ ] **Step 3: Implement deterministic local evidence helpers**

Export `evidenceDirectory`, `writeEvidence`, `readEvidence`, `parsePeSections`, `classifyModuleAddress`, `rankRoutineCandidates`, `validateObjectShapes`, `deriveVtableRvas`, and `buildCandidateArtifact`.

PE checks must require:

- routine candidates inside an executable main-module section;
- vtables inside readable main-module image memory;
- sampled vtable entries inside executable main-module sections;
- all accepted addresses at or above module base and below `moduleBase + SizeOfImage`.

- [ ] **Step 4: Define the candidate schema in code**

Use schema version 1 and include:

```js
{
  schemaVersion: 1,
  build: { label, executableSize, executableSha256 },
  session: { pid, sessionId, moduleBase, capturedAt },
  tables: {
    '4168': { passed, candidateCount, score, rereadPassed },
    '4176': { passed, candidateCount, score, rereadPassed },
    '4190': { passed, candidateCount, score, rereadPassed },
    '4251': { passed, candidateCount, score, rereadPassed },
    '5790': { passed, candidateCount, score, rereadPassed },
    '5847': { passed, candidateCount, score, rereadPassed },
  },
  captures: {
    add: { writeCount, executeCount, consistent },
    remove: { writeCount, executeCount, consistent },
  },
  proposedBoard: {
    genericRecordWrapperVtableRva,
    recruitingControllerVtableRva,
    fullAddRva,
    fullRemoveRva,
  },
  gates: [{ name, passed, detail }],
  passed: true,
}
```

Hex RVAs in JSON are uppercase canonical strings. The artifact may contain local raw addresses, but generated committed material must use only the four RVAs and sanitized gate results.

- [ ] **Step 5: Run focused and full tests**

```powershell
node --test tests/board-reanchor-evidence.test.cjs
npm run check
npm test
```

- [ ] **Step 6: Commit evidence analysis**

```powershell
git add -- scripts/board-verification/reanchor-evidence.cjs tests/board-reanchor-evidence.test.cjs package.json
git commit -m "feat: analyze board re-anchor evidence"
```

---

### Task 6: Build the guided Patch 1 re-anchor CLI

**Files:**

- Create: `scripts/board-verification/reanchor-build.cjs`
- Create: `tests/board-reanchor-cli.test.cjs`
- Modify: `package.json`
- Modify: `docs/development/building.md`

- [ ] **Step 1: Write failing command-level tests with a fake SDK client**

Cover `preflight`, `validate`, `capture-add-write`, `capture-add-execute`, `capture-remove-write`, `capture-remove-execute`, `transition-check`, `analyze`, and `status`. Require each capture command to reject missing prior phases, wrong PID/session, non-diagnostic host state, anticheat, stale table anchors, or an unverified save backup.

- [ ] **Step 2: Confirm the test fails**

Run:

```powershell
node --test tests/board-reanchor-cli.test.cjs
```

Expected: missing CLI/module failure.

- [ ] **Step 3: Implement strict CLI argument parsing and preflight**

Required common arguments are `--game-dir`, `--save`, and optional `--output-root` defaulting to `.frtk/board-reanchor`. Preflight must:

1. hash `<game-dir>\CollegeFB27.exe`;
2. require the exact diagnostic manifest entry;
3. compare the discovered process executable path/size/hash to disk;
4. require hello ready with `supportedBuild:false` and `writesAllowed:false`;
5. reject a real EA/Javelin anticheat process;
6. create and SHA-256-verify `save-backup\<save-name>` inside the evidence directory;
7. record PID plus a session identifier derived from PID, process creation time, and host-start log/status evidence.

Preflight must never arm a watch.

- [ ] **Step 4: Implement table validation and before/after snapshots**

`validate` discovers all six tables through `reanchor-lib.cjs`, rereads them, identifies exactly one user board, and writes `tables.json`. Every later capture revalidates the table headers and current board before arming watches, then records a post-action snapshot and validates the vanilla postcondition.

- [ ] **Step 5: Implement write-watch capture commands**

For add, arm at most four write watches over the 4168 freelist head and first free 5847 membership slot. For remove, arm the selected membership slot and the 4168/5790 freelist heads. Each command prints one explicit operator instruction, waits for Enter only after the user completes the vanilla UI action, calls `cfb.watch_hits(true)`, and serializes hits through `cfb.log` with a unique session/capture prefix. Fetch and parse only matching log records.

Two independent write captures are required for each operation. Use different recruits, and store `add-write-1.json`, `add-write-2.json`, `remove-write-1.json`, and `remove-write-2.json`.

- [ ] **Step 6: Implement execute-watch confirmation**

`analyze --stage rank` intersects main-module stack return addresses across the two write captures and emits a bounded ranked list. `capture-*-execute` arms execute watches for at most four ranked executable addresses, prompts one more vanilla action, and requires a hit whose Windows x64 entry arguments match:

- `RCX`: recruiting controller object;
- `RDX`: pointer cell containing the Team wrapper;
- `R8`: pointer cell containing the Recruit wrapper.

Validate controller descriptor table `5003`, Recruit descriptor table `4269`, Team descriptor table `6334`, row identities, controller board store at `+0x138`, and readable wrapper fields at `+0x10/+0x18`. Reject inner allocation/table routines that do not receive this shape.

- [ ] **Step 7: Implement transition and final analysis gates**

`transition-check` asks the user to leave and re-enter Recruiting, rediscovers objects, and requires changed-or-still-valid object addresses but identical two vtable RVAs. Final `analyze` requires all six tables, two consistent write captures per operation, one argument-shaped execute capture per operation, stable vtables, executable routine sections, and transition stability before writing `candidate.json`.

- [ ] **Step 8: Document the exact future-update procedure**

Add the command sequence and explain that the candidate is local evidence only. Include the hard stop between backup creation and user-approved vanilla UI actions.

- [ ] **Step 9: Run tests and syntax checks**

```powershell
node --test tests/board-reanchor-cli.test.cjs
npm run check
npm test
```

- [ ] **Step 10: Commit the guided workflow**

```powershell
git add -- scripts/board-verification/reanchor-build.cjs tests/board-reanchor-cli.test.cjs package.json docs/development/building.md
git commit -m "feat: guide vanilla board re-anchoring"
```

---

### Task 7: Add explicit, reviewable promotion and demotion

**Files:**

- Create: `scripts/promote-game-build.cjs`
- Modify: `scripts/game-build-manifest.cjs`
- Modify: `tests/game-build-manifest.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing promotion tests**

Test that promotion rejects a failed artifact, wrong SHA/size, unknown build, noncanonical/zero RVAs, missing gates, raw RVAs outside valid PE sections, and attempts to overwrite another build. Test that successful promotion changes only Patch 1 to `certified`, installs exactly the four proposed RVAs, and regenerates the header. Test demotion sets support to `diagnostic`, removes the board layout, and regenerates the header.

- [ ] **Step 2: Confirm the tests fail**

```powershell
node --test tests/game-build-manifest.test.cjs
```

Expected: missing promotion exports/CLI.

- [ ] **Step 3: Implement promotion as an explicit source edit**

Support only these modes:

```powershell
node scripts/promote-game-build.cjs --candidate <candidate.json> --certify
node scripts/promote-game-build.cjs --sha <SHA256> --diagnostic
```

`--certify` rereads the candidate, requires `passed:true` and all gates true, matches the existing diagnostic identity exactly, rewrites `game_builds.json` atomically, and regenerates the header. `--diagnostic` removes the board layout. Neither command changes `.frtk` evidence or invokes Git.

- [ ] **Step 4: Make tests and generator check pass**

```powershell
node --test tests/game-build-manifest.test.cjs
node scripts/generate-game-builds.cjs --check
npm run check
npm test
```

- [ ] **Step 5: Commit promotion tooling**

```powershell
git add -- scripts/promote-game-build.cjs scripts/game-build-manifest.cjs tests/game-build-manifest.test.cjs package.json
git commit -m "feat: require evidence for build promotion"
```

---

### Task 8: Build and install the diagnostic Patch 1 host

**Files:**

- Runtime output only: `native/build-patch1/Release/**`
- Runtime installation only: `F:\EA SPORTS College Football 27\**`
- Runtime installation only: `C:\Users\Eric Levinson\Downloads\MMC_Modding_Tools_v1.1.0.1\MMC_ModManager_v1.1.0.1\**`

- [ ] **Step 1: Run the complete pre-install automated gate**

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-patch1 -A x64
cmake --build native/build-patch1 --config Release
```

Run every native smoke from `docs/development/building.md`, including `cfb27_game_builds_smoke.exe`. Only wrap `cfb27_protocol_smoke.exe` with `CFB27_SMOKE_ALLOW_WRITES=1`, and remove the variable in `finally`.

Expected: all Node tests and native smokes pass; no source or generated-header drift.

- [ ] **Step 2: Close the game and MMC, then verify both are absent**

Use read-only process checks. Do not install while `CollegeFB27.exe` or MMC is running.

- [ ] **Step 3: Install through the supported CLI**

```powershell
node packages/cli/bin/cfb27lua.cjs install `
  --game-dir "F:\EA SPORTS College Football 27" `
  --mmc-dir "C:\Users\Eric Levinson\Downloads\MMC_Modding_Tools_v1.1.0.1\MMC_ModManager_v1.1.0.1" `
  --artifacts-dir "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27-codex\saves\cfb27-lua-hook-restructure\native\build-patch1\Release"
```

Require the installer to recognize stock MMC `CryptBase.dll` size `95744` and SHA-256 `3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454`, preserve/verify both originals, and install matching host/proxy hashes in both locations.

- [ ] **Step 4: Run doctor and record the installed hashes locally**

```powershell
node packages/cli/bin/cfb27lua.cjs doctor `
  --game-dir "F:\EA SPORTS College Football 27" `
  --mmc-dir "C:\Users\Eric Levinson\Downloads\MMC_Modding_Tools_v1.1.0.1\MMC_ModManager_v1.1.0.1"
```

Expected while the game is closed: installation healthy; no claim that Patch 1 is certified.

- [ ] **Step 5: Launch MMC and the game offline to the Dynasty hub**

After the host connects, require exact Patch 1 identity, `supportedBuild:false`, `writesAllowed:false`, and `researchWatch` capability. If either public flag is true at this stage, close both applications and treat it as a release-blocking defect.

---

### Task 9: Capture Patch 1 vanilla evidence and generate the candidate

**Files:**

- Ignored local evidence only: `.frtk/board-reanchor/A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD/**`
- Read-only source save plus verified local backup: `C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE`

- [ ] **Step 1: Run preflight and create the verified backup**

```powershell
node scripts/board-verification/reanchor-build.cjs preflight `
  --game-dir "F:\EA SPORTS College Football 27" `
  --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
```

Expected: exact diagnostic build, matching process/disk identity, offline host, no anticheat, and byte-identical backup copy. If the user selects a different disposable dynasty, rerun preflight with that exact path and do not mix evidence sets.

- [ ] **Step 2: Pause for explicit user confirmation before vanilla changes**

Report the save path, original SHA-256, backup path/SHA-256, PID, and session ID. Do not proceed until the user confirms that this dynasty may be changed through the normal game UI.

- [ ] **Step 3: Validate all six live tables**

```powershell
node scripts/board-verification/reanchor-build.cjs validate `
  --game-dir "F:\EA SPORTS College Football 27" `
  --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
```

Expected: one unambiguous validated candidate each for 4168, 4176, 4190, 4251, 5790, and 5847, plus exactly one user board. A tie or changed reread ends the session.

- [ ] **Step 4: Capture two vanilla adds and confirm the full entry**

Run the following sequence, selecting a different off-board recruit for the second write capture and another valid recruit for execute confirmation:

```powershell
node scripts/board-verification/reanchor-build.cjs capture-add-write --capture 1 --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
node scripts/board-verification/reanchor-build.cjs capture-add-write --capture 2 --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
node scripts/board-verification/reanchor-build.cjs analyze --stage rank --operation add --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
node scripts/board-verification/reanchor-build.cjs capture-add-execute --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
```

Follow only the script's printed prompt; do not call `addBoard` while diagnostic.

- [ ] **Step 5: Capture two vanilla removes and confirm the full entry**

Choose on-board recruits with no visit, pitch, or assigned action that would make the trace ambiguous, then run:

```powershell
node scripts/board-verification/reanchor-build.cjs capture-remove-write --capture 1 --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
node scripts/board-verification/reanchor-build.cjs capture-remove-write --capture 2 --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
node scripts/board-verification/reanchor-build.cjs analyze --stage rank --operation remove --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
node scripts/board-verification/reanchor-build.cjs capture-remove-execute --game-dir "F:\EA SPORTS College Football 27" --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
```

Require both freelist returns, cleared references, compact membership, and the full three-argument object shape.

- [ ] **Step 6: Validate vtables across a screen transition**

```powershell
node scripts/board-verification/reanchor-build.cjs transition-check `
  --game-dir "F:\EA SPORTS College Football 27" `
  --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
```

Leave Recruiting, return to it when prompted, and require the same wrapper/controller vtable RVAs from structurally valid new/current objects.

- [ ] **Step 7: Generate and manually review `candidate.json`**

```powershell
node scripts/board-verification/reanchor-build.cjs analyze `
  --game-dir "F:\EA SPORTS College Football 27" `
  --save "C:\Users\Eric Levinson\Documents\EA SPORTS College Football 27\saves\DYNASTY-JUL14-10h09m30-AUTOSAVE"
```

Review:

`.frtk\board-reanchor\A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD\candidate.json`

Require every gate true. Do not promote if the candidate selects a low-level allocation/table routine, contains a section mismatch, or does not show consistent entry arguments.

---

### Task 10: Promote Patch 1 only into a local acceptance build

**Files:**

- Modify: `native/host/game_builds.json`
- Modify: `native/host/game_builds.generated.h`
- Create: `docs/research/patch1-build-reanchor.md`

- [ ] **Step 1: Promote the reviewed candidate**

```powershell
node scripts/promote-game-build.cjs `
  --candidate ".frtk\board-reanchor\A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD\candidate.json" `
  --certify
node scripts/generate-game-builds.cjs --check
```

Inspect the diff. It must change only the Patch 1 support state, its four board RVAs, and the deterministic generated header.

- [ ] **Step 2: Write a sanitized research record**

Record Patch 1 size/hash, four promoted RVAs, capture counts, table IDs, pass/fail gates, backup hash verification, and dates. Do not include process addresses, raw qwords, save contents, or `.frtk` paths beyond naming the ignored evidence convention.

- [ ] **Step 3: Rebuild and rerun all automated gates**

```powershell
npm run check
npm test
cmake --build native/build-patch1 --config Release --clean-first
```

Run every native smoke from the updated building guide. Expected: registry smoke now expects Patch 1 certified with exactly the candidate layout.

- [ ] **Step 4: Reinstall the exact acceptance build with both apps closed**

Repeat Task 8's supported CLI install command and doctor verification. Relaunch offline and require `supportedBuild:true`, `writesAllowed:true`, healthy ticks, and no session lockout.

- [ ] **Step 5: Commit the local promotion only after automated gates pass**

```powershell
git add -- native/host/game_builds.json native/host/game_builds.generated.h docs/research/patch1-build-reanchor.md
git commit -m "feat: certify patch 1 board layout"
```

This commit is still not releasable until Task 11 passes.

---

### Task 11: Execute the guarded live acceptance gate

**Files:**

- Modify: `docs/research/patch1-build-reanchor.md`

- [ ] **Step 1: Revalidate the backup and live tables**

Recompute the backup SHA-256 and compare it with preflight. Re-anchor all six tables in the current PID/session before any mutation.

- [ ] **Step 2: Exercise both no-op paths**

Call guarded add for an already-present recruit and require `UNCHANGED` with no native invocation. Call guarded remove for an already-absent recruit and require the same. Confirm table snapshots and freelist heads are unchanged.

- [ ] **Step 3: Exercise one real guarded add**

On the approved disposable dynasty, add one absent recruit through the board mutation API. Require exactly:

- one 4168 freelist allocation;
- one 5790 freelist allocation;
- one compact 5847 membership append;
- expected recruit/team references;
- healthy host status with writes still eligible.

- [ ] **Step 4: Exercise one real guarded remove**

Remove that same recruit. Require both allocated rows returned to their freelists, recruit/pitch references cleared, membership compacted, original board count restored, and no session lockout.

- [ ] **Step 5: Verify UI, autosave, and reload**

Leave and re-enter Recruiting, verify the rendered board, allow the game's normal autosave, return to the Dynasty hub, reload the dynasty, and revalidate the final board/table state. Do not edit the backup.

- [ ] **Step 6: Record sanitized results**

Update `docs/research/patch1-build-reanchor.md` with commands, hashes, counts, state transitions, and pass/fail results. Exclude addresses and raw memory.

- [ ] **Step 7: Handle any failure by demoting immediately**

If a native fault, postcondition mismatch, table ambiguity, UI failure, save/reload mismatch, or host lockout occurs:

```powershell
node scripts/promote-game-build.cjs `
  --sha A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD `
  --diagnostic
node scripts/generate-game-builds.cjs --check
```

Rebuild before any later live session. Reload the disposable dynasty or restore a copy from the verified backup; never overwrite the backup itself. Record the failed gate and do not continue toward release.

- [ ] **Step 8: Commit successful live evidence**

Only if every live gate passes:

```powershell
git add -- docs/research/patch1-build-reanchor.md
git commit -m "docs: verify patch 1 board mutation live"
```

---

### Task 12: Final verification and future-update handoff

**Files:**

- Modify: `docs/development/release-checklist.md`
- Modify: `docs/getting-started.md`
- Modify: `README.md`

- [ ] **Step 1: Add a fresh Patch 1 release ledger**

Do not rewrite the historical `0.2.0-dev.2` checks as though they apply to Patch 1. Add a new dated section or a separate copied ledger with every automated, installer, diagnostic-capture, promotion, live mutation, backup, and cleanup gate reset and then checked from actual evidence.

- [ ] **Step 2: Document the next-update fast path**

The public developer docs must give this concise sequence:

1. hash the new executable and add it to `game_builds.json` as diagnostic;
2. regenerate, test, build, and install;
3. run preflight plus six-table validation;
4. capture two vanilla add/remove write traces and one execute confirmation each;
5. validate vtables across a screen transition;
6. review `candidate.json`;
7. promote into source and rebuild;
8. pass the complete guarded live gate;
9. demote on any failure.

- [ ] **Step 3: Run the final clean gate**

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-patch1-final -A x64
cmake --build native/build-patch1-final --config Release
```

Run every native smoke from `docs/development/building.md`, with only the protocol smoke receiving the temporary smoke override.

- [ ] **Step 4: Verify packaging excludes all evidence**

```powershell
$env:CFB27_NATIVE_ARTIFACTS = (Resolve-Path native/build-patch1-final/Release).Path
npm run pack:preview
git diff --check
```

Inspect the staged archive and npm tarballs. Require no `.frtk`, `board-reanchor`, save, raw address, memory dump, game binary, build intermediate, or MMC backup content. The package must contain the compiled host, not `candidate.json`.

- [ ] **Step 5: Close both applications and verify uninstall recovery**

After live work, close MMC and CFB27, use the supported uninstall command, and verify both restored stock proxies match SHA-256 `3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454`. Reinstall only if the user wants the repaired hook left active.

- [ ] **Step 6: Commit the handoff documentation**

```powershell
git add -- docs/development/release-checklist.md docs/getting-started.md README.md
git commit -m "docs: document repeatable game update recovery"
```

- [ ] **Step 7: Final integrity review**

```powershell
git status --short
git log --oneline --decorate -12
rg -n "candidate\.json|board-reanchor" native packages scripts docs README.md
```

Expected: clean worktree; all planned functions are implemented; `.frtk` references are documentation/tooling only; no production host path loads a candidate artifact; all commits are scoped and reviewable.
