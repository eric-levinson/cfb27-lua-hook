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
from collections.abc import Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from live_process import discover_live_player_objects, live_status, write_live_player_rating
from live_dynasty import (
    dynasty_unlock_monitor_status,
    player_rating_patch,
    start_dynasty_unlock_monitor,
    unlock_dynasty_player_editing,
)
from native_hook import (
    attach_hook, attach_response_guard, hook_command, hook_status, list_lua_scripts,
    eval_startup_lua, patch_record_at, queue_response_rating, response_guard_status, run_lua_script,
    startup_lua_status,
)


APP_DIR = Path(__file__).resolve().parent
SAVE_DIR_ENV = "CFB27_SAVE_DIR"
STATIC_DIR = APP_DIR / "static"
BACKUP_DIR = APP_DIR / "backups"
SIDECAR_DIR = APP_DIR / "sidecars"
REPORT_DIR = APP_DIR / "reports"
HOME_DOGS_REPORT_DIR = REPORT_DIR / "home-dogs"
SCHEMA_DIR = APP_DIR / "schema"
RECRUITING_SCHEMA_INDEX = SCHEMA_DIR / "recruiting_schema_index.json"
FRANCHISE_HELPER = APP_DIR / "franchise_helper.js"
MADDEN_FRANCHISE_SCHEMA = SCHEMA_DIR / "CFB27_schema_for_madden_franchise.gz"
HOME_DOGS_REPO_ENVS = ("CFB27_HOME_DOGS_REPO", "HOME_DOGS_REPO")

MAGIC = b"FBCHUNKS"

PLAYER_INTERNAL_KEY = bytes.fromhex("c25c33")
PLAYER_FIRST_KEY = bytes.fromhex("c26ba1")
PLAYER_LAST_KEY = bytes.fromhex("c2cba1")
PLAYER_HOMETOWN_KEY = bytes.fromhex("c28d2e")


def read_dotenv_values(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def resolve_save_dir(env: Mapping[str, str] | None = None, dotenv_path: Path | None = None) -> Path:
    source = os.environ if env is None else env
    override = source.get(SAVE_DIR_ENV, "").strip()
    if not override and env is None:
        override = read_dotenv_values(dotenv_path or (APP_DIR / ".env")).get(SAVE_DIR_ENV, "").strip()
    if override:
        expanded = os.path.expandvars(os.path.expanduser(override))
        return Path(expanded).resolve()
    return APP_DIR.parent.resolve()


SAVE_DIR = resolve_save_dir()


def atomic_write_bytes(path: Path, data: bytes) -> None:
    timestamp = time.strftime("%Y%m%d%H%M%S")
    tmp = path.with_name(f".{path.name}.{timestamp}.{os.getpid()}.tmp")
    try:
        with tmp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def compress_franchise_database(payload: bytes) -> tuple[bytes, str]:
    try:
        import deflate  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        compressed = zlib.compress(payload, level=9)
        return compressed, "zlib"

    compressed = deflate.zlib_compress(payload, 12)
    if zlib.decompress(compressed) != payload:
        raise AppError("libdeflate round-trip verification failed", 500)
    return compressed, "libdeflate"

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

ABILITY_RANK_OPTIONS = ["None", "Bronze", "Silver", "Gold", "Platinum"]

DEVELOPMENT_TRAIT_OPTIONS = [
    {"value": "Normal", "label": "Normal"},
    {"value": "College_Impact", "label": "Impact"},
    {"value": "College_Star", "label": "Star"},
    {"value": "College_Elite", "label": "Elite"},
]

MENTAL_ABILITY_OPTIONS = [
    {"value": "None", "label": "None"},
    {"value": "RoadFanFavorite", "label": "Road Dog"},
    {"value": "Toughness", "label": "Toughness"},
    {"value": "FieldGeneral", "label": "Field General"},
    {"value": "ClutchKicker", "label": "Clutch Kicker"},
    {"value": "Captain", "label": "Captain"},
    {"value": "TeamPlayer", "label": "Team Player"},
    {"value": "ClearHeaded", "label": "Clear Headed"},
    {"value": "Headstrong", "label": "Headstrong"},
    {"value": "Adrenaline", "label": "Adrenaline"},
    {"value": "HomeFanFavorite", "label": "Home Field Advantage"},
    {"value": "WinningTime", "label": "Winning Time"},
    {"value": "TheNatural", "label": "The Natural"},
    {"value": "Rhythm", "label": "Rhythm"},
    {"value": "BestFriend", "label": "Best Friend"},
    {"value": "OLRally", "label": "O-Line Rally"},
    {"value": "DLRally", "label": "D-Line Rally"},
    {"value": "DBRally", "label": "Legion"},
    {"value": "BellCow", "label": "Bell Cow"},
    {"value": "HotHead", "label": "Hot Head"},
]

DEALBREAKER_OPTIONS = [
    {"value": "AcademicPrestige", "label": "Academic Prestige"},
    {"value": "AthleticFacilities", "label": "Athletic Facilities"},
    {"value": "BrandExposure", "label": "Brand Exposure"},
    {"value": "CampusLifestyle", "label": "Campus Lifestyle"},
    {"value": "ChampionshipContender", "label": "Championship Contender"},
    {"value": "CoachPrestige", "label": "Coach Prestige"},
    {"value": "CoachStability", "label": "Coach Stability"},
    {"value": "ConferencePrestige", "label": "Conference Prestige"},
    {"value": "PlayingStyle", "label": "Playing Style"},
    {"value": "PlayingTime", "label": "Playing Time"},
    {"value": "ProPotential", "label": "Pro Potential"},
    {"value": "ProgramTradition", "label": "Program Tradition"},
    {"value": "ProximityToHome", "label": "Proximity To Home"},
    {"value": "StadiumAtmosphere", "label": "Stadium Atmosphere"},
    {"value": "Invalid", "label": "Invalid"},
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

RECRUIT_RATING_SCHEMA_FIELDS = {
    "overall": "OverallRating",
    "speed": "SpeedRating",
    "acceleration": "AccelerationRating",
    "strength": "StrengthRating",
    "agility": "AgilityRating",
    "awareness": "AwarenessRating",
    "jumping": "JumpingRating",
    "injury": "InjuryRating",
    "stamina": "StaminaRating",
    "toughness": "ToughnessRating",
    "carrying": "CarryingRating",
    "break_tackle": "BreakTackleRating",
    "trucking": "TruckingRating",
    "change_of_direction": "ChangeOfDirectionRating",
    "bc_vision": "BCVisionRating",
    "stiff_arm": "StiffArmRating",
    "spin_move": "SpinMoveRating",
    "juke_move": "JukeMoveRating",
    "break_sack": "BreakSackRating",
    "run_block": "RunBlockRating",
    "pass_block": "PassBlockRating",
    "impact_blocking": "ImpactBlockingRating",
    "run_block_power": "RunBlockPowerRating",
    "run_block_finesse": "RunBlockFinesseRating",
    "pass_block_power": "PassBlockPowerRating",
    "pass_block_finesse": "PassBlockFinesseRating",
    "lead_block": "LeadBlockRating",
    "throw_power": "ThrowPowerRating",
    "throw_under_pressure": "ThrowUnderPressureRating",
    "throw_accuracy_short": "ThrowAccuracyShortRating",
    "throw_accuracy_mid": "ThrowAccuracyMidRating",
    "throw_accuracy_deep": "ThrowAccuracyDeepRating",
    "throw_on_the_run": "ThrowOnTheRunRating",
    "play_action": "PlayActionRating",
    "tackle": "TackleRating",
    "power_moves": "PowerMovesRating",
    "finesse_moves": "FinesseMovesRating",
    "block_shedding": "BlockSheddingRating",
    "pursuit": "PursuitRating",
    "play_recognition": "PlayRecognitionRating",
    "man_coverage": "ManCoverageRating",
    "zone_coverage": "ZoneCoverageRating",
    "hit_power": "HitPowerRating",
    "press": "PressRating",
    "catching": "CatchingRating",
    "spectacular_catch": "SpectacularCatchRating",
    "catch_in_traffic": "CatchInTrafficRating",
    "short_route_running": "ShortRouteRunningRating",
    "medium_route_running": "MediumRouteRunningRating",
    "deep_route_running": "DeepRouteRunningRating",
    "kick_power": "KickPowerRating",
    "kick_accuracy": "KickAccuracyRating",
    "kick_return": "KickReturnRating",
}

FIELD_CAPABILITY_STATUSES = {
    "writable",
    "manual-writable",
    "research",
    "preserve",
    "unsafe",
}

GENERATOR_STATE_BY_STATUS = {
    "writable": "writable",
    "manual-writable": "preview-only",
    "research": "skipped because unverified",
    "preserve": "skipped because unverified",
    "unsafe": "blocked because unsafe",
}

BASE_FIELD_CAPABILITIES = [
    {
        "field": "Recruit.NationalRank",
        "owner": "Recruit",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Already covered by structured recruit patch read-back tests.",
    },
    {
        "field": "Recruit.PositionRank",
        "owner": "Recruit",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Already covered by structured recruit patching.",
    },
    {
        "field": "Recruit.StateRank",
        "owner": "Recruit",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Writable as an existing rank field; home-state generation still requires RG-8.",
    },
    {
        "field": "Player.FirstName",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Structured Player string field with read-back coverage.",
    },
    {
        "field": "Player.LastName",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Structured Player string field with read-back coverage.",
    },
    {
        "field": "Player.Position",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Validated against known position enum values.",
    },
    {
        "field": "Player.TraitDevelopment",
        "owner": "Player",
        "status": "manual-writable",
        "gate": "RG-2/RG-GameLoad",
        "manualWritable": True,
        "safeToWrite": False,
        "notes": "Read-back validated, but generator writes are held until disposable dynasty copies load in game.",
    },
    {
        "field": "Player.RecruitingDealbreaker",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Patch preserves raw bits after the first 4 motivation bits.",
    },
    {
        "field": "Player.JerseyNum",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Numeric range is validated before write.",
    },
    {
        "field": "Player.Height",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Stored and displayed in inches.",
    },
    {
        "field": "Player.Weight",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-2",
        "manualWritable": True,
        "notes": "Storage is pounds minus 160; conversion is centralized in the patch helper.",
    },
    {
        "field": "Player.ProspectStarRating",
        "owner": "Player",
        "status": "writable",
        "gate": "RG-3",
        "manualWritable": True,
        "notes": "Rank-band enum writes are enabled for controlled game-load validation.",
    },
    {
        "field": "Player.PlayerType",
        "owner": "Player",
        "status": "research",
        "gate": "RG-4",
        "notes": "Displayed read-only until position-valid archetype map is verified.",
    },
    {
        "field": "Player.CharacterBodyType",
        "owner": "Player",
        "status": "research",
        "gate": "RG-5",
        "notes": "Labels must be mapped to visual presets before generation.",
    },
    {
        "field": "Recruit.QualityModifier",
        "owner": "Recruit",
        "status": "research",
        "gate": "RG-6",
        "notes": "Gem/bust/hidden behavior must be decoded before writes.",
    },
    {
        "field": "Player.GenericHeadAssetName",
        "owner": "Player",
        "status": "research",
        "gate": "RG-7",
        "manualWritable": True,
        "notes": "Manual editor can write the observed token, but generator must wait for paired appearance-token rules.",
    },
    {
        "field": "Player.PLYR_PORTRAIT",
        "owner": "Player",
        "status": "research",
        "gate": "RG-7",
        "notes": "Must be paired with GenericHeadAssetName before generation.",
    },
    {
        "field": "Player.PLYR_GENERICHEAD",
        "owner": "Player",
        "status": "research",
        "gate": "RG-7",
        "notes": "Observed related head token; preserve until appearance-token ownership is decoded.",
    },
    {
        "field": "Player.HomeState",
        "owner": "Player",
        "status": "research",
        "gate": "RG-8",
        "notes": "Candidate ownership for state-rank generation; exact field must be proven from schema and saves.",
    },
    {
        "field": "Recruit.ProductionGrade",
        "owner": "Recruit",
        "status": "preserve",
        "gate": "RG-11",
        "notes": "Recruiting presentation value; preserve until correlation and write tests exist.",
    },
    {
        "field": "CharacterVisuals.RawData",
        "owner": "Player",
        "status": "preserve",
        "gate": "RG-7",
        "notes": "Raw visuals blob remains read-only until direct offsets are decoded.",
    },
]

for index in range(1, 7):
    BASE_FIELD_CAPABILITIES.append(
        {
            "field": f"Player.SkillGroupCap{index}",
            "owner": "Player",
            "status": "preserve",
            "gate": "RG-9",
            "notes": "Skill cap slots are preserved until slot mapping and value direction are confirmed.",
        }
    )

for index in range(1, 6):
    BASE_FIELD_CAPABILITIES.append(
        {
            "field": f"Player.PhysicalAbility{index}",
            "owner": "Player",
            "status": "preserve",
            "gate": "RG-10",
            "manualWritable": index <= 5,
            "notes": "Manual editor writes rank slots only; generator ability identity/tier writes wait for RG-10.",
        }
    )

for index in range(1, 4):
    BASE_FIELD_CAPABILITIES.extend(
        [
            {
                "field": f"Player.MentalAbility{index}",
                "owner": "Player",
                "status": "preserve",
                "gate": "RG-10",
                "manualWritable": True,
                "notes": "Manual editor behavior exists; generator ability ecosystem writes wait for RG-10.",
            },
            {
                "field": f"Player.MentalAbilityRank{index}",
                "owner": "Player",
                "status": "preserve",
                "gate": "RG-10",
                "manualWritable": True,
                "notes": "Manual editor behavior exists; generator ability ecosystem writes wait for RG-10.",
            },
        ]
    )

RECRUIT_PATCH_FIELD_CAPABILITY_MAP = {
    "national_rank": "Recruit.NationalRank",
    "position_rank": "Recruit.PositionRank",
    "state_rank": "Recruit.StateRank",
    "first_name": "Player.FirstName",
    "last_name": "Player.LastName",
    "position": "Player.Position",
    "dev_trait": "Player.TraitDevelopment",
    "dealbreaker": "Player.RecruitingDealbreaker",
    "jersey_number": "Player.JerseyNum",
    "height_inches": "Player.Height",
    "weight_lbs": "Player.Weight",
    "prospect_star_rating": "Player.ProspectStarRating",
    "star_rating": "Player.ProspectStarRating",
    "player_type": "Player.PlayerType",
    "character_body_type": "Player.CharacterBodyType",
    "quality_modifier": "Recruit.QualityModifier",
    "home_state": "Player.HomeState",
    "generic_head_asset_name": "Player.GenericHeadAssetName",
    "mental_ability_1": "Player.MentalAbility1",
    "mental_ability_2": "Player.MentalAbility2",
    "mental_ability_3": "Player.MentalAbility3",
    "mental_rank_1": "Player.MentalAbilityRank1",
    "mental_rank_2": "Player.MentalAbilityRank2",
    "mental_rank_3": "Player.MentalAbilityRank3",
    "physical_rank_1": "Player.PhysicalAbility1",
    "physical_rank_2": "Player.PhysicalAbility2",
    "physical_rank_3": "Player.PhysicalAbility3",
    "physical_rank_4": "Player.PhysicalAbility4",
    "physical_rank_5": "Player.PhysicalAbility5",
    **{
        key: f"Player.{schema_field}"
        for key, schema_field in RECRUIT_RATING_SCHEMA_FIELDS.items()
    },
}


def normalize_field_capability(item: dict) -> dict:
    status = item.get("status", "research")
    if status not in FIELD_CAPABILITY_STATUSES:
        raise AppError(f"Invalid field capability status: {status}", 500)
    safe_to_write = bool(item.get("safeToWrite", status == "writable"))
    normalized = {
        "field": item["field"],
        "owner": item.get("owner", item["field"].split(".", 1)[0]),
        "status": status,
        "generatorState": GENERATOR_STATE_BY_STATUS[status],
        "safeToWrite": safe_to_write,
    }
    for key in ("gate", "manualWritable", "notes"):
        if key in item:
            normalized[key] = item[key]
    return normalized


def field_capabilities() -> dict:
    fields = [normalize_field_capability(item) for item in BASE_FIELD_CAPABILITIES]
    for key, _, label, _, _, _ in RECRUIT_RATING_COLUMNS:
        schema_field = RECRUIT_RATING_SCHEMA_FIELDS[key]
        fields.append(
            normalize_field_capability(
                {
                    "field": f"Player.{schema_field}",
                    "owner": "Player",
                    "status": "writable",
                    "gate": "RG-2",
                    "manualWritable": True,
                    "notes": f"Verified rating field exposed as {label}.",
                }
            )
        )
    return {
        "fields": fields,
        "statuses": sorted(FIELD_CAPABILITY_STATUSES),
        "generatorStates": sorted(set(GENERATOR_STATE_BY_STATUS.values())),
    }


def validate_recruit_patch_capabilities(changes: dict, mode: str = "manual") -> None:
    if mode not in {"manual", "generator"}:
        raise AppError(f"Unsupported recruit patch mode: {mode}", 400)
    if mode != "generator":
        return
    capability_by_field = {item["field"]: item for item in field_capabilities()["fields"]}
    blocked: list[str] = []
    unknown: list[str] = []
    for key in changes:
        field = RECRUIT_PATCH_FIELD_CAPABILITY_MAP.get(key)
        if not field:
            unknown.append(key)
            continue
        capability = capability_by_field.get(field)
        if not capability or not capability["safeToWrite"]:
            blocked.append(f"{key} ({field})")
    if unknown:
        raise AppError(f"Unsupported generator fields: {', '.join(sorted(unknown))}", 403)
    if blocked:
        raise AppError(
            "Generator cannot write research-gated fields: "
            + ", ".join(sorted(blocked)),
            403,
        )


CONFIG_VERSION = 1
STABLE_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
STAR_CUTOFF_KEYS = {"FIVE_STAR", "FOUR_STAR", "THREE_STAR", "TWO_STAR", "ONE_STAR"}
DEVELOPMENT_TRAIT_KEYS = {item["value"] for item in DEVELOPMENT_TRAIT_OPTIONS}
QUALITY_MODIFIER_KEYS = {"Gem", "Bust"}

DEFAULT_POSITION_WEIGHTS = {
    "QB": 0.06,
    "HB": 0.09,
    "FB": 0.01,
    "WR": 0.14,
    "TE": 0.06,
    "LT": 0.045,
    "LG": 0.04,
    "C": 0.035,
    "RG": 0.04,
    "RT": 0.045,
    "LE": 0.045,
    "RE": 0.045,
    "DT": 0.075,
    "LOLB": 0.04,
    "MLB": 0.045,
    "ROLB": 0.04,
    "CB": 0.11,
    "FS": 0.04,
    "SS": 0.04,
    "K": 0.015,
    "P": 0.01,
}

POSITION_ARCHETYPE_PREFIXES = {
    "QB": ("QB_",),
    "HB": ("HB_",),
    "FB": ("FB_",),
    "WR": ("WR_",),
    "TE": ("TE_",),
    "LT": ("OL_",),
    "LG": ("OL_",),
    "C": ("OL_",),
    "RG": ("OL_",),
    "RT": ("OL_",),
    "LE": ("DL_", "EDGE_"),
    "RE": ("DL_", "EDGE_"),
    "DT": ("DL_",),
    "LOLB": ("LB_", "EDGE_"),
    "MLB": ("LB_",),
    "ROLB": ("LB_", "EDGE_"),
    "CB": ("CB_",),
    "FS": ("S_",),
    "SS": ("S_",),
    "K": ("K_",),
    "P": ("P_",),
    "LS": ("OL_",),
    "KR": ("WR_", "HB_", "CB_"),
    "PR": ("WR_", "HB_", "CB_"),
}

DEFAULT_GENERATOR_CONFIG = {
    "configVersion": CONFIG_VERSION,
    "id": "manifesto-realistic-v1",
    "name": "Manifesto Realistic V1",
    "game": "CFB27",
    "generator": {
        "mode": "reroll-existing-recruits",
        "writePolicy": "verified-fields-only",
    },
    "classBudget": {
        "useExistingRecruitCount": True,
        "fiveStarCount": 32,
        "fourStarCount": 368,
        "generationalFreshmanCount": {"min": 0, "max": 2},
        "eliteDevelopmentCount": {"min": 5, "max": 12},
        "platinumPhysicalAbilityCount": {"min": 0, "max": 3},
        "classStrengthModifier": {"min": -1.0, "max": 1.0},
        "positionWeights": DEFAULT_POSITION_WEIGHTS,
    },
    "rankBands": [
        {
            "id": "rank-1-5",
            "minRank": 1,
            "maxRank": 5,
            "expectedOverall": {"min": 85, "max": 87},
            "typicalOverall": {"min": 83, "max": 88},
            "rareMaxOverall": 90,
        },
        {
            "id": "rank-6-32",
            "minRank": 6,
            "maxRank": 32,
            "expectedOverall": {"min": 81, "max": 85},
            "typicalOverall": {"min": 79, "max": 86},
            "rareMaxOverall": 88,
        },
        {
            "id": "rank-33-100",
            "minRank": 33,
            "maxRank": 100,
            "expectedOverall": {"min": 77, "max": 82},
            "typicalOverall": {"min": 75, "max": 84},
            "rareMaxOverall": 86,
        },
        {
            "id": "rank-101-400",
            "minRank": 101,
            "maxRank": 400,
            "expectedOverall": {"min": 73, "max": 79},
            "typicalOverall": {"min": 70, "max": 82},
            "rareMaxOverall": 84,
        },
        {
            "id": "rank-401-1500",
            "minRank": 401,
            "maxRank": 1500,
            "expectedOverall": {"min": 66, "max": 74},
            "typicalOverall": {"min": 62, "max": 78},
            "rareMaxOverall": 81,
        },
        {
            "id": "rank-1501-3000",
            "minRank": 1501,
            "maxRank": 3000,
            "expectedOverall": {"min": 58, "max": 68},
            "typicalOverall": {"min": 54, "max": 72},
            "rareMaxOverall": 76,
        },
        {
            "id": "rank-3001-plus",
            "minRank": 3001,
            "maxRank": None,
            "expectedOverall": {"min": 52, "max": 62},
            "typicalOverall": {"min": 48, "max": 67},
            "rareMaxOverall": 72,
        },
    ],
    "starCutoffs": {
        "FIVE_STAR": {"minRank": 1, "maxRank": 32},
        "FOUR_STAR": {"minRank": 33, "maxRank": 400},
        "THREE_STAR": {"minRank": 401, "maxRank": 1500},
        "TWO_STAR": {"minRank": 1501, "maxRank": 3000},
        "ONE_STAR": {"minRank": 3001, "maxRank": None},
    },
    "profileTypes": {
        "CompleteProdigy": {
            "rankBandWeights": {
                "rank-1-5": 0.28,
                "rank-6-32": 0.12,
                "rank-33-100": 0.04,
            },
            "readiness": {"min": 0.82, "max": 0.98},
            "physical": {"min": 0.75, "max": 0.96},
            "technical": {"min": 0.78, "max": 0.96},
            "mental": {"min": 0.72, "max": 0.95},
            "ceiling": {"min": 0.72, "max": 0.9},
        },
        "BlueChipBalanced": {
            "rankBandWeights": {
                "rank-1-5": 0.35,
                "rank-6-32": 0.42,
                "rank-33-100": 0.34,
                "rank-101-400": 0.18,
            },
            "readiness": {"min": 0.7, "max": 0.88},
            "physical": {"min": 0.66, "max": 0.9},
            "technical": {"min": 0.64, "max": 0.88},
            "mental": {"min": 0.58, "max": 0.86},
            "ceiling": {"min": 0.66, "max": 0.88},
        },
        "RarePhysicalFreak": {
            "rankBandWeights": {
                "rank-1-5": 0.18,
                "rank-6-32": 0.2,
                "rank-33-100": 0.18,
                "rank-101-400": 0.12,
                "rank-401-1500": 0.04,
            },
            "readiness": {"min": 0.55, "max": 0.82},
            "physical": {"min": 0.86, "max": 0.99},
            "technical": {"min": 0.45, "max": 0.74},
            "mental": {"min": 0.44, "max": 0.72},
            "ceiling": {"min": 0.74, "max": 0.94},
        },
        "PolishedTechnician": {
            "rankBandWeights": {
                "rank-6-32": 0.12,
                "rank-33-100": 0.22,
                "rank-101-400": 0.26,
                "rank-401-1500": 0.2,
            },
            "readiness": {"min": 0.66, "max": 0.88},
            "physical": {"min": 0.5, "max": 0.78},
            "technical": {"min": 0.75, "max": 0.94},
            "mental": {"min": 0.68, "max": 0.92},
            "ceiling": {"min": 0.52, "max": 0.78},
        },
        "Developmental": {
            "rankBandWeights": {
                "rank-101-400": 0.44,
                "rank-401-1500": 0.76,
                "rank-1501-3000": 0.84,
                "rank-3001-plus": 1.0,
            },
            "readiness": {"min": 0.35, "max": 0.68},
            "physical": {"min": 0.38, "max": 0.8},
            "technical": {"min": 0.32, "max": 0.7},
            "mental": {"min": 0.34, "max": 0.74},
            "ceiling": {"min": 0.42, "max": 0.82},
        },
    },
    "positionProfiles": {
        "QB": {"archetypeWeights": {"QB_FieldGeneral": 0.72, "QB_Scrambler": 0.28}, "bodyRule": "QB"},
        "HB": {"archetypeWeights": {"HB_ElusiveBack": 0.45, "HB_PowerBack": 0.35, "HB_ReceivingBack": 0.2}, "bodyRule": "HB"},
        "FB": {"archetypeWeights": {"FB_Blocking": 0.64, "FB_Power": 0.36}, "bodyRule": "FB"},
        "WR": {"archetypeWeights": {"WR_DeepThreat": 0.34, "WR_Playmaker": 0.28, "WR_Physical": 0.24, "WR_Slot": 0.14}, "bodyRule": "WR"},
        "TE": {"archetypeWeights": {"TE_Possession": 0.45, "TE_VerticalThreat": 0.34, "TE_Blocking": 0.21}, "bodyRule": "TE"},
        "LT": {"archetypeWeights": {"OL_PassProtector": 0.58, "OL_RunBlocker": 0.42}, "bodyRule": "OL"},
        "LG": {"archetypeWeights": {"OL_RunBlocker": 0.58, "OL_PassProtector": 0.42}, "bodyRule": "OL"},
        "C": {"archetypeWeights": {"OL_RunBlocker": 0.52, "OL_PassProtector": 0.48}, "bodyRule": "OL"},
        "RG": {"archetypeWeights": {"OL_RunBlocker": 0.58, "OL_PassProtector": 0.42}, "bodyRule": "OL"},
        "RT": {"archetypeWeights": {"OL_PassProtector": 0.54, "OL_RunBlocker": 0.46}, "bodyRule": "OL"},
        "LE": {"archetypeWeights": {"EDGE_SpeedRusher": 0.42, "EDGE_PowerRusher": 0.36, "DL_RunStopper": 0.22}, "bodyRule": "DL"},
        "RE": {"archetypeWeights": {"EDGE_SpeedRusher": 0.42, "EDGE_PowerRusher": 0.36, "DL_RunStopper": 0.22}, "bodyRule": "DL"},
        "DT": {"archetypeWeights": {"DL_RunStopper": 0.56, "DL_PowerRusher": 0.44}, "bodyRule": "DL"},
        "LOLB": {"archetypeWeights": {"LB_RunStopper": 0.36, "LB_Coverage": 0.32, "EDGE_SpeedRusher": 0.32}, "bodyRule": "LB"},
        "MLB": {"archetypeWeights": {"LB_FieldGeneral": 0.44, "LB_RunStopper": 0.36, "LB_Coverage": 0.2}, "bodyRule": "LB"},
        "ROLB": {"archetypeWeights": {"LB_RunStopper": 0.36, "LB_Coverage": 0.32, "EDGE_SpeedRusher": 0.32}, "bodyRule": "LB"},
        "CB": {"archetypeWeights": {"CB_MantoMan": 0.55, "CB_Zone": 0.45}, "bodyRule": "CB"},
        "FS": {"archetypeWeights": {"S_Zone": 0.6, "S_Hybrid": 0.4}, "bodyRule": "S"},
        "SS": {"archetypeWeights": {"S_RunSupport": 0.5, "S_Hybrid": 0.3, "S_Zone": 0.2}, "bodyRule": "S"},
        "K": {"archetypeWeights": {"K_PlaceKicker": 1.0}, "bodyRule": "K"},
        "P": {"archetypeWeights": {"P_Punter": 1.0}, "bodyRule": "P"},
    },
    "archetypeProfiles": {
        "QB_FieldGeneral": {"primaryRatings": ["throw_power", "throw_accuracy_short", "throw_accuracy_mid", "awareness"]},
        "QB_Scrambler": {"primaryRatings": ["throw_on_the_run", "speed", "throw_power", "break_sack"]},
        "HB_ElusiveBack": {"primaryRatings": ["speed", "acceleration", "change_of_direction", "juke_move"]},
        "HB_PowerBack": {"primaryRatings": ["strength", "carrying", "break_tackle", "trucking"]},
        "HB_ReceivingBack": {"primaryRatings": ["speed", "catching", "short_route_running", "carrying"]},
        "FB_Blocking": {"primaryRatings": ["lead_block", "impact_blocking", "strength", "run_block"]},
        "FB_Power": {"primaryRatings": ["lead_block", "carrying", "break_tackle", "run_block"]},
        "WR_DeepThreat": {"primaryRatings": ["speed", "acceleration", "deep_route_running", "catching"]},
        "WR_Playmaker": {"primaryRatings": ["catching", "change_of_direction", "juke_move", "medium_route_running"]},
        "WR_Physical": {"primaryRatings": ["catching", "catch_in_traffic", "strength", "spectacular_catch"]},
        "WR_Slot": {"primaryRatings": ["short_route_running", "catching", "change_of_direction", "catch_in_traffic"]},
        "TE_Blocking": {"primaryRatings": ["run_block", "impact_blocking", "strength", "pass_block"]},
        "TE_VerticalThreat": {"primaryRatings": ["speed", "catching", "medium_route_running", "catch_in_traffic"]},
        "TE_Possession": {"primaryRatings": ["catching", "catch_in_traffic", "short_route_running", "strength"]},
        "OL_PassProtector": {"primaryRatings": ["pass_block", "pass_block_power", "pass_block_finesse", "strength"]},
        "OL_RunBlocker": {"primaryRatings": ["run_block", "run_block_power", "impact_blocking", "strength"]},
        "DL_RunStopper": {"primaryRatings": ["block_shedding", "strength", "tackle", "pursuit"]},
        "DL_PowerRusher": {"primaryRatings": ["power_moves", "block_shedding", "strength", "pursuit"]},
        "EDGE_SpeedRusher": {"primaryRatings": ["finesse_moves", "speed", "pursuit", "tackle"]},
        "EDGE_PowerRusher": {"primaryRatings": ["power_moves", "block_shedding", "strength", "tackle"]},
        "LB_RunStopper": {"primaryRatings": ["tackle", "block_shedding", "pursuit", "hit_power"]},
        "LB_Coverage": {"primaryRatings": ["zone_coverage", "play_recognition", "speed", "tackle"]},
        "LB_FieldGeneral": {"primaryRatings": ["play_recognition", "tackle", "pursuit", "zone_coverage"]},
        "CB_MantoMan": {"primaryRatings": ["speed", "man_coverage", "press", "acceleration"]},
        "CB_Zone": {"primaryRatings": ["zone_coverage", "play_recognition", "speed", "tackle"]},
        "S_RunSupport": {"primaryRatings": ["tackle", "hit_power", "pursuit", "zone_coverage"]},
        "S_Hybrid": {"primaryRatings": ["speed", "zone_coverage", "man_coverage", "tackle"]},
        "S_Zone": {"primaryRatings": ["zone_coverage", "play_recognition", "speed", "tackle"]},
        "K_PlaceKicker": {"primaryRatings": ["kick_power", "kick_accuracy", "awareness"]},
        "P_Punter": {"primaryRatings": ["kick_power", "kick_accuracy", "awareness"]},
    },
    "bodyRules": {
        "QB": {"heightInches": {"min": 72, "max": 78}, "weightLbs": {"min": 195, "max": 235}},
        "HB": {"heightInches": {"min": 67, "max": 74}, "weightLbs": {"min": 185, "max": 230}},
        "FB": {"heightInches": {"min": 70, "max": 75}, "weightLbs": {"min": 225, "max": 260}},
        "WR": {"heightInches": {"min": 68, "max": 78}, "weightLbs": {"min": 170, "max": 225}},
        "TE": {"heightInches": {"min": 75, "max": 80}, "weightLbs": {"min": 230, "max": 270}},
        "CB": {"heightInches": {"min": 68, "max": 75}, "weightLbs": {"min": 170, "max": 205}},
        "S": {"heightInches": {"min": 70, "max": 76}, "weightLbs": {"min": 185, "max": 220}},
        "OL": {"heightInches": {"min": 74, "max": 80}, "weightLbs": {"min": 285, "max": 360}},
        "DL": {"heightInches": {"min": 72, "max": 79}, "weightLbs": {"min": 245, "max": 335}},
        "LB": {"heightInches": {"min": 72, "max": 77}, "weightLbs": {"min": 220, "max": 255}},
        "K": {"heightInches": {"min": 68, "max": 76}, "weightLbs": {"min": 165, "max": 215}},
        "P": {"heightInches": {"min": 70, "max": 78}, "weightLbs": {"min": 175, "max": 225}},
    },
    "development": {
        "traitWeights": {
            "Normal": 0.72,
            "College_Impact": 0.21,
            "College_Star": 0.06,
            "College_Elite": 0.01,
        },
        "rankBandMultipliers": {
            "rank-1-5": 3.0,
            "rank-6-32": 2.0,
            "rank-33-100": 1.5,
            "rank-101-400": 1.1,
        },
    },
    "qualityModifier": {
        "budgets": {
            "Gem": {"min": 20, "max": 55},
            "Bust": {"min": 20, "max": 55},
        },
        "writeBehavior": "preview-only-until-rg6",
    },
    "validation": {
        "overallTolerance": 2,
        "maxRareOverallCount": 3,
        "requireRankBandCoverage": True,
        "blockResearchGatedWrites": True,
    },
    "writeFields": {
        "ranks": True,
        "ratings": True,
        "identity": True,
        "body": True,
        "developmentTrait": "after-research",
        "starRating": "after-research",
        "archetype": "after-research",
        "bodyType": "after-research",
        "qualityModifier": "after-research",
        "abilities": False,
        "skillCaps": False,
    },
}

CONFIG_REQUIRED_TOP_LEVEL_KEYS = {
    "configVersion",
    "id",
    "name",
    "game",
    "generator",
    "classBudget",
    "rankBands",
    "starCutoffs",
    "profileTypes",
    "positionProfiles",
    "archetypeProfiles",
    "bodyRules",
    "development",
    "qualityModifier",
    "validation",
}

CONFIG_WRITE_FIELD_GROUPS = {
    "ranks": ["Recruit.NationalRank", "Recruit.PositionRank", "Recruit.StateRank"],
    "ratings": [f"Player.{schema_field}" for schema_field in RECRUIT_RATING_SCHEMA_FIELDS.values()],
    "identity": ["Player.FirstName", "Player.LastName", "Player.Position"],
    "body": ["Player.Height", "Player.Weight"],
    "developmentTrait": ["Player.TraitDevelopment"],
    "starRating": ["Player.ProspectStarRating"],
    "archetype": ["Player.PlayerType"],
    "bodyType": ["Player.CharacterBodyType"],
    "qualityModifier": ["Recruit.QualityModifier"],
    "abilities": [
        *[f"Player.PhysicalAbility{index}" for index in range(1, 6)],
        *[f"Player.MentalAbility{index}" for index in range(1, 4)],
        *[f"Player.MentalAbilityRank{index}" for index in range(1, 4)],
    ],
    "skillCaps": [f"Player.SkillGroupCap{index}" for index in range(1, 7)],
}


def clone_json(value: object) -> object:
    return json.loads(json.dumps(value))


def deep_merge_config(base: object, override: object) -> object:
    if isinstance(base, dict) and isinstance(override, dict):
        merged = dict(base)
        for key, value in override.items():
            merged[key] = deep_merge_config(merged.get(key), value)
        return merged
    return clone_json(override)


def migrate_generator_config(config: dict) -> tuple[dict, list[str], list[str]]:
    version = config.get("configVersion")
    warnings: list[str] = []
    errors: list[str] = []
    if version == CONFIG_VERSION:
        return clone_json(config), warnings, errors
    if version is None or version == 0:
        migrated = deep_merge_config(DEFAULT_GENERATOR_CONFIG, config)
        if isinstance(migrated, dict):
            migrated["configVersion"] = CONFIG_VERSION
            class_budget = config.get("classBudget")
            if isinstance(class_budget, dict) and isinstance(class_budget.get("positionWeights"), dict):
                migrated.setdefault("classBudget", {})["positionWeights"] = clone_json(class_budget["positionWeights"])
        source_version = "missing" if version is None else "0"
        warnings.append(
            f"Migrated configVersion {source_version} to {CONFIG_VERSION}; missing v1 sections were filled from the built-in default"
        )
        return migrated, warnings, errors
    if isinstance(version, int) and version > CONFIG_VERSION:
        errors.append(
            f"Unsupported future configVersion {version}; this editor supports {CONFIG_VERSION}. "
            "Export this config from a compatible editor or add a migration before importing it."
        )
        return clone_json(config), warnings, errors
    errors.append(f"Unsupported configVersion {version}; no migration is available")
    return clone_json(config), warnings, errors


def clean_config_id(value: object, path: str, errors: list[str]) -> str:
    text = str(value or "").strip()
    if not STABLE_ID_PATTERN.match(text):
        errors.append(f"{path} must be a stable id using letters, numbers, underscores, or hyphens")
    return text


def numeric_range(value: object, path: str, errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append(f"{path} must be an object with min and max")
        return {"min": 0, "max": 0}
    minimum = value.get("min")
    maximum = value.get("max")
    if not isinstance(minimum, (int, float)) or not isinstance(maximum, (int, float)):
        errors.append(f"{path}.min and {path}.max must be numeric")
        return {"min": minimum, "max": maximum}
    if minimum > maximum:
        errors.append(f"{path}.min cannot be greater than {path}.max")
    return {"min": minimum, "max": maximum}


def count_range(value: object, path: str, errors: list[str]) -> dict:
    normalized = numeric_range(value, path, errors)
    minimum = normalized.get("min")
    maximum = normalized.get("max")
    if not isinstance(minimum, int) or not isinstance(maximum, int):
        errors.append(f"{path}.min and {path}.max must be integer counts")
    elif minimum < 0 or maximum < 0:
        errors.append(f"{path}.min and {path}.max must be non-negative counts")
    return normalized


def normalize_probability_map(value: object, path: str, errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append(f"{path} must be a probability map")
        return {}
    cleaned: dict[str, float] = {}
    total = 0.0
    for key, raw_weight in value.items():
        if not isinstance(raw_weight, (int, float)) or raw_weight < 0:
            errors.append(f"{path}.{key} must be a non-negative number")
            continue
        cleaned[str(key)] = float(raw_weight)
        total += float(raw_weight)
    if total <= 0:
        errors.append(f"{path} must contain at least one positive weight")
        return cleaned
    return {key: round(weight / total, 6) for key, weight in cleaned.items()}


def validate_rank_intervals(
    items: list[tuple[str, int, int | None]],
    path: str,
    errors: list[str],
    require_start_at_one: bool = False,
) -> None:
    intervals = sorted(items, key=lambda item: item[1])
    previous_end: int | None = None
    for item_id, minimum, maximum in intervals:
        if minimum < 1:
            errors.append(f"{path}.{item_id}.minRank must be at least 1")
        if maximum is not None and maximum < minimum:
            errors.append(f"{path}.{item_id}.maxRank cannot be less than minRank")
        if previous_end is not None and minimum <= previous_end:
            errors.append(f"{path}.{item_id} overlaps a previous rank interval")
        if previous_end is not None and minimum > previous_end + 1:
            errors.append(f"{path}.{item_id} leaves a rank gap after {previous_end}")
        previous_end = maximum
        if maximum is None:
            break
    if require_start_at_one and intervals and intervals[0][1] != 1:
        errors.append(f"{path} must start at rank 1")


def normalize_rank_bands(value: object, errors: list[str]) -> tuple[list[dict], set[str]]:
    if not isinstance(value, list) or not value:
        errors.append("rankBands must be a non-empty array")
        return [], set()
    normalized = []
    intervals = []
    ids: set[str] = set()
    for index, item in enumerate(value):
        path = f"rankBands[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{path} must be an object")
            continue
        band_id = clean_config_id(item.get("id"), f"{path}.id", errors)
        if band_id in ids:
            errors.append(f"{path}.id is duplicated")
        ids.add(band_id)
        minimum = item.get("minRank")
        maximum = item.get("maxRank")
        if not isinstance(minimum, int):
            errors.append(f"{path}.minRank must be an integer")
            minimum = 1
        if maximum is not None and not isinstance(maximum, int):
            errors.append(f"{path}.maxRank must be an integer or null")
            maximum = minimum
        normalized_item = {**item, "id": band_id, "minRank": minimum, "maxRank": maximum}
        for range_key in ("expectedOverall", "typicalOverall"):
            if range_key in item:
                normalized_item[range_key] = numeric_range(item[range_key], f"{path}.{range_key}", errors)
        if "rareMaxOverall" in item and not isinstance(item["rareMaxOverall"], int):
            errors.append(f"{path}.rareMaxOverall must be an integer")
        normalized.append(normalized_item)
        intervals.append((band_id, minimum, maximum))
    validate_rank_intervals(intervals, "rankBands", errors)
    return normalized, ids


def normalize_star_cutoffs(value: object, errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append("starCutoffs must be an object")
        return {}
    missing = STAR_CUTOFF_KEYS - set(value)
    if missing:
        errors.append(f"starCutoffs is missing: {', '.join(sorted(missing))}")
    normalized = {}
    intervals = []
    for key, item in value.items():
        if key not in STAR_CUTOFF_KEYS:
            errors.append(f"starCutoffs.{key} is not a known star cutoff")
        if not isinstance(item, dict):
            errors.append(f"starCutoffs.{key} must be an object")
            continue
        minimum = item.get("minRank")
        maximum = item.get("maxRank")
        if not isinstance(minimum, int):
            errors.append(f"starCutoffs.{key}.minRank must be an integer")
            minimum = 1
        if maximum is not None and not isinstance(maximum, int):
            errors.append(f"starCutoffs.{key}.maxRank must be an integer or null")
            maximum = minimum
        normalized[key] = {"minRank": minimum, "maxRank": maximum}
        intervals.append((key, minimum, maximum))
    validate_rank_intervals(intervals, "starCutoffs", errors, require_start_at_one=True)
    return normalized


def normalize_class_budget(value: object, errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append("classBudget must be an object")
        return {}
    normalized = dict(value)
    position_weights = normalize_probability_map(
        value.get("positionWeights", {}),
        "classBudget.positionWeights",
        errors,
    )
    for position in position_weights:
        if position not in RECRUIT_POSITION_OPTIONS:
            errors.append(f"classBudget.positionWeights.{position} is not a known position")
    normalized["positionWeights"] = position_weights
    for key in ("fiveStarCount", "fourStarCount"):
        if key in value and (not isinstance(value[key], int) or value[key] < 0):
            errors.append(f"classBudget.{key} must be a non-negative integer")
    if "useExistingRecruitCount" in value and not isinstance(value["useExistingRecruitCount"], bool):
        errors.append("classBudget.useExistingRecruitCount must be true or false")
    for key in ("generationalFreshmanCount", "eliteDevelopmentCount", "platinumPhysicalAbilityCount"):
        if key in value:
            normalized[key] = count_range(value[key], f"classBudget.{key}", errors)
    if "classStrengthModifier" in value:
        normalized["classStrengthModifier"] = numeric_range(
            value["classStrengthModifier"],
            "classBudget.classStrengthModifier",
            errors,
        )
    return normalized


def rank_interval_size(item: dict) -> int | None:
    minimum = item.get("minRank")
    maximum = item.get("maxRank")
    if not isinstance(minimum, int) or not isinstance(maximum, int):
        return None
    return maximum - minimum + 1


def compare_class_budget_to_star_cutoffs(class_budget: dict, star_cutoffs: dict, warnings: list[str]) -> None:
    comparisons = [
        ("fiveStarCount", "FIVE_STAR"),
        ("fourStarCount", "FOUR_STAR"),
    ]
    for budget_key, cutoff_key in comparisons:
        budget_value = class_budget.get(budget_key)
        cutoff_size = rank_interval_size(star_cutoffs.get(cutoff_key, {}))
        if isinstance(budget_value, int) and cutoff_size is not None and budget_value != cutoff_size:
            warnings.append(
                f"classBudget.{budget_key} is {budget_value}, but starCutoffs.{cutoff_key} covers {cutoff_size} ranks"
            )


def validate_budget_recruit_count(
    class_budget: dict,
    quality_modifier: dict,
    recruit_count: int | None,
    errors: list[str],
) -> None:
    if recruit_count is None:
        return
    star_budget_total = 0
    for key in ("fiveStarCount", "fourStarCount"):
        value = class_budget.get(key)
        if isinstance(value, int):
            star_budget_total += value
            if value > recruit_count:
                errors.append(f"classBudget.{key} cannot exceed recruitCount {recruit_count}")
    if star_budget_total > recruit_count:
        errors.append(
            f"classBudget five-star plus four-star total {star_budget_total} cannot exceed recruitCount {recruit_count}"
        )

    for key in ("generationalFreshmanCount", "eliteDevelopmentCount", "platinumPhysicalAbilityCount"):
        item = class_budget.get(key)
        if isinstance(item, dict):
            maximum = item.get("max")
            if isinstance(maximum, int) and maximum > recruit_count:
                errors.append(f"classBudget.{key}.max cannot exceed recruitCount {recruit_count}")

    quality_budgets = quality_modifier.get("budgets", {}) if isinstance(quality_modifier, dict) else {}
    quality_min_total = 0
    quality_max_total = 0
    for key, item in quality_budgets.items():
        if not isinstance(item, dict):
            continue
        minimum = item.get("min")
        maximum = item.get("max")
        if isinstance(minimum, int):
            quality_min_total += minimum
            if minimum > recruit_count:
                errors.append(f"qualityModifier.budgets.{key}.min cannot exceed recruitCount {recruit_count}")
        if isinstance(maximum, int):
            quality_max_total += maximum
            if maximum > recruit_count:
                errors.append(f"qualityModifier.budgets.{key}.max cannot exceed recruitCount {recruit_count}")
    if quality_min_total > recruit_count:
        errors.append(
            f"qualityModifier minimum budget total {quality_min_total} cannot exceed recruitCount {recruit_count}"
        )
    if quality_max_total > recruit_count:
        errors.append(
            f"qualityModifier maximum budget total {quality_max_total} cannot exceed recruitCount {recruit_count}"
        )


def normalize_profile_types(value: object, rank_band_ids: set[str], errors: list[str]) -> dict:
    if not isinstance(value, dict) or not value:
        errors.append("profileTypes must be a non-empty object")
        return {}
    normalized = {}
    for key, item in value.items():
        profile_id = clean_config_id(key, f"profileTypes.{key}", errors)
        if not isinstance(item, dict):
            errors.append(f"profileTypes.{key} must be an object")
            continue
        normalized_item = dict(item)
        weights = normalize_probability_map(
            item.get("rankBandWeights", {}),
            f"profileTypes.{key}.rankBandWeights",
            errors,
        )
        for band_id in weights:
            if band_id not in rank_band_ids:
                errors.append(f"profileTypes.{key}.rankBandWeights.{band_id} does not match a rank band")
        normalized_item["rankBandWeights"] = weights
        for range_key in ("readiness", "physical", "technical", "mental", "ceiling"):
            if range_key in item:
                normalized_item[range_key] = numeric_range(
                    item[range_key],
                    f"profileTypes.{key}.{range_key}",
                    errors,
                )
        normalized[profile_id] = normalized_item
    return normalized


def validate_profile_type_coverage(profile_types: dict, rank_band_ids: set[str], errors: list[str]) -> None:
    covered = set()
    for item in profile_types.values():
        for band_id, weight in item.get("rankBandWeights", {}).items():
            if weight > 0:
                covered.add(band_id)
    missing = sorted(rank_band_ids - covered)
    if missing:
        errors.append(f"profileTypes do not provide positive weights for rank bands: {', '.join(missing)}")


def validate_position_profile_coverage(class_budget: dict, position_profiles: dict, errors: list[str]) -> None:
    position_weights = class_budget.get("positionWeights", {})
    if not isinstance(position_weights, dict):
        return
    missing = sorted(
        position
        for position, weight in position_weights.items()
        if isinstance(weight, (int, float)) and weight > 0 and position not in position_profiles
    )
    if missing:
        errors.append(
            "positionProfiles must define every position with positive classBudget.positionWeights: "
            + ", ".join(missing)
        )


def normalize_archetype_profiles(value: object, errors: list[str]) -> tuple[dict, set[str]]:
    if not isinstance(value, dict) or not value:
        errors.append("archetypeProfiles must be a non-empty object")
        return {}, set()
    normalized = {}
    ids: set[str] = set()
    known_ratings = set(RECRUIT_RATING_SCHEMA_FIELDS)
    for key, item in value.items():
        archetype_id = clean_config_id(key, f"archetypeProfiles.{key}", errors)
        ids.add(archetype_id)
        if not isinstance(item, dict):
            errors.append(f"archetypeProfiles.{key} must be an object")
            continue
        normalized_item = dict(item)
        primary_ratings = item.get("primaryRatings", [])
        if not isinstance(primary_ratings, list) or not primary_ratings:
            errors.append(f"archetypeProfiles.{key}.primaryRatings must be a non-empty array")
            primary_ratings = []
        cleaned_ratings = []
        for rating in primary_ratings:
            if rating not in known_ratings:
                errors.append(f"archetypeProfiles.{key}.primaryRatings contains unknown rating {rating}")
                continue
            cleaned_ratings.append(rating)
        normalized_item["primaryRatings"] = cleaned_ratings
        normalized[archetype_id] = normalized_item
    return normalized, ids


def normalize_position_profiles(
    value: object,
    archetype_ids: set[str],
    body_rule_ids: set[str],
    errors: list[str],
) -> dict:
    if not isinstance(value, dict):
        errors.append("positionProfiles must be an object")
        return {}
    normalized = {}
    for position, item in value.items():
        if position not in RECRUIT_POSITION_OPTIONS:
            errors.append(f"positionProfiles.{position} is not a known position")
        if not isinstance(item, dict):
            errors.append(f"positionProfiles.{position} must be an object")
            continue
        normalized_item = dict(item)
        if "archetypeWeights" in item:
            normalized_item["archetypeWeights"] = normalize_probability_map(
                item["archetypeWeights"],
                f"positionProfiles.{position}.archetypeWeights",
                errors,
            )
            allowed_prefixes = POSITION_ARCHETYPE_PREFIXES.get(position, ())
            for archetype_id in normalized_item["archetypeWeights"]:
                if archetype_id not in archetype_ids:
                    errors.append(f"positionProfiles.{position}.archetypeWeights.{archetype_id} is not defined in archetypeProfiles")
                elif allowed_prefixes and not archetype_id.startswith(allowed_prefixes):
                    errors.append(
                        f"positionProfiles.{position}.archetypeWeights.{archetype_id} is not compatible with {position}; "
                        f"expected archetype id prefix: {', '.join(allowed_prefixes)}"
                    )
        body_rule = item.get("bodyRule")
        if body_rule is not None and body_rule not in body_rule_ids:
            errors.append(f"positionProfiles.{position}.bodyRule {body_rule} is not defined in bodyRules")
        normalized[position] = normalized_item
    return normalized


def normalize_body_rules(value: object, errors: list[str]) -> tuple[dict, set[str]]:
    if not isinstance(value, dict):
        errors.append("bodyRules must be an object")
        return {}, set()
    normalized = {}
    ids: set[str] = set()
    for key, item in value.items():
        clean_key = clean_config_id(key, f"bodyRules.{key}", errors)
        ids.add(clean_key)
        if not isinstance(item, dict):
            errors.append(f"bodyRules.{key} must be an object")
            continue
        normalized_item = dict(item)
        if "heightInches" in item:
            normalized_item["heightInches"] = numeric_range(item["heightInches"], f"bodyRules.{key}.heightInches", errors)
        if "weightLbs" in item:
            normalized_item["weightLbs"] = numeric_range(item["weightLbs"], f"bodyRules.{key}.weightLbs", errors)
        height = normalized_item.get("heightInches")
        weight = normalized_item.get("weightLbs")
        if isinstance(height, dict):
            if height.get("min", 0) < 48 or height.get("max", 0) > 96:
                errors.append(f"bodyRules.{key}.heightInches must stay within 48 to 96 inches")
        if isinstance(weight, dict):
            if weight.get("min", 0) < 160 or weight.get("max", 0) > 415:
                errors.append(f"bodyRules.{key}.weightLbs must stay within 160 to 415 pounds")
        normalized[clean_key] = normalized_item
    return normalized, ids


def normalize_development(value: object, rank_band_ids: set[str], errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append("development must be an object")
        return {}
    normalized = dict(value)
    trait_weights = normalize_probability_map(value.get("traitWeights", {}), "development.traitWeights", errors)
    for trait in trait_weights:
        if trait not in DEVELOPMENT_TRAIT_KEYS:
            errors.append(f"development.traitWeights.{trait} is not a known development trait")
    normalized["traitWeights"] = trait_weights
    multipliers = value.get("rankBandMultipliers", {})
    if not isinstance(multipliers, dict):
        errors.append("development.rankBandMultipliers must be an object")
        multipliers = {}
    normalized_multipliers = {}
    for band_id, raw_value in multipliers.items():
        if band_id not in rank_band_ids:
            errors.append(f"development.rankBandMultipliers.{band_id} does not match a rank band")
        if not isinstance(raw_value, (int, float)) or raw_value < 0:
            errors.append(f"development.rankBandMultipliers.{band_id} must be a non-negative number")
            continue
        normalized_multipliers[band_id] = float(raw_value)
    normalized["rankBandMultipliers"] = normalized_multipliers
    return normalized


def normalize_quality_modifier(value: object, errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append("qualityModifier must be an object")
        return {}
    normalized = dict(value)
    budgets = value.get("budgets", {})
    if not isinstance(budgets, dict):
        errors.append("qualityModifier.budgets must be an object")
        budgets = {}
    normalized_budgets = {}
    for key, item in budgets.items():
        if key not in QUALITY_MODIFIER_KEYS:
            errors.append(f"qualityModifier.budgets.{key} is not a known quality modifier budget")
        normalized_budgets[key] = count_range(item, f"qualityModifier.budgets.{key}", errors)
    normalized["budgets"] = normalized_budgets
    return normalized


def normalize_validation_settings(value: object, errors: list[str]) -> dict:
    if not isinstance(value, dict):
        errors.append("validation must be an object")
        return {}
    normalized = dict(value)
    for key in ("overallTolerance", "maxRareOverallCount"):
        if key in value and (not isinstance(value[key], int) or value[key] < 0):
            errors.append(f"validation.{key} must be a non-negative integer")
    for key in ("requireRankBandCoverage", "blockResearchGatedWrites"):
        if key in value and not isinstance(value[key], bool):
            errors.append(f"validation.{key} must be true or false")
    return normalized


def resolve_write_field_states(write_fields: object, errors: list[str], warnings: list[str]) -> tuple[dict, dict]:
    if not isinstance(write_fields, dict):
        errors.append("writeFields must be an object when supplied")
        return {}, {}
    capabilities = {item["field"]: item for item in field_capabilities()["fields"]}
    normalized = {}
    states = {}
    for key, value in write_fields.items():
        if key not in CONFIG_WRITE_FIELD_GROUPS:
            errors.append(f"writeFields.{key} is not a known write field group")
            continue
        if value is not True and value is not False and value != "after-research":
            errors.append(f"writeFields.{key} must be true, false, or after-research")
            continue
        fields = CONFIG_WRITE_FIELD_GROUPS[key]
        blocked = [field for field in fields if not capabilities.get(field, {}).get("safeToWrite")]
        if value is True and blocked:
            warnings.append(
                f"writeFields.{key} requested writes to unverified fields and will be preview-only: "
                + ", ".join(blocked)
            )
            normalized[key] = "after-research"
        else:
            normalized[key] = value
        if value is False:
            state = "disabled"
        elif blocked:
            state = "preview-only"
        else:
            state = "writable"
        states[key] = {
            "state": state,
            "fields": fields,
            "blockedFields": blocked,
        }
    return normalized, states


def normalize_generator_config(config: object, recruit_count: int | None = None) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    migration_warnings: list[str] = []
    if recruit_count is not None and (isinstance(recruit_count, bool) or not isinstance(recruit_count, int) or recruit_count < 0):
        errors.append("recruitCount must be a non-negative integer when supplied")
        recruit_count = None
    if not isinstance(config, dict):
        return {
            "valid": False,
            "errors": [*errors, "config must be an object"],
            "warnings": [],
            "migrationWarnings": [],
            "normalizedConfig": None,
            "validationContext": {"recruitCount": recruit_count},
            "fieldCapabilities": field_capabilities(),
        }

    config, migration_warnings, migration_errors = migrate_generator_config(config)
    errors.extend(migration_errors)
    missing = sorted(CONFIG_REQUIRED_TOP_LEVEL_KEYS - set(config))
    if missing:
        errors.append(f"Missing required config keys: {', '.join(missing)}")
    version = config.get("configVersion")
    if version != CONFIG_VERSION and not migration_errors:
        errors.append(f"Unsupported configVersion {version}; no migration is available")

    normalized = clone_json(config)
    if isinstance(normalized, dict):
        normalized["configVersion"] = version
        normalized["id"] = clean_config_id(config.get("id"), "id", errors)
        normalized["name"] = str(config.get("name") or "").strip()
        if not normalized["name"]:
            errors.append("name is required")
        if config.get("game") != "CFB27":
            errors.append("game must be CFB27")

        generator = config.get("generator", {})
        if not isinstance(generator, dict):
            errors.append("generator must be an object")
            generator = {}
        mode = generator.get("mode")
        write_policy = generator.get("writePolicy")
        if mode != "reroll-existing-recruits":
            errors.append("generator.mode must be reroll-existing-recruits")
        if write_policy != "verified-fields-only":
            errors.append("generator.writePolicy must be verified-fields-only")
        normalized["generator"] = {"mode": mode, "writePolicy": write_policy}

        normalized["classBudget"] = normalize_class_budget(config.get("classBudget"), errors)
        rank_bands, rank_band_ids = normalize_rank_bands(config.get("rankBands"), errors)
        normalized["rankBands"] = rank_bands
        normalized["starCutoffs"] = normalize_star_cutoffs(config.get("starCutoffs"), errors)
        compare_class_budget_to_star_cutoffs(normalized["classBudget"], normalized["starCutoffs"], warnings)
        normalized["profileTypes"] = normalize_profile_types(config.get("profileTypes"), rank_band_ids, errors)
        validate_profile_type_coverage(normalized["profileTypes"], rank_band_ids, errors)
        normalized["archetypeProfiles"], archetype_ids = normalize_archetype_profiles(
            config.get("archetypeProfiles"),
            errors,
        )
        normalized["bodyRules"], body_rule_ids = normalize_body_rules(config.get("bodyRules"), errors)
        normalized["positionProfiles"] = normalize_position_profiles(
            config.get("positionProfiles"),
            archetype_ids,
            body_rule_ids,
            errors,
        )
        validate_position_profile_coverage(normalized["classBudget"], normalized["positionProfiles"], errors)
        normalized["development"] = normalize_development(config.get("development"), rank_band_ids, errors)
        normalized["qualityModifier"] = normalize_quality_modifier(config.get("qualityModifier"), errors)
        validate_budget_recruit_count(
            normalized["classBudget"],
            normalized["qualityModifier"],
            recruit_count,
            errors,
        )
        normalized["validation"] = normalize_validation_settings(config.get("validation"), errors)
        write_fields, write_field_states = resolve_write_field_states(
            config.get("writeFields", DEFAULT_GENERATOR_CONFIG["writeFields"]),
            errors,
            warnings,
        )
        normalized["writeFields"] = write_fields
        normalized["writeFieldStates"] = write_field_states

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "migrationWarnings": migration_warnings,
        "normalizedConfig": normalized if not errors else None,
        "validationContext": {"recruitCount": recruit_count},
        "fieldCapabilities": field_capabilities(),
    }


def default_generator_configs() -> dict:
    validation = normalize_generator_config(DEFAULT_GENERATOR_CONFIG)
    return {
        "configs": [validation["normalizedConfig"] or clone_json(DEFAULT_GENERATOR_CONFIG)],
        "fieldCapabilities": field_capabilities(),
    }


class StableRandom:
    def __init__(self, seed: str):
        self.seed = str(seed)
        self.counter = 0

    def random(self, label: str = "") -> float:
        self.counter += 1
        material = f"{self.seed}|{self.counter}|{label}".encode("utf-8")
        digest = hashlib.sha256(material).digest()
        return int.from_bytes(digest[:8], "big") / float(1 << 64)

    def randint(self, minimum: int, maximum: int, label: str = "") -> int:
        if maximum <= minimum:
            return int(minimum)
        span = maximum - minimum + 1
        return minimum + int(self.random(label) * span)

    def uniform(self, minimum: float, maximum: float, label: str = "") -> float:
        if maximum <= minimum:
            return float(minimum)
        return float(minimum) + self.random(label) * (float(maximum) - float(minimum))

    def weighted_choice(self, weights: dict, label: str = "") -> str:
        positive = [(key, float(value)) for key, value in weights.items() if isinstance(value, (int, float)) and value > 0]
        if not positive:
            return next(iter(weights), "")
        total = sum(value for _, value in positive)
        cursor = self.random(label) * total
        running = 0.0
        for key, value in positive:
            running += value
            if cursor <= running:
                return key
        return positive[-1][0]

    def shuffled(self, values: list, label: str = "") -> list:
        return sorted(values, key=lambda item: self.random(f"{label}:{item}"))


def clamp_int(value: float, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(round(value))))


def rank_band_for_rank(config: dict, rank: int) -> dict | None:
    for band in config.get("rankBands", []):
        maximum = band.get("maxRank")
        if rank >= band.get("minRank", 1) and (maximum is None or rank <= maximum):
            return band
    return None


def star_for_rank(config: dict, rank: int) -> str:
    for star, cutoff in config.get("starCutoffs", {}).items():
        maximum = cutoff.get("maxRank")
        if rank >= cutoff.get("minRank", 1) and (maximum is None or rank <= maximum):
            return star
    return "ONE_STAR"


def allocate_weighted_counts(total: int, weights: dict) -> list[str]:
    positive = [(key, float(value)) for key, value in weights.items() if isinstance(value, (int, float)) and value > 0]
    if not positive or total <= 0:
        return []
    weight_total = sum(value for _, value in positive)
    allocations = []
    assigned = 0
    for key, weight in positive:
        exact = total * weight / weight_total
        count = int(exact)
        assigned += count
        allocations.append([key, count, exact - count])
    for item in sorted(allocations, key=lambda row: row[2], reverse=True)[: max(0, total - assigned)]:
        item[1] += 1
    result: list[str] = []
    for key, count, _ in allocations:
        result.extend([key] * count)
    return result[:total]


def profile_type_for_band(config: dict, band_id: str, rng: StableRandom, label: str) -> str:
    weights = {
        profile_id: profile.get("rankBandWeights", {}).get(band_id, 0)
        for profile_id, profile in config.get("profileTypes", {}).items()
    }
    return rng.weighted_choice(weights, label) or next(iter(config.get("profileTypes", {})), "Developmental")


def score_from_profile(profile_config: dict, key: str, rng: StableRandom, label: str) -> float:
    score_range = profile_config.get(key, {})
    return round(rng.uniform(score_range.get("min", 0.5), score_range.get("max", 0.5), label), 4)


def body_composition_for_size(rule: dict, height: int, weight: int) -> str:
    height_range = rule.get("heightInches", {})
    weight_range = rule.get("weightLbs", {})
    h_min = height_range.get("min", height)
    h_max = height_range.get("max", height)
    w_min = weight_range.get("min", weight)
    w_max = weight_range.get("max", weight)
    height_pct = 0.5 if h_max == h_min else (height - h_min) / (h_max - h_min)
    weight_pct = 0.5 if w_max == w_min else (weight - w_min) / (w_max - w_min)
    if height_pct >= 0.68 and weight_pct <= 0.45:
        return "LONG"
    if weight_pct >= 0.7:
        return "POWER"
    if weight_pct <= 0.32:
        return "LEAN"
    return "BALANCED"


GENERAL_RATING_WEIGHTS = {
    "speed": "physical",
    "acceleration": "physical",
    "strength": "physical",
    "agility": "physical",
    "jumping": "physical",
    "awareness": "mental",
    "injury": "readiness",
    "stamina": "readiness",
    "toughness": "mental",
}


RATING_KEYWORD_WEIGHTS = {
    "throw": "technical",
    "accuracy": "technical",
    "route": "technical",
    "catch": "technical",
    "block": "technical",
    "coverage": "technical",
    "tackle": "technical",
    "moves": "technical",
    "power": "physical",
    "speed": "physical",
    "strength": "physical",
    "agility": "physical",
    "vision": "mental",
    "recognition": "mental",
    "awareness": "mental",
    "pursuit": "readiness",
    "carrying": "readiness",
    "return": "physical",
}


def score_for_rating(rating: str, scores: dict, primary_ratings: set[str]) -> float:
    if rating in primary_ratings:
        return 0.45 * scores["technical"] + 0.25 * scores["physical"] + 0.2 * scores["readiness"] + 0.1 * scores["mental"]
    if rating in GENERAL_RATING_WEIGHTS:
        return scores[GENERAL_RATING_WEIGHTS[rating]]
    for keyword, score_key in RATING_KEYWORD_WEIGHTS.items():
        if keyword in rating:
            return scores[score_key]
    return 0.35 * scores["technical"] + 0.25 * scores["physical"] + 0.25 * scores["readiness"] + 0.15 * scores["mental"]


def generate_ratings(
    target_overall: int,
    scores: dict,
    primary_ratings: set[str],
    rng: StableRandom,
    label: str,
) -> dict:
    ratings: dict[str, int] = {}
    for rating_key in RECRUIT_RATING_SCHEMA_FIELDS:
        if rating_key == "overall":
            continue
        identity_score = score_for_rating(rating_key, scores, primary_ratings)
        offset = (identity_score - 0.62) * 24
        if rating_key in primary_ratings:
            offset += 7
        elif rating_key not in GENERAL_RATING_WEIGHTS:
            offset -= 9
        noise = rng.uniform(-5.5, 5.5, f"{label}:rating:{rating_key}")
        ratings[rating_key] = clamp_int(target_overall + offset + noise, 18, 99)
    primary_values = [ratings[key] for key in primary_ratings if key in ratings]
    if primary_values:
        calculated = round((sum(primary_values) / len(primary_values)) * 0.68 + target_overall * 0.32)
    else:
        calculated = target_overall
    ratings["overall"] = clamp_int(calculated, 40, 99)
    delta = target_overall - ratings["overall"]
    if abs(delta) > 1 and primary_ratings:
        for key in primary_ratings:
            if key in ratings:
                ratings[key] = clamp_int(ratings[key] + delta * 0.75, 18, 99)
        primary_values = [ratings[key] for key in primary_ratings if key in ratings]
        ratings["overall"] = clamp_int((sum(primary_values) / len(primary_values)) if primary_values else target_overall, 40, 99)
    return ratings


def choose_development_trait(
    config: dict,
    band_id: str,
    rank_index: int,
    elite_budget: int,
    rng: StableRandom,
    label: str,
) -> str:
    if rank_index < elite_budget:
        return "College_Elite"
    weights = dict(config.get("development", {}).get("traitWeights", {}))
    weights["College_Elite"] = 0
    multiplier = config.get("development", {}).get("rankBandMultipliers", {}).get(band_id, 1)
    for trait in ("College_Impact", "College_Star"):
        if trait in weights:
            weights[trait] = weights[trait] * multiplier
    return rng.weighted_choice(weights, label) or "Normal"


def count_budget_value(config: dict, path: tuple[str, ...], rng: StableRandom, label: str) -> int:
    current: object = config
    for key in path:
        current = current.get(key, {}) if isinstance(current, dict) else {}
    if not isinstance(current, dict):
        return 0
    minimum = int(current.get("min", 0))
    maximum = int(current.get("max", minimum))
    return rng.randint(minimum, maximum, label)


def generated_field_values(profile: dict, generated: dict) -> dict[str, tuple[str, str, object, object]]:
    football = generated.get("footballProfile", {})
    game = generated.get("gameFields", {})
    ratings = game.get("ratings", {})
    original_recruit = profile.get("originalFields", {}).get("Recruit", {})
    original_player = profile.get("originalFields", {}).get("Player", {})
    values = {
        "Recruit.NationalRank": ("national_rank", "ranks", original_recruit.get("NationalRank"), football.get("nationalRank")),
        "Recruit.PositionRank": ("position_rank", "ranks", original_recruit.get("PositionRank"), football.get("positionRank")),
        "Recruit.StateRank": ("state_rank", "ranks", original_recruit.get("StateRank"), football.get("stateRank")),
        "Player.Position": ("position", "identity", original_player.get("Position"), football.get("position")),
        "Player.ProspectStarRating": ("star_rating", "starRating", original_player.get("ProspectStarRating"), football.get("starRating")),
        "Player.PlayerType": ("player_type", "archetype", original_player.get("PlayerType"), football.get("archetype")),
        "Recruit.QualityModifier": (
            "quality_modifier",
            "qualityModifier",
            original_recruit.get("QualityModifier"),
            game.get("qualityModifier"),
        ),
        "Player.TraitDevelopment": (
            "dev_trait",
            "developmentTrait",
            original_player.get("TraitDevelopment"),
            game.get("developmentTrait"),
        ),
        "Player.Height": ("height_inches", "body", original_player.get("Height"), game.get("heightInches")),
        "Player.Weight": ("weight_lbs", "body", None, game.get("weightLbs")),
    }
    raw_weight = original_player.get("Weight")
    if isinstance(raw_weight, int):
        values["Player.Weight"] = ("weight_lbs", "body", decode_weight_lbs(raw_weight), game.get("weightLbs"))
    for rating_key, schema_field in RECRUIT_RATING_SCHEMA_FIELDS.items():
        values[f"Player.{schema_field}"] = (
            rating_key,
            "ratings",
            original_player.get(schema_field),
            ratings.get(rating_key),
        )
    return values


def lock_blocks_group(locks: dict, group: str) -> bool:
    if locks.get("rowLocked"):
        return True
    locked_fields = set(locks.get("fields") or [])
    if group == "ratings":
        return "gameFields.ratings" in locked_fields
    if group == "body":
        return "gameFields.size" in locked_fields
    if group == "developmentTrait":
        return "gameFields.developmentTrait" in locked_fields
    if group in {"ranks", "identity"}:
        return "footballProfile" in locked_fields or "identity" in locked_fields
    return group in locked_fields


def preview_write_diffs(profile: dict, generated: dict, config: dict) -> tuple[dict, list[dict], list[str]]:
    capability_by_field = {item["field"]: item for item in field_capabilities()["fields"]}
    write_states = config.get("writeFieldStates", {})
    generated_writes: dict[str, object] = {}
    diffs: list[dict] = []
    skipped: list[str] = []
    locks = generated.get("locks", {})
    for field, (patch_key, group, before, after) in generated_field_values(profile, generated).items():
        if before == after:
            continue
        if lock_blocks_group(locks, group):
            skipped.append(f"{field} skipped by lock")
            continue
        state = write_states.get(group, {}).get("state", "disabled")
        capability = capability_by_field.get(field, {})
        if state != "writable" or not capability.get("safeToWrite"):
            skipped.append(f"{field} skipped because {capability.get('generatorState', state)}")
            continue
        generated_writes[patch_key] = after
        diffs.append(
            {
                "recruitId": profile.get("recruitId"),
                "playerId": profile.get("playerId"),
                "source": profile.get("source", {}),
                "field": field,
                "patchKey": patch_key,
                "from": before,
                "to": after,
                "writeState": "writable",
            }
        )
    return generated_writes, diffs, skipped


def rating_bounds_by_key() -> dict[str, tuple[int, int]]:
    return {
        key: (minimum, maximum)
        for key, _, _, _, minimum, maximum in RECRUIT_RATING_COLUMNS
    }


def encode_weight_lbs(weight_lbs: int) -> int:
    return int(weight_lbs) - 160


def decode_weight_lbs(encoded_weight: int) -> int:
    return int(encoded_weight) + 160


def max_budget_value(config: dict, path: tuple[str, ...]) -> int | None:
    current: object = config
    for key in path:
        current = current.get(key, {}) if isinstance(current, dict) else {}
    if not isinstance(current, dict):
        return None
    value = current.get("max")
    return value if isinstance(value, int) else None


def budget_range_value(config: dict, path: tuple[str, ...]) -> dict:
    current: object = config
    for key in path:
        current = current.get(key, {}) if isinstance(current, dict) else {}
    if not isinstance(current, dict):
        return {"min": 0, "max": 0}
    minimum = current.get("min", 0)
    maximum = current.get("max", minimum)
    return {
        "min": minimum if isinstance(minimum, int) else 0,
        "max": maximum if isinstance(maximum, int) else 0,
    }


def validate_generated_preview_class(
    generated_profiles: list[dict],
    config: dict,
    diffs: list[dict],
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    checks: dict[str, object] = {}
    ranks = [item.get("footballProfile", {}).get("nationalRank") for item in generated_profiles]
    expected_ranks = list(range(1, len(generated_profiles) + 1))
    checks["nationalRanksUnique"] = len(ranks) == len(set(ranks))
    checks["nationalRanksContiguous"] = sorted(ranks) == expected_ranks
    if not checks["nationalRanksUnique"]:
        errors.append("Generated national ranks are not unique")
    if not checks["nationalRanksContiguous"]:
        errors.append("Generated national ranks are not contiguous from 1 to class size")

    position_rank_seen: dict[str, set[int]] = {}
    position_rank_counts: dict[str, int] = {}
    state_rank_seen: dict[str, set[int]] = {}
    state_rank_counts: dict[str, int] = {}
    star_mismatch_count = 0
    typical_overall_warning_count = 0
    rare_overall_error_count = 0
    rating_bound_error_count = 0
    body_rule_error_count = 0
    encoded_weight_error_count = 0
    locked_write_count = 0
    rank_band_details: dict[str, dict] = {}
    position_details: dict[str, dict] = {}
    warning_samples: list[dict] = []
    error_samples: list[dict] = []
    bounds = rating_bounds_by_key()
    position_profiles = config.get("positionProfiles", {})
    body_rules = config.get("bodyRules", {})

    locked_recruit_ids = {
        item.get("recruitId")
        for item in generated_profiles
        if item.get("locks", {}).get("rowLocked")
    }
    for diff in diffs:
        if diff.get("recruitId") in locked_recruit_ids:
            locked_write_count += 1

    for profile in generated_profiles:
        football = profile.get("footballProfile", {})
        game = profile.get("gameFields", {})
        identity = profile.get("identity", {})
        rank = football.get("nationalRank")
        position = football.get("position") or ""
        position_rank = football.get("positionRank")
        position_rank_counts[position] = position_rank_counts.get(position, 0) + 1
        position_rank_seen.setdefault(position, set()).add(position_rank)
        position_detail = position_details.setdefault(
            position,
            {"count": 0, "overallTotal": 0, "minOverall": None, "maxOverall": None, "minRank": None, "maxRank": None},
        )
        position_detail["count"] += 1
        if isinstance(rank, int):
            position_detail["minRank"] = rank if position_detail["minRank"] is None else min(position_detail["minRank"], rank)
            position_detail["maxRank"] = rank if position_detail["maxRank"] is None else max(position_detail["maxRank"], rank)

        home_state = identity.get("homeState") or ""
        if home_state:
            state_rank = football.get("stateRank")
            state_rank_counts[home_state] = state_rank_counts.get(home_state, 0) + 1
            state_rank_seen.setdefault(home_state, set()).add(state_rank)

        if isinstance(rank, int) and football.get("starRating") != star_for_rank(config, rank):
            star_mismatch_count += 1

        band = rank_band_for_rank(config, rank) if isinstance(rank, int) else None
        ratings = game.get("ratings", {})
        overall = ratings.get("overall")
        body_rule_id = position_profiles.get(position, {}).get("bodyRule") if isinstance(position_profiles, dict) else None
        body_rule = body_rules.get(body_rule_id, {}) if isinstance(body_rules, dict) else {}
        height = game.get("heightInches")
        weight = game.get("weightLbs")
        encoded_weight = game.get("encodedWeight")
        height_range = body_rule.get("heightInches", {}) if isinstance(body_rule, dict) else {}
        weight_range = body_rule.get("weightLbs", {}) if isinstance(body_rule, dict) else {}
        height_valid = (
            isinstance(height, int)
            and isinstance(height_range.get("min"), int)
            and isinstance(height_range.get("max"), int)
            and height_range["min"] <= height <= height_range["max"]
        )
        weight_valid = (
            isinstance(weight, int)
            and isinstance(weight_range.get("min"), int)
            and isinstance(weight_range.get("max"), int)
            and weight_range["min"] <= weight <= weight_range["max"]
        )
        if not height_valid or not weight_valid:
            body_rule_error_count += 1
            if len(error_samples) < 12:
                error_samples.append(
                    {
                        "recruitId": profile.get("recruitId"),
                        "rank": rank,
                        "position": position,
                        "rankBand": band["id"] if band else None,
                        "overall": overall,
                        "issue": "height or weight outside configured body rule",
                    }
                )
        if not isinstance(weight, int) or encoded_weight != encode_weight_lbs(weight):
            encoded_weight_error_count += 1
            if len(error_samples) < 12:
                error_samples.append(
                    {
                        "recruitId": profile.get("recruitId"),
                        "rank": rank,
                        "position": position,
                        "rankBand": band["id"] if band else None,
                        "overall": overall,
                        "issue": "encoded weight does not match display weight",
                    }
                )
        if band and isinstance(overall, int):
            band_detail = rank_band_details.setdefault(
                band["id"],
                {
                    "count": 0,
                    "overallTotal": 0,
                    "minOverall": None,
                    "maxOverall": None,
                    "typicalOverallWarnings": 0,
                    "rareOverallErrors": 0,
                },
            )
            band_detail["count"] += 1
            band_detail["overallTotal"] += overall
            band_detail["minOverall"] = overall if band_detail["minOverall"] is None else min(band_detail["minOverall"], overall)
            band_detail["maxOverall"] = overall if band_detail["maxOverall"] is None else max(band_detail["maxOverall"], overall)
            position_detail["overallTotal"] += overall
            position_detail["minOverall"] = overall if position_detail["minOverall"] is None else min(position_detail["minOverall"], overall)
            position_detail["maxOverall"] = overall if position_detail["maxOverall"] is None else max(position_detail["maxOverall"], overall)
            typical = band.get("typicalOverall", {})
            rare_max = band.get("rareMaxOverall")
            if isinstance(rare_max, int) and overall > rare_max:
                rare_overall_error_count += 1
                band_detail["rareOverallErrors"] += 1
                if len(error_samples) < 12:
                    error_samples.append(
                        {
                            "recruitId": profile.get("recruitId"),
                            "rank": rank,
                            "position": position,
                            "rankBand": band["id"],
                            "overall": overall,
                            "issue": "overall exceeds rare rank-band maximum",
                        }
                    )
            elif (
                isinstance(typical.get("min"), int)
                and isinstance(typical.get("max"), int)
                and not (typical["min"] <= overall <= typical["max"])
            ):
                typical_overall_warning_count += 1
                band_detail["typicalOverallWarnings"] += 1
                if len(warning_samples) < 12:
                    warning_samples.append(
                        {
                            "recruitId": profile.get("recruitId"),
                            "rank": rank,
                            "position": position,
                            "rankBand": band["id"],
                            "overall": overall,
                            "issue": "overall outside typical rank-band range",
                        }
                    )

        for rating_key, value in ratings.items():
            minimum, maximum = bounds.get(rating_key, (0, 99))
            if not isinstance(value, int) or value < minimum or value > maximum:
                rating_bound_error_count += 1

    invalid_position_rank_positions = [
        position
        for position, count in position_rank_counts.items()
        if position_rank_seen.get(position) != set(range(1, count + 1))
    ]
    invalid_state_rank_states = [
        state
        for state, count in state_rank_counts.items()
        if state_rank_seen.get(state) != set(range(1, count + 1))
    ]

    if invalid_position_rank_positions:
        errors.append(
            "Generated position ranks are not unique/contiguous for: "
            + ", ".join(sorted(invalid_position_rank_positions))
        )
    if invalid_state_rank_states:
        errors.append(
            "Generated state ranks are not unique/contiguous for known states: "
            + ", ".join(sorted(invalid_state_rank_states))
        )
    if star_mismatch_count:
        errors.append(f"{star_mismatch_count} generated star rating(s) do not match rank cutoffs")
    if rare_overall_error_count:
        errors.append(f"{rare_overall_error_count} generated overall rating(s) exceed rare rank-band maximums")
    if rating_bound_error_count:
        errors.append(f"{rating_bound_error_count} generated rating value(s) are outside configured field bounds")
    if body_rule_error_count:
        errors.append(f"{body_rule_error_count} generated body profile(s) are outside configured body rules")
    if encoded_weight_error_count:
        errors.append(f"{encoded_weight_error_count} generated encoded weight value(s) do not match display weight")
    if locked_write_count:
        errors.append(f"{locked_write_count} generated diff(s) target row-locked recruits")
    if typical_overall_warning_count:
        warnings.append(
            f"{typical_overall_warning_count} generated overall rating(s) are outside typical rank-band ranges but within rare caps"
        )

    elite_count = sum(
        1
        for profile in generated_profiles
        if profile.get("gameFields", {}).get("developmentTrait") == "College_Elite"
    )
    elite_max = max_budget_value(config, ("classBudget", "eliteDevelopmentCount"))
    if elite_max is not None and elite_count > elite_max:
        errors.append(f"College_Elite development count {elite_count} exceeds configured max {elite_max}")

    quality_counts: dict[str, int] = {}
    for profile in generated_profiles:
        quality = profile.get("gameFields", {}).get("qualityModifier")
        quality_counts[quality] = quality_counts.get(quality, 0) + 1
    for quality in QUALITY_MODIFIER_KEYS:
        quality_max = max_budget_value(config, ("qualityModifier", "budgets", quality))
        if quality_max is not None and quality_counts.get(quality, 0) > quality_max:
            errors.append(f"{quality} count {quality_counts.get(quality, 0)} exceeds configured max {quality_max}")

    checks.update(
        {
            "positionRanksValid": not invalid_position_rank_positions,
            "stateRanksValid": not invalid_state_rank_states,
            "starRatingsMatchRankCutoffs": star_mismatch_count == 0,
            "ratingsWithinBounds": rating_bound_error_count == 0,
            "bodyRulesValid": body_rule_error_count == 0,
            "encodedWeightsValid": encoded_weight_error_count == 0,
            "rareOverallCapsValid": rare_overall_error_count == 0,
            "lockedRowsUnchangedByDiffs": locked_write_count == 0,
            "eliteDevelopmentWithinBudget": elite_max is None or elite_count <= elite_max,
            "qualityModifierWithinBudget": all(
                max_budget_value(config, ("qualityModifier", "budgets", quality)) is None
                or quality_counts.get(quality, 0) <= max_budget_value(config, ("qualityModifier", "budgets", quality))
                for quality in QUALITY_MODIFIER_KEYS
            ),
        }
    )
    for detail in rank_band_details.values():
        detail["averageOverall"] = round(detail["overallTotal"] / detail["count"], 2) if detail["count"] else None
        del detail["overallTotal"]
    for detail in position_details.values():
        detail["averageOverall"] = round(detail["overallTotal"] / detail["count"], 2) if detail["count"] else None
        del detail["overallTotal"]
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
        "counts": {
            "typicalOverallWarnings": typical_overall_warning_count,
            "rareOverallErrors": rare_overall_error_count,
            "ratingBoundErrors": rating_bound_error_count,
            "bodyRuleErrors": body_rule_error_count,
            "encodedWeightErrors": encoded_weight_error_count,
            "starMismatches": star_mismatch_count,
            "lockedWriteDiffs": locked_write_count,
            "eliteDevelopment": elite_count,
        },
        "details": {
            "rankBands": rank_band_details,
            "positions": position_details,
            "invalidPositionRankPositions": sorted(invalid_position_rank_positions),
            "invalidStateRankStates": sorted(invalid_state_rank_states),
        },
        "samples": {
            "warnings": warning_samples,
            "errors": error_samples,
        },
    }


def summarize_preview_diffs(diffs: list[dict]) -> list[dict]:
    by_field: dict[str, dict] = {}
    for diff in diffs:
        field = diff.get("field") or diff.get("patchKey") or "unknown"
        item = by_field.setdefault(
            field,
            {
                "field": field,
                "patchKey": diff.get("patchKey"),
                "count": 0,
                "sampleRecruitId": diff.get("recruitId"),
                "sampleFrom": diff.get("from"),
                "sampleTo": diff.get("to"),
            },
        )
        item["count"] += 1
    return sorted(by_field.values(), key=lambda item: (-item["count"], item["field"]))


def recruit_budget_ref(profile: dict) -> dict:
    football = profile.get("footballProfile", {})
    identity = profile.get("identity", {})
    game = profile.get("gameFields", {})
    return {
        "recruitId": profile.get("recruitId"),
        "name": f"{identity.get('firstName', '')} {identity.get('lastName', '')}".strip(),
        "rank": football.get("nationalRank"),
        "position": football.get("position"),
        "overall": game.get("ratings", {}).get("overall"),
    }


def summarize_budget_consumers(generated_profiles: list[dict]) -> dict:
    consumers = {
        "generationalFreshman": [],
        "eliteDevelopment": [],
        "Gem": [],
        "Bust": [],
    }
    for profile in generated_profiles:
        intent = profile.get("generationIntent", {})
        game = profile.get("gameFields", {})
        if intent.get("generationalFreshman"):
            consumers["generationalFreshman"].append(recruit_budget_ref(profile))
        if game.get("developmentTrait") == "College_Elite":
            consumers["eliteDevelopment"].append(recruit_budget_ref(profile))
        quality = game.get("qualityModifier")
        if quality in {"Gem", "Bust"}:
            consumers[quality].append(recruit_budget_ref(profile))
    for key in consumers:
        consumers[key] = sorted(consumers[key], key=lambda item: item.get("rank") or 999999)[:24]
    return consumers


def generate_recruit_preview_from_profiles(
    joined: dict,
    config: dict,
    seed: str,
    locks: dict | None = None,
) -> dict:
    profiles = clone_json(joined.get("recruits", []))
    if not profiles:
        raise AppError("No joined recruit profiles are available for preview", 422)
    validation = joined.get("validation", {})
    if validation and not validation.get("passed", True):
        raise AppError("Joined recruit validation failed; preview cannot run", 422)

    config_result = normalize_generator_config(config, recruit_count=joined.get("count") or len(profiles))
    if not config_result["valid"]:
        return {
            "previewId": "",
            "configHash": "",
            "saveFingerprint": joined.get("saveFingerprint", ""),
            "seed": seed,
            "valid": False,
            "errors": config_result["errors"],
            "warnings": config_result["warnings"],
            "summary": {},
            "recruits": [],
            "diffs": [],
            "fieldCapabilities": field_capabilities(),
        }
    normalized = config_result["normalizedConfig"]
    seed_material = "|".join(
        [
            str(seed or "default"),
            str(joined.get("saveFingerprint", "")),
            json.dumps(normalized, sort_keys=True),
        ]
    )
    rng = StableRandom(seed_material)
    count = len(profiles)
    strength = normalized.get("classBudget", {}).get("classStrengthModifier", {})
    class_strength = rng.uniform(strength.get("min", 0), strength.get("max", 0), "class-strength")
    position_slots = rng.shuffled(
        allocate_weighted_counts(count, normalized.get("classBudget", {}).get("positionWeights", {})),
        "positions",
    )
    if len(position_slots) < count:
        position_slots.extend([profiles[index].get("footballProfile", {}).get("position") or "WR" for index in range(len(position_slots), count)])

    elite_budget = count_budget_value(normalized, ("classBudget", "eliteDevelopmentCount"), rng, "elite-dev-budget")
    generational_budget = count_budget_value(normalized, ("classBudget", "generationalFreshmanCount"), rng, "generational-budget")
    gem_budget = count_budget_value(normalized, ("qualityModifier", "budgets", "Gem"), rng, "gem-budget")
    bust_budget = count_budget_value(normalized, ("qualityModifier", "budgets", "Bust"), rng, "bust-budget")
    class_budget_summary = {
        "generationalFreshman": {
            **budget_range_value(normalized, ("classBudget", "generationalFreshmanCount")),
            "target": min(generational_budget, count),
            "actual": 0,
        },
        "eliteDevelopment": {
            **budget_range_value(normalized, ("classBudget", "eliteDevelopmentCount")),
            "target": min(elite_budget, count),
            "actual": 0,
        },
        "Gem": {
            **budget_range_value(normalized, ("qualityModifier", "budgets", "Gem")),
            "target": min(gem_budget, count),
            "actual": 0,
        },
        "Bust": {
            **budget_range_value(normalized, ("qualityModifier", "budgets", "Bust")),
            "target": min(bust_budget, max(0, count - min(gem_budget, count))),
            "actual": 0,
        },
    }
    quality_slots = ["Gem"] * min(gem_budget, count) + ["Bust"] * min(bust_budget, max(0, count - gem_budget))
    quality_slots.extend(["NORMAL"] * max(0, count - len(quality_slots)))
    quality_slots = rng.shuffled(quality_slots[:count], "quality-slots")

    candidates: list[dict] = []
    for index, profile in enumerate(rng.shuffled(profiles, "profile-order")):
        intended_rank = index + 1
        band = rank_band_for_rank(normalized, intended_rank) or normalized["rankBands"][-1]
        band_id = band["id"]
        position = position_slots[index]
        position_profile = normalized.get("positionProfiles", {}).get(position) or next(iter(normalized.get("positionProfiles", {}).values()))
        archetype = rng.weighted_choice(position_profile.get("archetypeWeights", {}), f"archetype:{index}")
        archetype_profile = normalized.get("archetypeProfiles", {}).get(archetype, {})
        profile_type = profile_type_for_band(normalized, band_id, rng, f"profile-type:{index}")
        profile_config = normalized.get("profileTypes", {}).get(profile_type, {})
        scores = {
            "readiness": score_from_profile(profile_config, "readiness", rng, f"readiness:{index}"),
            "physical": score_from_profile(profile_config, "physical", rng, f"physical:{index}"),
            "technical": score_from_profile(profile_config, "technical", rng, f"technical:{index}"),
            "mental": score_from_profile(profile_config, "mental", rng, f"mental:{index}"),
            "ceiling": score_from_profile(profile_config, "ceiling", rng, f"ceiling:{index}"),
        }
        scores["confidence"] = round(0.54 + scores["readiness"] * 0.28 + rng.uniform(-0.08, 0.1, f"confidence:{index}"), 4)
        typical = band.get("typicalOverall", band.get("expectedOverall", {"min": 60, "max": 70}))
        target_overall = rng.randint(typical.get("min", 60), typical.get("max", 70), f"ovr:{index}")
        target_overall = clamp_int(target_overall + class_strength * 2 + (scores["readiness"] - 0.58) * 4, 40, band.get("rareMaxOverall", 99))
        if index < generational_budget:
            target_overall = clamp_int(max(target_overall, band.get("expectedOverall", {}).get("max", target_overall) + 2), 40, band.get("rareMaxOverall", 99))
        ratings = generate_ratings(
            target_overall,
            scores,
            set(archetype_profile.get("primaryRatings", [])),
            rng,
            f"candidate:{index}",
        )
        ratings["overall"] = min(ratings["overall"], band.get("rareMaxOverall", ratings["overall"]))
        body_rule = normalized.get("bodyRules", {}).get(position_profile.get("bodyRule"), {})
        height_range = body_rule.get("heightInches", {"min": 70, "max": 76})
        weight_range = body_rule.get("weightLbs", {"min": 180, "max": 240})
        height = rng.randint(height_range.get("min", 70), height_range.get("max", 76), f"height:{index}")
        weight = rng.randint(weight_range.get("min", 180), weight_range.get("max", 240), f"weight:{index}")
        development_trait = choose_development_trait(normalized, band_id, index, elite_budget, rng, f"dev:{index}")
        quality_score = (
            ratings["overall"] * 1.0
            + scores["ceiling"] * 8
            + scores["physical"] * 5
            + scores["technical"] * 5
            + rng.uniform(-0.35, 0.35, f"quality:{index}")
        )
        candidates.append(
            {
                "profile": profile,
                "position": position,
                "archetype": archetype,
                "profileType": profile_type,
                "scores": scores,
                "bodyRule": body_rule,
                "height": height,
                "weight": weight,
                "bodyComposition": body_composition_for_size(body_rule, height, weight),
                "ratings": ratings,
                "developmentTrait": development_trait,
                "qualityModifier": quality_slots[index] if index < len(quality_slots) else "NORMAL",
                "generationalFreshman": index < generational_budget,
                "qualityScore": quality_score,
                "intendedRankBand": band_id,
            }
        )

    candidates.sort(key=lambda item: item["qualityScore"], reverse=True)
    position_counts: dict[str, int] = {}
    state_counts: dict[str, int] = {}
    generated_profiles: list[dict] = []
    all_diffs: list[dict] = []
    warnings = list(config_result.get("warnings", []))
    skipped_fields: set[str] = set()
    rare_overall_count = 0
    star_counts: dict[str, int] = {}
    rank_band_counts: dict[str, int] = {}
    development_counts: dict[str, int] = {}
    position_summary: dict[str, int] = {}
    quality_counts: dict[str, int] = {}
    lock_map = locks if isinstance(locks, dict) else {}

    for national_index, candidate in enumerate(candidates):
        rank = national_index + 1
        profile = candidate["profile"]
        sidecar_lock_key = profile.get("sidecar", {}).get("recordId")
        full_lock_key = (
            f"{profile.get('source', {}).get('saveFingerprint', joined.get('saveFingerprint', ''))}:"
            f"R{profile.get('source', {}).get('recruitRow')}:P{profile.get('source', {}).get('playerRow')}"
        )
        lock_key = next((key for key in (sidecar_lock_key, full_lock_key) if key in lock_map), "")
        if lock_key and isinstance(lock_map[lock_key], dict):
            profile["locks"] = {
                "rowLocked": bool(lock_map[lock_key].get("rowLocked")),
                "fields": sorted(lock_map[lock_key].get("fields") or []),
            }
        band = rank_band_for_rank(normalized, rank) or normalized["rankBands"][-1]
        star = star_for_rank(normalized, rank)
        position = candidate["position"]
        final_ratings = dict(candidate["ratings"])
        final_ratings["overall"] = min(final_ratings["overall"], band.get("rareMaxOverall", final_ratings["overall"]))
        position_counts[position] = position_counts.get(position, 0) + 1
        home_state = profile.get("identity", {}).get("homeState") or ""
        state_rank = profile.get("footballProfile", {}).get("stateRank") or rank
        if home_state:
            state_counts[home_state] = state_counts.get(home_state, 0) + 1
            state_rank = state_counts[home_state]
        generated = clone_json(profile)
        generated["footballProfile"] = {
            **generated.get("footballProfile", {}),
            "nationalRank": rank,
            "positionRank": position_counts[position],
            "stateRank": state_rank,
            "rankBand": band["id"],
            "starRating": star,
            "position": position,
            "archetype": candidate["archetype"],
            "archetypeDisplay": candidate["archetype"],
            "profileType": candidate["profileType"],
            "readinessScore": candidate["scores"]["readiness"],
            "physicalScore": candidate["scores"]["physical"],
            "technicalScore": candidate["scores"]["technical"],
            "mentalScore": candidate["scores"]["mental"],
            "ceilingScore": candidate["scores"]["ceiling"],
            "evaluationConfidence": candidate["scores"]["confidence"],
            "bodyComposition": candidate["bodyComposition"],
        }
        generated["gameFields"] = {
            **generated.get("gameFields", {}),
            "ratings": final_ratings,
            "developmentTrait": candidate["developmentTrait"],
            "qualityModifier": candidate["qualityModifier"],
            "heightInches": candidate["height"],
            "weightLbs": candidate["weight"],
            "encodedWeight": encode_weight_lbs(candidate["weight"]),
        }
        generated["generationIntent"] = {
            **generated.get("generationIntent", {}),
            "seed": seed,
            "configId": normalized.get("id"),
            "profileType": candidate["profileType"],
            "rankBand": band["id"],
            "starRating": star,
            "generationalFreshman": bool(candidate["generationalFreshman"]),
            "qualityScore": round(candidate["qualityScore"], 4),
            "qualityModifier": candidate["qualityModifier"],
        }
        generated_writes, diffs, skipped = preview_write_diffs(profile, generated, normalized)
        generated["gameFields"]["generatedWrites"] = generated_writes
        generated["gameFields"]["generatedDiffs"] = diffs
        all_diffs.extend(diffs)
        skipped_fields.update(skipped)
        generated_profiles.append(generated)
        star_counts[star] = star_counts.get(star, 0) + 1
        rank_band_counts[band["id"]] = rank_band_counts.get(band["id"], 0) + 1
        development_counts[candidate["developmentTrait"]] = development_counts.get(candidate["developmentTrait"], 0) + 1
        position_summary[position] = position_summary.get(position, 0) + 1
        quality_counts[candidate["qualityModifier"]] = quality_counts.get(candidate["qualityModifier"], 0) + 1
        rare_max = band.get("rareMaxOverall")
        if isinstance(rare_max, int) and final_ratings["overall"] > rare_max:
            rare_overall_count += 1

    class_budget_summary["generationalFreshman"]["actual"] = sum(
        1
        for profile in generated_profiles
        if profile.get("generationIntent", {}).get("generationalFreshman")
    )
    class_budget_summary["eliteDevelopment"]["actual"] = development_counts.get("College_Elite", 0)
    class_budget_summary["Gem"]["actual"] = quality_counts.get("Gem", 0)
    class_budget_summary["Bust"]["actual"] = quality_counts.get("Bust", 0)

    validation_report = validate_generated_preview_class(generated_profiles, normalized, all_diffs)
    errors: list[str] = list(validation_report["errors"])
    warnings.extend(validation_report["warnings"])
    max_rare_allowed = normalized.get("validation", {}).get("maxRareOverallCount", 0)
    if rare_overall_count > max_rare_allowed:
        errors.append(f"Generated rare overall count {rare_overall_count} exceeds maxRareOverallCount {max_rare_allowed}")
    if skipped_fields:
        warnings.append(f"{len(skipped_fields)} generated field change(s) were skipped by locks or field gates")
    diff_field_summary = summarize_preview_diffs(all_diffs)
    budget_consumers = summarize_budget_consumers(generated_profiles)
    config_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode("utf-8")).hexdigest().upper()
    preview_material = {
        "saveFingerprint": joined.get("saveFingerprint", ""),
        "seed": seed,
        "configHash": config_hash,
        "diffCount": len(all_diffs),
        "recruits": [
            {
                "recruitId": item.get("recruitId"),
                "rank": item.get("footballProfile", {}).get("nationalRank"),
                "overall": item.get("gameFields", {}).get("ratings", {}).get("overall"),
            }
            for item in generated_profiles
        ],
    }
    preview_id = hashlib.sha256(json.dumps(preview_material, sort_keys=True).encode("utf-8")).hexdigest().upper()
    return {
        "previewId": preview_id,
        "configHash": config_hash,
        "saveFingerprint": joined.get("saveFingerprint", ""),
        "seed": seed,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "count": count,
            "classStrength": round(class_strength, 4),
            "rankBands": rank_band_counts,
            "stars": star_counts,
            "positions": position_summary,
            "development": development_counts,
            "qualityModifier": quality_counts,
            "budgets": class_budget_summary,
            "budgetConsumers": budget_consumers,
            "diffFields": diff_field_summary,
            "diffCount": len(all_diffs),
            "skippedFieldCount": len(skipped_fields),
            "validationErrorCount": len(errors),
            "validationWarningCount": len(validation_report["warnings"]),
        },
        "validationReport": validation_report,
        "recruits": generated_profiles,
        "diffs": all_diffs,
        "skippedFields": sorted(skipped_fields),
        "normalizedConfig": normalized,
        "fieldCapabilities": field_capabilities(),
    }


def resolve_home_dogs_repo() -> Path | None:
    candidates: list[Path] = []
    for env_name in HOME_DOGS_REPO_ENVS:
        value = os.environ.get(env_name)
        if value:
            candidates.append(Path(value).expanduser())
    candidates.extend(
        [
            APP_DIR.parent / "cfb27-dynasty-modding",
            Path(tempfile.gettempdir()) / "cfb27-dynasty-modding",
        ]
    )
    for candidate in candidates:
        preview_script = candidate / "franchise-lab" / "generator" / "preview.js"
        if preview_script.is_file():
            return candidate.resolve()
    return None


def home_dogs_status() -> dict:
    repo = resolve_home_dogs_repo()
    if repo is None:
        return {
            "available": False,
            "engine": "home-dogs",
            "repoPath": "",
            "message": "Set CFB27_HOME_DOGS_REPO to a clone of brooksg357-a11y/cfb27-dynasty-modding.",
        }
    lab = repo / "franchise-lab"
    node_modules = lab / "node_modules"
    return {
        "available": True,
        "engine": "home-dogs",
        "repoPath": str(repo),
        "previewScript": str(lab / "generator" / "preview.js"),
        "applyScript": str(lab / "generator" / "apply.js"),
        "dependenciesInstalled": node_modules.is_dir(),
        "message": "Home Dogs generator repo found.",
    }


def home_dogs_subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    python_dir = str(Path(sys.executable).resolve().parent)
    path_key = "Path" if "Path" in env else "PATH"
    current_path = env.get(path_key, "")
    env[path_key] = python_dir if not current_path else f"{python_dir}{os.pathsep}{current_path}"
    return env


def snake_rating_key(name: str) -> str:
    if not name:
        return ""
    base = name.removesuffix("Rating")
    return re.sub(r"(?<!^)(?=[A-Z])", "_", base).lower()


def update_count(counter: dict, key: object) -> None:
    if key is None or key == "":
        return
    text = str(key)
    counter[text] = counter.get(text, 0) + 1


def average_numeric_score(values: object, keys: tuple[str, ...] | None = None) -> float | None:
    if not isinstance(values, dict):
        return None
    selected = []
    source = keys if keys is not None else tuple(values.keys())
    for key in source:
        value = values.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            selected.append(float(value))
    if not selected:
        return None
    return round(clamp_int(sum(selected) / len(selected), 0, 100) / 100, 4)


def home_dogs_recruit_to_profile(assignment: dict, save_fingerprint: str, save_name: str = "") -> dict:
    geo = assignment.get("geoBio") if isinstance(assignment.get("geoBio"), dict) else {}
    frame = geo.get("frame") if isinstance(geo.get("frame"), dict) else {}
    ratings: dict[str, int] = {}
    for section in ("athletic", "skills", "background"):
        values = assignment.get(section)
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            if key == "trace" or not isinstance(value, int):
                continue
            ratings[snake_rating_key(str(key))] = value
    local_overall = assignment.get("localOverall")
    if isinstance(local_overall, (int, float)) and not isinstance(local_overall, bool):
        ratings["overall"] = clamp_int(round(float(local_overall)), 0, 100)

    athletic_score = average_numeric_score(assignment.get("athletic"), ("Speed", "Acceleration", "Agility", "ChangeOfDirection", "Strength", "Jumping"))
    technical_score = average_numeric_score(assignment.get("skills"))
    mental_score = average_numeric_score(assignment.get("background"), ("Awareness", "PlayRecognition"))
    readiness_score = average_numeric_score({"overall": ratings.get("overall") or local_overall})
    latent_values = assignment.get("latents") if isinstance(assignment.get("latents"), dict) else {}
    ceiling_score = None
    projection = latent_values.get("projection")
    if isinstance(projection, (int, float)) and not isinstance(projection, bool):
        ceiling_score = round(max(0, min(1, float(projection))), 4)
    if ceiling_score is None:
        ceiling_score = readiness_score

    appearance = assignment.get("appearance") if isinstance(assignment.get("appearance"), dict) else {}
    appearance_token = {
        "genericHeadAssetName": appearance.get("genericHeadAssetName") or appearance.get("head") or "",
        "portrait": appearance.get("portrait"),
    }

    recruit_row = assignment.get("recruitRow")
    player_row = assignment.get("playerRow")
    recruit_id = f"Recruit:{recruit_row}" if recruit_row is not None else ""
    player_id = f"Player:{player_row}" if player_row is not None else ""
    return {
        "recruitId": recruit_id,
        "playerId": player_id,
        "identity": {
            "firstName": geo.get("firstName") or "",
            "lastName": geo.get("lastName") or "",
            "hometown": geo.get("homeTown") or "",
            "homeState": geo.get("homeState") or "",
            "homePipeline": geo.get("homePipeline") or "",
        },
        "footballProfile": {
            "nationalRank": assignment.get("nationalRank"),
            "positionRank": assignment.get("positionRank"),
            "stateRank": assignment.get("stateRank"),
            "rankBand": assignment.get("rankBand"),
            "starRating": assignment.get("star"),
            "position": assignment.get("position"),
            "archetype": assignment.get("archetype"),
            "archetypeDisplay": assignment.get("archetype"),
            "profileType": assignment.get("profileType"),
            "bodyComposition": frame.get("bodyComposition") or geo.get("bodyComposition"),
            "readinessScore": readiness_score,
            "physicalScore": athletic_score,
            "technicalScore": technical_score,
            "mentalScore": mental_score,
            "ceilingScore": ceiling_score,
            "evaluationConfidence": 100,
        },
        "gameFields": {
            "ratings": ratings,
            "developmentTrait": assignment.get("devTrait"),
            "qualityModifier": assignment.get("qualityModifier"),
            "heightInches": frame.get("height"),
            "weightLbs": frame.get("weight"),
            "encodedWeight": encode_weight_lbs(frame["weight"]) if isinstance(frame.get("weight"), int) else None,
            "bodyType": assignment.get("bodyType"),
            "abilities": assignment.get("abilities"),
            "appearance": assignment.get("appearance"),
            "appearanceToken": appearance_token,
            "generatedWrites": {},
            "generatedDiffs": [],
        },
        "generationIntent": {
            "seed": assignment.get("seed"),
            "engine": "home-dogs",
            "profileType": assignment.get("profileType"),
            "rankBand": assignment.get("rankBand"),
            "starRating": assignment.get("star"),
            "qualityModifier": assignment.get("qualityModifier"),
            "previewOnly": True,
        },
        "source": {
            "saveFingerprint": save_fingerprint,
            "saveName": save_name,
            "recruitRow": recruit_row,
            "playerRow": player_row,
        },
        "sidecar": {
            "recordId": f"{save_fingerprint}:R{recruit_row}:P{player_row}",
            "engine": "home-dogs",
        },
        "homeDogs": assignment,
    }


def adapt_home_dogs_preview(
    home_preview: dict,
    home_report: dict,
    save_fingerprint: str,
    seed: str,
    save_name: str,
    repo: Path,
) -> dict:
    assignments = home_preview.get("recruits", [])
    if not isinstance(assignments, list):
        raise AppError("Home Dogs preview did not include a recruits list", 502)
    profiles = [home_dogs_recruit_to_profile(item, save_fingerprint, save_name) for item in assignments if isinstance(item, dict)]
    star_counts: dict[str, int] = {}
    position_counts: dict[str, int] = {}
    development_counts: dict[str, int] = {}
    quality_counts: dict[str, int] = {}
    for item in profiles:
        football = item.get("footballProfile", {})
        game = item.get("gameFields", {})
        update_count(star_counts, football.get("starRating"))
        update_count(position_counts, football.get("position"))
        update_count(development_counts, game.get("developmentTrait"))
        update_count(quality_counts, game.get("qualityModifier"))

    checks = ((home_report.get("validation") or {}).get("checks") or []) if isinstance(home_report, dict) else []
    errors = [
        f"{check.get('name')}: {check.get('detail')}"
        for check in checks
        if isinstance(check, dict) and not check.get("passed", False)
    ]
    warnings = [
        "Home Dogs preview is external-preview-only in this UI; use Home Dogs apply.js for writes until the adapter is explicitly wired.",
    ]
    config_versions = home_preview.get("configVersions") or {}
    preview_material = {
        "engine": "home-dogs",
        "saveFingerprint": save_fingerprint,
        "seed": seed,
        "configVersions": config_versions,
        "count": len(profiles),
        "firstRows": [
            {
                "recruitRow": item.get("source", {}).get("recruitRow"),
                "playerRow": item.get("source", {}).get("playerRow"),
                "rank": item.get("footballProfile", {}).get("nationalRank"),
            }
            for item in profiles[:50]
        ],
    }
    preview_id = hashlib.sha256(json.dumps(preview_material, sort_keys=True).encode("utf-8")).hexdigest().upper()
    config_hash = hashlib.sha256(json.dumps(config_versions, sort_keys=True).encode("utf-8")).hexdigest().upper()
    validation_report = {
        "valid": not errors,
        "errors": errors,
        "warnings": [],
        "checks": {
            "homeDogsValidationPassed": not errors,
        },
        "counts": {
            "homeDogsCheckCount": len(checks),
            "homeDogsFailedCheckCount": len(errors),
        },
        "details": {
            "homeDogs": home_report,
        },
        "samples": {"warnings": [], "errors": []},
    }
    return {
        "previewId": preview_id,
        "configHash": config_hash,
        "saveFingerprint": save_fingerprint,
        "seed": seed,
        "engine": "home-dogs",
        "applyMode": "external-preview-only",
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "count": len(profiles),
            "classSize": home_preview.get("classSize", len(profiles)),
            "stars": star_counts,
            "positions": position_counts,
            "development": development_counts,
            "qualityModifier": quality_counts,
            "diffFields": [],
            "diffCount": 0,
            "skippedFieldCount": 0,
            "validationErrorCount": len(errors),
            "validationWarningCount": len(warnings),
            "engine": {
                "id": "home-dogs",
                "repoPath": str(repo),
                "source": "brooksg357-a11y/cfb27-dynasty-modding",
            },
        },
        "validationReport": validation_report,
        "recruits": profiles,
        "diffs": [],
        "skippedFields": [],
        "normalizedConfig": {"engine": "home-dogs", "configVersions": config_versions},
        "fieldCapabilities": field_capabilities(),
        "homeDogs": {
            "configVersions": config_versions,
            "report": home_report,
        },
    }


def run_home_dogs_preview(save_path: Path, seed: str, save_fingerprint: str, save_name: str) -> dict:
    repo = resolve_home_dogs_repo()
    if repo is None:
        raise AppError(
            "Home Dogs generator repo was not found. Set CFB27_HOME_DOGS_REPO to brooksg357-a11y/cfb27-dynasty-modding.",
            503,
        )
    lab = repo / "franchise-lab"
    preview_script = lab / "generator" / "preview.js"
    if not (lab / "node_modules").is_dir():
        raise AppError(f"Home Dogs dependencies are not installed. Run npm install in {lab}", 503)
    HOME_DOGS_REPORT_DIR.mkdir(parents=True, exist_ok=True)
    run_id = hashlib.sha256(f"{save_path}|{save_fingerprint}|{seed}|{time.time()}".encode("utf-8")).hexdigest()[:16]
    out_dir = HOME_DOGS_REPORT_DIR / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "node",
        str(preview_script),
        "--save",
        str(save_path),
        "--seed",
        seed or "default",
        "--out-dir",
        str(out_dir),
    ]
    result = subprocess.run(
        command,
        cwd=str(lab),
        env=home_dogs_subprocess_env(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=240,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise AppError(f"Home Dogs preview failed: {detail}", 502)
    preview_path = out_dir / "generator-preview.json"
    report_path = out_dir / "generator-report.json"
    if not preview_path.is_file() or not report_path.is_file():
        raise AppError("Home Dogs preview finished without generator-preview.json and generator-report.json", 502)
    home_preview = json.loads(preview_path.read_text(encoding="utf-8"))
    home_report = json.loads(report_path.read_text(encoding="utf-8"))
    adapted = adapt_home_dogs_preview(home_preview, home_report, save_fingerprint, seed, save_name, repo)
    adapted["homeDogs"]["previewPath"] = str(preview_path)
    adapted["homeDogs"]["reportPath"] = str(report_path)
    return adapted


def validated_home_dogs_preview_path(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value).resolve()
    root = HOME_DOGS_REPORT_DIR.resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise AppError("Home Dogs preview path must be under reports/home-dogs", 403) from exc
    if path.name != "generator-preview.json" or not path.is_file():
        raise AppError("Home Dogs preview artifact was not found; regenerate preview", 404)
    return path


def run_home_dogs_apply(
    save_path: Path,
    preview_path: Path,
    target_path: Path,
    backup: dict,
) -> dict:
    repo = resolve_home_dogs_repo()
    if repo is None:
        raise AppError(
            "Home Dogs generator repo was not found. Set CFB27_HOME_DOGS_REPO to brooksg357-a11y/cfb27-dynasty-modding.",
            503,
        )
    lab = repo / "franchise-lab"
    apply_script = lab / "generator" / "apply.js"
    if not apply_script.is_file():
        raise AppError("Home Dogs apply.js was not found", 503)
    if not (lab / "node_modules").is_dir():
        raise AppError(f"Home Dogs dependencies are not installed. Run npm install in {lab}", 503)
    HOME_DOGS_REPORT_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        "node",
        str(apply_script),
        "--save",
        str(save_path),
        "--preview",
        str(preview_path),
        "--out",
        str(target_path),
        "--report-dir",
        str(HOME_DOGS_REPORT_DIR),
    ]
    result = subprocess.run(
        command,
        cwd=str(lab),
        env=home_dogs_subprocess_env(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise AppError(f"Home Dogs apply failed: {detail}", 502)
    try:
        apply_result = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        apply_result = {"stdout": result.stdout}
    report_path_text = str(apply_result.get("reportPath") or "")
    report_path = Path(report_path_text) if report_path_text else None
    report_payload: dict = {}
    if report_path and report_path.is_file():
        report_payload = json.loads(report_path.read_text(encoding="utf-8"))
    field_write_counts = report_payload.get("fieldWriteCounts", {}) if isinstance(report_payload, dict) else {}
    changed_field_count = sum(value for value in field_write_counts.values() if isinstance(value, int))
    mismatches = report_payload.get("mismatches", []) if isinstance(report_payload, dict) else []
    class_size = report_payload.get("classSize") if isinstance(report_payload, dict) else None
    return {
        "applied": not mismatches,
        "writeSucceeded": True,
        "artifactWriteSucceeded": bool(report_path and report_path.is_file()),
        "artifactError": "",
        "appliedRecruitCount": class_size if isinstance(class_size, int) else 0,
        "changedFieldCount": changed_field_count,
        "backup": backup,
        "sidecar": None,
        "report": {
            "path": str(report_path) if report_path else "",
            "kind": "home-dogs-apply-report",
            "summary": apply_result.get("summary", {}),
        },
        "readBackMismatches": mismatches,
        "writeMode": "copy",
        "sourceFile": save_path.name,
        "targetFile": target_path.name,
        "targetPath": str(target_path),
        "sourceUnchanged": True,
        "engine": "home-dogs",
        "homeDogs": {
            "previewPath": str(preview_path),
            "reportPath": str(report_path) if report_path else "",
            "summary": apply_result.get("summary", {}),
            "fieldWriteCounts": field_write_counts,
            "chunk2Preserved": report_payload.get("chunk2Preserved") if isinstance(report_payload, dict) else None,
            "weightFloorClamps": report_payload.get("weightFloorClamps") if isinstance(report_payload, dict) else None,
            "skippedPhantoms": report_payload.get("skippedPhantoms") if isinstance(report_payload, dict) else None,
        },
    }

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
    payload_offset: int
    chunk1_compressed_size: int
    chunk1_budget: int
    chunk1_size_field_offset: int
    chunk1_size_field_matches: bool
    header: bytes
    compressed_payload: bytes
    tail: bytes
    decompressed_payload: bytes
    compression_method: str = "original"

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

        chunk1_size_field_offset = payload_offset - 8
        if chunk1_size_field_offset < 0 or chunk1_size_field_offset + 4 > len(source):
            raise AppError("Invalid FBCHUNKS chunk size offset", 422)
        chunk1_size_field = int.from_bytes(source[chunk1_size_field_offset : chunk1_size_field_offset + 4], "little")
        header = source[18:payload_offset]
        payload_bytes = source[payload_offset:]
        leading_zero_tail = 0
        try:
            decompressor = zlib.decompressobj()
            decompressed_payload = decompressor.decompress(payload_bytes) + decompressor.flush()
        except zlib.error as exc:
            raise AppError(f"Could not decompress zlib payload: {exc}", 422) from exc
        chunk1_compressed_size = len(payload_bytes) - len(decompressor.unused_data)
        if chunk1_compressed_size <= 0 or chunk1_compressed_size > payload_size:
            raise AppError("Invalid FBCHUNKS chunk 1 compressed size", 422)

        compressed_payload = payload_bytes[:chunk1_compressed_size]
        tail = payload_bytes[chunk1_compressed_size:]
        while leading_zero_tail < len(tail) and tail[leading_zero_tail] == 0:
            leading_zero_tail += 1
        chunk1_budget = chunk1_compressed_size + leading_zero_tail
        chunk1_size_field_matches = chunk1_size_field == chunk1_compressed_size

        return cls(
            source=source,
            header_size=header_size,
            payload_size=payload_size,
            payload_offset=payload_offset,
            chunk1_compressed_size=chunk1_compressed_size,
            chunk1_budget=chunk1_budget,
            chunk1_size_field_offset=chunk1_size_field_offset,
            chunk1_size_field_matches=chunk1_size_field_matches,
            header=header,
            compressed_payload=compressed_payload,
            tail=tail,
            decompressed_payload=decompressed_payload,
        )

    def rebuild(self, new_decompressed_payload: bytes) -> bytes:
        new_compressed, method = compress_franchise_database(new_decompressed_payload)
        if len(new_compressed) > self.chunk1_budget:
            raise AppError(
                "Recompressed database "
                f"({len(new_compressed)} bytes via {method}) exceeds available chunk 1 space "
                f"({self.chunk1_budget} bytes); refusing to overwrite CharacterVisuals",
                422,
            )

        new_source = bytearray(self.source[: self.payload_offset])
        if self.chunk1_size_field_matches:
            new_source[self.chunk1_size_field_offset : self.chunk1_size_field_offset + 4] = len(new_compressed).to_bytes(
                4,
                "little",
            )
        new_source.extend(new_compressed)
        new_source.extend(bytes(self.chunk1_budget - len(new_compressed)))
        new_source.extend(self.source[self.payload_offset + self.chunk1_budget :])
        if len(new_source) != len(self.source):
            raise AppError("Rebuilt FBCHUNKS output size changed unexpectedly", 500)
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
        {"key": "archetype", "label": "Archetype", "title": "Archetype", "writable": False},
        {"key": "dev_trait", "label": "Dev", "title": "Development Trait", "writable": True, "type": "select", "options": DEVELOPMENT_TRAIT_OPTIONS},
        {"key": "dealbreaker", "label": "Deal", "title": "Deal Breaker", "writable": True, "type": "select", "options": DEALBREAKER_OPTIONS},
        {"key": "physical_traits", "label": "Physical", "title": "Physical Traits", "writable": False},
        {"key": "mental_traits", "label": "Mental", "title": "Mental Traits", "writable": False},
        {"key": "jersey_number", "label": "#", "title": "Jersey Number", "writable": True, "type": "number", "min": 0, "max": 99},
        {"key": "height_inches", "label": "Height In", "writable": True, "type": "number", "min": 48, "max": 96},
        {"key": "height_display", "label": "Height", "writable": False},
        {"key": "weight_lbs", "label": "Weight", "writable": True, "type": "number", "min": 160, "max": 415},
        {"key": "generic_head_asset_name", "label": "Head Asset", "writable": True, "maxLength": 33},
        {"key": "skin_tone", "label": "Skin", "writable": False},
        {"key": "hair", "label": "Hair", "writable": False},
        {"key": "mental_ability_1", "label": "Mental 1", "writable": True, "type": "select", "options": MENTAL_ABILITY_OPTIONS},
        {"key": "mental_rank_1", "label": "M1 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "mental_ability_2", "label": "Mental 2", "writable": True, "type": "select", "options": MENTAL_ABILITY_OPTIONS},
        {"key": "mental_rank_2", "label": "M2 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "mental_ability_3", "label": "Mental 3", "writable": True, "type": "select", "options": MENTAL_ABILITY_OPTIONS},
        {"key": "mental_rank_3", "label": "M3 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "physical_ability_1", "label": "Phys 1", "writable": False},
        {"key": "physical_rank_1", "label": "P1 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "physical_ability_2", "label": "Phys 2", "writable": False},
        {"key": "physical_rank_2", "label": "P2 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "physical_ability_3", "label": "Phys 3", "writable": False},
        {"key": "physical_rank_3", "label": "P3 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "physical_ability_4", "label": "Phys 4", "writable": False},
        {"key": "physical_rank_4", "label": "P4 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "physical_ability_5", "label": "Phys 5", "writable": False},
        {"key": "physical_rank_5", "label": "P5 Rank", "writable": True, "type": "select", "options": ABILITY_RANK_OPTIONS},
        {"key": "player_type", "label": "Player Type", "writable": False},
        {"key": "dealbreaker_raw", "label": "Deal Raw", "writable": False},
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
            "position, archetype display, dev trait, deal breaker, mental traits, physical trait ranks, "
            "jersey number, height in inches, weight in pounds, head asset, and verified EA ratings. "
            "Physical trait names are resolved for verified archetypes; skin tone and hair hints are "
            "decoded from head asset names but stay read-only until the CharacterVisuals offsets are verified."
        ),
    }


def joined_recruit_profiles_from_payload(
    payload: bytes,
    save_fingerprint: str,
    save_name: str = "",
    limit: int = 1000,
    offset: int = 0,
) -> dict:
    with tempfile.TemporaryDirectory(prefix="cfb27-joined-recruits-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        input_path = temp_dir / "input.frk"
        input_path.write_bytes(payload)
        result = run_franchise_helper(
            ["joined", str(input_path), str(max(1, min(limit, 7600))), str(max(0, offset))],
            timeout=120,
        )

    for profile in result.get("recruits", []):
        source = profile.setdefault("source", {})
        source["saveFingerprint"] = save_fingerprint
        source["saveName"] = save_name
        recruit_row = source.get("recruitRow")
        player_row = source.get("playerRow")
        sidecar_record_id = f"{save_fingerprint[:12]}:R{recruit_row}:P{player_row}"
        profile["sidecar"] = {
            "recordId": sidecar_record_id,
            "keyFields": ["saveFingerprint", "recruitRow", "playerRow"],
            "storage": "sidecars/{saveName}.{saveFingerprint}.json",
        }
        intent = profile.setdefault("generationIntent", {})
        intent["sidecarRecordId"] = sidecar_record_id
    return {
        **result,
        "saveFingerprint": save_fingerprint,
        "fieldCapabilities": field_capabilities(),
        "sidecar": {
            "directory": str(SIDECAR_DIR),
            "fileName": f"{save_name}.{save_fingerprint}.json" if save_name else f"{save_fingerprint}.json",
            "keyStrategy": "save fingerprint plus recruit row plus player row",
            "recordIdFormat": "<fingerprint12>:R<recruitRow>:P<playerRow>",
            "writeTiming": "created during future generator apply, not during preview load",
        },
        "notes": (
            "Read-only normalized Recruit plus linked Player profiles for generator preview. "
            "Generation writes remain empty until config, validation, sidecar, and apply flows are implemented."
        ),
    }


def recruiting_board_from_payload(payload: bytes, save_fingerprint: str, save_name: str = "") -> dict:
    with tempfile.TemporaryDirectory(prefix="cfb27-recruiting-board-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        input_path = temp_dir / "input.frk"
        input_path.write_bytes(payload)
        result = run_franchise_helper(
            ["recruiting-board", str(input_path)],
            timeout=120,
        )
    result["saveName"] = save_name or result.get("saveName") or ""
    result["saveFingerprint"] = save_fingerprint
    result["readOnly"] = True
    result.setdefault("previewOnly", True)
    return result


def search_players_from_payload(payload: bytes, query: str, limit: int = 100) -> dict:
    with tempfile.TemporaryDirectory(prefix="cfb27-player-search-") as temp_dir_name:
        input_path = Path(temp_dir_name) / "input.frk"
        input_path.write_bytes(payload)
        return run_franchise_helper(
            ["player-search", str(input_path), str(query or ""), str(max(1, min(limit, 500)))],
            timeout=120,
        )


RECRUITING_WEEKLY_ACTION_HOURS = {
    "SearchSocialMedia": 5,
    "ContactHighSchoolCoaches": 10,
    "ContactFriendsAndFamily": 25,
    "SendTheHouse": 50,
}


def preview_recruiting_plan(board: dict, plans: object, expected_fingerprint: str = "") -> dict:
    normalized_plans = plans if isinstance(plans, list) else []
    errors: list[dict] = []
    warnings: list[dict] = []
    if plans is not None and not isinstance(plans, list):
        errors.append({"code": "plans-not-list", "message": "plans must be a list"})
    if expected_fingerprint and expected_fingerprint != board.get("saveFingerprint"):
        errors.append(
            {
                "code": "stale-save-fingerprint",
                "message": "Save fingerprint changed; reload the recruiting board before previewing.",
            }
        )
    if normalized_plans:
        warnings.append(
            {
                "code": "write-gated",
                "message": "Recruiting plans are preview-only until 017 enables copy-first applies.",
            }
        )
    counters = board.get("counters", {}) if isinstance(board.get("counters"), dict) else {}
    planned_hours = 0
    planned_targets: list[dict] = []
    targets_by_id = {
        str(target.get("id")): target
        for target in board.get("targets", [])
        if isinstance(target, dict) and target.get("id") is not None
    }
    targets_by_user_row = {
        int(((target.get("provenance") or {}).get("userRecruitTargetRow")))
        : target
        for target in board.get("targets", [])
        if isinstance(target, dict)
        and isinstance(target.get("provenance"), dict)
        and isinstance((target.get("provenance") or {}).get("userRecruitTargetRow"), int)
    }
    for plan in normalized_plans:
        if not isinstance(plan, dict):
            errors.append({"code": "invalid-plan", "message": "Every plan item must be an object"})
            continue
        plan_type = str(plan.get("type") or "")
        if plan_type == "add-prospect-to-board":
            planned_targets.append(
                {
                    "type": plan_type,
                    "name": plan.get("name"),
                    "recruitRow": plan.get("recruitRow"),
                    "playerRow": plan.get("playerRow"),
                    "hoursDelta": 0,
                    "status": "allocation-write-gated",
                }
            )
            continue
        if plan_type != "set-weekly-action":
            errors.append({"code": "unsupported-plan", "message": f"Unsupported recruiting plan type: {plan_type or '<blank>'}"})
            continue
        action_field = str(plan.get("actionField") or "")
        if action_field not in RECRUITING_WEEKLY_ACTION_HOURS:
            errors.append({"code": "unsupported-action", "message": f"Unsupported weekly action field: {action_field or '<blank>'}"})
            continue
        target = targets_by_id.get(str(plan.get("targetId") or ""))
        user_row = plan.get("userRecruitTargetRow")
        if target is None and isinstance(user_row, int):
            target = targets_by_user_row.get(user_row)
        if target is None:
            errors.append({"code": "target-not-found", "message": f"Recruiting target was not found for action {action_field}"})
            continue
        current_enabled = bool(((target.get("actionBooleans") or {}).get(action_field)))
        enabled = bool(plan.get("enabled"))
        expected_delta = RECRUITING_WEEKLY_ACTION_HOURS[action_field] * (1 if enabled else -1)
        if current_enabled == enabled:
            errors.append({"code": "no-action-change", "message": f"{action_field} is already {'enabled' if enabled else 'disabled'}"})
            continue
        supplied_delta = int(plan.get("hoursDelta") or 0)
        if supplied_delta != expected_delta:
            errors.append({"code": "invalid-hour-delta", "message": f"{action_field} expected hour delta {expected_delta}, got {supplied_delta}"})
            continue
        planned_hours += expected_delta
        planned_targets.append(
            {
                "type": plan_type,
                "targetId": target.get("id"),
                "name": target.get("name"),
                "userRecruitTargetRow": (target.get("provenance") or {}).get("userRecruitTargetRow"),
                "actionField": action_field,
                "enabled": enabled,
                "hoursDelta": expected_delta,
                "status": "validated-preview-write-gated",
            }
        )
    hour_summary = {
        "currentUsed": counters.get("hoursUsed"),
        "currentMax": counters.get("hoursMax"),
        "plannedDelta": planned_hours,
        "projectedUsed": (counters.get("hoursUsed") or 0) + planned_hours,
    }
    return {
        "valid": not errors,
        "writeEnabled": False,
        "readOnly": True,
        "errors": errors,
        "warnings": warnings,
        "hourSummary": hour_summary,
        "plannedTargets": planned_targets,
        "writeGates": board.get("writeGates", {}),
        "saveFingerprint": board.get("saveFingerprint"),
    }


def patch_recruit_payload(payload: bytes, row_id: str, changes: dict, mode: str = "manual") -> tuple[bytes, dict]:
    if not isinstance(changes, dict) or not changes:
        raise AppError("No changes supplied")
    validate_recruit_patch_capabilities(changes, mode=mode)
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


def patch_recruits_payload(payload: bytes, patches: list[dict], mode: str = "generator") -> tuple[bytes, list[dict]]:
    if not patches:
        return payload, []
    normalized_patches: list[dict] = []
    seen_rows: set[str] = set()
    for patch in patches:
        row_id = str(patch.get("id", ""))
        changes = patch.get("changes")
        if not row_id:
            raise AppError("Batch patch row id is required")
        if row_id in seen_rows:
            raise AppError(f"Recruit row {row_id} was supplied more than once")
        seen_rows.add(row_id)
        if not isinstance(changes, dict) or not changes:
            raise AppError(f"No changes supplied for recruit row {row_id}")
        validate_recruit_patch_capabilities(changes, mode=mode)
        normalized_patches.append({"id": row_id, "changes": changes})

    with tempfile.TemporaryDirectory(prefix="cfb27-recruit-batch-patch-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        input_path = temp_dir / "input.frk"
        output_path = temp_dir / "output.frk"
        patch_path = temp_dir / "patches.json"
        input_path.write_bytes(payload)
        patch_path.write_text(json.dumps({"patches": normalized_patches}), encoding="ascii")
        result = run_franchise_helper(
            ["patch-batch", str(input_path), str(patch_path), str(output_path)],
            timeout=240,
        )
        if not output_path.exists():
            raise AppError("Recruit batch patch did not produce an output payload", 500)
        return output_path.read_bytes(), result.get("players", [])


def recruit_patch_value_from_profile(profile: dict, key: str) -> object:
    football = profile.get("footballProfile", {})
    game = profile.get("gameFields", {})
    identity = profile.get("identity", {})
    ratings = game.get("ratings", {})
    if key == "national_rank":
        return football.get("nationalRank")
    if key == "position_rank":
        return football.get("positionRank")
    if key == "state_rank":
        return football.get("stateRank")
    if key == "position":
        return football.get("position")
    if key == "star_rating":
        return game.get("starRating")
    if key == "dev_trait":
        return game.get("developmentTrait")
    if key == "height_inches":
        return game.get("heightInches")
    if key == "weight_lbs":
        return game.get("weightLbs")
    if key == "first_name":
        return identity.get("firstName")
    if key == "last_name":
        return identity.get("lastName")
    if key in ratings:
        return ratings.get(key)
    return None


def build_generator_apply_patches(preview: dict) -> list[dict]:
    patches: list[dict] = []
    for profile in preview.get("recruits", []):
        changes = profile.get("gameFields", {}).get("generatedWrites", {})
        if not changes:
            continue
        recruit_row = profile.get("source", {}).get("recruitRow")
        if recruit_row is None:
            raise AppError("Generated recruit is missing source recruit row", 500)
        validate_recruit_patch_capabilities(changes, mode="generator")
        patches.append(
            {
                "id": str(recruit_row),
                "recruitId": profile.get("recruitId"),
                "playerId": profile.get("playerId"),
                "source": profile.get("source", {}),
                "changes": changes,
            }
        )
    return patches


def compare_generator_read_back(preview: dict, read_back: dict) -> list[dict]:
    by_recruit_row = {
        str(profile.get("source", {}).get("recruitRow")): profile
        for profile in read_back.get("recruits", [])
    }
    mismatches: list[dict] = []
    for profile in preview.get("recruits", []):
        changes = profile.get("gameFields", {}).get("generatedWrites", {})
        if not changes:
            continue
        recruit_row = str(profile.get("source", {}).get("recruitRow"))
        actual_profile = by_recruit_row.get(recruit_row)
        if not actual_profile:
            mismatches.append(
                {
                    "recruitId": profile.get("recruitId"),
                    "recruitRow": recruit_row,
                    "field": "*",
                    "expected": "present",
                    "actual": "missing",
                }
            )
            continue
        for key, expected in changes.items():
            actual = recruit_patch_value_from_profile(actual_profile, key)
            if actual != expected:
                mismatches.append(
                    {
                        "recruitId": profile.get("recruitId"),
                        "playerId": profile.get("playerId"),
                        "recruitRow": recruit_row,
                        "field": key,
                        "expected": expected,
                        "actual": actual,
                    }
                )
    return mismatches


def config_hash(config: dict) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode("utf-8")).hexdigest().upper()


def sidecar_record_from_profile(profile: dict, generation_version: str, normalized_config: dict, seed: str) -> dict:
    football = profile.get("footballProfile", {})
    game = profile.get("gameFields", {})
    identity = profile.get("identity", {})
    intent = profile.get("generationIntent", {})
    source = profile.get("source", {})
    appearance = game.get("appearanceToken", {})
    return {
        "id": profile.get("sidecar", {}).get("recordId"),
        "player_id": source.get("playerRow"),
        "recruit_id": source.get("recruitRow"),
        "generation_version": generation_version,
        "config_id": normalized_config.get("id"),
        "config_hash": config_hash(normalized_config),
        "seed": seed,
        "national_rank": football.get("nationalRank"),
        "position": football.get("position"),
        "archetype": football.get("archetype"),
        "profile_type": football.get("profileType"),
        "body_composition": football.get("bodyComposition"),
        "readiness_score": football.get("readinessScore"),
        "physical_score": football.get("physicalScore"),
        "technical_score": football.get("technicalScore"),
        "mental_score": football.get("mentalScore"),
        "ceiling_score": football.get("ceilingScore"),
        "evaluation_confidence": football.get("evaluationConfidence"),
        "initial_overall": game.get("ratings", {}).get("overall"),
        "initial_weight": game.get("weightLbs"),
        "initial_body_type": game.get("bodyType"),
        "initial_ratings": game.get("ratings", {}),
        "dev_trait": game.get("developmentTrait"),
        "quality_modifier": game.get("qualityModifier"),
        "ability_plan": intent.get("abilityPlan", []),
        "cap_plan": intent.get("capPlan", []),
        "appearance_token": appearance.get("genericHeadAssetName"),
        "portrait_id": appearance.get("portrait"),
        "name": f"{identity.get('firstName', '')} {identity.get('lastName', '')}".strip(),
        "original_values": profile.get("originalFields", {}),
        "generated_writes": game.get("generatedWrites", {}),
        "skipped_fields": profile.get("skippedFields", []),
    }


def write_generator_apply_artifacts(
    save_name: str,
    preview: dict,
    backup: dict,
    read_back_mismatches: list[dict],
    applied_recruit_count: int,
    changed_field_count: int,
    write_context: dict | None = None,
) -> tuple[dict, dict]:
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    fingerprint = preview.get("saveFingerprint") or "UNKNOWN"
    normalized_config = preview.get("normalizedConfig", {})
    sidecar_records = [
        sidecar_record_from_profile(profile, "0.1.0", normalized_config, preview.get("seed", ""))
        for profile in preview.get("recruits", [])
    ]
    sidecar_payload = {
        "schemaVersion": 1,
        "saveName": save_name,
        "saveFingerprint": fingerprint,
        "previewId": preview.get("previewId"),
        "configHash": preview.get("configHash"),
        "seed": preview.get("seed"),
        "createdAt": timestamp,
        "writeContext": write_context or {},
        "recordCount": len(sidecar_records),
        "records": sidecar_records,
    }
    report_payload = {
        "schemaVersion": 1,
        "saveName": save_name,
        "saveFingerprint": fingerprint,
        "previewId": preview.get("previewId"),
        "configHash": preview.get("configHash"),
        "seed": preview.get("seed"),
        "createdAt": timestamp,
        "appliedRecruitCount": applied_recruit_count,
        "changedFieldCount": changed_field_count,
        "backup": backup,
        "writeContext": write_context or {},
        "summary": preview.get("summary", {}),
        "validationReport": preview.get("validationReport", {}),
        "skippedFields": preview.get("skippedFields", []),
        "readBackMismatches": read_back_mismatches,
    }

    SIDECAR_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    safe_save_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", save_name)
    sidecar_path = SIDECAR_DIR / f"{safe_save_name}.{fingerprint}.{timestamp}.json"
    report_path = REPORT_DIR / f"{safe_save_name}.{preview.get('previewId', 'preview')}.{timestamp}.json"
    sidecar_path.write_text(json.dumps(sidecar_payload, indent=2, sort_keys=True), encoding="utf-8")
    report_path.write_text(json.dumps(report_payload, indent=2, sort_keys=True), encoding="utf-8")
    return (
        {
            "path": str(sidecar_path),
            "recordCount": len(sidecar_records),
            "sha256": hashlib.sha256(sidecar_path.read_bytes()).hexdigest().upper(),
        },
        {
            "path": str(report_path),
            "sha256": hashlib.sha256(report_path.read_bytes()).hexdigest().upper(),
            "validationErrorCount": len(report_payload["validationReport"].get("errors", [])),
            "validationWarningCount": len(report_payload["validationReport"].get("warnings", [])),
        },
    )


def generator_artifact_policy() -> dict:
    return {
        "storage": "app-local-json",
        "sidecarDirectory": str(SIDECAR_DIR),
        "reportDirectory": str(REPORT_DIR),
        "gitIgnored": True,
        "naming": "{saveName}.{saveFingerprintOrPreviewId}.{timestamp}.json",
        "retention": "manual cleanup through /api/generator/artifacts/cleanup",
    }


def artifact_entry(path: Path, kind: str) -> dict:
    stat = path.stat()
    return {
        "kind": kind,
        "name": path.name,
        "path": str(path),
        "size": stat.st_size,
        "modified": stat.st_mtime,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest().upper(),
    }


def generator_artifact_directory(kind: str) -> Path:
    if kind == "sidecar":
        return SIDECAR_DIR
    if kind == "report":
        return REPORT_DIR
    raise AppError("Artifact kind must be sidecar or report")


def generator_artifact_summary(kind: str, payload: object) -> dict:
    if not isinstance(payload, dict):
        return {}
    if kind == "sidecar":
        return {
            "saveName": payload.get("saveName"),
            "saveFingerprint": payload.get("saveFingerprint"),
            "previewId": payload.get("previewId"),
            "configHash": payload.get("configHash"),
            "seed": payload.get("seed"),
            "createdAt": payload.get("createdAt"),
            "recordCount": payload.get("recordCount") or len(payload.get("records", [])),
        }
    validation = payload.get("validationReport", {})
    if not isinstance(validation, dict):
        validation = {}
    return {
        "saveName": payload.get("saveName"),
        "saveFingerprint": payload.get("saveFingerprint"),
        "previewId": payload.get("previewId"),
        "configHash": payload.get("configHash"),
        "seed": payload.get("seed"),
        "createdAt": payload.get("createdAt"),
        "appliedRecruitCount": payload.get("appliedRecruitCount"),
        "changedFieldCount": payload.get("changedFieldCount"),
        "validationValid": validation.get("valid"),
        "validationErrorCount": len(validation.get("errors", [])),
        "validationWarningCount": len(validation.get("warnings", [])),
        "readBackMismatchCount": len(payload.get("readBackMismatches", [])),
    }


def get_generator_artifact(kind: str, name: str) -> dict:
    if not name or Path(name).name != name:
        raise AppError("Artifact name must be a file name")
    directory = generator_artifact_directory(kind).resolve()
    path = (directory / name).resolve()
    try:
        path.relative_to(directory)
    except ValueError as exc:
        raise AppError("Artifact path escaped managed directory") from exc
    if not path.is_file() or path.suffix.lower() != ".json":
        raise AppError("Artifact not found", 404)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AppError(f"Artifact JSON is invalid: {exc}") from exc
    entry = artifact_entry(path, kind)
    return {
        "artifact": entry,
        "summary": generator_artifact_summary(kind, payload),
        "data": payload,
    }


def list_generator_artifacts(limit: int = 200) -> dict:
    artifacts: list[dict] = []
    for kind, directory in (("sidecar", SIDECAR_DIR), ("report", REPORT_DIR)):
        if not directory.exists():
            continue
        for path in directory.glob("*.json"):
            if path.is_file():
                artifacts.append(artifact_entry(path, kind))
    artifacts.sort(key=lambda item: item["modified"], reverse=True)
    return {
        "policy": generator_artifact_policy(),
        "count": len(artifacts),
        "artifacts": artifacts[: max(1, min(limit, 1000))],
    }


def cleanup_generator_artifacts(keep_latest: int = 25) -> dict:
    keep = max(0, min(int(keep_latest), 1000))
    deleted: list[dict] = []
    kept: list[dict] = []
    for kind, directory in (("sidecar", SIDECAR_DIR), ("report", REPORT_DIR)):
        if not directory.exists():
            continue
        files = sorted(
            [path for path in directory.glob("*.json") if path.is_file()],
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        for index, path in enumerate(files):
            entry = artifact_entry(path, kind)
            if index < keep:
                kept.append(entry)
                continue
            try:
                path.relative_to(directory)
            except ValueError as exc:
                raise AppError("Artifact cleanup path escaped managed directory", 500) from exc
            path.unlink()
            deleted.append(entry)
    return {
        "policy": generator_artifact_policy(),
        "keepLatestPerKind": keep,
        "deletedCount": len(deleted),
        "keptCount": len(kept),
        "deleted": deleted,
    }


def generator_patch_export_payload(preview: dict, patches: list[dict]) -> dict:
    patch_items = [
        {
            "id": patch["id"],
            "recruitId": patch.get("recruitId"),
            "playerId": patch.get("playerId"),
            "source": patch.get("source", {}),
            "changes": patch.get("changes", {}),
        }
        for patch in patches
    ]
    return {
        "dryRun": True,
        "previewId": preview.get("previewId"),
        "configHash": preview.get("configHash"),
        "saveFingerprint": preview.get("saveFingerprint"),
        "seed": preview.get("seed"),
        "valid": preview.get("valid"),
        "appliedRecruitCount": len(patch_items),
        "changedFieldCount": sum(len(item["changes"]) for item in patch_items),
        "patches": patch_items,
        "summary": preview.get("summary", {}),
        "validationReport": preview.get("validationReport", {}),
        "skippedFields": preview.get("skippedFields", []),
        "fieldCapabilities": preview.get("fieldCapabilities", field_capabilities()),
        "artifactPolicy": generator_artifact_policy(),
    }


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
                    "payload_size": container.payload_size,
                    "compressed_payload_size": container.chunk1_compressed_size,
                    "chunk1_budget": container.chunk1_budget,
                    "preserved_tail_size": len(container.source) - (container.payload_offset + container.chunk1_budget),
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

    def generator_output_path(self, source_path: Path) -> Path:
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        base_name = f"{source_path.name}-MODDED-{timestamp}"
        for suffix in ["", *[f"-{index}" for index in range(2, 100)]]:
            candidate = self.base_dir / f"{base_name}{suffix}"
            if not candidate.exists():
                return candidate
        raise AppError("Could not allocate a unique generated save copy name", 500)

    def clear_file_caches(self, file_name: str) -> None:
        for cache_key in list(self._table_cache):
            if cache_key.startswith(f"{file_name}:"):
                self._table_cache.pop(cache_key, None)
        for cache_key in list(self._occurrence_cache):
            if cache_key.startswith(f"{file_name}:"):
                self._occurrence_cache.pop(cache_key, None)

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

    def discover_live_player(self, name: str, query: str, player_row: int | None = None) -> dict:
        path, container = self.load_container(name)
        if not query.strip() and player_row is None:
            raise AppError("query or playerRow is required", 400)
        result = search_players_from_payload(container.decompressed_payload, query, limit=100)
        players = result.get("players", [])
        if player_row is not None:
            players = [player for player in players if int(player.get("row", -1)) == player_row]
        if not players:
            raise AppError("No structured Dynasty player matched that search", 404)
        if len(players) > 1:
            exact = [
                player for player in players
                if query.casefold() in {
                    str(player.get("firstName", "")).casefold(),
                    str(player.get("lastName", "")).casefold(),
                    f"{player.get('firstName', '')} {player.get('lastName', '')}".strip().casefold(),
                    str(player.get("genericHeadAssetName", "")).casefold(),
                }
            ]
            if len(exact) == 1:
                players = exact
        if len(players) != 1:
            choices = [
                {
                    "row": player.get("row"),
                    "firstName": player.get("firstName"),
                    "lastName": player.get("lastName"),
                    "position": player.get("position"),
                    "genericHeadAssetName": player.get("genericHeadAssetName"),
                }
                for player in players[:25]
            ]
            raise AppError(f"Player search is ambiguous; choose a playerRow from: {json.dumps(choices)}", 409)
        player = players[0]
        asset_name = str(player.get("genericHeadAssetName") or "")
        id_match = re.search(r"_(\d+)$", asset_name)
        if not id_match:
            raise AppError("Selected player does not have a numeric runtime asset ID", 422)
        player_id = int(id_match.group(1))
        ratings = {
            key: int(value.get("value", 0))
            for key, value in (player.get("ratings") or {}).items()
            if isinstance(value, dict) and isinstance(value.get("value"), int)
        }
        status = live_status()
        processes = status.get("gameProcesses", [])
        if not processes:
            raise AppError("CollegeFB27.exe is not running", 409)
        discovery = discover_live_player_objects(
            int(processes[0]["pid"]),
            player_id,
            ratings,
            max_scan_bytes=3 * 1024 * 1024 * 1024,
        )
        return {
            "file": self.describe_file(path, include_player_count=False),
            "player": {
                "row": player.get("row"),
                "firstName": player.get("firstName"),
                "lastName": player.get("lastName"),
                "position": player.get("position"),
                "jerseyNum": player.get("jerseyNum"),
                "playerType": player.get("playerType"),
                "development": player.get("development"),
                "genericHeadAssetName": asset_name,
                "playerId": player_id,
                "ratings": ratings,
            },
            "discovery": discovery,
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

    def get_joined_recruits(self, name: str, limit: int = 1000, offset: int = 0) -> dict:
        path, container = self.load_container(name)
        fingerprint = hashlib.sha256(container.decompressed_payload).hexdigest().upper()
        result = joined_recruit_profiles_from_payload(
            container.decompressed_payload,
            save_fingerprint=fingerprint,
            save_name=path.name,
            limit=limit,
            offset=offset,
        )
        return {
            "file": self.describe_file(path, include_player_count=False),
            **result,
        }

    def get_recruiting_board(self, name: str) -> dict:
        path, container = self.load_container(name)
        fingerprint = hashlib.sha256(container.decompressed_payload).hexdigest().upper()
        result = recruiting_board_from_payload(
            container.decompressed_payload,
            save_fingerprint=fingerprint,
            save_name=path.name,
        )
        return {
            "file": self.describe_file(path, include_player_count=False),
            **result,
        }

    def preview_recruiting(self, name: str, save_fingerprint: str, plans: object) -> dict:
        board = self.get_recruiting_board(name)
        return preview_recruiting_plan(board, plans, expected_fingerprint=save_fingerprint)

    def preview_generator(self, name: str, config: dict, seed: str, locks: dict | None = None, engine: str = "local") -> dict:
        path, container = self.load_container(name)
        fingerprint = hashlib.sha256(container.decompressed_payload).hexdigest().upper()
        if engine == "home-dogs":
            return {
                "file": self.describe_file(path, include_player_count=False),
                **run_home_dogs_preview(path, seed, fingerprint, path.name),
            }
        if engine not in {"", "local"}:
            raise AppError(f"Unsupported generator engine: {engine}", 400)
        joined = joined_recruit_profiles_from_payload(
            container.decompressed_payload,
            save_fingerprint=fingerprint,
            save_name=path.name,
            limit=7600,
            offset=0,
        )
        return {
            "file": self.describe_file(path, include_player_count=False),
            **generate_recruit_preview_from_profiles(joined, config, seed, locks=locks),
        }

    def apply_generator(
        self,
        name: str,
        config: dict,
        seed: str,
        preview_id: str,
        config_hash_value: str,
        confirm: bool,
        locks: dict | None = None,
        write_mode: str = "copy",
        engine: str = "local",
        home_dogs_preview_path: object = None,
        expected_save_fingerprint: str = "",
    ) -> dict:
        if confirm is not True:
            raise AppError("confirm must be true before applying generated recruits", 400)
        if write_mode not in {"copy", "overwrite"}:
            raise AppError("writeMode must be copy or overwrite", 400)
        if not isinstance(config, dict):
            raise AppError("config is required for server-side preview regeneration", 400)
        if not isinstance(preview_id, str) or not preview_id:
            raise AppError("previewId is required", 400)
        if not isinstance(config_hash_value, str) or not config_hash_value:
            raise AppError("configHash is required", 400)

        path, container = self.load_container(name)
        before_fingerprint = hashlib.sha256(container.decompressed_payload).hexdigest().upper()
        if engine == "home-dogs":
            if write_mode != "copy":
                raise AppError("Home Dogs apply currently supports copy mode only", 400)
            if expected_save_fingerprint and expected_save_fingerprint != before_fingerprint:
                raise AppError("Save fingerprint changed while preparing Home Dogs apply; regenerate preview", 409)
            preview_path = validated_home_dogs_preview_path(home_dogs_preview_path)
            if preview_path is None:
                regenerated = run_home_dogs_preview(path, seed, before_fingerprint, path.name)
                preview_path = validated_home_dogs_preview_path(regenerated.get("homeDogs", {}).get("previewPath"))
                preview = regenerated
            else:
                report_path = preview_path.with_name("generator-report.json")
                if not report_path.is_file():
                    raise AppError("Home Dogs report artifact was not found; regenerate preview", 404)
                home_preview = json.loads(preview_path.read_text(encoding="utf-8"))
                home_report = json.loads(report_path.read_text(encoding="utf-8"))
                preview = adapt_home_dogs_preview(home_preview, home_report, before_fingerprint, seed, path.name, resolve_home_dogs_repo() or Path(""))
            if preview.get("saveFingerprint") != before_fingerprint:
                raise AppError("Save fingerprint changed while preparing Home Dogs apply; regenerate preview", 409)
            if preview.get("previewId") != preview_id:
                raise AppError("Home Dogs preview no longer matches this save/seed; regenerate preview", 409)
            if preview.get("configHash") != config_hash_value:
                raise AppError("Home Dogs config hash no longer matches this preview; regenerate preview", 409)
            if not preview.get("valid") or preview.get("errors"):
                raise AppError("Home Dogs preview has blocking validation errors and cannot be applied", 422)
            backup = self.create_backup(name)
            target_path = self.generator_output_path(path)
            result = run_home_dogs_apply(path, preview_path, target_path, backup)
            self.clear_file_caches(target_path.name)
            read_back_container = FBChunks.parse(target_path.read_bytes())
            result["previewId"] = preview.get("previewId")
            result["configHash"] = preview.get("configHash")
            result["saveFingerprintBefore"] = before_fingerprint
            result["saveFingerprintAfter"] = hashlib.sha256(read_back_container.decompressed_payload).hexdigest().upper()
            return result
        if engine not in {"", "local"}:
            raise AppError(f"Unsupported generator engine: {engine}", 400)
        joined = joined_recruit_profiles_from_payload(
            container.decompressed_payload,
            save_fingerprint=before_fingerprint,
            save_name=path.name,
            limit=7600,
            offset=0,
        )
        preview = generate_recruit_preview_from_profiles(joined, config, seed, locks=locks)
        if preview.get("saveFingerprint") != before_fingerprint:
            raise AppError("Save fingerprint changed while preparing apply; regenerate preview", 409)
        if preview.get("previewId") != preview_id:
            raise AppError("Preview no longer matches this save/config/seed; regenerate preview", 409)
        if preview.get("configHash") != config_hash_value:
            raise AppError("Config hash no longer matches the preview; regenerate preview", 409)
        if not preview.get("valid") or preview.get("errors"):
            raise AppError("Generated preview has blocking validation errors and cannot be applied", 422)
        validation_report = preview.get("validationReport", {})
        if not validation_report.get("valid", False):
            raise AppError("Validation report has blocking errors and cannot be applied", 422)

        patches = build_generator_apply_patches(preview)
        changed_field_count = sum(len(patch["changes"]) for patch in patches)
        if changed_field_count:
            new_payload, _ = patch_recruits_payload(container.decompressed_payload, patches, mode="generator")
            rebuilt = container.rebuild(new_payload)
        else:
            rebuilt = container.source
        FBChunks.parse(rebuilt)
        backup = self.create_backup(name)
        target_path = path if write_mode == "overwrite" else self.generator_output_path(path)
        atomic_write_bytes(target_path, rebuilt)
        self.clear_file_caches(target_path.name)
        if write_mode == "overwrite":
            self.clear_file_caches(path.name)

        read_back_container = FBChunks.parse(target_path.read_bytes())
        read_back_joined = joined_recruit_profiles_from_payload(
            read_back_container.decompressed_payload,
            save_fingerprint=hashlib.sha256(read_back_container.decompressed_payload).hexdigest().upper(),
            save_name=target_path.name,
            limit=7600,
            offset=0,
        )
        mismatches = compare_generator_read_back(preview, read_back_joined)
        sidecar: dict | None = None
        report: dict | None = None
        artifact_error = ""
        try:
            sidecar, report = write_generator_apply_artifacts(
                target_path.name,
                preview,
                backup,
                mismatches,
                applied_recruit_count=len(patches),
                changed_field_count=changed_field_count,
                write_context={
                    "writeMode": write_mode,
                    "sourceFile": path.name,
                    "targetFile": target_path.name,
                    "targetPath": str(target_path),
                    "sourceUnchanged": write_mode == "copy",
                    "saveFingerprintBefore": before_fingerprint,
                    "saveFingerprintAfter": read_back_joined.get("saveFingerprint"),
                },
            )
        except Exception as exc:
            artifact_error = str(exc) or exc.__class__.__name__
        return {
            "applied": not mismatches,
            "writeSucceeded": True,
            "artifactWriteSucceeded": not artifact_error,
            "artifactError": artifact_error,
            "appliedRecruitCount": len(patches),
            "changedFieldCount": changed_field_count,
            "backup": backup,
            "sidecar": sidecar,
            "report": report,
            "readBackMismatches": mismatches,
            "previewId": preview.get("previewId"),
            "configHash": preview.get("configHash"),
            "writeMode": write_mode,
            "sourceFile": path.name,
            "targetFile": target_path.name,
            "targetPath": str(target_path),
            "sourceUnchanged": write_mode == "copy",
            "saveFingerprintBefore": before_fingerprint,
            "saveFingerprintAfter": read_back_joined.get("saveFingerprint"),
        }

    def export_generator_patch(
        self,
        name: str,
        config: dict,
        seed: str,
        preview_id: str,
        config_hash_value: str,
        locks: dict | None = None,
    ) -> dict:
        if not isinstance(config, dict):
            raise AppError("config is required for server-side patch export", 400)
        if not isinstance(preview_id, str) or not preview_id:
            raise AppError("previewId is required", 400)
        if not isinstance(config_hash_value, str) or not config_hash_value:
            raise AppError("configHash is required", 400)
        path, container = self.load_container(name)
        fingerprint = hashlib.sha256(container.decompressed_payload).hexdigest().upper()
        joined = joined_recruit_profiles_from_payload(
            container.decompressed_payload,
            save_fingerprint=fingerprint,
            save_name=path.name,
            limit=7600,
            offset=0,
        )
        preview = generate_recruit_preview_from_profiles(joined, config, seed, locks=locks)
        if preview.get("previewId") != preview_id:
            raise AppError("Preview no longer matches this save/config/seed; regenerate preview", 409)
        if preview.get("configHash") != config_hash_value:
            raise AppError("Config hash no longer matches the preview; regenerate preview", 409)
        if not preview.get("valid") or preview.get("errors"):
            raise AppError("Generated preview has blocking validation errors and cannot be exported", 422)
        validation_report = preview.get("validationReport", {})
        if not validation_report.get("valid", False):
            raise AppError("Validation report has blocking errors and cannot be exported", 422)
        patches = build_generator_apply_patches(preview)
        return generator_patch_export_payload(preview, patches)

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
        atomic_write_bytes(path, rebuilt)
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
        atomic_write_bytes(path, rebuilt)
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
        atomic_write_bytes(path, rebuilt)
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

    def patch_recruit(self, name: str, row_id: str, changes: dict, mode: str = "manual") -> dict:
        path, container = self.load_container(name)
        new_payload, updated_player = patch_recruit_payload(
            container.decompressed_payload,
            row_id=row_id,
            changes=changes,
            mode=mode,
        )
        rebuilt = container.rebuild(new_payload)
        FBChunks.parse(rebuilt)
        backup = self.create_backup(name)
        atomic_write_bytes(path, rebuilt)
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


def apply_live_rating_layers(
    store: SaveStore,
    file_name: str,
    pid: int,
    row: int,
    field: str,
    expected: int,
    value: int,
) -> dict[str, object]:
    """Write verified live copies first, then arm persistence fallbacks."""
    save_path = store.validate_filename(file_name)
    attach_hook(pid)
    player_patch = player_rating_patch(save_path, row, field, value)
    if int(player_patch["expectedBefore"]) != expected:
        raise ValueError(
            f"The selected save has {field}={player_patch['expectedBefore']}, not the expected {expected}"
        )
    player_id = int(player_patch.get("player", {}).get("playerId") or 0)
    if player_id <= 0:
        raise ValueError("The selected Player record does not have a PresentationId")

    patch_player = player_patch.get("player") or {}
    player_query = str(patch_player.get("lastName") or patch_player.get("firstName") or "").strip()
    if not player_query:
        raise ValueError("The selected Player record does not have a searchable name")
    snapshot = store.discover_live_player(file_name, player_query, player_row=row)
    player = snapshot.get("player") or {}
    if int(player.get("playerId") or 0) != player_id:
        raise ValueError("The selected save and live discovery resolved different player IDs")
    discovery = snapshot.get("discovery") or {}
    object_addresses = [int(item["address"]) for item in discovery.get("objects", [])]
    if not object_addresses:
        raise RuntimeError("No verified live player copies were found")

    direct_write = write_live_player_rating(
        pid,
        object_addresses,
        player_id,
        field,
        expected,
        value,
    )
    attach_response_guard(pid)
    queued = queue_response_rating(pid, player_id, field, expected, value)
    unlocked = unlock_dynasty_player_editing(pid, save_path)
    monitor = start_dynasty_unlock_monitor(pid, save_path, extra_patches=[player_patch])

    expected_ratings = dict(player.get("ratings") or {})
    expected_ratings[field] = value
    post_discovery = discover_live_player_objects(pid, player_id, expected_ratings)
    updated_player = dict(player)
    updated_player["ratings"] = expected_ratings
    return {
        "ok": True,
        "directWrite": direct_write,
        "queued": queued,
        "unlocked": unlocked,
        "patch": player_patch,
        "monitor": monitor,
        "player": updated_player,
        "discovery": post_discovery,
        "refresh": "instant-pending-verification",
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
            if parsed.path in {"/", "/index.html", "/recruiting"}:
                self.serve_static("index.html")
                return
            if self.path.startswith("/static/"):
                self.serve_static(self.path.removeprefix("/static/"))
                return
            if parsed.path == "/api/health":
                self.send_json(
                    200,
                    {
                        "ok": True,
                        "app": "cfb27-save-editor",
                        "saveDirectory": str(SAVE_DIR),
                    },
                )
                return
            if parsed.path == "/api/live/status":
                self.send_json(200, live_status())
                return
            if parsed.path == "/api/live/hook/status":
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    self.send_json(200, {"loaded": False, "ready": False, "reason": "CollegeFB27.exe is not running"})
                    return
                self.send_json(200, hook_status(int(processes[0]["pid"])))
                return
            if parsed.path == "/api/live/lua/status":
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    self.send_json(200, {"loaded": False, "ready": False, "reason": "CollegeFB27.exe is not running"})
                    return
                self.send_json(200, startup_lua_status(int(processes[0]["pid"])))
                return
            if parsed.path == "/api/live/hook/unlock-status":
                self.send_json(200, dynasty_unlock_monitor_status())
                return
            if parsed.path == "/api/live/scripts":
                self.send_json(200, {"scripts": list_lua_scripts()})
                return
            if self.path == "/api/files":
                self.send_json(200, {"directory": str(STORE.base_dir), "files": STORE.list_files()})
                return
            if parsed.path == "/api/generator/field-capabilities":
                self.send_json(200, field_capabilities())
                return
            if parsed.path == "/api/generator/home-dogs/status":
                self.send_json(200, home_dogs_status())
                return
            if parsed.path == "/api/generator/default-configs":
                self.send_json(200, default_generator_configs())
                return
            if parsed.path == "/api/generator/artifacts":
                limit = int(query_params.get("limit", ["200"])[0])
                self.send_json(200, list_generator_artifacts(limit=limit))
                return
            if parsed.path == "/api/generator/artifact":
                kind = query_params.get("kind", [""])[0]
                name = query_params.get("name", [""])[0]
                self.send_json(200, get_generator_artifact(kind, name))
                return
            if parsed.path.startswith("/api/generator/recruits/"):
                parts = parsed.path.split("/")
                if len(parts) == 5:
                    limit = int(query_params.get("limit", ["1000"])[0])
                    offset = int(query_params.get("offset", ["0"])[0])
                    self.send_json(200, STORE.get_joined_recruits(parts[4], limit=limit, offset=offset))
                    return
            if parsed.path.startswith("/api/recruiting/"):
                parts = parsed.path.split("/")
                if len(parts) == 4:
                    self.send_json(200, STORE.get_recruiting_board(parts[3]))
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
        global SAVE_DIR, STORE
        try:
            if self.path == "/api/settings/save-directory":
                body = self.read_json_body()
                raw_directory = body.get("directory")
                if not isinstance(raw_directory, str) or not raw_directory.strip():
                    raise AppError("Choose a save folder first", 400)
                directory = Path(raw_directory).expanduser().resolve()
                if not directory.is_dir():
                    raise AppError("That save folder does not exist", 400)
                try:
                    next_store = SaveStore(directory)
                    files = next_store.list_files()
                except OSError as exc:
                    raise AppError(f"Cannot read that save folder: {exc}", 400) from exc
                SAVE_DIR = directory
                STORE = next_store
                self.send_json(200, {"directory": str(directory), "files": files})
                return
            if self.path == "/api/live/discover-player":
                body = self.read_json_body()
                file_name = body.get("file")
                query = body.get("query")
                if isinstance(file_name, str) and file_name and isinstance(query, str):
                    player_row = body.get("playerRow")
                    if player_row is not None and not isinstance(player_row, int):
                        raise AppError("playerRow must be an integer", 400)
                    self.send_json(200, STORE.discover_live_player(file_name, query, player_row=player_row))
                    return
                player_id = body.get("playerId")
                ratings = body.get("ratings")
                if not isinstance(player_id, int):
                    raise AppError("playerId must be an integer", 400)
                if not isinstance(ratings, dict):
                    raise AppError("ratings must be an object", 400)
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                self.send_json(
                    200,
                    discover_live_player_objects(int(processes[0]["pid"]), player_id, ratings),
                )
                return
            if self.path == "/api/live/hook/attach":
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                if status.get("anticheatProcesses"):
                    raise AppError("A real EA anticheat/Javelin process is running; hook loading is blocked", 403)
                recognized = any(
                    build.get("recognized") for build in status.get("builds", [])
                    if str(build.get("path", "")).lower().endswith("collegefb27.exe")
                )
                if not recognized:
                    raise AppError("The running CFB27 build is not recognized; hook loading is blocked", 409)
                try:
                    self.send_json(200, attach_hook(int(processes[0]["pid"])))
                except (FileNotFoundError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                return
            if self.path == "/api/live/hook/queue-rating":
                body = self.read_json_body()
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                field = body.get("field")
                expected = body.get("expected")
                value = body.get("value")
                if not isinstance(field, str) or not isinstance(expected, int) or not isinstance(value, int):
                    raise AppError("field, expected, and value are required", 400)
                try:
                    player_id = body.get("playerId")
                    if not isinstance(player_id, int):
                        raise AppError("playerId is required", 400)
                    result = queue_response_rating(int(processes[0]["pid"]), player_id, field, expected, value)
                except (FileNotFoundError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                if not result.get("ok"):
                    raise AppError(str(result.get("error") or "The hook rejected the rating"), 409)
                self.send_json(200, result)
                return
            if self.path == "/api/live/hook/unlock-editing":
                body = self.read_json_body()
                file_name = body.get("file")
                if not isinstance(file_name, str) or not file_name:
                    raise AppError("file is required", 400)
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                if status.get("anticheatProcesses"):
                    raise AppError("A real EA anticheat/Javelin process is running; live writes are blocked", 403)
                try:
                    result = unlock_dynasty_player_editing(int(processes[0]["pid"]), save_path)
                    result["monitor"] = start_dynasty_unlock_monitor(int(processes[0]["pid"]), save_path)
                except (FileNotFoundError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                self.send_json(200, result)
                return
            if self.path == "/api/live/hook/apply-rating":
                body = self.read_json_body()
                file_name = body.get("file")
                row = body.get("row")
                field = body.get("field")
                expected = body.get("expected")
                value = body.get("value")
                if not isinstance(file_name, str) or not file_name:
                    raise AppError("file is required", 400)
                if not isinstance(row, int) or not isinstance(field, str):
                    raise AppError("row and field are required", 400)
                if not isinstance(expected, int) or not isinstance(value, int):
                    raise AppError("expected and value are required", 400)
                save_path = STORE.validate_filename(file_name)
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                if status.get("anticheatProcesses"):
                    raise AppError("A real EA anticheat/Javelin process is running; live writes are blocked", 403)
                pid = int(processes[0]["pid"])
                try:
                    result = apply_live_rating_layers(
                        STORE,
                        file_name,
                        pid,
                        row,
                        field,
                        expected,
                        value,
                    )
                except (FileNotFoundError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                self.send_json(200, result)
                return
            if self.path == "/api/live/lua/eval":
                body = self.read_json_body()
                script = body.get("script")
                if not isinstance(script, str) or not script.strip():
                    raise AppError("script is required", 400)
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                pid = int(processes[0]["pid"])
                host = startup_lua_status(pid)
                if not host.get("loaded") or not host.get("ready"):
                    raise AppError(str(host.get("reason") or "The persistent Lua host is not ready"), 409)
                try:
                    result = eval_startup_lua(pid, script)
                except (FileNotFoundError, PermissionError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                if not result.get("ok"):
                    raise AppError(str(result.get("result") or result.get("error") or "Lua evaluation failed"), 409)
                self.send_json(200, result)
                return
            if self.path == "/api/live/hook/run-script":
                body = self.read_json_body()
                script = body.get("script")
                if not isinstance(script, str):
                    raise AppError("script is required", 400)
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                try:
                    result = run_lua_script(int(processes[0]["pid"]), script)
                except (FileNotFoundError, PermissionError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                if not result.get("ok"):
                    raise AppError(str(result.get("result") or result.get("error") or "Lua script failed"), 409)
                self.send_json(200, result)
                return
            if self.path == "/api/live/hook/clear":
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                try:
                    pid = int(processes[0]["pid"])
                    primary = hook_command(pid, "CLEAR")
                    guard = response_guard_status(pid)
                    if guard.get("loaded"):
                        from native_hook import _hook_command_to_pipe, RESPONSE_GUARD_PIPE_PREFIX
                        guard = _hook_command_to_pipe(pid, "CLEAR", pipe_prefix=RESPONSE_GUARD_PIPE_PREFIX)
                    self.send_json(200, {"ok": True, "primary": primary, "responseGuard": guard})
                except (FileNotFoundError, RuntimeError, OSError, ValueError) as exc:
                    raise AppError(str(exc), 409) from exc
                return
            if self.path == "/api/live/write-rating":
                body = self.read_json_body()
                if body.get("confirm") is not True or body.get("confirmOffline") is not True:
                    raise AppError("confirm and confirmOffline must both be true", 400)
                status = live_status()
                processes = status.get("gameProcesses", [])
                if not processes:
                    raise AppError("CollegeFB27.exe is not running", 409)
                if status.get("anticheatProcesses"):
                    raise AppError("A real EA anticheat/Javelin process is running; live writes are blocked", 403)
                recognized = any(
                    build.get("recognized") for build in status.get("builds", [])
                    if str(build.get("path", "")).lower().endswith("collegefb27.exe")
                )
                if not recognized:
                    raise AppError("The running CFB27 build is not recognized; live writes are blocked", 409)
                player_id = body.get("playerId")
                addresses = body.get("objectAddresses")
                field = body.get("field")
                before = body.get("expectedBefore")
                value = body.get("value")
                if not isinstance(player_id, int) or not isinstance(addresses, list):
                    raise AppError("playerId and objectAddresses are required", 400)
                if not isinstance(field, str) or not isinstance(before, int) or not isinstance(value, int):
                    raise AppError("field, expectedBefore, and value are required", 400)
                parsed_addresses = []
                for address in addresses:
                    if isinstance(address, int):
                        parsed_addresses.append(address)
                    elif isinstance(address, str):
                        parsed_addresses.append(int(address, 0))
                    else:
                        raise AppError("objectAddresses must contain integers or hexadecimal strings", 400)
                try:
                    result = write_live_player_rating(
                        int(processes[0]["pid"]),
                        parsed_addresses,
                        player_id,
                        field,
                        before,
                        value,
                    )
                except (ValueError, RuntimeError, OSError) as exc:
                    raise AppError(str(exc), 409) from exc
                self.send_json(200, result)
                return
            if self.path == "/api/generator/preview":
                body = self.read_json_body()
                file_name = body.get("file")
                if not isinstance(file_name, str) or not file_name:
                    raise AppError("file is required")
                config = body.get("config")
                seed = str(body.get("seed") or "default")
                locks = body.get("locks")
                engine = str(body.get("engine") or "local")
                if locks is not None and not isinstance(locks, dict):
                    raise AppError("locks must be an object when supplied")
                self.send_json(200, STORE.preview_generator(file_name, config, seed, locks=locks, engine=engine))
                return
            if self.path == "/api/generator/apply":
                body = self.read_json_body()
                file_name = body.get("file")
                if not isinstance(file_name, str) or not file_name:
                    raise AppError("file is required")
                locks = body.get("locks")
                if locks is not None and not isinstance(locks, dict):
                    raise AppError("locks must be an object when supplied")
                self.send_json(
                    200,
                    STORE.apply_generator(
                        file_name,
                        body.get("config"),
                        str(body.get("seed") or "default"),
                        str(body.get("previewId") or ""),
                        str(body.get("configHash") or ""),
                        body.get("confirm") is True,
                        locks=locks,
                        write_mode=str(body.get("writeMode") or "copy"),
                        engine=str(body.get("engine") or "local"),
                        home_dogs_preview_path=body.get("homeDogsPreviewPath"),
                        expected_save_fingerprint=str(body.get("saveFingerprint") or ""),
                    ),
                )
                return
            if self.path == "/api/generator/patch-export":
                body = self.read_json_body()
                file_name = body.get("file")
                if not isinstance(file_name, str) or not file_name:
                    raise AppError("file is required")
                locks = body.get("locks")
                if locks is not None and not isinstance(locks, dict):
                    raise AppError("locks must be an object when supplied")
                self.send_json(
                    200,
                    STORE.export_generator_patch(
                        file_name,
                        body.get("config"),
                        str(body.get("seed") or "default"),
                        str(body.get("previewId") or ""),
                        str(body.get("configHash") or ""),
                        locks=locks,
                    ),
                )
                return
            if self.path == "/api/generator/config/validate":
                body = self.read_json_body()
                self.send_json(200, normalize_generator_config(body.get("config"), recruit_count=body.get("recruitCount")))
                return
            if self.path == "/api/recruiting/preview":
                body = self.read_json_body()
                file_name = body.get("file")
                if not isinstance(file_name, str) or not file_name:
                    raise AppError("file is required")
                self.send_json(
                    200,
                    STORE.preview_recruiting(
                        file_name,
                        str(body.get("saveFingerprint") or ""),
                        body.get("plans", []),
                    ),
                )
                return
            if self.path == "/api/generator/artifacts/cleanup":
                body = self.read_json_body()
                self.send_json(200, cleanup_generator_artifacts(keep_latest=int(body.get("keepLatestPerKind", 25))))
                return
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
                    mode = body.get("mode", "manual")
                    changes = body.get("changes")
                    if changes is None:
                        changes = {key: value for key, value in body.items() if key != "mode"}
                    self.send_json(200, STORE.patch_recruit(parts[3], parts[5], changes, mode=mode))
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
