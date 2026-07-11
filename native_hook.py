from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
NATIVE_RELEASE_DIR = APP_DIR / "native" / "build-final" / "Release"
HOOK_DLL = NATIVE_RELEASE_DIR / "cfb27_live_hook.dll"
RESPONSE_GUARD_DLL = NATIVE_RELEASE_DIR / "cfb27_response_guard.dll"
LUA_HOST_DLL = NATIVE_RELEASE_DIR / "cfb27_lua_host.dll"
STARTUP_PROXY_DLL = NATIVE_RELEASE_DIR / "cfb27_cryptbase_proxy.dll"
HOOK_INJECTOR = NATIVE_RELEASE_DIR / "cfb27_hook_injector.exe"
SCRIPT_DIR = APP_DIR / "scripts"
PIPE_PREFIX = r"\\.\pipe\CFB27LiveEditor."
FALLBACK_PIPE_PREFIX = r"\\.\pipe\CFB27LiveEditorFallback."
DIRECT_FAST_PIPE_PREFIX = r"\\.\pipe\CFB27LiveEditorDirectFast."
RESPONSE_GUARD_PIPE_PREFIX = r"\\.\pipe\CFB27ResponseGuard."
LUA_HOST_PIPE_PREFIX = r"\\.\pipe\CFB27LuaHost."


def native_artifacts() -> dict[str, object]:
    return {
        "built": HOOK_DLL.is_file() and HOOK_INJECTOR.is_file(),
        "dll": str(HOOK_DLL),
        "responseGuardDll": str(RESPONSE_GUARD_DLL),
        "luaHostDll": str(LUA_HOST_DLL),
        "startupProxyDll": str(STARTUP_PROXY_DLL),
        "injector": str(HOOK_INJECTOR),
        "scriptDirectory": str(SCRIPT_DIR),
    }


def _wait_for_pipe(name: str, timeout_ms: int) -> None:
    if sys.platform != "win32":
        raise OSError("The native CFB27 hook is Windows-only")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.WaitNamedPipeW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
    kernel32.WaitNamedPipeW.restype = ctypes.c_int
    if not kernel32.WaitNamedPipeW(name, timeout_ms):
        error = ctypes.get_last_error()
        if error in {2, 3, 121}:  # not found / path not found / timeout
            raise FileNotFoundError(name)
        raise OSError(error, f"WaitNamedPipeW({name}) failed")


def _hook_command_to_pipe(
    pid: int,
    command: str,
    *,
    timeout_ms: int = 1500,
    pipe_prefix: str = PIPE_PREFIX,
) -> dict[str, object]:
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError("pid must be a positive integer")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("hook command is required")
    encoded = command.encode("utf-8")
    if len(encoded) > 60 * 1024:
        raise ValueError("hook command is too large")
    pipe_name = f"{pipe_prefix}{pid}"
    _wait_for_pipe(pipe_name, timeout_ms)
    with open(pipe_name, "r+b", buffering=0) as pipe:
        pipe.write(encoded)
        raw = pipe.read(64 * 1024)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"The native hook returned an invalid response: {raw[:200]!r}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("The native hook returned a non-object response")
    return payload


def hook_command(
    pid: int,
    command: str,
    *,
    timeout_ms: int = 1500,
    pipe_prefix: str = PIPE_PREFIX,
) -> dict[str, object]:
    selected_prefix = pipe_prefix
    if pipe_prefix == PIPE_PREFIX:
        try:
            primary = _hook_command_to_pipe(pid, "STATUS", timeout_ms=250, pipe_prefix=PIPE_PREFIX)
        except (FileNotFoundError, OSError, RuntimeError):
            primary = {}
        if primary.get("requestHookReady") is False:
            selected_prefix = FALLBACK_PIPE_PREFIX
    return _hook_command_to_pipe(pid, command, timeout_ms=timeout_ms, pipe_prefix=selected_prefix)


def hook_status(pid: int) -> dict[str, object]:
    result = {**native_artifacts(), "pid": pid, "loaded": False, "ready": False}
    guard = response_guard_status(pid)
    result["responseGuard"] = guard
    statuses = []
    for prefix in (PIPE_PREFIX, FALLBACK_PIPE_PREFIX):
        try:
            status = _hook_command_to_pipe(pid, "STATUS", timeout_ms=250, pipe_prefix=prefix)
        except (FileNotFoundError, OSError, RuntimeError):
            continue
        statuses.append((prefix, status))
    if not statuses:
        if guard.get("ready"):
            result["loaded"] = True
            result["ready"] = True
            result["mode"] = "response-guard"
        return result
    prefix, status = next(
        ((candidate_prefix, candidate) for candidate_prefix, candidate in statuses
         if candidate.get("ok") and candidate.get("requestHookReady") is not False),
        statuses[0],
    )
    result.update(status)
    result["loaded"] = True
    result["ready"] = bool(status.get("ok")) and status.get("requestHookReady") is not False
    result["pipePrefix"] = prefix
    return result


def response_guard_status(pid: int) -> dict[str, object]:
    result: dict[str, object] = {
        "built": RESPONSE_GUARD_DLL.is_file(),
        "dll": str(RESPONSE_GUARD_DLL),
        "loaded": False,
        "ready": False,
    }
    try:
        status = _hook_command_to_pipe(pid, "STATUS", timeout_ms=250, pipe_prefix=RESPONSE_GUARD_PIPE_PREFIX)
    except (FileNotFoundError, OSError, RuntimeError):
        return result
    result.update(status)
    result["loaded"] = True
    result["ready"] = bool(status.get("ok"))
    return result


def startup_lua_status(pid: int) -> dict[str, object]:
    result: dict[str, object] = {
        "built": LUA_HOST_DLL.is_file() and STARTUP_PROXY_DLL.is_file(),
        "hostDll": str(LUA_HOST_DLL),
        "proxyDll": str(STARTUP_PROXY_DLL),
        "loaded": False,
        "ready": False,
    }
    try:
        status = _hook_command_to_pipe(pid, "STATUS", timeout_ms=250, pipe_prefix=LUA_HOST_PIPE_PREFIX)
    except (FileNotFoundError, OSError, RuntimeError):
        return result
    result.update(status)
    result["loaded"] = True
    result["ready"] = bool(status.get("ok") and status.get("ready"))
    return result


def eval_startup_lua(pid: int, script: str) -> dict[str, object]:
    if not isinstance(script, str) or not script.strip():
        raise ValueError("Lua script is required")
    if len(script.encode("utf-8")) > 60 * 1024:
        raise ValueError("Lua script is too large")
    return _hook_command_to_pipe(
        pid,
        f"EVAL {script}",
        timeout_ms=5000,
        pipe_prefix=LUA_HOST_PIPE_PREFIX,
    )


def _inject_dll(pid: int, dll: Path) -> str:
    if not dll.is_file() or not HOOK_INJECTOR.is_file():
        raise FileNotFoundError(f"Native hook artifact is missing: {dll}")
    completed = subprocess.run(
        [str(HOOK_INJECTOR), str(pid), str(dll.resolve())],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "native injector failed").strip())
    return completed.stdout.strip()


def attach_response_guard(pid: int) -> dict[str, object]:
    existing = response_guard_status(pid)
    if existing.get("ready"):
        return existing
    output = _inject_dll(pid, RESPONSE_GUARD_DLL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = response_guard_status(pid)
        if status.get("ready"):
            status["injectorOutput"] = output
            return status
        time.sleep(0.1)
    raise RuntimeError("Response-guard DLL loaded, but its control pipe did not become ready")


def attach_hook(pid: int) -> dict[str, object]:
    existing = hook_status(pid)
    main_ready = existing.get("pipePrefix") in {PIPE_PREFIX, FALLBACK_PIPE_PREFIX}
    if existing.get("ready") and main_ready:
        existing["responseGuard"] = attach_response_guard(pid)
        return existing
    if not HOOK_DLL.is_file() or not HOOK_INJECTOR.is_file():
        raise FileNotFoundError(
            "Native hook artifacts are missing; build them with cmake -S native -B native/build -A x64 "
            "and cmake --build native/build --config Release"
        )
    completed = subprocess.run(
        [str(HOOK_INJECTOR), str(pid), str(HOOK_DLL.resolve())],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "native injector failed").strip()
        raise RuntimeError(detail)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = hook_status(pid)
        if status.get("ready"):
            status["responseGuard"] = attach_response_guard(pid)
            status["injectorOutput"] = completed.stdout.strip()
            return status
        time.sleep(0.1)
    raise RuntimeError("Hook DLL loaded, but its control pipe did not become ready")


def queue_rating(pid: int, field: str, expected: int, value: int) -> dict[str, object]:
    if not field or any(character.isspace() for character in field):
        raise ValueError("field must be a non-empty rating key")
    if not isinstance(expected, int) or not isinstance(value, int):
        raise ValueError("expected and value must be integers")
    return hook_command(pid, f"QUEUE {field} {expected} {value}")


def queue_response_rating(pid: int, player_id: int, field: str, expected: int, value: int) -> dict[str, object]:
    if not isinstance(player_id, int) or player_id <= 0:
        raise ValueError("player_id must be a positive integer")
    if not field or any(character.isspace() for character in field):
        raise ValueError("field must be a non-empty rating key")
    attach_response_guard(pid)
    return _hook_command_to_pipe(
        pid,
        f"QUEUE {player_id} {field} {expected} {value}",
        pipe_prefix=RESPONSE_GUARD_PIPE_PREFIX,
    )


def patch_record_at(pid: int, address: int, before: bytes, after: bytes) -> dict[str, object]:
    if not isinstance(address, int) or address <= 0:
        raise ValueError("address must be a positive integer")
    if not isinstance(before, bytes) or not isinstance(after, bytes) or len(before) != len(after):
        raise ValueError("before and after must be equal-length byte strings")
    command = f"PATCH_AT {address} {before.hex()} {after.hex()}"
    result = hook_command(pid, command, timeout_ms=5000)
    if result.get("ok") or "unknown command" not in str(result.get("error", "")).casefold():
        return result
    # Development sessions may already have the earlier request-only DLL
    # loaded under the primary pipe. Use the isolated direct-fast module until
    # the next game restart loads the combined build.
    return hook_command(pid, command, timeout_ms=5000, pipe_prefix=DIRECT_FAST_PIPE_PREFIX)


def list_lua_scripts() -> list[dict[str, object]]:
    SCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    return [
        {
            "name": path.name,
            "path": str(path),
            "size": path.stat().st_size,
            "modifiedTime": path.stat().st_mtime,
        }
        for path in sorted(SCRIPT_DIR.glob("*.lua"), key=lambda item: item.name.casefold())
        if path.is_file()
    ]


def resolve_lua_script(name: str) -> Path:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("script is required")
    candidate = (SCRIPT_DIR / name).resolve()
    try:
        candidate.relative_to(SCRIPT_DIR.resolve())
    except ValueError as exc:
        raise PermissionError("Lua scripts must be inside the editor scripts folder") from exc
    if candidate.suffix.casefold() != ".lua" or not candidate.is_file():
        raise FileNotFoundError(f"Lua script was not found: {name}")
    return candidate


def run_lua_script(pid: int, name: str) -> dict[str, object]:
    script = resolve_lua_script(name)
    startup = startup_lua_status(pid)
    if startup.get("ready"):
        result = _hook_command_to_pipe(
            pid,
            f"RUN {script}",
            timeout_ms=5000,
            pipe_prefix=LUA_HOST_PIPE_PREFIX,
        )
        result["script"] = script.name
        result["host"] = "startup"
        return result
    attach_response_guard(pid)
    result = _hook_command_to_pipe(pid, f"RUN {script}", pipe_prefix=RESPONSE_GUARD_PIPE_PREFIX)
    result["script"] = script.name
    return result
