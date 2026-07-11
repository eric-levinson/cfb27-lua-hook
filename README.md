# CFB27 Lua Hook

Offline Lua scripting runtime, Node SDK, and MMC startup tooling for EA SPORTS
College Football 27 on PC.

> Developer preview `0.1.0-dev.1`. The runtime supports one verified game
> build, is intended only for offline play, and does not include or provide an
> anticheat bypass.

## Project direction

CFB27 Lua Hook is the supported product in this repository:

- a persistent Lua 5.4 runtime loaded through MMC's existing startup proxy;
- exact-build and offline write gates;
- a versioned local named-pipe protocol;
- the reusable `@cfb27/lua-hook` CommonJS SDK;
- the `cfb27lua` developer CLI;
- safe examples and runtime research documentation.

The previous save editor, experimental injection hooks, and raw research tools
are retained under `archive/` for provenance. They are unsupported and excluded
from active packages and releases.

## Target CLI surface

```text
cfb27lua install
cfb27lua uninstall
cfb27lua status [--json]
cfb27lua run <script.lua>
cfb27lua eval <source>
cfb27lua events [--after <cursor>]
cfb27lua logs [--follow]
cfb27lua doctor
```

These commands are the `0.1.0-dev.1` target. The restructuring branch adds
them incrementally with tests; do not treat an unimplemented command as part of
a published release.

## Safety boundary

- Close CFB27 before installing or restoring startup files.
- Writes require an exact recognized executable build.
- Writes are blocked when a real EA/Javelin anticheat process is present.
- Memory writes are compare-before-write and readback-verified.
- Do not disable or allowlist antivirus protection for this project.
- Keep scripts and integrations offline.

## Documentation

- [Repository redesign](docs/superpowers/specs/2026-07-11-cfb27-lua-hook-repository-design.md)
- [Implementation plan](docs/superpowers/plans/2026-07-11-cfb27-lua-hook-repository.md)
- Supported getting-started, Lua API, protocol, CLI, and safety guides are added
  as their corresponding implementation slices land.

## Development

Requirements:

- Windows x64
- Node.js 20 or later
- CMake 3.24 or later
- Visual Studio 2022 C++ build tools

```powershell
npm install
npm test
npm run check
```

Native build and release instructions will live under `docs/development/`.

## License

[MIT](LICENSE)
