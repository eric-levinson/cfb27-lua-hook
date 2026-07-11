from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path

from live_process import running_processes


KNOWN_MMC_CRYPTBASE_SHA256 = "3E87682118E593F334BA665826E2A6AB85BA460F2E1FE95B173A7199863AD454"


def running_game_processes() -> list[dict[str, object]]:
    return [
        process
        for process in running_processes()
        if str(process.get("name", "")).casefold() in {"collegefb27.exe", "collegefb27_trial.exe"}
    ]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.cfb27.tmp")
    shutil.copy2(source, temporary)
    os.replace(temporary, destination)


def _ensure_mmc_backup(directory: Path, expected_hash: str) -> Path:
    active = directory / "CryptBase.dll"
    backup = directory / "MMCBase.dll"
    if backup.is_file():
        if _sha256(backup) != expected_hash:
            raise RuntimeError(f"MMCBase.dll does not match the expected MMC proxy: {backup}")
        return backup
    if not active.is_file() or _sha256(active) != expected_hash:
        raise RuntimeError(f"CryptBase.dll is not the recognized MMC proxy: {active}")
    _atomic_copy(active, backup)
    if _sha256(backup) != expected_hash:
        raise RuntimeError(f"MMC proxy backup verification failed: {backup}")
    return backup


def install_startup_hook(
    game_dir: Path,
    mod_manager_dir: Path,
    proxy_dll: Path,
    host_dll: Path,
    *,
    autorun_script: Path | None = None,
    expected_mmc_sha256: str = KNOWN_MMC_CRYPTBASE_SHA256,
) -> dict[str, object]:
    if running_game_processes():
        raise RuntimeError("Close College Football 27 before installing the startup Lua hook")
    game_dir = Path(game_dir).resolve()
    third_party = Path(mod_manager_dir).resolve() / "ThirdParty"
    proxy_dll = Path(proxy_dll).resolve()
    host_dll = Path(host_dll).resolve()
    if not proxy_dll.is_file() or not host_dll.is_file():
        raise FileNotFoundError("The startup proxy and Lua host must be built before installation")
    expected_hash = expected_mmc_sha256.upper()
    _ensure_mmc_backup(game_dir, expected_hash)
    _ensure_mmc_backup(third_party, expected_hash)
    _atomic_copy(proxy_dll, game_dir / "CryptBase.dll")
    _atomic_copy(proxy_dll, third_party / "CryptBase.dll")
    host_destination = game_dir / "CFB27LiveEditor" / "cfb27_lua_host.dll"
    _atomic_copy(host_dll, host_destination)
    autorun_destination = None
    if autorun_script is not None:
        autorun_script = Path(autorun_script).resolve()
        if not autorun_script.is_file():
            raise FileNotFoundError(f"Autorun Lua script was not found: {autorun_script}")
        autorun_destination = game_dir / "CFB27LiveEditor" / "scripts" / "autorun.lua"
        _atomic_copy(autorun_script, autorun_destination)
    return {
        "installed": True,
        "gameProxy": str(game_dir / "CryptBase.dll"),
        "managerProxy": str(third_party / "CryptBase.dll"),
        "host": str(host_destination),
        "autorun": str(autorun_destination) if autorun_destination else None,
        "mmcSha256": expected_hash,
        "proxySha256": _sha256(proxy_dll),
        "hostSha256": _sha256(host_dll),
    }


def uninstall_startup_hook(game_dir: Path, mod_manager_dir: Path) -> dict[str, object]:
    if running_game_processes():
        raise RuntimeError("Close College Football 27 before restoring the MMC startup proxy")
    game_dir = Path(game_dir).resolve()
    third_party = Path(mod_manager_dir).resolve() / "ThirdParty"
    restored: list[str] = []
    for directory in (game_dir, third_party):
        backup = directory / "MMCBase.dll"
        if not backup.is_file():
            raise FileNotFoundError(f"MMC proxy backup was not found: {backup}")
        _atomic_copy(backup, directory / "CryptBase.dll")
        restored.append(str(directory / "CryptBase.dll"))
    return {"restored": True, "paths": restored}
