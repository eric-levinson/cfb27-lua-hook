# Getting started

CFB27 Lua Hook `0.1.0-dev.1` is a Windows x64 developer preview. It requires
Node.js 20 or later, CMake 3.24 or later, Visual Studio 2022 C++ build tools,
MMC, and a separately launched offline CFB27 session.

The project does not include an anticheat bypass. Do not disable or allowlist
antivirus protection for it.

## Build and test

```powershell
npm ci
npm run check
npm test
cmake -S native -B native/build-active -A x64
cmake --build native/build-active --config Release
```

## Configure local paths

Set these values to your own installation directories:

```powershell
$env:CFB27_GAME_DIR = 'F:\EA SPORTS College Football 27'
$env:CFB27_MMC_DIR = 'C:\path\to\MMC_ModManager'
$env:CFB27_HOOK_ARTIFACTS = (Resolve-Path 'native\build-active\Release').Path
```

The CLI never guesses the game or MMC directories.

## Install, launch, and verify

Close CFB27 before installing:

```powershell
node packages/cli/bin/cfb27lua.cjs install
```

The installer verifies and preserves both MMC proxies before replacing either.
Launch the game through MMC in your offline configuration. At the Dynasty hub,
run the read-only diagnostics and status checks:

```powershell
node packages/cli/bin/cfb27lua.cjs doctor
node packages/cli/bin/cfb27lua.cjs status --json
node packages/cli/bin/cfb27lua.cjs run examples/lua/read-image-header.lua
node packages/cli/bin/cfb27lua.cjs events --after 0 --json
```

`doctor` should report the game, installation, host, supported build, and write
eligibility separately. A failed write-eligibility check does not prevent safe
read-only scripts.

## Restore MMC

Close the game, then restore both verified original proxies:

```powershell
node packages/cli/bin/cfb27lua.cjs uninstall
```

If installation state is unclear, run `doctor` first and inspect the reported
paths. Never manually overwrite an unknown `CryptBase.dll` or `MMCBase.dll`.
