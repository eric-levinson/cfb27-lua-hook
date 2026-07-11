from __future__ import annotations

import ctypes
import hashlib
import os
import sys
from ctypes import wintypes
from pathlib import Path


GAME_DIR_ENV = "CFB27_GAME_DIR"
DEFAULT_GAME_DIR = Path(r"F:\EA SPORTS College Football 27")
GAME_EXECUTABLES = ("CollegeFB27.exe", "CollegeFB27_Trial.exe")
KNOWN_FULL_BUILD_SHA256 = "9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8"

LIVE_PLAYER_OBJECT_SIZE = 584
LIVE_PLAYER_ID_OFFSET = 0x10
LIVE_PLAYER_RATING_OFFSETS = {
    "overall": 0x10C,
    "speed": 0x164,
    "acceleration": 0x113,
    "strength": 0x16C,
    "agility": 0x115,
    "awareness": 0x117,
    "jumping": 0x135,
    "injury": 0x131,
    "stamina": 0x168,
    "toughness": 0x17E,
    "carrying": 0x121,
    "break_tackle": 0x11F,
    "trucking": 0x180,
    "change_of_direction": 0x127,
    "bc_vision": 0x119,
    "stiff_arm": 0x16A,
    "spin_move": 0x166,
    "juke_move": 0x133,
    "break_sack": 0x11D,
    "run_block": 0x15E,
    "pass_block": 0x145,
    "impact_blocking": 0x12F,
    "run_block_power": 0x15C,
    "run_block_finesse": 0x15A,
    "pass_block_power": 0x143,
    "pass_block_finesse": 0x141,
    "lead_block": 0x13D,
    "throw_power": 0x17A,
    "throw_under_pressure": 0x17C,
    "throw_accuracy_short": 0x176,
    "throw_accuracy_mid": 0x172,
    "throw_accuracy_deep": 0x170,
    "throw_on_the_run": 0x178,
    "play_action": 0x148,
    "tackle": 0x16E,
    "power_moves": 0x14C,
    "finesse_moves": 0x12B,
    "block_shedding": 0x11B,
    "pursuit": 0x150,
    "play_recognition": 0x14A,
    "man_coverage": 0x13F,
    "zone_coverage": 0x184,
    "hit_power": 0x12D,
    "press": 0x14E,
    "catching": 0x123,
    "spectacular_catch": 0x162,
    "catch_in_traffic": 0x125,
    "short_route_running": 0x158,
    "medium_route_running": 0x156,
    "deep_route_running": 0x154,
    "kick_power": 0x139,
    "kick_accuracy": 0x137,
    "kick_return": 0x13B,
}
LIVE_PLAYER_DUPLICATE_OFFSETS = {
    **{field: offset + 1 for field, offset in LIVE_PLAYER_RATING_OFFSETS.items() if field != "overall"},
    "overall": 0x10F,
}

PROCESS_VM_READ = 0x0010
PROCESS_VM_WRITE = 0x0020
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MEM_COMMIT = 0x00001000
MEM_PRIVATE = 0x00020000
MEM_MAPPED = 0x00040000
MEM_IMAGE = 0x01000000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
READABLE_PAGE_MASK = 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80
TH32CS_SNAPPROCESS = 0x00000002
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
MAX_PATH = 260


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_byte)),
        ("modBaseSize", wintypes.DWORD),
        ("hModule", wintypes.HMODULE),
        ("szModule", wintypes.WCHAR * 256),
        ("szExePath", wintypes.WCHAR * MAX_PATH),
    ]


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", wintypes.LPVOID),
        ("AllocationBase", wintypes.LPVOID),
        ("AllocationProtect", wintypes.DWORD),
        ("PartitionId", wintypes.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


def configured_game_dir(env: dict[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    raw = source.get(GAME_DIR_ENV, "").strip()
    return Path(os.path.expandvars(os.path.expanduser(raw))).resolve() if raw else DEFAULT_GAME_DIR


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def executable_build(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {"path": str(path), "exists": False}
    stat = path.stat()
    digest = sha256_file(path)
    return {
        "path": str(path),
        "exists": True,
        "size": stat.st_size,
        "modifiedNs": stat.st_mtime_ns,
        "sha256": digest,
        "recognized": path.name.casefold() == "collegefb27.exe" and digest == KNOWN_FULL_BUILD_SHA256,
    }


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W))
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W))
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.Module32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W))
    kernel32.Module32FirstW.restype = wintypes.BOOL
    kernel32.Module32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W))
    kernel32.Module32NextW.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.ReadProcessMemory.argtypes = (
        wintypes.HANDLE,
        wintypes.LPCVOID,
        wintypes.LPVOID,
        ctypes.c_size_t,
        ctypes.POINTER(ctypes.c_size_t),
    )
    kernel32.ReadProcessMemory.restype = wintypes.BOOL
    kernel32.WriteProcessMemory.argtypes = (
        wintypes.HANDLE,
        wintypes.LPVOID,
        wintypes.LPCVOID,
        ctypes.c_size_t,
        ctypes.POINTER(ctypes.c_size_t),
    )
    kernel32.WriteProcessMemory.restype = wintypes.BOOL
    kernel32.VirtualQueryEx.argtypes = (
        wintypes.HANDLE,
        wintypes.LPCVOID,
        ctypes.POINTER(MEMORY_BASIC_INFORMATION),
        ctypes.c_size_t,
    )
    kernel32.VirtualQueryEx.restype = ctypes.c_size_t
    kernel32.QueryFullProcessImageNameW.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32


def _handle_value(handle) -> int | None:
    if isinstance(handle, int):
        return handle
    return ctypes.cast(handle, ctypes.c_void_p).value if handle else None


def _close(kernel32, handle) -> None:
    if _handle_value(handle) not in {None, INVALID_HANDLE_VALUE}:
        kernel32.CloseHandle(handle)


def running_processes() -> list[dict[str, object]]:
    if sys.platform != "win32":
        return []
    kernel32 = _kernel32()
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if _handle_value(snapshot) == INVALID_HANDLE_VALUE:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot(processes) failed")
    results: list[dict[str, object]] = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            process = {
                "pid": int(entry.th32ProcessID),
                "name": entry.szExeFile,
                "parentPid": int(entry.th32ParentProcessID),
                "threads": int(entry.cntThreads),
            }
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, entry.th32ProcessID)
            if handle:
                try:
                    capacity = wintypes.DWORD(32768)
                    image_path = ctypes.create_unicode_buffer(capacity.value)
                    if kernel32.QueryFullProcessImageNameW(handle, 0, image_path, ctypes.byref(capacity)):
                        process["path"] = image_path.value
                finally:
                    _close(kernel32, handle)
            results.append(process)
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        _close(kernel32, snapshot)
    return results


def process_modules(pid: int) -> list[dict[str, object]]:
    if sys.platform != "win32":
        return []
    kernel32 = _kernel32()
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if _handle_value(snapshot) == INVALID_HANDLE_VALUE:
        raise OSError(ctypes.get_last_error(), f"CreateToolhelp32Snapshot(modules, pid={pid}) failed")
    modules: list[dict[str, object]] = []
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel32.Module32FirstW(snapshot, ctypes.byref(entry))
        while more:
            modules.append({
                "name": entry.szModule,
                "path": entry.szExePath,
                "base": ctypes.cast(entry.modBaseAddr, ctypes.c_void_p).value or 0,
                "size": int(entry.modBaseSize),
            })
            more = kernel32.Module32NextW(snapshot, ctypes.byref(entry))
    finally:
        _close(kernel32, snapshot)
    return modules


def verify_read_only_attach(pid: int, base_address: int) -> dict[str, object]:
    if sys.platform != "win32":
        return {"attached": False, "error": "Live process access is Windows-only"}
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return {"attached": False, "error": f"OpenProcess failed ({ctypes.get_last_error()})"}
    try:
        buffer = (ctypes.c_ubyte * 2)()
        bytes_read = ctypes.c_size_t()
        ok = kernel32.ReadProcessMemory(
            handle,
            ctypes.c_void_p(base_address),
            ctypes.byref(buffer),
            len(buffer),
            ctypes.byref(bytes_read),
        )
        if not ok:
            return {"attached": False, "error": f"ReadProcessMemory failed ({ctypes.get_last_error()})"}
        signature = bytes(buffer[: bytes_read.value])
        return {
            "attached": True,
            "access": "query+read",
            "imageSignature": signature.hex().upper(),
            "validPeImage": signature == b"MZ",
        }
    finally:
        _close(kernel32, handle)


def _readable_region(region: MEMORY_BASIC_INFORMATION) -> bool:
    return (
        region.State == MEM_COMMIT
        and not (region.Protect & (PAGE_NOACCESS | PAGE_GUARD))
        and bool(region.Protect & READABLE_PAGE_MASK)
        and region.Type in {MEM_PRIVATE, MEM_MAPPED, MEM_IMAGE}
    )


def scan_process_strings(
    pid: int,
    values: list[str],
    *,
    max_matches_per_value: int = 100,
    max_bytes: int = 12 * 1024 * 1024 * 1024,
    chunk_size: int = 4 * 1024 * 1024,
) -> dict[str, object]:
    """Scan committed readable memory for exact ASCII and UTF-16LE strings.

    This deliberately opens the process without PROCESS_VM_WRITE or PROCESS_VM_OPERATION.
    """
    if sys.platform != "win32":
        raise OSError("Live process access is Windows-only")
    clean_values = list(dict.fromkeys(value for value in values if value and len(value) <= 256))
    if not clean_values:
        raise ValueError("At least one non-empty search value is required")
    if not (1 <= max_matches_per_value <= 1000):
        raise ValueError("max_matches_per_value must be between 1 and 1000")
    patterns: list[tuple[str, str, bytes]] = []
    for value in clean_values:
        patterns.append((value, "ascii", value.encode("utf-8")))
        patterns.append((value, "utf16le", value.encode("utf-16le")))
    longest = max(len(pattern) for _, _, pattern in patterns)

    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"OpenProcess(pid={pid}) failed")
    matches: dict[str, list[dict[str, object]]] = {value: [] for value in clean_values}
    address = 0
    bytes_read_total = 0
    regions_scanned = 0
    read_failures = 0
    max_address = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8 - 1)) - 1
    try:
        while address < max_address and bytes_read_total < max_bytes:
            region = MEMORY_BASIC_INFORMATION()
            queried = kernel32.VirtualQueryEx(
                handle,
                ctypes.c_void_p(address),
                ctypes.byref(region),
                ctypes.sizeof(region),
            )
            if not queried:
                break
            base = int(region.BaseAddress or 0)
            size = int(region.RegionSize or 0)
            next_address = base + max(size, 0x1000)
            if next_address <= address:
                break
            address = next_address
            if not _readable_region(region) or size <= 0:
                continue
            regions_scanned += 1
            offset = 0
            carry = b""
            while offset < size and bytes_read_total < max_bytes:
                requested = min(chunk_size, size - offset, max_bytes - bytes_read_total)
                if requested <= 0:
                    break
                buffer = ctypes.create_string_buffer(requested)
                actual = ctypes.c_size_t()
                ok = kernel32.ReadProcessMemory(
                    handle,
                    ctypes.c_void_p(base + offset),
                    buffer,
                    requested,
                    ctypes.byref(actual),
                )
                if not ok and actual.value == 0:
                    read_failures += 1
                    break
                data = carry + buffer.raw[: actual.value]
                data_base = base + offset - len(carry)
                for value, encoding, pattern in patterns:
                    found = matches[value]
                    if len(found) >= max_matches_per_value:
                        continue
                    start = 0
                    while len(found) < max_matches_per_value:
                        index = data.find(pattern, start)
                        if index < 0:
                            break
                        absolute = data_base + index
                        if not found or found[-1].get("address") != absolute:
                            found.append({
                                "address": absolute,
                                "addressHex": f"0x{absolute:X}",
                                "encoding": encoding,
                                "regionBase": base,
                                "regionBaseHex": f"0x{base:X}",
                                "regionSize": size,
                                "regionType": int(region.Type),
                                "protection": int(region.Protect),
                            })
                        start = index + 1
                bytes_read_total += actual.value
                if actual.value == 0:
                    break
                carry = data[-(longest - 1):] if longest > 1 else b""
                offset += actual.value
                if actual.value < requested:
                    break
    finally:
        _close(kernel32, handle)
    return {
        "pid": pid,
        "access": "query+read",
        "searched": clean_values,
        "bytesRead": bytes_read_total,
        "regionsScanned": regions_scanned,
        "readFailures": read_failures,
        "truncated": bytes_read_total >= max_bytes,
        "matches": matches,
    }


def read_process_bytes(pid: int, address: int, size: int) -> bytes:
    """Read a bounded byte range without requesting write or operation rights."""
    if sys.platform != "win32":
        raise OSError("Live process access is Windows-only")
    if address < 0:
        raise ValueError("address must be non-negative")
    if not (1 <= size <= 16 * 1024 * 1024):
        raise ValueError("size must be between 1 byte and 16 MiB")
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"OpenProcess(pid={pid}) failed")
    try:
        buffer = ctypes.create_string_buffer(size)
        actual = ctypes.c_size_t()
        ok = kernel32.ReadProcessMemory(
            handle,
            ctypes.c_void_p(address),
            buffer,
            size,
            ctypes.byref(actual),
        )
        if not ok and actual.value == 0:
            raise OSError(ctypes.get_last_error(), f"ReadProcessMemory(0x{address:X}, {size}) failed")
        return buffer.raw[: actual.value]
    finally:
        _close(kernel32, handle)


def decode_live_player_object(data: bytes, address: int = 0) -> dict[str, object]:
    if len(data) < LIVE_PLAYER_OBJECT_SIZE:
        raise ValueError(f"Live player object requires {LIVE_PLAYER_OBJECT_SIZE} bytes")
    player_id = int.from_bytes(data[LIVE_PLAYER_ID_OFFSET : LIVE_PLAYER_ID_OFFSET + 4], "little")
    ratings: dict[str, int] = {}
    duplicate_mismatches: list[dict[str, object]] = []
    for field, offset in LIVE_PLAYER_RATING_OFFSETS.items():
        value = data[offset]
        duplicate_offset = LIVE_PLAYER_DUPLICATE_OFFSETS[field]
        duplicate = data[duplicate_offset]
        ratings[field] = value
        if duplicate != value:
            duplicate_mismatches.append({
                "field": field,
                "offset": offset,
                "duplicateOffset": duplicate_offset,
                "value": value,
                "duplicate": duplicate,
            })
    return {
        "address": address,
        "addressHex": f"0x{address:X}",
        "size": LIVE_PLAYER_OBJECT_SIZE,
        "playerId": player_id,
        "ratings": ratings,
        "duplicateRatingBytesValid": not duplicate_mismatches,
        "duplicateMismatches": duplicate_mismatches,
    }


def discover_live_player_objects(
    pid: int,
    player_id: int,
    expected_ratings: dict[str, int],
    *,
    minimum_rating_matches: int = 5,
    max_scan_bytes: int = 4 * 1024 * 1024 * 1024,
) -> dict[str, object]:
    if not (1 <= player_id <= 0xFFFFFFFF):
        raise ValueError("player_id must be an unsigned 32-bit integer")
    expected = {
        field: int(value)
        for field, value in expected_ratings.items()
        if field in LIVE_PLAYER_RATING_OFFSETS and isinstance(value, int) and 0 <= value <= 100
    }
    if len(expected) < minimum_rating_matches:
        raise ValueError(f"At least {minimum_rating_matches} verified expected ratings are required")
    scan = scan_process_patterns(
        pid,
        {"player-id": player_id.to_bytes(4, "little")},
        max_matches_per_pattern=1000,
        max_bytes=max_scan_bytes,
    )
    candidates = scan["matches"]["player-id"]
    objects: list[dict[str, object]] = []
    rejected = 0
    for candidate in candidates:
        address = int(candidate["address"]) - LIVE_PLAYER_ID_OFFSET
        if address < 0:
            continue
        try:
            decoded = decode_live_player_object(read_process_bytes(pid, address, LIVE_PLAYER_OBJECT_SIZE), address)
        except (OSError, ValueError):
            rejected += 1
            continue
        if decoded["playerId"] != player_id:
            rejected += 1
            continue
        ratings = decoded["ratings"]
        matching = [field for field, value in expected.items() if ratings.get(field) == value]
        mismatching = [
            {"field": field, "expected": value, "actual": ratings.get(field)}
            for field, value in expected.items()
            if ratings.get(field) != value
        ]
        decoded["expectedRatingMatches"] = matching
        decoded["expectedRatingMismatches"] = mismatching
        decoded["expectedRatingMatchCount"] = len(matching)
        decoded["verified"] = (
            len(matching) >= minimum_rating_matches
            and bool(decoded["duplicateRatingBytesValid"])
        )
        if decoded["verified"]:
            objects.append(decoded)
        else:
            rejected += 1
    # De-duplicate exact addresses while preserving discovery order.
    unique_objects = list({int(item["address"]): item for item in objects}.values())
    return {
        "pid": pid,
        "playerId": player_id,
        "mode": "read-only-discovery",
        "ratingLayoutVersion": "cfb27-2026-07-08.v1",
        "ratingOffsets": LIVE_PLAYER_RATING_OFFSETS,
        "scan": {
            "bytesRead": scan["bytesRead"],
            "regionsScanned": scan["regionsScanned"],
            "readFailures": scan["readFailures"],
            "truncated": scan["truncated"],
            "rawIdCandidates": len(candidates),
            "rejectedCandidates": rejected,
        },
        "count": len(unique_objects),
        "objects": unique_objects,
        "writeEligible": False,
    }


def live_rating_write_addresses(object_address: int, field: str) -> tuple[int, int]:
    if field not in LIVE_PLAYER_RATING_OFFSETS:
        raise ValueError(f"Unsupported live rating field: {field}")
    if object_address < 0:
        raise ValueError("object_address must be non-negative")
    return (
        object_address + LIVE_PLAYER_RATING_OFFSETS[field],
        object_address + LIVE_PLAYER_DUPLICATE_OFFSETS[field],
    )


def normalize_live_object_addresses(object_addresses) -> list[int]:
    addresses = list(dict.fromkeys(int(address) for address in object_addresses))
    if not 1 <= len(addresses) <= 64:
        raise ValueError("One to 64 verified live object addresses are required")
    return addresses


def plan_live_rating_object_writes(
    objects: list[dict[str, object]],
    player_id: int,
    field: str,
    value: int,
) -> list[dict[str, int]]:
    """Validate live player copies and retain each copy's rollback value."""
    if field not in LIVE_PLAYER_RATING_OFFSETS:
        raise ValueError(f"Unsupported live rating field: {field}")
    maximum = 100 if field == "overall" else 99
    if not 0 <= value <= maximum:
        raise ValueError(f"{field} must be between 0 and {maximum}")
    plan: list[dict[str, int]] = []
    for item in objects:
        address = int(item["address"])
        if int(item["playerId"]) != player_id:
            raise RuntimeError(f"Player ID changed at 0x{address:X}; rediscover the player")
        if not item["duplicateRatingBytesValid"]:
            raise RuntimeError(f"Rating duplicate integrity failed at 0x{address:X}; rediscover the player")
        ratings = item.get("ratings")
        if not isinstance(ratings, dict) or field not in ratings:
            raise RuntimeError(f"Live {field} value is unavailable at 0x{address:X}; rediscover the player")
        before = int(ratings[field])
        if not 0 <= before <= maximum:
            raise RuntimeError(f"Live {field} value is invalid at 0x{address:X}; rediscover the player")
        plan.append({"address": address, "before": before, "after": value})
    if not plan:
        raise RuntimeError("No verified live player copies were available")
    return plan


def write_live_player_rating(
    pid: int,
    object_addresses: list[int],
    player_id: int,
    field: str,
    expected_before: int,
    value: int,
) -> dict[str, object]:
    """Apply one rating to every verified live copy with per-copy rollback."""
    if field not in LIVE_PLAYER_RATING_OFFSETS:
        raise ValueError(f"Unsupported live rating field: {field}")
    maximum = 100 if field == "overall" else 99
    if not (0 <= expected_before <= maximum and 0 <= value <= maximum):
        raise ValueError(f"{field} must be between 0 and {maximum}")
    addresses = normalize_live_object_addresses(object_addresses)

    requested_addresses = addresses
    before_objects = [
        decode_live_player_object(read_process_bytes(pid, address, LIVE_PLAYER_OBJECT_SIZE), address)
        for address in requested_addresses
    ]
    write_plan = plan_live_rating_object_writes(before_objects, player_id, field, value)
    addresses = [item["address"] for item in write_plan]

    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
        False,
        pid,
    )
    if not handle:
        raise OSError(ctypes.get_last_error(), f"OpenProcess(pid={pid}, write) failed")
    written_targets: list[tuple[int, int]] = []

    def write_byte(target: int, byte_value: int) -> None:
        source = ctypes.c_ubyte(byte_value)
        actual = ctypes.c_size_t()
        ok = kernel32.WriteProcessMemory(
            handle,
            ctypes.c_void_p(target),
            ctypes.byref(source),
            1,
            ctypes.byref(actual),
        )
        if not ok or actual.value != 1:
            raise OSError(ctypes.get_last_error(), f"WriteProcessMemory(0x{target:X}) failed")

    try:
        try:
            for item in write_plan:
                for target in live_rating_write_addresses(item["address"], field):
                    write_byte(target, value)
                    written_targets.append((target, item["before"]))
            after_objects = [
                decode_live_player_object(read_process_bytes(pid, address, LIVE_PLAYER_OBJECT_SIZE), address)
                for address in addresses
            ]
            failures = [
                item for item in after_objects
                if item["playerId"] != player_id
                or item["ratings"][field] != value
                or not item["duplicateRatingBytesValid"]
            ]
            if failures:
                raise RuntimeError("Live rating readback verification failed")
        except Exception:
            rollback_errors = []
            for target, old_value in reversed(written_targets):
                try:
                    write_byte(target, old_value)
                except Exception as rollback_exc:  # pragma: no cover - catastrophic OS failure
                    rollback_errors.append(str(rollback_exc))
            if rollback_errors:
                raise RuntimeError(f"Live write failed and rollback was incomplete: {rollback_errors}")
            raise
    finally:
        _close(kernel32, handle)

    return {
        "pid": pid,
        "playerId": player_id,
        "field": field,
        "before": expected_before,
        "after": value,
        "observedBeforeValues": sorted({item["before"] for item in write_plan}),
        "requestedObjectAddresses": requested_addresses,
        "objectAddresses": addresses,
        "objectAddressHex": [f"0x{address:X}" for address in addresses],
        "skippedObjects": [],
        "skippedObjectCount": 0,
        "bytesWritten": len(addresses) * 2,
        "verified": True,
        "rollbackUsed": False,
        "persistentToSave": False,
    }


def scan_process_patterns(
    pid: int,
    patterns: dict[str, bytes],
    *,
    max_matches_per_pattern: int = 20,
    max_bytes: int = 12 * 1024 * 1024 * 1024,
    chunk_size: int = 4 * 1024 * 1024,
    stop_when_all_found: bool = False,
) -> dict[str, object]:
    """Scan readable memory for named binary patterns using read-only process rights."""
    if sys.platform != "win32":
        raise OSError("Live process access is Windows-only")
    clean = {
        str(name): bytes(pattern)
        for name, pattern in patterns.items()
        if name and isinstance(pattern, (bytes, bytearray)) and 4 <= len(pattern) <= 1024 * 1024
    }
    if not clean:
        raise ValueError("At least one named pattern of 4 bytes or longer is required")
    if not (1 <= max_matches_per_pattern <= 1000):
        raise ValueError("max_matches_per_pattern must be between 1 and 1000")
    longest = max(len(pattern) for pattern in clean.values())
    matches: dict[str, list[dict[str, object]]] = {name: [] for name in clean}
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"OpenProcess(pid={pid}) failed")
    address = 0
    bytes_read_total = 0
    regions_scanned = 0
    read_failures = 0
    max_address = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8 - 1)) - 1
    stop = False
    try:
        while address < max_address and bytes_read_total < max_bytes and not stop:
            region = MEMORY_BASIC_INFORMATION()
            queried = kernel32.VirtualQueryEx(
                handle,
                ctypes.c_void_p(address),
                ctypes.byref(region),
                ctypes.sizeof(region),
            )
            if not queried:
                break
            base = int(region.BaseAddress or 0)
            size = int(region.RegionSize or 0)
            next_address = base + max(size, 0x1000)
            if next_address <= address:
                break
            address = next_address
            if not _readable_region(region) or size <= 0:
                continue
            regions_scanned += 1
            offset = 0
            carry = b""
            while offset < size and bytes_read_total < max_bytes:
                requested = min(chunk_size, size - offset, max_bytes - bytes_read_total)
                if requested <= 0:
                    break
                buffer = ctypes.create_string_buffer(requested)
                actual = ctypes.c_size_t()
                ok = kernel32.ReadProcessMemory(
                    handle,
                    ctypes.c_void_p(base + offset),
                    buffer,
                    requested,
                    ctypes.byref(actual),
                )
                if not ok and actual.value == 0:
                    read_failures += 1
                    break
                data = carry + buffer.raw[: actual.value]
                data_base = base + offset - len(carry)
                for name, pattern in clean.items():
                    found = matches[name]
                    if len(found) >= max_matches_per_pattern:
                        continue
                    start = 0
                    while len(found) < max_matches_per_pattern:
                        index = data.find(pattern, start)
                        if index < 0:
                            break
                        absolute = data_base + index
                        if not any(item["address"] == absolute for item in found):
                            found.append({
                                "address": absolute,
                                "addressHex": f"0x{absolute:X}",
                                "regionBase": base,
                                "regionBaseHex": f"0x{base:X}",
                                "regionSize": size,
                                "regionType": int(region.Type),
                                "protection": int(region.Protect),
                                "patternLength": len(pattern),
                            })
                        start = index + 1
                bytes_read_total += actual.value
                if stop_when_all_found and all(matches[name] for name in clean):
                    stop = True
                    break
                if actual.value == 0:
                    break
                carry = data[-(longest - 1):] if longest > 1 else b""
                offset += actual.value
                if actual.value < requested:
                    break
    finally:
        _close(kernel32, handle)
    return {
        "pid": pid,
        "access": "query+read",
        "patterns": {name: len(pattern) for name, pattern in clean.items()},
        "bytesRead": bytes_read_total,
        "regionsScanned": regions_scanned,
        "readFailures": read_failures,
        "truncated": bytes_read_total >= max_bytes,
        "stoppedAfterAllFound": stop,
        "matches": matches,
    }


def scan_private_writable_pattern(
    pid: int,
    pattern: bytes,
    *,
    max_matches: int = 2,
    min_region_size: int = 3 * 1024 * 1024,
    max_region_size: int = 256 * 1024 * 1024,
    chunk_size: int = 4 * 1024 * 1024,
    preferred_only: bool = False,
) -> dict[str, object]:
    """Find an exact record image in plausible private table allocations.

    Franchise Player records live in a large private read/write allocation.
    Restricting discovery to those allocations avoids scanning image modules,
    mapped assets, render buffers, and tiny heaps on every edit.
    """
    if sys.platform != "win32":
        raise OSError("Live process access is Windows-only")
    needle = bytes(pattern)
    if not (32 <= len(needle) <= 4096):
        raise ValueError("pattern must be between 32 and 4096 bytes")
    if not (1 <= max_matches <= 16):
        raise ValueError("max_matches must be between 1 and 16")
    kernel32 = _kernel32()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"OpenProcess(pid={pid}) failed")
    matches: list[dict[str, object]] = []
    bytes_read_total = 0
    regions_scanned = 0
    read_failures = 0
    max_address = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8 - 1)) - 1
    try:
        candidate_regions: list[tuple[int, int, int]] = []
        address = 0
        while address < max_address:
            region = MEMORY_BASIC_INFORMATION()
            queried = kernel32.VirtualQueryEx(
                handle,
                ctypes.c_void_p(address),
                ctypes.byref(region),
                ctypes.sizeof(region),
            )
            if not queried:
                break
            base = int(region.BaseAddress or 0)
            size = int(region.RegionSize or 0)
            next_address = base + max(size, 0x1000)
            if next_address <= address:
                break
            address = next_address
            if (
                region.State == MEM_COMMIT
                and region.Type == MEM_PRIVATE
                and not (region.Protect & (PAGE_NOACCESS | PAGE_GUARD))
                and bool(region.Protect & (0x04 | 0x08 | 0x40 | 0x80))
                and min_region_size <= size <= max_region_size
            ):
                candidate_regions.append((base, size, int(region.Protect)))

        preferred_size = 40 * 1024 * 1024
        candidate_regions.sort(key=lambda item: (item[1] != preferred_size, abs(item[1] - preferred_size), -item[0]))
        for base, size, protection in candidate_regions:
            if preferred_only and size != preferred_size:
                continue
            if len(matches) >= max_matches:
                break
            regions_scanned += 1
            offset = 0
            carry = b""
            while offset < size and len(matches) < max_matches:
                requested = min(chunk_size, size - offset)
                buffer = ctypes.create_string_buffer(requested)
                actual = ctypes.c_size_t()
                ok = kernel32.ReadProcessMemory(
                    handle,
                    ctypes.c_void_p(base + offset),
                    buffer,
                    requested,
                    ctypes.byref(actual),
                )
                if not ok and actual.value == 0:
                    read_failures += 1
                    break
                bytes_read_total += actual.value
                data = carry + buffer.raw[: actual.value]
                data_base = base + offset - len(carry)
                start = 0
                while len(matches) < max_matches:
                    index = data.find(needle, start)
                    if index < 0:
                        break
                    absolute = data_base + index
                    if not any(item["address"] == absolute for item in matches):
                        matches.append({
                            "address": absolute,
                            "addressHex": f"0x{absolute:X}",
                            "regionBase": base,
                            "regionBaseHex": f"0x{base:X}",
                            "regionSize": size,
                            "protection": protection,
                            "preferredAllocation": size == preferred_size,
                        })
                    start = index + 1
                carry = data[-(len(needle) - 1) :] if len(needle) > 1 else b""
                if actual.value <= 0:
                    break
                offset += actual.value
            # This CFB27 build reserves exactly 40 MiB for the live franchise
            # table arena. A full 192-byte record match in that allocation is
            # already identity-grade; avoid scanning gigabytes of render heaps.
            if size == preferred_size and matches:
                break
    finally:
        _close(kernel32, handle)
    return {
        "pid": pid,
        "patternLength": len(needle),
        "bytesRead": bytes_read_total,
        "regionsScanned": regions_scanned,
        "readFailures": read_failures,
        "matches": matches,
    }


def _is_real_anticheat_process(process: dict[str, object]) -> bool:
    name = str(process.get("name") or "").casefold()
    path = Path(str(process.get("path") or ""))
    if "javelin" in name:
        return True
    if "eaanticheat" not in name:
        return False
    try:
        # The MMC replacement keeps the launcher's filename but is a small proxy.
        # The preserved EA Javelin launcher in this installation is over 17 MB.
        return path.is_file() and path.stat().st_size >= 1024 * 1024
    except OSError:
        return True


def live_status() -> dict[str, object]:
    game_dir = configured_game_dir()
    builds = [executable_build(game_dir / name) for name in GAME_EXECUTABLES]
    if sys.platform != "win32":
        return {
            "supportedPlatform": False,
            "gameDirectory": str(game_dir),
            "builds": builds,
            "gameProcesses": [],
            "writeEligible": False,
            "writeBlockers": ["Live editing is Windows-only"],
        }

    processes = running_processes()
    game_names = {name.casefold() for name in GAME_EXECUTABLES}
    anticheat_markers = ("eaanticheat", "javelin")
    marker_processes = [
        item for item in processes
        if any(marker in str(item["name"]).casefold() for marker in anticheat_markers)
    ]
    anticheat_processes = [item for item in marker_processes if _is_real_anticheat_process(item)]
    offline_launcher_processes = [item for item in marker_processes if item not in anticheat_processes]
    game_processes: list[dict[str, object]] = []
    for process in processes:
        if str(process["name"]).casefold() not in game_names:
            continue
        item = dict(process)
        try:
            modules = process_modules(int(process["pid"]))
            item["modules"] = modules
            main = next(
                (module for module in modules if str(module["name"]).casefold() == str(process["name"]).casefold()),
                modules[0] if modules else None,
            )
            item["readOnlyAttach"] = (
                verify_read_only_attach(int(process["pid"]), int(main["base"]))
                if main else {"attached": False, "error": "Main module was not found"}
            )
        except OSError as exc:
            item["modules"] = []
            item["readOnlyAttach"] = {"attached": False, "error": str(exc)}
        game_processes.append(item)

    recognized = any(bool(build.get("recognized")) for build in builds)
    blockers = []
    if not recognized:
        blockers.append("The installed CollegeFB27.exe build is not supported")
    if anticheat_processes:
        blockers.append("An EA anticheat/Javelin process is running")
    if not game_processes:
        blockers.append("CollegeFB27.exe is not running")
    if not offline_launcher_processes:
        blockers.append("The verified offline launcher was not detected")
    write_eligible = bool(recognized and game_processes and offline_launcher_processes and not anticheat_processes)
    return {
        "supportedPlatform": True,
        "mode": "response-guard-live-edit" if write_eligible else "read-only-discovery",
        "gameDirectory": str(game_dir),
        "builds": builds,
        "gameProcesses": game_processes,
        "anticheatProcesses": anticheat_processes,
        "offlineLauncherProcesses": offline_launcher_processes,
        "writeEligible": write_eligible,
        "writeBlockers": blockers,
    }
