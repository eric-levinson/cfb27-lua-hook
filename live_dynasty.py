from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

from live_process import read_process_bytes, scan_private_writable_pattern
from native_hook import hook_status, patch_record_at


APP_DIR = Path(__file__).resolve().parent
FRANCHISE_HELPER = APP_DIR / "franchise_helper.js"
_RECORD_ADDRESS_CACHE: dict[tuple[int, int, int, int], int] = {}
_MONITOR_LOCK = threading.Lock()
_MONITOR_STOP: threading.Event | None = None
_MONITOR_STATE: dict[str, object] = {"running": False}


def _helper_json(command: str, save_path: Path, *arguments: object) -> dict[str, object]:
    completed = subprocess.run(
        ["node", str(FRANCHISE_HELPER), command, str(save_path), *(str(item) for item in arguments)],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or f"{command} failed").strip())
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{command} returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{command} returned a non-object payload")
    return payload


def league_edit_permission_patch(save_path: Path) -> dict[str, object]:
    return _helper_json("league-edit-permission-patch", save_path, "ANY")


def franchise_owner_patch(save_path: Path) -> dict[str, object]:
    return _helper_json("franchise-owner-patch", save_path)


def player_rating_patch(
    save_path: Path,
    row: int,
    field: str,
    value: int,
) -> dict[str, object]:
    return _helper_json("player-record-patch", save_path, row, field, value)


def locate_live_record(pid: int, patch: dict[str, object]) -> dict[str, object]:
    before = bytes.fromhex(str(patch["beforeHex"]))
    after = bytes.fromhex(str(patch["afterHex"]))
    row = int(patch["row"])
    table_unique_id = int(patch.get("tableUniqueId") or patch.get("playerTableUniqueId") or 0)
    key = (pid, table_unique_id, row, len(before))
    cached = _RECORD_ADDRESS_CACHE.get(key)
    if cached:
        current = read_process_bytes(pid, cached, len(before))
        if current in {before, after}:
            return {
                "address": cached,
                "addressHex": f"0x{cached:X}",
                "state": "before" if current == before else "after",
                "cached": True,
            }
        _RECORD_ADDRESS_CACHE.pop(key, None)

    attempts = []
    for state, image in (("before", before), ("after", after)):
        scan = scan_private_writable_pattern(pid, image, preferred_only=True)
        attempts.append({
            "state": state,
            "bytesRead": scan["bytesRead"],
            "regionsScanned": scan["regionsScanned"],
            "matchCount": len(scan["matches"]),
        })
        if len(scan["matches"]) > 1:
            raise RuntimeError(f"{patch.get('table') or 'Player'} record identity was not unique")
        if len(scan["matches"]) == 1:
            address = int(scan["matches"][0]["address"])
            _RECORD_ADDRESS_CACHE[key] = address
            return {
                "address": address,
                "addressHex": f"0x{address:X}",
                "state": state,
                "cached": False,
                "attempts": attempts,
            }
    raise RuntimeError(f"The live {patch.get('table') or 'Player'} record was not found in the Dynasty table arena")


def _apply_record_patch(pid: int, patch: dict[str, object]) -> dict[str, object]:
    if str(patch["beforeHex"]) == str(patch["afterHex"]):
        return {"changed": False, "alreadySaved": True, "patch": patch, "location": None}
    location = locate_live_record(pid, patch)
    if location["state"] == "after":
        return {"changed": False, "patch": patch, "location": location}
    result = patch_record_at(
        pid,
        int(location["address"]),
        bytes.fromhex(str(patch["beforeHex"])),
        bytes.fromhex(str(patch["afterHex"])),
    )
    if not result.get("ok"):
        raise RuntimeError(str(result.get("error") or f"The hook rejected the {patch.get('table')} patch"))
    return {"changed": True, "patch": patch, "location": location, "hookResult": result}


def unlock_dynasty_player_editing(pid: int, save_path: Path) -> dict[str, object]:
    status = hook_status(pid)
    if not status.get("ready"):
        raise RuntimeError("Attach the native CFB27 hook before unlocking Dynasty player editing")
    patches = [league_edit_permission_patch(save_path), franchise_owner_patch(save_path)]
    results = [_apply_record_patch(pid, patch) for patch in patches]
    return {
        "ok": True,
        "changed": any(bool(item["changed"]) for item in results),
        "permission": "ANY",
        "adminLevel": "Owner",
        "results": results,
        "hook": status,
    }


def start_dynasty_unlock_monitor(
    pid: int,
    save_path: Path,
    *,
    interval: float = 0.5,
    extra_patches: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    global _MONITOR_STOP, _MONITOR_STATE
    patches = [league_edit_permission_patch(save_path), franchise_owner_patch(save_path), *(extra_patches or [])]
    with _MONITOR_LOCK:
        if _MONITOR_STOP is not None:
            _MONITOR_STOP.set()
        stop = threading.Event()
        _MONITOR_STOP = stop
        _MONITOR_STATE = {
            "running": True,
            "pid": pid,
            "save": str(save_path),
            "startedAt": time.time(),
            "passes": 0,
            "writes": 0,
            "patches": [
                {"table": patch.get("table", "Player"), "row": patch.get("row"), "field": patch.get("field"), "value": patch.get("value")}
                for patch in patches
            ],
            "lastError": None,
        }

    def worker() -> None:
        global _MONITOR_STATE
        while not stop.is_set():
            try:
                results = [_apply_record_patch(pid, patch) for patch in patches]
                with _MONITOR_LOCK:
                    _MONITOR_STATE["passes"] = int(_MONITOR_STATE.get("passes", 0)) + 1
                    _MONITOR_STATE["writes"] = int(_MONITOR_STATE.get("writes", 0)) + sum(
                        1 for item in results if item["changed"]
                    )
                    _MONITOR_STATE["lastResults"] = results
                    _MONITOR_STATE["lastError"] = None
                    _MONITOR_STATE["updatedAt"] = time.time()
            except Exception as exc:
                with _MONITOR_LOCK:
                    _MONITOR_STATE["lastError"] = str(exc)
                    _MONITOR_STATE["updatedAt"] = time.time()
            stop.wait(interval)
        with _MONITOR_LOCK:
            _MONITOR_STATE["running"] = False

    threading.Thread(target=worker, name="cfb27-dynasty-unlock", daemon=True).start()
    return dynasty_unlock_monitor_status()


def dynasty_unlock_monitor_status() -> dict[str, object]:
    with _MONITOR_LOCK:
        return dict(_MONITOR_STATE)
