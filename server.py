from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import zlib
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


APP_DIR = Path(__file__).resolve().parent
SAVE_DIR = APP_DIR.parent
STATIC_DIR = APP_DIR / "static"
BACKUP_DIR = APP_DIR / "backups"
SCHEMA_DIR = APP_DIR / "schema"
RECRUITING_SCHEMA_INDEX = SCHEMA_DIR / "recruiting_schema_index.json"
FRANCHISE_HELPER = APP_DIR / "franchise_helper.js"
MADDEN_FRANCHISE_SCHEMA = SCHEMA_DIR / "CFB27_schema_for_madden_franchise.gz"

MAGIC = b"FBCHUNKS"

PLAYER_INTERNAL_KEY = bytes.fromhex("c25c33")
PLAYER_FIRST_KEY = bytes.fromhex("c26ba1")
PLAYER_LAST_KEY = bytes.fromhex("c2cba1")
PLAYER_HOMETOWN_KEY = bytes.fromhex("c28d2e")

KNOWN_PLAYER_FIELDS = {
    "internal_id": PLAYER_INTERNAL_KEY,
    "first_name": PLAYER_FIRST_KEY,
    "last_name": PLAYER_LAST_KEY,
    "hometown": PLAYER_HOMETOWN_KEY,
}

PLAYER_RELATED_KEYS = {
    PLAYER_INTERNAL_KEY,
    PLAYER_FIRST_KEY,
    PLAYER_LAST_KEY,
    PLAYER_HOMETOWN_KEY,
}

TEAM_RELATED_KEYS = {
    bytes.fromhex(key)
    for key in [
        "d21cee",
        "d2486e",
        "d24ba1",
        "d2cba1",
        "d2d86e",
        "d2da2f",
        "d2da34",
        "d2dba3",
        "d2dbf4",
        "d2dcef",
        "d2dcf4",
        "d309ae",
        "d33ba1",
        "d3586e",
        "d359b0",
    ]
}

PROFILE_RELATED_KEYS = {bytes.fromhex("ca7924"), bytes.fromhex("ca7ba9")}

RECRUITING_TERMS = (
    "recruit",
    "prospect",
    "scholarship",
    "pipeline",
    "visit",
    "scout",
    "nil",
    "portal",
    "influence",
    "pitch",
)

DYNASTY_PLAYER_RECORD_SIZE = 138
DYNASTY_PLAYER_STRING_FIELDS = {
    "first_name": (0, 17, "First Name"),
    "visual_id": (17, 33, "Visual ID"),
    "last_name": (50, 21, "Last Name"),
    "slug": (71, 41, "Slug / Player ID"),
    "hometown": (112, 26, "Hometown"),
}
DYNASTY_PLAYER_WRITABLE_FIELDS = {"first_name", "visual_id", "last_name", "hometown"}
DYNASTY_PLAYER_VISUAL_PATTERN = re.compile(rb"^(Generic|Unique)_[A-Za-z0-9_\-]+$")
DYNASTY_PLAYER_SLUG_PATTERN = re.compile(rb"^[A-Za-z .'\-]{1,28}[A-Za-z .'\-]{1,20}_\d{2,8}$")

RECRUIT_POSITION_OPTIONS = [
    "QB",
    "HB",
    "FB",
    "WR",
    "TE",
    "LT",
    "LG",
    "C",
    "RG",
    "RT",
    "LE",
    "RE",
    "DT",
    "LOLB",
    "MLB",
    "ROLB",
    "CB",
    "FS",
    "SS",
    "K",
    "P",
    "LS",
    "KR",
    "PR",
]

RECRUIT_RATING_COLUMNS = [
    ("overall", "OVR", "Overall", "General", 0, 100),
    ("speed", "SPD", "Speed", "General", 0, 99),
    ("acceleration", "ACC", "Acceleration", "General", 0, 99),
    ("strength", "STR", "Strength", "General", 0, 99),
    ("agility", "AGI", "Agility", "General", 0, 99),
    ("awareness", "AWR", "Awareness", "General", 0, 99),
    ("jumping", "JMP", "Jumping", "General", 0, 99),
    ("injury", "INJ", "Injury", "General", 0, 99),
    ("stamina", "STA", "Stamina", "General", 0, 99),
    ("toughness", "TGH", "Toughness", "General", 0, 99),
    ("carrying", "CAR", "Carrying", "Ballcarrier", 0, 99),
    ("break_tackle", "BTK", "Break Tackle", "Ballcarrier", 0, 99),
    ("trucking", "TRK", "Trucking", "Ballcarrier", 0, 99),
    ("change_of_direction", "COD", "Change Of Direction", "Ballcarrier", 0, 99),
    ("bc_vision", "BCV", "BC Vision", "Ballcarrier", 0, 99),
    ("stiff_arm", "SFA", "Stiff Arm", "Ballcarrier", 0, 99),
    ("spin_move", "SPM", "Spin Move", "Ballcarrier", 0, 99),
    ("juke_move", "JKM", "Juke Move", "Ballcarrier", 0, 99),
    ("break_sack", "BSK", "Break Sack", "Ballcarrier", 0, 99),
    ("run_block", "RBK", "Run Block", "Blocking", 0, 99),
    ("pass_block", "PBK", "Pass Block", "Blocking", 0, 99),
    ("impact_blocking", "IBL", "Impact Blocking", "Blocking", 0, 99),
    ("run_block_power", "RBP", "Run Block Power", "Blocking", 0, 99),
    ("run_block_finesse", "RBF", "Run Block Finesse", "Blocking", 0, 99),
    ("pass_block_power", "PBP", "Pass Block Power", "Blocking", 0, 99),
    ("pass_block_finesse", "PBF", "Pass Block Finesse", "Blocking", 0, 99),
    ("lead_block", "LBK", "Lead Block", "Blocking", 0, 99),
    ("throw_power", "THP", "Throw Power", "Passing", 0, 99),
    ("throw_under_pressure", "TUP", "Throw Under Pressure", "Passing", 0, 99),
    ("throw_accuracy_short", "SAC", "Throw Accuracy Short", "Passing", 0, 99),
    ("throw_accuracy_mid", "MAC", "Throw Accuracy Mid", "Passing", 0, 99),
    ("throw_accuracy_deep", "DAC", "Throw Accuracy Deep", "Passing", 0, 99),
    ("throw_on_the_run", "TOR", "Throw On The Run", "Passing", 0, 99),
    ("play_action", "PAC", "Play Action", "Passing", 0, 99),
    ("tackle", "TAK", "Tackle", "Defense", 0, 99),
    ("power_moves", "PMV", "Power Moves", "Defense", 0, 99),
    ("finesse_moves", "FMV", "Finesse Moves", "Defense", 0, 99),
    ("block_shedding", "BSH", "Block Shedding", "Defense", 0, 99),
    ("pursuit", "PUR", "Pursuit", "Defense", 0, 99),
    ("play_recognition", "PRC", "Play Recognition", "Defense", 0, 99),
    ("man_coverage", "MCV", "Man Coverage", "Defense", 0, 99),
    ("zone_coverage", "ZCV", "Zone Coverage", "Defense", 0, 99),
    ("hit_power", "POW", "Hit Power", "Defense", 0, 99),
    ("press", "PRS", "Press", "Defense", 0, 99),
    ("catching", "CTH", "Catching", "Receiving", 0, 99),
    ("spectacular_catch", "SPC", "Spectacular Catch", "Receiving", 0, 99),
    ("catch_in_traffic", "CIT", "Catch In Traffic", "Receiving", 0, 99),
    ("short_route_running", "SRR", "Short Route Running", "Receiving", 0, 99),
    ("medium_route_running", "MRR", "Medium Route Running", "Receiving", 0, 99),
    ("deep_route_running", "DRR", "Deep Route Running", "Receiving", 0, 99),
    ("kick_power", "KPW", "Kick Power", "Kicking", 0, 99),
    ("kick_accuracy", "KAC", "Kick Accuracy", "Kicking", 0, 99),
    ("kick_return", "KRT", "Kick Return", "Kicking", 0, 99),
]

KEY_LABELS = {
    PLAYER_INTERNAL_KEY: "Internal ID",
    PLAYER_FIRST_KEY: "First Name",
    PLAYER_LAST_KEY: "Last Name",
    PLAYER_HOMETOWN_KEY: "Hometown",
    bytes.fromhex("d21cee"): "Team Code",
    bytes.fromhex("d2486e"): "Team DB ID",
    bytes.fromhex("d24ba1"): "Team Name",
    bytes.fromhex("d2cba1"): "Display Name",
    bytes.fromhex("d2d86e"): "Short Code",
    bytes.fromhex("d2da2f"): "Hashtag 1",
    bytes.fromhex("d2da34"): "Hashtag 2",
    bytes.fromhex("d2dba3"): "Mascot",
    bytes.fromhex("d2dcef"): "Chant 1",
    bytes.fromhex("d2dcf4"): "Chant 2",
    bytes.fromhex("d309ae"): "Abbreviation",
    bytes.fromhex("d33ba1"): "Alt Abbreviation",
    bytes.fromhex("d3586e"): "Alt Team Code",
    bytes.fromhex("d359b0"): "Alt Short Code",
    bytes.fromhex("ca7924"): "Save Timestamp",
    bytes.fromhex("ca7ba9"): "Save Name",
}

SLUG_PATTERN = re.compile(rb"[A-Z][A-Za-z]{1,24}[A-Z][A-Za-z]{1,24}_\d{2,6}\x00")
PRINTABLE_TLV_STRING_PATTERN = re.compile(rb"[ -~]{2,}\x00")


class AppError(Exception):
    status = 400

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        if status is not None:
            self.status = status


@dataclass
class FBChunks:
    source: bytes
    header_size: int
    payload_size: int
    header: bytes
    compressed_payload: bytes
    decompressed_payload: bytes

    @classmethod
    def parse(cls, source: bytes) -> "FBChunks":
        if len(source) < 18 or source[:8] != MAGIC:
            raise AppError("File is not an FBCHUNKS container", 422)

        header_size = int.from_bytes(source[10:14], "little")
        payload_size = int.from_bytes(source[14:18], "little")
        payload_offset = 18 + header_size
        if header_size < 0 or payload_offset > len(source):
            raise AppError("Invalid FBCHUNKS header size", 422)
        if payload_size != len(source) - payload_offset:
            raise AppError("FBCHUNKS payload size does not match file size", 422)

        header = source[18:payload_offset]
        compressed_payload = source[payload_offset:]
        try:
            decompressed_payload = zlib.decompress(compressed_payload)
        except zlib.error as exc:
            raise AppError(f"Could not decompress zlib payload: {exc}", 422) from exc

        return cls(
            source=source,
            header_size=header_size,
            payload_size=payload_size,
            header=header,
            compressed_payload=compressed_payload,
            decompressed_payload=decompressed_payload,
        )

    def rebuild(self, new_decompressed_payload: bytes) -> bytes:
        new_compressed = zlib.compress(new_decompressed_payload, level=9)
        new_source = bytearray(self.source[: 18 + self.header_size])
        new_source[14:18] = len(new_compressed).to_bytes(4, "little")

        # College Football 27 uses the first metadata-header dword differently
        # across files. Preserve the observed rule instead of forcing one value.
        if self.header_size >= 4:
            secondary = int.from_bytes(self.header[:4], "little")
            original_container_tail = len(self.source) - 18
            if secondary == original_container_tail:
                new_secondary = self.header_size + len(new_compressed)
                new_source[18:22] = new_secondary.to_bytes(4, "little")
            elif secondary == len(self.decompressed_payload):
                new_source[18:22] = len(new_decompressed_payload).to_bytes(4, "little")

        new_source.extend(new_compressed)
        return bytes(new_source)


@dataclass
class TLVField:
    key: bytes
    type_code: int
    start: int
    end: int
    length_pos: int | None
    value_start: int
    value_end: int
    value: int | str

    @property
    def key_hex(self) -> str:
        return self.key.hex()

    @property
    def label(self) -> str:
        return KEY_LABELS.get(self.key, self.key.hex())


@dataclass
class PlayerRecord:
    row_id: str
    offset: int
    fields: list[TLVField]

    def get_text(self, key: bytes) -> str:
        for field in self.fields:
            if field.key == key and isinstance(field.value, str):
                return field.value
        return ""

    def get_field(self, key: bytes) -> TLVField | None:
        for field in self.fields:
            if field.key == key:
                return field
        return None

    def to_dict(self, include_fields: bool = False) -> dict:
        result = {
            "id": self.row_id,
            "offset": self.offset,
            "internal_id": self.get_text(PLAYER_INTERNAL_KEY),
            "first_name": self.get_text(PLAYER_FIRST_KEY),
            "last_name": self.get_text(PLAYER_LAST_KEY),
            "hometown": self.get_text(PLAYER_HOMETOWN_KEY),
        }
        if include_fields:
            result["fields"] = [
                {
                    "key": field.key_hex,
                    "label": field.label,
                    "type": "string" if field.type_code == 1 else "number",
                    "value": field.value,
                    "writable": field.key in KNOWN_PLAYER_FIELDS.values()
                    and field.type_code == 1,
                }
                for field in self.fields
            ]
        return result


@dataclass
class DynastyPlayerRecord:
    row_id: str
    offset: int
    fields: dict[str, str]
    writable: list[str]

    def to_dict(self) -> dict:
        return {
            "id": self.row_id,
            "offset": self.offset,
            **self.fields,
            "writable": self.writable,
            "slotMax": {
                key: size - 1
                for key, (_, size, _) in DYNASTY_PLAYER_STRING_FIELDS.items()
                if key in DYNASTY_PLAYER_WRITABLE_FIELDS
            },
        }


@dataclass
class InferredTable:
    table_id: str
    name: str
    file_name: str
    anchor_key: bytes
    record_offsets: list[int]
    writable: bool
    confidence: str
    notes: str

    def to_summary(self, payload: bytes) -> dict:
        sample = (
            read_inferred_table_rows(payload, self, limit=10)
            if self.confidence in {"high", "medium"}
            else {"columns": [], "rows": []}
        )
        return {
            "id": self.table_id,
            "name": self.name,
            "file": self.file_name,
            "anchorKey": self.anchor_key.hex(),
            "recordCount": len(self.record_offsets),
            "writable": self.writable,
            "confidence": self.confidence,
            "notes": self.notes,
            "stringEditable": self.confidence in {"high", "medium"},
            "columns": sample["columns"],
            "sampleRows": sample["rows"][:5],
        }


def printable_context(buf: bytes, offset: int, size: int = 96) -> str:
    start = max(0, offset - size)
    end = min(len(buf), offset + size)
    context = re.sub(rb"[^\x20-\x7e]+", b".", bytes(buf[start:end]))
    return context.decode("ascii", errors="ignore")


def load_recruiting_schema_index() -> list[dict]:
    if not RECRUITING_SCHEMA_INDEX.is_file():
        return []
    try:
        raw_entries = json.loads(RECRUITING_SCHEMA_INDEX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    entries: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "")
        file_name = str(raw.get("fileName") or "")
        kind = str(raw.get("kind") or "")
        if not name:
            continue
        key = (name, file_name, kind)
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            {
                "name": name,
                "kind": kind,
                "fileName": file_name,
                "base": raw.get("base"),
                "assetId": raw.get("assetId"),
                "majorVersionCRC": raw.get("majorVersionCRC"),
                "minorVersionCRC": raw.get("minorVersionCRC"),
                "attributes": raw.get("attributes") if isinstance(raw.get("attributes"), list) else [],
            }
        )
    return sorted(entries, key=lambda item: (item["name"].lower(), item["fileName"].lower()))


SCHEMA_INDEX = load_recruiting_schema_index()


def schema_entry_matches(entry: dict, query: str = "", domain: str = "recruiting") -> bool:
    haystack = " ".join(
        [
            str(entry.get("name") or ""),
            str(entry.get("fileName") or ""),
            " ".join(str(attr.get("name") or "") for attr in entry.get("attributes", []) if isinstance(attr, dict)),
        ]
    ).lower()
    if domain == "recruiting" and not any(term in haystack for term in RECRUITING_TERMS):
        return False
    return not query or query.lower() in haystack


def schema_entries(query: str = "", domain: str = "recruiting", limit: int = 300) -> dict:
    matches = [entry for entry in SCHEMA_INDEX if schema_entry_matches(entry, query=query, domain=domain)]
    bounded = matches[: max(1, min(limit, 1000))]
    return {
        "source": str(RECRUITING_SCHEMA_INDEX),
        "available": bool(SCHEMA_INDEX),
        "count": len(matches),
        "entries": [
            {
                **entry,
                "attributeCount": len(entry.get("attributes", [])),
            }
            for entry in bounded
        ],
    }


def schema_occurrences(payload: bytes, query: str = "", domain: str = "recruiting", limit: int = 300) -> dict:
    entries = [entry for entry in SCHEMA_INDEX if schema_entry_matches(entry, query=query, domain=domain)]
    found = []
    for entry in entries:
        name = entry["name"]
        if len(name) < 3 or not all(32 <= ord(ch) <= 126 for ch in name):
            continue
        needle = name.encode("ascii")
        offsets: list[int] = []
        pos = 0
        while True:
            pos = payload.find(needle, pos)
            if pos < 0:
                break
            offsets.append(pos)
            pos += 1
        if not offsets:
            continue
        found.append(
            {
                "name": name,
                "kind": entry.get("kind"),
                "fileName": entry.get("fileName"),
                "attributeCount": len(entry.get("attributes", [])),
                "attributes": entry.get("attributes", []),
                "occurrenceCount": len(offsets),
                "offsets": offsets[:25],
                "contexts": [
                    {"offset": offset, "text": printable_context(payload, offset)}
                    for offset in offsets[:5]
                ],
            }
        )

    found.sort(key=lambda item: (-item["occurrenceCount"], item["name"].lower()))
    return {
        "source": str(RECRUITING_SCHEMA_INDEX),
        "available": bool(SCHEMA_INDEX),
        "scanned": len(entries),
        "count": len(found),
        "entries": found[: max(1, min(limit, 1000))],
    }


def read_varint(buf: bytes | bytearray, offset: int) -> tuple[int, int] | None:
    value = 0
    shift = 0
    pos = offset
    while pos < len(buf) and shift <= 35:
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, pos
        shift += 7
    return None


def parse_tlv_field(buf: bytes | bytearray, offset: int) -> TLVField | None:
    if offset + 4 > len(buf):
        return None

    key = bytes(buf[offset : offset + 3])
    type_code = buf[offset + 3]

    if type_code == 0:
        parsed = read_varint(buf, offset + 4)
        if parsed is None:
            return None
        value, end = parsed
        return TLVField(
            key=key,
            type_code=type_code,
            start=offset,
            end=end,
            length_pos=None,
            value_start=offset + 4,
            value_end=end,
            value=value,
        )

    if type_code == 1:
        if offset + 5 > len(buf):
            return None
        raw_len = buf[offset + 4]
        value_start = offset + 5
        value_end = value_start + raw_len
        if raw_len < 1 or value_end > len(buf):
            return None
        raw = bytes(buf[value_start:value_end])
        if raw[-1:] != b"\x00":
            return None
        text_raw = raw[:-1]
        if any(ch < 32 or ch > 126 for ch in text_raw):
            return None
        text = text_raw.decode("ascii")
        return TLVField(
            key=key,
            type_code=type_code,
            start=offset,
            end=value_end,
            length_pos=offset + 4,
            value_start=value_start,
            value_end=value_end,
            value=text,
        )

    return None


def parse_player_records(payload: bytes) -> list[PlayerRecord]:
    anchor_offsets: list[int] = []
    for match in SLUG_PATTERN.finditer(payload):
        string_start = match.start()
        if string_start < 5:
            continue
        field_offset = string_start - 5
        raw_len = match.end() - string_start
        if (
            payload[field_offset : field_offset + 3] == PLAYER_INTERNAL_KEY
            and payload[field_offset + 3] == 1
            and payload[field_offset + 4] == raw_len
        ):
            anchor_offsets.append(field_offset)

    records: list[PlayerRecord] = []
    for index, offset in enumerate(anchor_offsets):
        next_offset = anchor_offsets[index + 1] if index + 1 < len(anchor_offsets) else len(payload)
        stop = min(next_offset, offset + 1200)
        fields: list[TLVField] = []
        pos = offset
        while pos < stop:
            field = parse_tlv_field(payload, pos)
            if field is None or field.end <= pos or field.end > stop:
                break
            fields.append(field)
            pos = field.end

        if not fields:
            continue
        has_first = any(field.key == PLAYER_FIRST_KEY for field in fields)
        has_last = any(field.key == PLAYER_LAST_KEY for field in fields)
        if not (has_first and has_last):
            continue

        records.append(PlayerRecord(row_id=str(offset), offset=offset, fields=fields))

    return records


def read_fixed_c_string(payload: bytes | bytearray, start: int, size: int) -> str:
    raw = bytes(payload[start : start + size])
    value = raw.split(b"\x00", 1)[0]
    if any(ch < 32 or ch > 126 for ch in value):
        return ""
    return value.decode("ascii")


def dynasty_player_at(payload: bytes | bytearray, offset: int) -> DynastyPlayerRecord | None:
    if offset < 0 or offset + DYNASTY_PLAYER_RECORD_SIZE > len(payload):
        return None
    fields: dict[str, str] = {}
    for name, (relative, size, _) in DYNASTY_PLAYER_STRING_FIELDS.items():
        fields[name] = read_fixed_c_string(payload, offset + relative, size)

    if not fields["first_name"] or not fields["last_name"] or not fields["hometown"]:
        return None
    if not DYNASTY_PLAYER_VISUAL_PATTERN.match(fields["visual_id"].encode("ascii")):
        return None
    if not DYNASTY_PLAYER_SLUG_PATTERN.match(fields["slug"].encode("ascii")):
        return None

    return DynastyPlayerRecord(
        row_id=str(offset),
        offset=offset,
        fields=fields,
        writable=sorted(DYNASTY_PLAYER_WRITABLE_FIELDS),
    )


def find_dynasty_player_pool(payload: bytes) -> list[DynastyPlayerRecord]:
    records_by_offset: dict[int, DynastyPlayerRecord] = {}
    for match in re.finditer(rb"(?:Generic|Unique)_[A-Za-z0-9_\-]+", payload):
        visual_start = match.start()
        record_start = visual_start - DYNASTY_PLAYER_STRING_FIELDS["visual_id"][0]
        record = dynasty_player_at(payload, record_start)
        if record is not None:
            records_by_offset[record.offset] = record

    records = sorted(records_by_offset.values(), key=lambda item: item.offset)
    clusters: list[list[DynastyPlayerRecord]] = []
    current: list[DynastyPlayerRecord] = []
    last_offset: int | None = None
    for record in records:
        if last_offset is None or record.offset - last_offset <= DYNASTY_PLAYER_RECORD_SIZE * 4:
            current.append(record)
        else:
            if current:
                clusters.append(current)
            current = [record]
        last_offset = record.offset
    if current:
        clusters.append(current)

    if not clusters:
        return []
    largest = max(clusters, key=len)
    return largest if len(largest) >= 100 else records


def patch_dynasty_player_payload(
    payload: bytes,
    row_id: str,
    changes: dict,
) -> tuple[bytes, dict]:
    if not isinstance(changes, dict) or not changes:
        raise AppError("No changes supplied")
    unsupported = sorted(set(changes) - DYNASTY_PLAYER_WRITABLE_FIELDS)
    if unsupported:
        raise AppError(f"Unsupported dynasty player fields: {', '.join(unsupported)}")

    try:
        offset = int(row_id)
    except ValueError as exc:
        raise AppError("Invalid dynasty player row id", 400) from exc

    record = dynasty_player_at(payload, offset)
    if record is None:
        raise AppError("Dynasty player row was not found; reload the file and try again", 404)

    patched = bytearray(payload)
    for field_name, value in changes.items():
        relative, size, label = DYNASTY_PLAYER_STRING_FIELDS[field_name]
        clean_value = validate_text_value(label, value)
        raw = clean_value.encode("ascii")
        if len(raw) > size - 1:
            raise AppError(f"{label} must be {size - 1} characters or fewer")
        start = offset + relative
        patched[start : start + size] = raw + (b"\x00" * (size - len(raw)))

    updated = dynasty_player_at(patched, offset)
    if updated is None:
        raise AppError("Patch produced an invalid dynasty player row; no file was written", 422)
    return bytes(patched), updated.to_dict()


def iter_string_fields(payload: bytes):
    for match in PRINTABLE_TLV_STRING_PATTERN.finditer(payload):
        string_start = match.start()
        raw_len = match.end() - string_start
        field_start = string_start - 5
        if field_start < 0 or raw_len > 255:
            continue
        if payload[field_start + 3] != 1 or payload[field_start + 4] != raw_len:
            continue
        field = parse_tlv_field(payload, field_start)
        if field and field.type_code == 1 and isinstance(field.value, str):
            yield field


def find_anchor_offsets(payload: bytes, key: bytes) -> list[int]:
    offsets: list[int] = []
    needle = key + b"\x01"
    pos = 0
    while True:
        offset = payload.find(needle, pos)
        if offset < 0:
            break
        field = parse_tlv_field(payload, offset)
        if field and field.key == key and field.type_code == 1:
            offsets.append(offset)
        pos = offset + 1
    return offsets


def discover_inferred_tables(file_name: str, payload: bytes, deep: bool = False) -> list[InferredTable]:
    tables: list[InferredTable] = []
    seen_keys: set[bytes] = set()

    player_offsets = (
        [record.offset for record in parse_player_records(payload)]
        if payload.find(PLAYER_INTERNAL_KEY + b"\x01") >= 0
        else []
    )
    if len(player_offsets) >= 10:
        tables.append(
            InferredTable(
                table_id="players",
                name="Players",
                file_name=file_name,
                anchor_key=PLAYER_INTERNAL_KEY,
                record_offsets=player_offsets,
                writable=True,
                confidence="high",
                notes="Roster-style player TLV records anchored by Internal ID.",
            )
        )
        seen_keys.add(PLAYER_INTERNAL_KEY)
        seen_keys.update(PLAYER_RELATED_KEYS)

    team_key = bytes.fromhex("d21cee")
    team_offsets = find_anchor_offsets(payload, team_key)
    if len(team_offsets) >= 10:
        tables.append(
            InferredTable(
                table_id="teams",
                name="Teams",
                file_name=file_name,
                anchor_key=team_key,
                record_offsets=team_offsets,
                writable=True,
                confidence="high",
                notes="Team TLV records. String fields are editable; numeric/reference-like fields stay read-only.",
            )
        )
        seen_keys.add(team_key)
        seen_keys.update(TEAM_RELATED_KEYS)

    profile_key = bytes.fromhex("ca7924")
    profile_offsets = find_anchor_offsets(payload, profile_key)
    if profile_offsets:
        tables.append(
            InferredTable(
                table_id="profile-summary",
                name="Profile Save Summary",
                file_name=file_name,
                anchor_key=profile_key,
                record_offsets=profile_offsets,
                writable=True,
                confidence="medium",
                notes="Profile metadata string block. String fields are editable; numeric fields stay read-only.",
            )
        )
        seen_keys.add(profile_key)
        seen_keys.update(PROFILE_RELATED_KEYS)

    if deep:
        counts: dict[bytes, list[int]] = {}
        for field in iter_string_fields(payload):
            if field.key in seen_keys:
                continue
            counts.setdefault(field.key, []).append(field.start)

        for key, offsets in sorted(counts.items(), key=lambda item: len(item[1]), reverse=True)[:50]:
            if len(offsets) < 5:
                continue
            table_id = f"strings-{key.hex()}"
            tables.append(
                InferredTable(
                    table_id=table_id,
                    name=f"String-Anchored {key.hex()}",
                    file_name=file_name,
                    anchor_key=key,
                    record_offsets=offsets,
                    writable=False,
                    confidence="low",
                    notes="Repeated string-key group found by deep scanner; read-only pending schema mapping.",
                )
            )

    return tables


def parse_fields_until(payload: bytes, start: int, end: int, max_fields: int = 250) -> list[TLVField]:
    fields: list[TLVField] = []
    pos = start
    while pos < min(end, len(payload)) and len(fields) < max_fields:
        field = parse_tlv_field(payload, pos)
        if field is None or field.end <= pos or field.end > end:
            break
        fields.append(field)
        pos = field.end
    return fields


def record_fields_for_table(payload: bytes, table: InferredTable, index: int) -> list[TLVField]:
    offset = table.record_offsets[index]
    next_offset = (
        table.record_offsets[index + 1]
        if index + 1 < len(table.record_offsets)
        else min(len(payload), offset + 1800)
    )
    window_end = min(next_offset, offset + 1800)
    fields = parse_fields_until(payload, offset, window_end)
    if table.table_id == "players":
        records = parse_player_records(payload)
        record = next((item for item in records if item.offset == offset), None)
        if record is not None:
            return record.fields
    return fields


def row_from_fields(row_id: str, offset: int, fields: list[TLVField]) -> tuple[dict, dict]:
    row = {"_id": row_id, "_offset": offset}
    duplicates: dict[str, int] = {}
    meta = {
        "_id": {"key": "_id", "label": "Row ID", "type": "meta", "writable": False},
        "_offset": {"key": "_offset", "label": "Offset", "type": "meta", "writable": False},
    }
    for field in fields:
        key = field.key_hex
        duplicates[key] = duplicates.get(key, 0) + 1
        column = key if duplicates[key] == 1 else f"{key}#{duplicates[key]}"
        row[column] = field.value
        meta[column] = {
            "key": column,
            "label": field.label,
            "type": "string" if field.type_code == 1 else "number",
            "writable": field.type_code == 1,
        }
    return row, meta


def read_inferred_table_rows(
    payload: bytes,
    table: InferredTable,
    limit: int = 500,
    offset: int = 0,
) -> dict:
    rows = []
    meta_by_key: dict[str, dict] = {}
    start = max(0, offset)
    stop = min(len(table.record_offsets), start + max(1, min(limit, 1000)))
    for index in range(start, stop):
        record_offset = table.record_offsets[index]
        fields = record_fields_for_table(payload, table, index)
        row, row_meta = row_from_fields(str(record_offset), record_offset, fields)
        rows.append(row)
        for key, meta in row_meta.items():
            if key not in meta_by_key:
                meta_by_key[key] = meta
    columns = summarize_columns(rows)
    for column in columns:
        column.update(meta_by_key.get(column["key"], {}))
        if table.confidence == "low":
            column["writable"] = False
    return {
        "id": table.table_id,
        "name": table.name,
        "file": table.file_name,
        "recordCount": len(table.record_offsets),
        "offset": start,
        "limit": limit,
        "rows": rows,
        "columns": columns,
    }


def summarize_columns(rows: list[dict]) -> list[dict]:
    ordered: list[str] = []
    for row in rows:
        for key in row:
            if key not in ordered:
                ordered.append(key)
    columns = []
    for key in ordered:
        base_key = key.split("#", 1)[0]
        label = KEY_LABELS.get(bytes.fromhex(base_key), base_key) if re.fullmatch(r"[0-9a-f]{6}", base_key) else key
        columns.append({"key": key, "label": label})
    return columns


def validate_text_value(field_name: str, value: object) -> str:
    if not isinstance(value, str):
        raise AppError(f"{field_name} must be a string")
    if not value:
        raise AppError(f"{field_name} cannot be empty")
    if len(value.encode("ascii", errors="ignore")) != len(value):
        raise AppError(f"{field_name} must contain ASCII text only")
    if "\x00" in value:
        raise AppError(f"{field_name} cannot contain null bytes")
    if any(ord(ch) < 32 or ord(ch) > 126 for ch in value):
        raise AppError(f"{field_name} contains unsupported characters")
    if len(value.encode("ascii")) + 1 > 255:
        raise AppError(f"{field_name} is too long")
    if field_name == "internal_id":
        candidate = value.encode("ascii") + b"\x00"
        if not SLUG_PATTERN.fullmatch(candidate):
            raise AppError("internal_id must keep the observed NameName_123 format")
    return value


def patch_player_payload(payload: bytes, row_id: str, changes: dict) -> tuple[bytes, dict]:
    if not isinstance(changes, dict) or not changes:
        raise AppError("No changes supplied")

    allowed_names = set(KNOWN_PLAYER_FIELDS)
    unsupported = sorted(set(changes) - allowed_names)
    if unsupported:
        raise AppError(f"Unsupported writable fields: {', '.join(unsupported)}")

    records = parse_player_records(payload)
    record = next((item for item in records if item.row_id == row_id), None)
    if record is None:
        raise AppError("Player row was not found; reload the file and try again", 404)

    replacements: list[tuple[int, int, bytes]] = []
    for field_name, value in changes.items():
        key = KNOWN_PLAYER_FIELDS[field_name]
        field = record.get_field(key)
        if field is None or field.type_code != 1 or field.length_pos is None:
            raise AppError(f"{field_name} is not present on this player")
        clean_value = validate_text_value(field_name, value)
        raw = clean_value.encode("ascii") + b"\x00"
        replacements.append((field.length_pos, field.value_end, bytes([len(raw)]) + raw))

    new_payload = bytearray(payload)
    for start, end, replacement in sorted(replacements, reverse=True):
        new_payload[start:end] = replacement

    updated = next(
        (item for item in parse_player_records(bytes(new_payload)) if item.offset == record.offset),
        None,
    )
    if updated is None:
        updated = next(
            (item for item in parse_player_records(bytes(new_payload)) if item.row_id == row_id),
            None,
        )
    return bytes(new_payload), (updated.to_dict(include_fields=True) if updated else {})


def recruit_columns() -> list[dict]:
    columns = [
        {"key": "national_rank", "label": "Nat Rank", "writable": True, "type": "number", "min": 0, "max": 4500},
        {"key": "position_rank", "label": "Pos Rank", "writable": True, "type": "number", "min": 0, "max": 4000},
        {"key": "state_rank", "label": "State Rank", "writable": True, "type": "number", "min": 0, "max": 4000},
        {"key": "first_name", "label": "First", "writable": True, "maxLength": 17},
        {"key": "last_name", "label": "Last", "writable": True, "maxLength": 21},
        {"key": "position", "label": "Pos", "writable": True, "type": "select", "options": RECRUIT_POSITION_OPTIONS},
        {"key": "height_inches", "label": "Height In", "writable": True, "type": "number", "min": 48, "max": 96},
        {"key": "height_display", "label": "Height", "writable": False},
        {"key": "weight_lbs", "label": "Weight", "writable": True, "type": "number", "min": 160, "max": 415},
        {"key": "generic_head_asset_name", "label": "Head Asset", "writable": True, "maxLength": 33},
        {"key": "skin_tone", "label": "Skin", "writable": False},
        {"key": "hair", "label": "Hair", "writable": False},
        {"key": "recruit_index", "label": "Recruit Row", "writable": False},
        {"key": "player_index", "label": "Player Row", "writable": False},
    ]
    columns.extend(
        {
            "key": key,
            "label": short_label,
            "title": display_label,
            "group": group,
            "writable": True,
            "type": "number",
            "min": min_value,
            "max": max_value,
        }
        for key, short_label, display_label, group, min_value, max_value in RECRUIT_RATING_COLUMNS
    )
    return columns


def parse_helper_json(stdout: str, stderr: str) -> dict:
    for text in (stdout, stderr):
        for line in reversed([item.strip() for item in text.splitlines() if item.strip()]):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
    message = (stderr or stdout or "No output from franchise helper").strip()
    raise AppError(message, 500)


def run_franchise_helper(args: list[str], timeout: int = 90) -> dict:
    if not FRANCHISE_HELPER.exists():
        raise AppError("Missing franchise helper; reinstall the editor app files", 500)
    if not MADDEN_FRANCHISE_SCHEMA.exists():
        raise AppError("Missing generated CFB27 schema for structured franchise tables", 500)
    try:
        completed = subprocess.run(
            ["node", str(FRANCHISE_HELPER), *args],
            cwd=str(APP_DIR),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AppError("Node.js is required for structured Recruit/Player table editing", 500) from exc
    except subprocess.TimeoutExpired as exc:
        raise AppError("Structured franchise table operation timed out", 504) from exc

    payload = parse_helper_json(completed.stdout, completed.stderr)
    if completed.returncode != 0:
        raise AppError(payload.get("error") or "Franchise helper failed", 500)
    if "error" in payload:
        raise AppError(str(payload["error"]), 500)
    return payload


def list_recruits_from_payload(payload: bytes, limit: int = 1000, offset: int = 0) -> dict:
    with tempfile.TemporaryDirectory(prefix="cfb27-recruits-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        input_path = temp_dir / "input.frk"
        input_path.write_bytes(payload)
        result = run_franchise_helper(
            ["list", str(input_path), str(max(1, min(limit, 7600))), str(max(0, offset))],
        )
    return {
        **result,
        "columns": recruit_columns(),
        "notes": (
            "Structured Recruit + Player tables. Editable now: recruit ranks, first/last name, "
            "position, height in inches, weight in pounds, head asset, and verified EA ratings. "
            "Skin tone and hair hints are decoded from head asset names but stay read-only until "
            "the CharacterVisuals offsets are verified."
        ),
    }


def patch_recruit_payload(payload: bytes, row_id: str, changes: dict) -> tuple[bytes, dict]:
    if not isinstance(changes, dict) or not changes:
        raise AppError("No changes supplied")
    with tempfile.TemporaryDirectory(prefix="cfb27-recruit-patch-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        input_path = temp_dir / "input.frk"
        output_path = temp_dir / "output.frk"
        patch_path = temp_dir / "patch.json"
        input_path.write_bytes(payload)
        patch_path.write_text(
            json.dumps({"id": row_id, "changes": changes}),
            encoding="ascii",
        )
        result = run_franchise_helper(
            ["patch", str(input_path), str(patch_path), str(output_path)],
            timeout=120,
        )
        if not output_path.exists():
            raise AppError("Recruit patch did not produce an output payload", 500)
        return output_path.read_bytes(), result.get("player", {})


class SaveStore:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir.resolve()
        self._table_cache: dict[str, tuple[tuple[int, int, int], list[InferredTable], bytes]] = {}
        self._occurrence_cache: dict[str, tuple[tuple[int, int, str, str], dict]] = {}

    def editable_files(self) -> list[Path]:
        files = []
        for path in self.base_dir.iterdir():
            if not path.is_file():
                continue
            if path.parent != self.base_dir:
                continue
            try:
                with path.open("rb") as handle:
                    if handle.read(8) == MAGIC:
                        files.append(path)
            except OSError:
                continue
        return sorted(files, key=lambda item: item.name.lower())

    def validate_filename(self, name: str) -> Path:
        decoded = unquote(name)
        if not decoded or decoded in {".", ".."}:
            raise AppError("Invalid file name", 400)
        if "/" in decoded or "\\" in decoded or os.path.basename(decoded) != decoded:
            raise AppError("Nested paths are not allowed", 403)
        allowed = {path.name: path for path in self.editable_files()}
        if decoded not in allowed:
            raise AppError("File is not in the editable top-level save set", 403)
        return allowed[decoded]

    def describe_file(self, path: Path, include_player_count: bool = True) -> dict:
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest().upper()
        info = {
            "name": path.name,
            "size": len(data),
            "sha256": digest,
            "modified": path.stat().st_mtime,
            "type": "FBCHUNKS",
        }
        try:
            container = FBChunks.parse(data)
            info.update(
                {
                    "header_size": container.header_size,
                    "compressed_payload_size": container.payload_size,
                    "decompressed_payload_size": len(container.decompressed_payload),
                }
            )
            if include_player_count:
                records = parse_player_records(container.decompressed_payload)
                info["player_count"] = len(records)
        except AppError as exc:
            info["error"] = str(exc)
        return info

    def list_files(self) -> list[dict]:
        return [self.describe_file(path) for path in self.editable_files()]

    def load_container(self, name: str) -> tuple[Path, FBChunks]:
        path = self.validate_filename(name)
        return path, FBChunks.parse(path.read_bytes())

    def get_roster(self, name: str) -> dict:
        path, container = self.load_container(name)
        records = parse_player_records(container.decompressed_payload)
        return {
            "file": self.describe_file(path),
            "players": [record.to_dict(include_fields=False) for record in records],
            "knownFields": list(KNOWN_PLAYER_FIELDS),
        }

    def get_dynasty_players(self, name: str, limit: int = 1000, offset: int = 0) -> dict:
        path, container = self.load_container(name)
        records = sorted(
            find_dynasty_player_pool(container.decompressed_payload),
            key=lambda item: (
                item.fields["last_name"].lower(),
                item.fields["first_name"].lower(),
                item.offset,
            ),
        )
        start = max(0, offset)
        stop = min(len(records), start + max(1, min(limit, 5000)))
        return {
            "file": self.describe_file(path, include_player_count=False),
            "recordCount": len(records),
            "offset": start,
            "limit": limit,
            "players": [record.to_dict() for record in records[start:stop]],
            "columns": [
                {"key": "first_name", "label": "First", "writable": True, "maxLength": 16},
                {"key": "last_name", "label": "Last", "writable": True, "maxLength": 20},
                {"key": "hometown", "label": "Hometown", "writable": True, "maxLength": 25},
                {"key": "visual_id", "label": "Visual ID", "writable": True, "maxLength": 32},
                {"key": "slug", "label": "Slug / Player ID", "writable": False},
                {"key": "offset", "label": "Offset", "writable": False},
            ],
            "notes": (
                "Dynasty player/recruit string pool. Edits are fixed-width in-place string writes; "
                "binary traits such as position, height, weight, and skin tone remain read-only pending field mapping."
            ),
        }

    def get_recruits(self, name: str, limit: int = 1000, offset: int = 0) -> dict:
        path, container = self.load_container(name)
        result = list_recruits_from_payload(
            container.decompressed_payload,
            limit=limit,
            offset=offset,
        )
        return {
            "file": self.describe_file(path, include_player_count=False),
            **result,
        }

    def discover_tables(self, name: str | None = None, deep: bool = False) -> dict:
        paths = [self.validate_filename(name)] if name else self.editable_files()
        result = []
        for path in paths:
            try:
                container, tables = self.cached_tables(path, deep=deep)
                result.append(
                    {
                        "file": self.describe_file(path, include_player_count=False),
                        "tables": [
                            table.to_summary(container.decompressed_payload)
                            for table in tables
                        ],
                    }
                )
            except AppError as exc:
                result.append({"file": {"name": path.name}, "error": str(exc), "tables": []})
        return {"files": result}

    def cached_tables(self, path: Path, deep: bool = False) -> tuple[FBChunks, list[InferredTable]]:
        stat = path.stat()
        signature = (stat.st_size, int(stat.st_mtime_ns), 1 if deep else 0)
        cache_key = f"{path.name}:{'deep' if deep else 'quick'}"
        cached = self._table_cache.get(cache_key)
        if cached and cached[0] == signature:
            container = FBChunks.parse(path.read_bytes())
            return container, cached[1]
        container = FBChunks.parse(path.read_bytes())
        tables = discover_inferred_tables(path.name, container.decompressed_payload, deep=deep)
        self._table_cache[cache_key] = (signature, tables, b"")
        return container, tables

    def get_table(self, name: str, table_id: str, limit: int = 500, offset: int = 0) -> dict:
        path = self.validate_filename(name)
        container, tables = self.cached_tables(path)
        table = next((item for item in tables if item.table_id == table_id), None)
        if table is None:
            raise AppError("Inferred table was not found", 404)
        return read_inferred_table_rows(
            container.decompressed_payload,
            table,
            limit=limit,
            offset=offset,
        )

    def get_schema_entries(self, query: str = "", domain: str = "recruiting", limit: int = 300) -> dict:
        return schema_entries(query=query, domain=domain, limit=limit)

    def get_schema_occurrences(
        self,
        name: str,
        query: str = "",
        domain: str = "recruiting",
        limit: int = 300,
    ) -> dict:
        path, container = self.load_container(name)
        stat = path.stat()
        signature = (stat.st_size, int(stat.st_mtime_ns), query.lower(), domain.lower())
        cache_key = f"{path.name}:{query.lower()}:{domain.lower()}"
        cached = self._occurrence_cache.get(cache_key)
        if cached and cached[0] == signature:
            payload = dict(cached[1])
        else:
            payload = schema_occurrences(
                container.decompressed_payload,
                query=query,
                domain=domain,
                limit=1000,
            )
            payload["file"] = self.describe_file(path, include_player_count=False)
            self._occurrence_cache[cache_key] = (signature, payload)
        entries = payload.get("entries", [])
        return {
            **payload,
            "entries": entries[: max(1, min(limit, 1000))],
        }

    def patch_table_row(self, name: str, table_id: str, row_id: str, changes: dict) -> dict:
        if not isinstance(changes, dict) or not changes:
            raise AppError("No changes supplied")
        path = self.validate_filename(name)
        container, tables = self.cached_tables(path)
        table = next((item for item in tables if item.table_id == table_id), None)
        if table is None:
            raise AppError("Inferred table was not found", 404)
        if table.confidence == "low":
            raise AppError("Low-confidence inferred groups are read-only", 403)
        try:
            row_index = table.record_offsets.index(int(row_id))
        except ValueError as exc:
            raise AppError("Row was not found; reload the table and try again", 404) from exc
        fields = record_fields_for_table(container.decompressed_payload, table, row_index)
        column_fields: dict[str, TLVField] = {}
        duplicates: dict[str, int] = {}
        for field in fields:
            key = field.key_hex
            duplicates[key] = duplicates.get(key, 0) + 1
            column = key if duplicates[key] == 1 else f"{key}#{duplicates[key]}"
            column_fields[column] = field

        patched = bytearray(container.decompressed_payload)
        replacements: list[tuple[int, int, bytes]] = []
        for column, value in changes.items():
            field = column_fields.get(column)
            if field is None:
                raise AppError(f"Column {column} was not found on this row")
            if field.type_code != 1 or field.length_pos is None:
                raise AppError(f"Column {column} is not a string field and is read-only", 403)
            clean_value = validate_text_value(column, value)
            raw = clean_value.encode("ascii") + b"\x00"
            replacements.append((field.length_pos, field.value_end, bytes([len(raw)]) + raw))

        for start, end, replacement in sorted(replacements, reverse=True):
            patched[start:end] = replacement

        rebuilt = container.rebuild(bytes(patched))
        FBChunks.parse(rebuilt)
        backup = self.create_backup(name)
        path.write_bytes(rebuilt)
        for cache_key in list(self._table_cache):
            if cache_key.startswith(f"{path.name}:"):
                self._table_cache.pop(cache_key, None)
        return {
            "backup": backup,
            "file": self.describe_file(path, include_player_count=False),
            "table": self.get_table(name, table_id, limit=1, offset=row_index),
        }

    def get_player(self, name: str, row_id: str) -> dict:
        _, container = self.load_container(name)
        for record in parse_player_records(container.decompressed_payload):
            if record.row_id == row_id:
                return record.to_dict(include_fields=True)
        raise AppError("Player row was not found", 404)

    def create_backup(self, name: str) -> dict:
        path = self.validate_filename(name)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        dest_dir = BACKUP_DIR / timestamp
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / path.name
        shutil.copy2(path, dest)
        return {
            "file": path.name,
            "backup": str(dest),
            "size": dest.stat().st_size,
            "sha256": hashlib.sha256(dest.read_bytes()).hexdigest().upper(),
        }

    def patch_player(self, name: str, row_id: str, changes: dict) -> dict:
        path, container = self.load_container(name)
        new_payload, updated_player = patch_player_payload(
            container.decompressed_payload,
            row_id=row_id,
            changes=changes,
        )
        rebuilt = container.rebuild(new_payload)
        FBChunks.parse(rebuilt)
        backup = self.create_backup(name)
        path.write_bytes(rebuilt)
        return {
            "backup": backup,
            "file": self.describe_file(path),
            "player": updated_player,
        }

    def patch_dynasty_player(self, name: str, row_id: str, changes: dict) -> dict:
        path, container = self.load_container(name)
        new_payload, updated_player = patch_dynasty_player_payload(
            container.decompressed_payload,
            row_id=row_id,
            changes=changes,
        )
        rebuilt = container.rebuild(new_payload)
        FBChunks.parse(rebuilt)
        backup = self.create_backup(name)
        path.write_bytes(rebuilt)
        for cache_key in list(self._table_cache):
            if cache_key.startswith(f"{path.name}:"):
                self._table_cache.pop(cache_key, None)
        for cache_key in list(self._occurrence_cache):
            if cache_key.startswith(f"{path.name}:"):
                self._occurrence_cache.pop(cache_key, None)
        return {
            "backup": backup,
            "file": self.describe_file(path, include_player_count=False),
            "player": updated_player,
        }

    def patch_recruit(self, name: str, row_id: str, changes: dict) -> dict:
        path, container = self.load_container(name)
        new_payload, updated_player = patch_recruit_payload(
            container.decompressed_payload,
            row_id=row_id,
            changes=changes,
        )
        rebuilt = container.rebuild(new_payload)
        FBChunks.parse(rebuilt)
        backup = self.create_backup(name)
        path.write_bytes(rebuilt)
        for cache_key in list(self._table_cache):
            if cache_key.startswith(f"{path.name}:"):
                self._table_cache.pop(cache_key, None)
        for cache_key in list(self._occurrence_cache):
            if cache_key.startswith(f"{path.name}:"):
                self._occurrence_cache.pop(cache_key, None)
        return {
            "backup": backup,
            "file": self.describe_file(path, include_player_count=False),
            "player": updated_player,
        }


STORE = SaveStore(SAVE_DIR)


class Handler(BaseHTTPRequestHandler):
    server_version = "CFB27SaveEditor/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise AppError(f"Invalid JSON body: {exc}") from exc
        if not isinstance(parsed, dict):
            raise AppError("JSON body must be an object")
        return parsed

    def handle_error(self, exc: Exception) -> None:
        if isinstance(exc, AppError):
            self.send_json(exc.status, {"error": str(exc)})
            return
        traceback.print_exc()
        self.send_json(500, {"error": "Internal server error"})

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            query_params = parse_qs(parsed.query)
            if self.path == "/" or self.path == "/index.html":
                self.serve_static("index.html")
                return
            if self.path.startswith("/static/"):
                self.serve_static(self.path.removeprefix("/static/"))
                return
            if self.path == "/api/files":
                self.send_json(200, {"files": STORE.list_files()})
                return
            if self.path == "/api/tables" or self.path.startswith("/api/tables?"):
                self.send_json(200, STORE.discover_tables(deep="deep=1" in self.path))
                return
            if parsed.path == "/api/schema":
                query = query_params.get("query", [""])[0]
                domain = query_params.get("domain", ["recruiting"])[0]
                limit = int(query_params.get("limit", ["300"])[0])
                self.send_json(200, STORE.get_schema_entries(query=query, domain=domain, limit=limit))
                return
            if parsed.path == "/api/schema/occurrences":
                file_name = query_params.get("file", [""])[0]
                query = query_params.get("query", [""])[0]
                domain = query_params.get("domain", ["recruiting"])[0]
                limit = int(query_params.get("limit", ["300"])[0])
                if not file_name:
                    raise AppError("file query parameter is required")
                self.send_json(
                    200,
                    STORE.get_schema_occurrences(
                        file_name,
                        query=query,
                        domain=domain,
                        limit=limit,
                    ),
                )
                return
            if self.path.startswith("/api/roster/"):
                parts = self.path.split("/")
                if len(parts) == 4:
                    self.send_json(200, STORE.get_roster(parts[3]))
                    return
                if len(parts) == 6 and parts[4] == "players":
                    self.send_json(200, STORE.get_player(parts[3], parts[5]))
                    return
            if parsed.path.startswith("/api/recruits/"):
                parts = parsed.path.split("/")
                if len(parts) == 4:
                    limit = int(query_params.get("limit", ["1000"])[0])
                    offset = int(query_params.get("offset", ["0"])[0])
                    self.send_json(200, STORE.get_recruits(parts[3], limit=limit, offset=offset))
                    return
            if parsed.path.startswith("/api/dynasty-players/"):
                parts = parsed.path.split("/")
                if len(parts) == 4:
                    limit = int(query_params.get("limit", ["1000"])[0])
                    offset = int(query_params.get("offset", ["0"])[0])
                    self.send_json(200, STORE.get_dynasty_players(parts[3], limit=limit, offset=offset))
                    return
            if self.path.startswith("/api/table/"):
                path_only, _, query = self.path.partition("?")
                parts = path_only.split("/")
                if len(parts) == 5:
                    params = {}
                    for chunk in query.split("&"):
                        if "=" in chunk:
                            key, value = chunk.split("=", 1)
                            params[key] = value
                    limit = int(params.get("limit", "500"))
                    offset = int(params.get("offset", "0"))
                    self.send_json(200, STORE.get_table(parts[3], parts[4], limit=limit, offset=offset))
                    return
            raise AppError("Not found", 404)
        except Exception as exc:
            self.handle_error(exc)

    def do_POST(self) -> None:
        try:
            if self.path.startswith("/api/backup/"):
                parts = self.path.split("/")
                if len(parts) == 4:
                    self.send_json(200, STORE.create_backup(parts[3]))
                    return
            raise AppError("Not found", 404)
        except Exception as exc:
            self.handle_error(exc)

    def do_PATCH(self) -> None:
        try:
            if self.path.startswith("/api/roster/"):
                parts = self.path.split("/")
                if len(parts) == 6 and parts[4] == "players":
                    body = self.read_json_body()
                    changes = body.get("changes", body)
                    self.send_json(200, STORE.patch_player(parts[3], parts[5], changes))
                    return
            if self.path.startswith("/api/table/"):
                parts = self.path.split("/")
                if len(parts) == 7 and parts[5] == "rows":
                    body = self.read_json_body()
                    changes = body.get("changes", body)
                    self.send_json(200, STORE.patch_table_row(parts[3], parts[4], parts[6], changes))
                    return
            if self.path.startswith("/api/dynasty-players/"):
                parts = self.path.split("/")
                if len(parts) == 6 and parts[4] == "players":
                    body = self.read_json_body()
                    changes = body.get("changes", body)
                    self.send_json(200, STORE.patch_dynasty_player(parts[3], parts[5], changes))
                    return
            if self.path.startswith("/api/recruits/"):
                parts = self.path.split("/")
                if len(parts) == 6 and parts[4] == "players":
                    body = self.read_json_body()
                    changes = body.get("changes", body)
                    self.send_json(200, STORE.patch_recruit(parts[3], parts[5], changes))
                    return
            raise AppError("Not found", 404)
        except Exception as exc:
            self.handle_error(exc)

    def serve_static(self, relative: str) -> None:
        target = (STATIC_DIR / relative).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError as exc:
            raise AppError("Static path is not allowed", 403) from exc
        if not target.is_file():
            raise AppError("Static file not found", 404)
        body = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local EA Sports College Football 27 save editor")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args(argv)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Serving CFB27 Save Editor at http://{args.host}:{args.port}")
    print(f"Save directory: {SAVE_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
