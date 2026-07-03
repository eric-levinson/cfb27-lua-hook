from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from server import (
    FBChunks,
    SaveStore,
    discover_inferred_tables,
    find_dynasty_player_pool,
    schema_entries,
    schema_occurrences,
    parse_player_records,
    patch_player_payload,
)


SAVE_DIR = Path(__file__).resolve().parent.parent


class EditorTests(unittest.TestCase):
    def test_all_top_level_fbchunks_parse_and_decompress(self) -> None:
        store = SaveStore(SAVE_DIR)
        files = store.editable_files()
        self.assertGreaterEqual(len(files), 3)
        for path in files:
            with self.subTest(path=path.name):
                container = FBChunks.parse(path.read_bytes())
                self.assertGreater(len(container.decompressed_payload), 0)

    def test_no_edit_rebuild_reparses(self) -> None:
        store = SaveStore(SAVE_DIR)
        for path in store.editable_files():
            with self.subTest(path=path.name):
                container = FBChunks.parse(path.read_bytes())
                rebuilt = container.rebuild(container.decompressed_payload)
                reparsed = FBChunks.parse(rebuilt)
                self.assertEqual(reparsed.decompressed_payload, container.decompressed_payload)

    def test_patch_one_player_field_changes_only_expected_payload_text(self) -> None:
        roster = SAVE_DIR / "ROSTER-Official"
        container = FBChunks.parse(roster.read_bytes())
        records = parse_player_records(container.decompressed_payload)
        self.assertGreater(len(records), 0)
        record = records[0]
        original = record.get_text(bytes.fromhex("c26ba1"))
        replacement = original + "X" if len(original) < 20 else original[:-1]

        patched, updated = patch_player_payload(
            container.decompressed_payload,
            row_id=record.row_id,
            changes={"first_name": replacement},
        )
        self.assertNotEqual(patched, container.decompressed_payload)
        self.assertEqual(updated["first_name"], replacement)
        rebuilt = container.rebuild(patched)
        reparsed = FBChunks.parse(rebuilt)
        self.assertEqual(reparsed.decompressed_payload, patched)

    def test_discovers_roster_player_and_team_tables(self) -> None:
        roster = SAVE_DIR / "ROSTER-Official"
        container = FBChunks.parse(roster.read_bytes())
        tables = discover_inferred_tables(roster.name, container.decompressed_payload)
        by_id = {table.table_id: table for table in tables}
        self.assertIn("players", by_id)
        self.assertIn("teams", by_id)
        self.assertGreaterEqual(len(by_id["players"].record_offsets), 10000)
        self.assertGreaterEqual(len(by_id["teams"].record_offsets), 100)

    def test_writes_create_backup_and_refuse_nested_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            shutil.copy2(SAVE_DIR / "ROSTER-Official", temp / "ROSTER-Official")
            store = SaveStore(temp)

            with self.assertRaises(Exception):
                store.validate_filename("backup/ROSTER-Official")

            records = parse_player_records(FBChunks.parse((temp / "ROSTER-Official").read_bytes()).decompressed_payload)
            self.assertGreater(len(records), 0)
            first = records[0]
            old_name = first.get_text(bytes.fromhex("c26ba1"))
            new_name = old_name + "Z" if len(old_name) < 20 else old_name[:-1]
            result = store.patch_player("ROSTER-Official", first.row_id, {"first_name": new_name})

            backup = Path(result["backup"]["backup"])
            self.assertTrue(backup.is_file())
            self.assertEqual(backup.name, "ROSTER-Official")
            edited_records = parse_player_records(
                FBChunks.parse((temp / "ROSTER-Official").read_bytes()).decompressed_payload
            )
            self.assertEqual(edited_records[0].get_text(bytes.fromhex("c26ba1")), new_name)

    def test_can_patch_high_confidence_team_string_cell_on_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            shutil.copy2(SAVE_DIR / "ROSTER-Official", temp / "ROSTER-Official")
            store = SaveStore(temp)
            table = store.get_table("ROSTER-Official", "teams", limit=1)
            row = table["rows"][0]
            row_id = row["_id"]
            old_mascot = row["d2dba3"]
            new_mascot = old_mascot + "X" if len(old_mascot) < 30 else old_mascot[:-1]
            store.patch_table_row("ROSTER-Official", "teams", row_id, {"d2dba3": new_mascot})
            updated = store.get_table("ROSTER-Official", "teams", limit=1)
            self.assertEqual(updated["rows"][0]["d2dba3"], new_mascot)

    def test_recruiting_schema_index_and_dynasty_occurrences_are_available(self) -> None:
        entries = schema_entries(query="RecruitTarget", limit=25)
        self.assertTrue(entries["available"])
        self.assertGreaterEqual(entries["count"], 1)
        self.assertTrue(any(entry["name"] == "RecruitTarget" for entry in entries["entries"]))

        dynasty = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
        payload = FBChunks.parse(dynasty.read_bytes()).decompressed_payload
        occurrences = schema_occurrences(payload, query="RecruitTarget", limit=25)
        self.assertGreaterEqual(occurrences["count"], 1)
        self.assertTrue(any(entry["name"] == "RecruitTarget" for entry in occurrences["entries"]))

    def test_can_patch_dynasty_player_string_on_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            file_name = "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            shutil.copy2(SAVE_DIR / file_name, temp / file_name)
            store = SaveStore(temp)
            payload = FBChunks.parse((temp / file_name).read_bytes()).decompressed_payload
            records = find_dynasty_player_pool(payload)
            self.assertGreaterEqual(len(records), 1000)
            target = records[0]
            old_name = target.fields["first_name"]
            new_name = old_name + "X" if len(old_name) < 15 else old_name[:-1]

            result = store.patch_dynasty_player(file_name, target.row_id, {"first_name": new_name})
            self.assertTrue(Path(result["backup"]["backup"]).is_file())
            self.assertEqual(result["player"]["first_name"], new_name)
            edited_payload = FBChunks.parse((temp / file_name).read_bytes()).decompressed_payload
            edited = next(item for item in find_dynasty_player_pool(edited_payload) if item.row_id == target.row_id)
            self.assertEqual(edited.fields["first_name"], new_name)

    def test_can_patch_structured_recruit_player_fields_on_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            file_name = "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            shutil.copy2(SAVE_DIR / file_name, temp / file_name)
            store = SaveStore(temp)
            recruits = store.get_recruits(file_name, limit=5)
            self.assertGreaterEqual(recruits["recordCount"], 1000)
            target = recruits["players"][0]
            new_weight = target["weight_lbs"] + 1 if target["weight_lbs"] < 415 else target["weight_lbs"] - 1
            new_speed = target["speed"] + 1 if target["speed"] < 99 else target["speed"] - 1

            result = store.patch_recruit(
                file_name,
                target["id"],
                {
                    "weight_lbs": new_weight,
                    "speed": new_speed,
                    "position": target["position"],
                    "national_rank": target["national_rank"],
                },
            )
            self.assertTrue(Path(result["backup"]["backup"]).is_file())
            self.assertEqual(result["player"]["weight_lbs"], new_weight)
            self.assertEqual(result["player"]["speed"], new_speed)
            updated = store.get_recruits(file_name, limit=5)
            updated_target = next(row for row in updated["players"] if row["id"] == target["id"])
            self.assertEqual(updated_target["weight_lbs"], new_weight)
            self.assertEqual(updated_target["speed"], new_speed)


if __name__ == "__main__":
    unittest.main()
