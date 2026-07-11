from __future__ import annotations

import argparse
import json
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = APP_DIR / ".requirements" / "research" / "upstream-cfb27-recruiting-tuning-tables.json"
DEFAULT_OUTPUT = APP_DIR / ".requirements" / "research" / "upstream-cfb27-recruiting-decode-maps.json"

ACTION_FIELD_TO_VALUE = {
    "SearchSocialMedia": "101",
    "ContactHighSchoolCoaches": "110",
    "ContactFriendsAndFamily": "111",
    "SendTheHouse": "1000",
}

ACTION_FIELD_STATUS = {
    "SearchSocialMedia": "validated-015",
    "ContactHighSchoolCoaches": "validated-015",
    "ContactFriendsAndFamily": "validated-015",
    "SendTheHouse": "validated-multi-source",
}


def decode_keys(value: object) -> list[str]:
    raw = str(value)
    keys = [raw]
    if raw and set(raw) <= {"0", "1"}:
        keys.append(str(int(raw, 2)))
        keys.append(f"0b{raw}")
    return list(dict.fromkeys(keys))


def enum_entry(record: dict) -> dict:
    return {
        "value": record.get("Value"),
        "shortName": record.get("ShortName"),
        "longName": record.get("LongName"),
        "description": record.get("Description"),
        "sourceIndex": record.get("_index"),
    }


def table_by_name(artifact: dict, actual_name: str) -> dict | None:
    matches = [table for table in artifact.get("tables", []) if table.get("actualName") == actual_name]
    if not matches:
        return None
    return sorted(matches, key=lambda table: table.get("recordCount", 0), reverse=True)[0]


def enum_map(table: dict | None) -> dict:
    if not table:
        return {}
    out = {}
    for record in table.get("records", []):
        entry = enum_entry(record)
        for key in decode_keys(record.get("Value")):
            out[key] = entry
    return out


def action_info_map(action_info_table: dict | None, action_type_map: dict, intensity_map: dict) -> dict:
    if not action_info_table:
        return {}
    out = {}
    for record in action_info_table.get("records", []):
        action_type = str(record.get("ActionType"))
        label = action_type_map.get(str(int(action_type, 2)) if set(action_type) <= {"0", "1"} else action_type)
        intensity = intensity_map.get(str(int(str(record.get("Intensity")), 2)) if set(str(record.get("Intensity"))) <= {"0", "1"} else str(record.get("Intensity")))
        entry = {
            "actionType": record.get("ActionType"),
            "action": label,
            "cost": record.get("Cost"),
            "baseInfluenceGranted": record.get("BaseInfluenceGranted"),
            "isEnabled": record.get("IsEnabled"),
            "isImmediateAction": record.get("IsImmediateAction"),
            "intensity": intensity,
            "iconId": record.get("IconId"),
            "sourceIndex": record.get("_index"),
        }
        for key in decode_keys(record.get("ActionType")):
            # Pitch has multiple intensity rows; keep all rows under variants while
            # preserving the first row as the simple lookup.
            if key in out:
                existing = out[key]
                existing.setdefault("variants", [dict(existing)])
                existing["variants"].append(entry)
            else:
                out[key] = entry
    return out


def action_field_map(action_info: dict) -> dict:
    out = {}
    for field, value in ACTION_FIELD_TO_VALUE.items():
        lookup_key = str(int(value, 2))
        info = action_info.get(lookup_key) or action_info.get(value)
        out[field] = {
            "field": field,
            "actionTypeValue": value,
            "status": ACTION_FIELD_STATUS[field],
            "upstream": info,
        }
    return out


def low_nibble_map(mapping: dict) -> dict:
    out = {}
    for value in mapping.values():
        raw = str(value.get("value"))
        if not raw or set(raw) - {"0", "1"}:
            continue
        out[str(int(raw, 2) & 0xF)] = value
    return out


def build_decode_maps(input_path: Path) -> dict:
    artifact = json.loads(input_path.read_text(encoding="utf-8"))
    enum_tables = {
        "RecruitingActionType": table_by_name(artifact, "RecruitingActionTypeEnumTableEntry"),
        "RecruitingActionIntensity": table_by_name(artifact, "RecruitingActionIntensityEnumTableEntry"),
        "RecruitingQuickActionType": table_by_name(artifact, "RecruitingQuickActionTypeEnumTableEntry"),
        "RecruitingPitchType": table_by_name(artifact, "RecruitingPitchTypeEnumTableEntry"),
        "RecruitingMotivation": table_by_name(artifact, "RecruitingMotivationEnumTableEntry"),
        "VisitActivityType": table_by_name(artifact, "VisitActivityTypeEnumTableEntry"),
        "RecruitingBonusType": table_by_name(artifact, "RecruitingBonusTypeEnumTableEntry"),
        "RecruitingBonusValueType": table_by_name(artifact, "RecruitingBonusValueTypeEnumTableEntry"),
        "ScoutingGrade": table_by_name(artifact, "ScoutingGradeEnumTableEntry"),
    }
    enums = {name: enum_map(table) for name, table in enum_tables.items()}
    action_info = action_info_map(
        table_by_name(artifact, "RecruitingActionInfo"),
        enums["RecruitingActionType"],
        enums["RecruitingActionIntensity"],
    )
    maps = {
        "kind": "cfb27.upstreamRecruitingDecodeMaps.v1",
        "source": str(input_path),
        "enums": enums,
        "derived": {
            "activeVisitInfoActivityLowNibble": low_nibble_map(enums["VisitActivityType"]),
        },
        "actionInfo": action_info,
        "weeklyActionFields": action_field_map(action_info),
        "tableSources": {
            name: {
                "jsonFile": table.get("jsonFile"),
                "uniqueId": table.get("uniqueId"),
                "recordCount": table.get("recordCount"),
            } if table else None
            for name, table in enum_tables.items()
        },
        "safety": {
            "writeRecipesEnabled": False,
            "note": "Decode maps are read/report aids only; write recipes still require local fixture and game validation.",
        },
    }
    return maps


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build local decode maps from exported upstream recruiting tuning tables.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    maps = build_decode_maps(args.input.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(maps, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "kind": maps["kind"],
        "output": str(args.output),
        "enumMaps": {name: len(values) for name, values in maps["enums"].items()},
        "weeklyActionFields": maps["weeklyActionFields"],
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
