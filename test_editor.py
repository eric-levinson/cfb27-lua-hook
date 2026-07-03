from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import server
from server import (
    AppError,
    FBChunks,
    Handler,
    SaveStore,
    build_generator_apply_patches,
    default_generator_configs,
    discover_inferred_tables,
    field_capabilities,
    find_dynasty_player_pool,
    generate_recruit_preview_from_profiles,
    get_generator_artifact,
    joined_recruit_profiles_from_payload,
    list_generator_artifacts,
    normalize_generator_config,
    run_franchise_helper,
    schema_entries,
    schema_occurrences,
    parse_player_records,
    patch_player_payload,
    patch_recruits_payload,
    validate_recruit_patch_capabilities,
    validate_generated_preview_class,
)


SAVE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"


class EditorTests(unittest.TestCase):
    def test_spa_shell_exposes_generator_default_and_supporting_views(self) -> None:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

        self.assertIn('data-view-tab="generator"', html)
        self.assertIn('data-view="generator"', html)
        self.assertLess(html.index('data-view-tab="generator"'), html.index('data-view-tab="configs"'))
        view_sections = {
            "configs": 'data-view="generator configs"',
            "recruit-editor": 'data-view="recruit-editor"',
            "save-tools": 'data-view="save-tools"',
            "schema": 'data-view="schema"',
            "tables": 'data-view="tables"',
            "roster": 'data-view="roster"',
        }
        for view, section in view_sections.items():
            self.assertIn(f'data-view-tab="{view}"', html)
            self.assertIn(section, html)

        self.assertIn('activeView: "generator"', app_js)
        self.assertIn('return "generator";', app_js)
        self.assertIn("setActiveView(state.activeView, false)", app_js)

    def test_spa_support_views_have_pagination_and_state_preservation_hooks(self) -> None:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

        for element_id in (
            "recruitEditorPrevBtn",
            "recruitEditorPageInfo",
            "recruitEditorNextBtn",
            "rosterPrevBtn",
            "rosterPageInfo",
            "rosterNextBtn",
            "artifactKindFilter",
            "artifactSearch",
        ):
            self.assertIn(f'id="{element_id}"', html)
            self.assertIn(element_id, app_js)

        self.assertIn('data-table-row-page="prev"', app_js)
        self.assertIn('data-table-row-page="next"', app_js)
        self.assertIn("rowPageSize: 50", app_js)
        self.assertIn("loadTableRows(selected.fileName, selected.tableId, nextOffset)", app_js)
        self.assertIn("pageSize: 250", app_js)
        self.assertIn("pageSize: 500", app_js)
        self.assertIn("artifactBrowser: { artifacts: [], selected: null, detail: null, loaded: false }", app_js)
        self.assertIn("function loadGeneratorArtifacts", app_js)
        self.assertIn("function loadArtifactDetail", app_js)
        self.assertIn("/api/generator/artifact?kind=", app_js)
        self.assertIn("data-artifact-kind", app_js)
        self.assertIn("state.currentPreview = null", app_js)
        self.assertIn("state.recruitEditor = { ...state.recruitEditor", app_js)

    def test_spa_preview_apply_is_gated_by_stale_preview_context(self) -> None:
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

        self.assertIn("function previewStaleReason", app_js)
        self.assertIn("selected save changed after preview", app_js)
        self.assertIn("save fingerprint changed after preview", app_js)
        self.assertIn("save modified time changed after preview", app_js)
        self.assertIn("save size changed after preview", app_js)
        self.assertIn("Regenerate preview before apply", app_js)
        self.assertIn("Regenerate preview before dry-run export", app_js)
        self.assertIn("els.applyPreviewBtn.disabled = !preview.valid || Boolean(apply) || Boolean(staleReason)", app_js)
        self.assertIn('writeMode: "copy"', app_js)
        self.assertIn("selected save stays unchanged", app_js)

    def test_spa_config_has_structured_controls_for_weights_rank_bands_and_write_states(self) -> None:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
        css = (STATIC_DIR / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="configStructured"', html)
        self.assertIn("POSITION_WEIGHT_ORDER", app_js)
        self.assertIn("DEVELOPMENT_TRAIT_ORDER", app_js)
        self.assertIn("QUALITY_MODIFIER_ORDER", app_js)
        self.assertIn("PROFILE_SCORE_KEYS", app_js)
        self.assertIn("function renderConfigStructured", app_js)
        self.assertIn("data-position-weight", app_js)
        self.assertIn("data-rank-band-field", app_js)
        self.assertIn("data-class-budget-range", app_js)
        self.assertIn("data-development-trait-weight", app_js)
        self.assertIn("data-development-rank-band", app_js)
        self.assertIn("data-quality-budget", app_js)
        self.assertIn("data-profile-type-rank-band", app_js)
        self.assertIn("data-profile-type-range", app_js)
        self.assertIn("data-body-rule-field", app_js)
        self.assertIn("writeFieldStates", app_js)
        self.assertIn("nextConfig.classBudget.positionWeights", app_js)
        self.assertIn("nextConfig.classBudget[key][bound]", app_js)
        self.assertIn("nextConfig.rankBands[index].expectedOverall.min", app_js)
        self.assertIn("optionalNumberFromInput(input, null)", app_js)
        self.assertIn("nextConfig.development.traitWeights", app_js)
        self.assertIn("nextConfig.development.rankBandMultipliers", app_js)
        self.assertIn("nextConfig.qualityModifier.budgets[quality][bound]", app_js)
        self.assertIn("nextConfig.profileTypes[profileType].rankBandWeights[band]", app_js)
        self.assertIn("nextConfig.bodyRules[rule][field][bound]", app_js)
        self.assertIn(".wide-config-section", css)
        self.assertIn(".split-config-tables", css)

    def test_default_generator_config_validates_and_normalizes(self) -> None:
        payload = default_generator_configs()

        self.assertEqual(len(payload["configs"]), 1)
        config = payload["configs"][0]
        self.assertEqual(config["configVersion"], 1)
        self.assertEqual(config["generator"]["mode"], "reroll-existing-recruits")
        self.assertEqual(config["generator"]["writePolicy"], "verified-fields-only")
        self.assertAlmostEqual(sum(config["classBudget"]["positionWeights"].values()), 1.0, places=4)
        weighted_positions = {
            position
            for position, weight in config["classBudget"]["positionWeights"].items()
            if weight > 0
        }
        self.assertFalse(weighted_positions - set(config["positionProfiles"]))
        self.assertEqual(config["writeFieldStates"]["ratings"]["state"], "writable")
        self.assertEqual(config["writeFieldStates"]["qualityModifier"]["state"], "preview-only")
        self.assertIn("Recruit.QualityModifier", config["writeFieldStates"]["qualityModifier"]["blockedFields"])

    def test_generator_config_validation_endpoint(self) -> None:
        config = default_generator_configs()["configs"][0]
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            port = httpd.server_address[1]
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/generator/config/validate",
                data=json.dumps({"config": config, "recruitCount": 4101}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
        finally:
            httpd.shutdown()
            thread.join(timeout=5)
            httpd.server_close()

        self.assertTrue(payload["valid"])
        self.assertEqual(payload["normalizedConfig"]["id"], "manifesto-realistic-v1")
        self.assertEqual(payload["validationContext"]["recruitCount"], 4101)
        self.assertIn("fieldCapabilities", payload)

    def test_generator_config_rejects_future_version_and_rank_overlap(self) -> None:
        config = default_generator_configs()["configs"][0]
        config["configVersion"] = 99
        config["rankBands"][1]["minRank"] = 4

        result = normalize_generator_config(config)

        self.assertFalse(result["valid"])
        self.assertIsNone(result["normalizedConfig"])
        self.assertTrue(any("Unsupported future configVersion 99" in item for item in result["errors"]))
        self.assertTrue(any("overlaps" in item for item in result["errors"]))

    def test_generator_config_migrates_legacy_sparse_config_to_v1(self) -> None:
        legacy = {
            "configVersion": 0,
            "id": "legacy-realistic",
            "name": "Legacy Realistic",
            "classBudget": {
                "fiveStarCount": 33,
                "positionWeights": {"QB": 2, "WR": 1},
            },
            "writeFields": {
                "qualityModifier": True,
            },
        }

        result = normalize_generator_config(legacy)

        self.assertTrue(result["valid"], result["errors"])
        self.assertTrue(any("Migrated configVersion 0 to 1" in item for item in result["migrationWarnings"]))
        normalized = result["normalizedConfig"]
        self.assertEqual(normalized["configVersion"], 1)
        self.assertEqual(normalized["id"], "legacy-realistic")
        self.assertEqual(normalized["name"], "Legacy Realistic")
        self.assertEqual(normalized["classBudget"]["fiveStarCount"], 33)
        self.assertEqual(normalized["classBudget"]["positionWeights"], {"QB": 0.666667, "WR": 0.333333})
        self.assertEqual(normalized["generator"]["mode"], "reroll-existing-recruits")
        self.assertEqual(normalized["writeFields"]["qualityModifier"], "after-research")
        self.assertEqual(normalized["writeFieldStates"]["qualityModifier"]["state"], "preview-only")
        self.assertIn("rankBands", normalized)
        self.assertIn("archetypeProfiles", normalized)

    def test_generator_config_migrates_missing_version_as_legacy(self) -> None:
        legacy = {
            "id": "legacy-no-version",
            "name": "Legacy No Version",
        }

        result = normalize_generator_config(legacy)

        self.assertTrue(result["valid"], result["errors"])
        self.assertEqual(result["normalizedConfig"]["configVersion"], 1)
        self.assertTrue(any("configVersion missing" in item for item in result["migrationWarnings"]))

    def test_generator_config_normalizes_probabilities_and_write_field_warnings(self) -> None:
        config = default_generator_configs()["configs"][0]
        config["classBudget"]["positionWeights"] = {"QB": 2, "WR": 1}
        config["writeFields"]["qualityModifier"] = True

        result = normalize_generator_config(config)

        self.assertTrue(result["valid"], result["errors"])
        normalized = result["normalizedConfig"]
        self.assertEqual(normalized["classBudget"]["positionWeights"], {"QB": 0.666667, "WR": 0.333333})
        self.assertEqual(normalized["writeFields"]["qualityModifier"], "after-research")
        self.assertEqual(normalized["writeFieldStates"]["qualityModifier"]["state"], "preview-only")
        self.assertTrue(any("qualityModifier" in item for item in result["warnings"]))

    def test_generator_config_reimport_round_trip_preserves_normalized_contract(self) -> None:
        first = normalize_generator_config(default_generator_configs()["configs"][0])
        self.assertTrue(first["valid"], first["errors"])

        exported = json.loads(json.dumps(first["normalizedConfig"]))
        second = normalize_generator_config(exported)

        self.assertTrue(second["valid"], second["errors"])
        self.assertEqual(second["normalizedConfig"]["id"], first["normalizedConfig"]["id"])
        self.assertEqual(
            second["normalizedConfig"]["classBudget"]["positionWeights"],
            first["normalizedConfig"]["classBudget"]["positionWeights"],
        )
        self.assertEqual(second["normalizedConfig"]["writeFieldStates"], first["normalizedConfig"]["writeFieldStates"])

    def test_generator_config_rejects_unknown_cross_references(self) -> None:
        config = default_generator_configs()["configs"][0]
        config["positionProfiles"]["QB"]["archetypeWeights"] = {"QB_Unknown": 1}
        config["positionProfiles"]["WR"]["bodyRule"] = "SPRINTER"
        config["archetypeProfiles"]["QB_FieldGeneral"]["primaryRatings"] = ["throw_power", "not_a_rating"]
        config["development"]["traitWeights"] = {"Normal": 1, "Superhuman": 1}

        result = normalize_generator_config(config)

        self.assertFalse(result["valid"])
        self.assertTrue(any("QB_Unknown" in item for item in result["errors"]))
        self.assertTrue(any("SPRINTER" in item for item in result["errors"]))
        self.assertTrue(any("not_a_rating" in item for item in result["errors"]))
        self.assertTrue(any("Superhuman" in item for item in result["errors"]))

    def test_generator_config_rejects_missing_position_profile_and_mismatched_archetype(self) -> None:
        config = default_generator_configs()["configs"][0]
        del config["positionProfiles"]["P"]
        config["positionProfiles"]["QB"]["archetypeWeights"] = {"WR_DeepThreat": 1}

        result = normalize_generator_config(config)

        self.assertFalse(result["valid"])
        self.assertTrue(any("must define every position" in item and "P" in item for item in result["errors"]))
        self.assertTrue(any("WR_DeepThreat is not compatible with QB" in item for item in result["errors"]))

    def test_generator_config_rejects_body_bounds_and_profile_coverage_gaps(self) -> None:
        config = default_generator_configs()["configs"][0]
        config["bodyRules"]["QB"]["heightInches"] = {"min": 44, "max": 78}
        for profile in config["profileTypes"].values():
            profile["rankBandWeights"].pop("rank-3001-plus", None)

        result = normalize_generator_config(config)

        self.assertFalse(result["valid"])
        self.assertTrue(any("heightInches must stay within 48 to 96 inches" in item for item in result["errors"]))
        self.assertTrue(any("rank-3001-plus" in item for item in result["errors"]))

    def test_generator_config_warns_when_class_budget_differs_from_star_cutoffs(self) -> None:
        config = default_generator_configs()["configs"][0]
        config["classBudget"]["fiveStarCount"] = 40

        result = normalize_generator_config(config)

        self.assertTrue(result["valid"], result["errors"])
        self.assertTrue(any("fiveStarCount" in item and "FIVE_STAR" in item for item in result["warnings"]))

    def test_generator_config_rejects_impossible_budget_for_recruit_count(self) -> None:
        config = default_generator_configs()["configs"][0]
        config["classBudget"]["fiveStarCount"] = 20
        config["classBudget"]["fourStarCount"] = 20
        config["classBudget"]["eliteDevelopmentCount"] = {"min": 1.5, "max": 12}
        config["qualityModifier"]["budgets"]["Gem"] = {"min": 8, "max": 18}
        config["qualityModifier"]["budgets"]["Bust"] = {"min": 8, "max": 18}

        result = normalize_generator_config(config, recruit_count=30)

        self.assertFalse(result["valid"])
        self.assertEqual(result["validationContext"]["recruitCount"], 30)
        self.assertTrue(any("five-star plus four-star total 40" in item for item in result["errors"]))
        self.assertTrue(any("eliteDevelopmentCount.min and classBudget.eliteDevelopmentCount.max" in item for item in result["errors"]))
        self.assertTrue(any("qualityModifier maximum budget total 36" in item for item in result["errors"]))

    def test_field_capability_endpoint_returns_metadata(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            port = httpd.server_address[1]
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/generator/field-capabilities",
                timeout=5,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
        finally:
            httpd.shutdown()
            thread.join(timeout=5)
            httpd.server_close()

        fields = {item["field"]: item for item in payload["fields"]}
        self.assertTrue(fields["Player.SpeedRating"]["safeToWrite"])
        self.assertFalse(fields["Recruit.QualityModifier"]["safeToWrite"])
        self.assertEqual(fields["Recruit.QualityModifier"]["generatorState"], "skipped because unverified")

    def test_field_capability_metadata_normalizes_statuses(self) -> None:
        payload = field_capabilities()
        fields = {item["field"]: item for item in payload["fields"]}

        self.assertIn("writable", payload["statuses"])
        self.assertIn("skipped because unverified", payload["generatorStates"])
        self.assertTrue(fields["Recruit.NationalRank"]["safeToWrite"])
        self.assertEqual(fields["Recruit.NationalRank"]["generatorState"], "writable")
        self.assertTrue(fields["Player.SpeedRating"]["safeToWrite"])
        self.assertFalse(fields["Player.CharacterBodyType"]["safeToWrite"])
        self.assertEqual(fields["Player.CharacterBodyType"]["gate"], "RG-5")
        self.assertEqual(
            fields["Player.GenericHeadAssetName"]["generatorState"],
            "skipped because unverified",
        )

    def test_generator_capability_gate_rejects_research_fields(self) -> None:
        validate_recruit_patch_capabilities(
            {"national_rank": 1, "first_name": "Isaac", "speed": 90},
            mode="generator",
        )

        with self.assertRaises(Exception) as blocked:
            validate_recruit_patch_capabilities(
                {"generic_head_asset_name": "Generic_101_P_T1_B_1_1"},
                mode="generator",
            )
        self.assertIn("Player.GenericHeadAssetName", str(blocked.exception))

        with self.assertRaises(Exception) as unsupported:
            validate_recruit_patch_capabilities({"unknown_generator_field": "x"}, mode="generator")
        self.assertIn("Unsupported generator fields", str(unsupported.exception))

        with self.assertRaises(Exception) as research_gated:
            validate_recruit_patch_capabilities({"quality_modifier": "Gem"}, mode="generator")
        self.assertIn("Recruit.QualityModifier", str(research_gated.exception))

    def test_research_helper_rg1_scan_writes_artifact(self) -> None:
        fixture = Path(__file__).resolve().parent / "schema" / "DYNASTY-decompressed-FrTk.bin"
        if not fixture.is_file():
            self.skipTest("Local decompressed dynasty FrTk fixture is not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = Path(temp_dir) / "rg1-research.json"
            result = run_franchise_helper(
                ["research", str(fixture), "25", str(artifact)],
                timeout=120,
            )
            self.assertTrue(artifact.is_file())
            saved = json.loads(artifact.read_text(encoding="utf-8"))

        self.assertEqual(result["gates"]["RG-1"]["unresolvedLinkCount"], 0)
        self.assertEqual(result["gates"]["RG-1"]["sharedPlayerLinkCount"], 0)
        self.assertTrue(result["gates"]["RG-1"]["passed"])
        self.assertEqual(saved["gates"]["RG-1"]["validLinks"], result["gates"]["RG-1"]["validLinks"])
        self.assertIn("Recruit.QualityModifier", result["fieldAvailability"])
        self.assertIn("Player.ProspectStarRating", result["fieldAvailability"])
        self.assertIn("missingFields", result)

    def test_joined_recruit_profiles_normalize_generator_shape(self) -> None:
        fixture = Path(__file__).resolve().parent / "schema" / "DYNASTY-decompressed-FrTk.bin"
        if not fixture.is_file():
            self.skipTest("Local decompressed dynasty FrTk fixture is not available")

        payload = fixture.read_bytes()
        result = joined_recruit_profiles_from_payload(
            payload,
            save_fingerprint="TEST-FINGERPRINT",
            limit=3,
        )

        self.assertGreaterEqual(result["count"], 1000)
        self.assertEqual(len(result["recruits"]), 3)
        self.assertTrue(result["validation"]["passed"])
        profile = result["recruits"][0]
        self.assertRegex(profile["recruitId"], r"^Recruit:\d+$")
        self.assertRegex(profile["playerId"], r"^Player:\d+$")
        self.assertEqual(profile["source"]["saveFingerprint"], "TEST-FINGERPRINT")
        self.assertIn("identity", profile)
        self.assertIn("footballProfile", profile)
        self.assertIn("gameFields", profile)
        self.assertIn("generatedWrites", profile["gameFields"])
        self.assertEqual(profile["gameFields"]["generatedWrites"], {})
        self.assertFalse(profile["locks"]["rowLocked"])
        self.assertEqual(profile["locks"]["fields"], [])
        self.assertRegex(profile["sidecar"]["recordId"], r"^TEST-FINGERP:R\d+:P\d+$")
        self.assertEqual(profile["generationIntent"]["sidecarRecordId"], profile["sidecar"]["recordId"])
        self.assertEqual(result["sidecar"]["keyStrategy"], "save fingerprint plus recruit row plus player row")
        self.assertIn("Recruit", profile["originalFields"])
        self.assertIn("Player", profile["originalFields"])
        self.assertIn("NationalRank", profile["originalFields"]["Recruit"])
        self.assertIn("SpeedRating", profile["originalFields"]["Player"])
        self.assertIn("Player.SpeedRating", {item["field"] for item in result["fieldCapabilities"]["fields"]})

    def test_store_exposes_joined_recruits_for_generator_endpoint(self) -> None:
        store = SaveStore(SAVE_DIR)
        file_name = "DYNASTY-JUL02-07h43m00-AUTOSAVE"
        if not (SAVE_DIR / file_name).is_file():
            self.skipTest("Local dynasty save is not available")

        result = store.get_joined_recruits(file_name, limit=2)

        self.assertEqual(result["file"]["name"], file_name)
        self.assertEqual(len(result["saveFingerprint"]), 64)
        self.assertGreaterEqual(result["count"], 1000)
        self.assertEqual(len(result["recruits"]), 2)
        self.assertEqual(result["recruits"][0]["source"]["saveFingerprint"], result["saveFingerprint"])
        self.assertIn(file_name, result["sidecar"]["fileName"])
        self.assertEqual(result["recruits"][0]["source"]["saveName"], file_name)

    def test_core_generator_preview_is_deterministic_and_preview_only(self) -> None:
        fixture = Path(__file__).resolve().parent / "schema" / "DYNASTY-decompressed-FrTk.bin"
        if not fixture.is_file():
            self.skipTest("Local decompressed dynasty FrTk fixture is not available")

        joined = joined_recruit_profiles_from_payload(
            fixture.read_bytes(),
            save_fingerprint="PREVIEW-FINGERPRINT",
            limit=80,
        )
        config = default_generator_configs()["configs"][0]
        config["classBudget"]["fiveStarCount"] = 5
        config["classBudget"]["fourStarCount"] = 15
        config["classBudget"]["generationalFreshmanCount"] = {"min": 2, "max": 2}
        config["classBudget"]["eliteDevelopmentCount"] = {"min": 3, "max": 3}
        config["qualityModifier"]["budgets"]["Gem"] = {"min": 3, "max": 3}
        config["qualityModifier"]["budgets"]["Bust"] = {"min": 4, "max": 4}

        first = generate_recruit_preview_from_profiles(joined, config, "unit-seed")
        second = generate_recruit_preview_from_profiles(joined, config, "unit-seed")
        different = generate_recruit_preview_from_profiles(joined, config, "different-seed")

        self.assertTrue(first["valid"], first["errors"])
        self.assertEqual(first["previewId"], second["previewId"])
        self.assertNotEqual(first["previewId"], different["previewId"])
        self.assertEqual(len(first["recruits"]), 80)
        self.assertEqual(len({item["footballProfile"]["nationalRank"] for item in first["recruits"]}), 80)
        self.assertEqual(first["recruits"][0]["footballProfile"]["starRating"], "FIVE_STAR")
        self.assertGreater(first["summary"]["diffCount"], 0)
        self.assertTrue(first["skippedFields"])
        self.assertTrue(first["validationReport"]["valid"], first["validationReport"]["errors"])
        self.assertTrue(first["validationReport"]["checks"]["nationalRanksContiguous"])
        self.assertTrue(first["validationReport"]["checks"]["positionRanksValid"])
        self.assertTrue(first["validationReport"]["checks"]["starRatingsMatchRankCutoffs"])
        self.assertTrue(first["validationReport"]["checks"]["ratingsWithinBounds"])
        self.assertTrue(first["validationReport"]["checks"]["bodyRulesValid"])
        self.assertTrue(first["validationReport"]["checks"]["encodedWeightsValid"])
        self.assertEqual(first["summary"]["validationErrorCount"], 0)
        self.assertIn("rankBands", first["validationReport"]["details"])
        self.assertIn("positions", first["validationReport"]["details"])
        self.assertTrue(first["validationReport"]["details"]["rankBands"])
        self.assertTrue(first["validationReport"]["details"]["positions"])
        self.assertIn("warnings", first["validationReport"]["samples"])
        self.assertIn("errors", first["validationReport"]["samples"])
        self.assertEqual(first["summary"]["budgets"]["generationalFreshman"]["target"], 2)
        self.assertEqual(first["summary"]["budgets"]["generationalFreshman"]["actual"], 2)
        self.assertEqual(first["summary"]["budgets"]["eliteDevelopment"]["actual"], 3)
        self.assertEqual(first["summary"]["budgets"]["Gem"]["actual"], 3)
        self.assertEqual(first["summary"]["budgets"]["Bust"]["actual"], 4)
        self.assertTrue(first["summary"]["diffFields"])
        self.assertTrue(all("field" in item and "count" in item for item in first["summary"]["diffFields"]))
        self.assertIn("generationalFreshman", first["summary"]["budgetConsumers"])
        self.assertEqual(len(first["summary"]["budgetConsumers"]["generationalFreshman"]), 2)
        self.assertTrue(
            all("recruitId" in item and "rank" in item and "overall" in item for item in first["summary"]["budgetConsumers"]["generationalFreshman"])
        )
        self.assertEqual(
            sum(1 for recruit in first["recruits"] if recruit["generationIntent"].get("generationalFreshman")),
            2,
        )
        self.assertFalse(any(diff["field"] == "Player.ProspectStarRating" for diff in first["diffs"]))
        self.assertTrue(any("overall" in recruit["gameFields"]["generatedWrites"] for recruit in first["recruits"]))
        recruit_with_diffs = next(recruit for recruit in first["recruits"] if recruit["gameFields"]["generatedDiffs"])
        self.assertEqual(
            len(recruit_with_diffs["gameFields"]["generatedDiffs"]),
            len(recruit_with_diffs["gameFields"]["generatedWrites"]),
        )
        self.assertTrue(
            all("from" in diff and "to" in diff and "field" in diff for diff in recruit_with_diffs["gameFields"]["generatedDiffs"])
        )

    def test_core_generator_validation_catches_encoded_weight_mismatch(self) -> None:
        fixture = Path(__file__).resolve().parent / "schema" / "DYNASTY-decompressed-FrTk.bin"
        if not fixture.is_file():
            self.skipTest("Local decompressed dynasty FrTk fixture is not available")

        joined = joined_recruit_profiles_from_payload(
            fixture.read_bytes(),
            save_fingerprint="WEIGHT-FINGERPRINT",
            limit=24,
        )
        config = default_generator_configs()["configs"][0]
        preview = generate_recruit_preview_from_profiles(joined, config, "weight-seed")
        generated = json.loads(json.dumps(preview["recruits"]))
        generated[0]["gameFields"]["encodedWeight"] += 1

        report = validate_generated_preview_class(generated, preview["normalizedConfig"], preview["diffs"])

        self.assertFalse(report["valid"])
        self.assertFalse(report["checks"]["encodedWeightsValid"])
        self.assertEqual(report["counts"]["encodedWeightErrors"], 1)
        self.assertTrue(
            any("encoded weight" in error for error in report["errors"]),
            report["errors"],
        )

    def test_core_generator_preview_respects_row_locks(self) -> None:
        fixture = Path(__file__).resolve().parent / "schema" / "DYNASTY-decompressed-FrTk.bin"
        if not fixture.is_file():
            self.skipTest("Local decompressed dynasty FrTk fixture is not available")

        joined = joined_recruit_profiles_from_payload(
            fixture.read_bytes(),
            save_fingerprint="LOCK-FINGERPRINT",
            limit=20,
        )
        config = default_generator_configs()["configs"][0]
        config["classBudget"]["fiveStarCount"] = 2
        config["classBudget"]["fourStarCount"] = 6
        config["qualityModifier"]["budgets"]["Gem"] = {"min": 1, "max": 2}
        config["qualityModifier"]["budgets"]["Bust"] = {"min": 1, "max": 2}
        locked_record_id = joined["recruits"][0]["sidecar"]["recordId"]

        preview = generate_recruit_preview_from_profiles(
            joined,
            config,
            "lock-seed",
            locks={locked_record_id: {"rowLocked": True, "fields": []}},
        )
        locked_preview = next(item for item in preview["recruits"] if item["sidecar"]["recordId"] == locked_record_id)

        self.assertTrue(preview["valid"], preview["errors"])
        self.assertTrue(locked_preview["locks"]["rowLocked"])
        self.assertEqual(locked_preview["gameFields"]["generatedWrites"], {})
        self.assertTrue(preview["validationReport"]["checks"]["lockedRowsUnchangedByDiffs"])

    def test_generator_apply_patches_use_verified_helper_keys(self) -> None:
        fixture = Path(__file__).resolve().parent / "schema" / "DYNASTY-decompressed-FrTk.bin"
        if not fixture.is_file():
            self.skipTest("Local decompressed dynasty FrTk fixture is not available")

        payload = fixture.read_bytes()
        joined = joined_recruit_profiles_from_payload(
            payload,
            save_fingerprint="APPLY-PATCH-FINGERPRINT",
            limit=16,
        )
        config = default_generator_configs()["configs"][0]
        config["classBudget"]["fiveStarCount"] = 2
        config["classBudget"]["fourStarCount"] = 5
        preview = generate_recruit_preview_from_profiles(joined, config, "apply-patch-seed")

        patches = build_generator_apply_patches(preview)

        self.assertTrue(patches)
        patch_keys = {key for patch in patches for key in patch["changes"]}
        self.assertNotIn("development_trait", patch_keys)
        self.assertNotIn("height", patch_keys)
        self.assertNotIn("weight", patch_keys)
        self.assertTrue({"dev_trait", "height_inches", "weight_lbs"} & patch_keys)
        patched_payload, updated_players = patch_recruits_payload(payload, patches[:2], mode="generator")
        self.assertNotEqual(patched_payload, payload)
        self.assertEqual(len(updated_players), 2)

    def test_generator_apply_requires_matching_preview_and_writes_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            if not source.is_file():
                self.skipTest("Local dynasty save is not available")
            original_sidecar_dir = server.SIDECAR_DIR
            original_report_dir = server.REPORT_DIR
            server.SIDECAR_DIR = temp / "sidecars"
            server.REPORT_DIR = temp / "reports"
            file_name = "DYNASTY-CODEX-APPLY-ARTIFACT"
            try:
                shutil.copy2(source, temp / file_name)
                store = SaveStore(temp)
                config = default_generator_configs()["configs"][0]
                for key in list(config["writeFields"]):
                    config["writeFields"][key] = False
                preview = store.preview_generator(file_name, config, "artifact-seed")
                original_bytes = (temp / file_name).read_bytes()
                self.assertTrue(preview["valid"], preview["errors"])
                self.assertEqual(preview["summary"]["diffCount"], 0)

                with self.assertRaises(Exception):
                    store.apply_generator(
                        file_name,
                        config,
                        "artifact-seed",
                        "WRONG-PREVIEW",
                        preview["configHash"],
                        True,
                    )

                result = store.apply_generator(
                    file_name,
                    config,
                    "artifact-seed",
                    preview["previewId"],
                    preview["configHash"],
                    True,
                )
            finally:
                server.SIDECAR_DIR = original_sidecar_dir
                server.REPORT_DIR = original_report_dir

            self.assertTrue(result["applied"], result["readBackMismatches"])
            self.assertTrue(result["artifactWriteSucceeded"], result["artifactError"])
            self.assertTrue(Path(result["backup"]["backup"]).is_file())
            self.assertEqual(result["writeMode"], "copy")
            self.assertEqual(result["sourceFile"], file_name)
            self.assertNotEqual(result["targetFile"], file_name)
            self.assertTrue(Path(result["targetPath"]).is_file())
            self.assertEqual((temp / file_name).read_bytes(), original_bytes)
            self.assertTrue(Path(result["sidecar"]["path"]).is_file())
            self.assertTrue(Path(result["report"]["path"]).is_file())
            report_payload = json.loads(Path(result["report"]["path"]).read_text(encoding="utf-8"))
            self.assertEqual(report_payload["writeContext"]["writeMode"], "copy")
            self.assertEqual(report_payload["writeContext"]["targetFile"], result["targetFile"])
            self.assertEqual(result["appliedRecruitCount"], 0)
            self.assertEqual(result["changedFieldCount"], 0)
            self.assertEqual(result["readBackMismatches"], [])

    def test_generator_apply_non_empty_development_write_read_back_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            if not source.is_file():
                self.skipTest("Local dynasty save is not available")
            original_sidecar_dir = server.SIDECAR_DIR
            original_report_dir = server.REPORT_DIR
            server.SIDECAR_DIR = temp / "sidecars"
            server.REPORT_DIR = temp / "reports"
            file_name = "DYNASTY-CODEX-APPLY-NONEMPTY"
            try:
                shutil.copy2(source, temp / file_name)
                store = SaveStore(temp)
                config = default_generator_configs()["configs"][0]
                for key in list(config["writeFields"]):
                    config["writeFields"][key] = False
                config["writeFields"]["developmentTrait"] = True
                preview = store.preview_generator(file_name, config, "non-empty-apply-seed")
                original_bytes = (temp / file_name).read_bytes()
                self.assertTrue(preview["valid"], preview["errors"])
                self.assertGreater(preview["summary"]["diffCount"], 0)

                result = store.apply_generator(
                    file_name,
                    config,
                    "non-empty-apply-seed",
                    preview["previewId"],
                    preview["configHash"],
                    True,
                )
            finally:
                server.SIDECAR_DIR = original_sidecar_dir
                server.REPORT_DIR = original_report_dir

            self.assertTrue(result["applied"], result["readBackMismatches"])
            self.assertTrue(result["artifactWriteSucceeded"], result["artifactError"])
            self.assertGreater(result["appliedRecruitCount"], 0)
            self.assertGreater(result["changedFieldCount"], 0)
            self.assertEqual(result["readBackMismatches"], [])
            self.assertEqual(result["writeMode"], "copy")
            self.assertTrue(Path(result["targetPath"]).is_file())
            self.assertEqual((temp / file_name).read_bytes(), original_bytes)
            self.assertNotEqual(Path(result["targetPath"]).read_bytes(), original_bytes)

    def test_generator_apply_backup_failure_leaves_save_unchanged(self) -> None:
        class FailingBackupStore(SaveStore):
            def create_backup(self, name: str) -> dict:
                raise RuntimeError("backup unavailable")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            if not source.is_file():
                self.skipTest("Local dynasty save is not available")
            file_name = "DYNASTY-CODEX-APPLY-BACKUPFAIL"
            shutil.copy2(source, temp / file_name)
            original_bytes = (temp / file_name).read_bytes()
            store = FailingBackupStore(temp)
            config = default_generator_configs()["configs"][0]
            for key in list(config["writeFields"]):
                config["writeFields"][key] = False
            preview = store.preview_generator(file_name, config, "backup-failure-seed")
            self.assertTrue(preview["valid"], preview["errors"])
            self.assertEqual(preview["summary"]["diffCount"], 0)

            with self.assertRaises(RuntimeError):
                with patch(
                    "server.patch_recruits_payload",
                    side_effect=lambda payload, patches, mode="generator": (payload + b"changed-before-backup", []),
                ):
                    store.apply_generator(
                        file_name,
                        config,
                        "backup-failure-seed",
                        preview["previewId"],
                        preview["configHash"],
                        True,
                    )

            self.assertEqual((temp / file_name).read_bytes(), original_bytes)

    def test_generator_apply_artifact_failure_reports_write_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            if not source.is_file():
                self.skipTest("Local dynasty save is not available")
            original_sidecar_dir = server.SIDECAR_DIR
            original_report_dir = server.REPORT_DIR
            server.SIDECAR_DIR = temp / "sidecars"
            server.REPORT_DIR = temp / "report-blocker"
            server.REPORT_DIR.write_text("not a directory", encoding="utf-8")
            file_name = "DYNASTY-CODEX-APPLY-ARTIFACTFAIL"
            try:
                shutil.copy2(source, temp / file_name)
                store = SaveStore(temp)
                config = default_generator_configs()["configs"][0]
                for key in list(config["writeFields"]):
                    config["writeFields"][key] = False
                preview = store.preview_generator(file_name, config, "artifact-failure-seed")

                result = store.apply_generator(
                    file_name,
                    config,
                    "artifact-failure-seed",
                    preview["previewId"],
                    preview["configHash"],
                    True,
                )
            finally:
                server.SIDECAR_DIR = original_sidecar_dir
                server.REPORT_DIR = original_report_dir

            self.assertTrue(result["writeSucceeded"])
            self.assertTrue(result["applied"], result["readBackMismatches"])
            self.assertFalse(result["artifactWriteSucceeded"])
            self.assertTrue(result["artifactError"])
            self.assertIsNone(result["sidecar"])
            self.assertIsNone(result["report"])
            self.assertEqual(result["writeMode"], "copy")
            self.assertTrue(Path(result["targetPath"]).is_file())

    def test_generator_patch_export_is_dry_run_and_matches_preview(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            if not source.is_file():
                self.skipTest("Local dynasty save is not available")
            file_name = "DYNASTY-CODEX-PATCH-EXPORT"
            shutil.copy2(source, temp / file_name)
            original_bytes = (temp / file_name).read_bytes()
            store = SaveStore(temp)
            config = default_generator_configs()["configs"][0]
            for key in list(config["writeFields"]):
                config["writeFields"][key] = False
            config["writeFields"]["developmentTrait"] = True
            preview = store.preview_generator(file_name, config, "patch-export-seed")
            self.assertTrue(preview["valid"], preview["errors"])
            self.assertGreater(preview["summary"]["diffCount"], 0)

            export = store.export_generator_patch(
                file_name,
                config,
                "patch-export-seed",
                preview["previewId"],
                preview["configHash"],
            )

            self.assertTrue(export["dryRun"])
            self.assertEqual(export["previewId"], preview["previewId"])
            self.assertEqual(export["changedFieldCount"], preview["summary"]["diffCount"])
            self.assertGreater(len(export["patches"]), 0)
            self.assertEqual((temp / file_name).read_bytes(), original_bytes)

    def test_generator_artifact_listing_and_cleanup_keep_latest_per_kind(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            original_sidecar_dir = server.SIDECAR_DIR
            original_report_dir = server.REPORT_DIR
            server.SIDECAR_DIR = temp / "sidecars"
            server.REPORT_DIR = temp / "reports"
            try:
                server.SIDECAR_DIR.mkdir()
                server.REPORT_DIR.mkdir()
                for kind, directory in (("sidecar", server.SIDECAR_DIR), ("report", server.REPORT_DIR)):
                    for index in range(3):
                        path = directory / f"{kind}-{index}.json"
                        payload = {"kind": kind, "index": index}
                        if kind == "sidecar":
                            payload.update({"saveName": "DYNASTY-TEST", "recordCount": 7, "records": [{}] * 7})
                        if kind == "report":
                            payload.update(
                                {
                                    "saveName": "DYNASTY-TEST",
                                    "appliedRecruitCount": 2,
                                    "changedFieldCount": 9,
                                    "validationReport": {"valid": True, "errors": [], "warnings": ["warn"]},
                                    "readBackMismatches": [],
                                }
                            )
                        path.write_text(json.dumps(payload), encoding="utf-8")
                        os_time = 1_700_000_000 + index
                        path.touch()
                        os.utime(path, (os_time, os_time))

                listed = list_generator_artifacts()
                report_detail = get_generator_artifact("report", "report-2.json")
                sidecar_detail = get_generator_artifact("sidecar", "sidecar-2.json")
                with self.assertRaises(AppError):
                    get_generator_artifact("report", "../report-2.json")
                cleaned = server.cleanup_generator_artifacts(keep_latest=1)
                remaining = list_generator_artifacts()
            finally:
                server.SIDECAR_DIR = original_sidecar_dir
                server.REPORT_DIR = original_report_dir

            self.assertEqual(listed["count"], 6)
            self.assertEqual(report_detail["summary"]["changedFieldCount"], 9)
            self.assertEqual(report_detail["summary"]["validationWarningCount"], 1)
            self.assertEqual(sidecar_detail["summary"]["recordCount"], 7)
            self.assertEqual(cleaned["deletedCount"], 4)
            self.assertEqual(remaining["count"], 2)
            self.assertEqual({item["kind"] for item in remaining["artifacts"]}, {"sidecar", "report"})
            self.assertTrue(all(item["name"].endswith("-2.json") for item in remaining["artifacts"]))

    def test_generator_apply_rebuild_parse_failure_prevents_backup_and_write(self) -> None:
        class RecordingBackupStore(SaveStore):
            backup_called = False

            def create_backup(self, name: str) -> dict:
                self.backup_called = True
                return super().create_backup(name)

        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            source = SAVE_DIR / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
            if not source.is_file():
                self.skipTest("Local dynasty save is not available")
            file_name = "DYNASTY-CODEX-APPLY-PARSEFAIL"
            shutil.copy2(source, temp / file_name)
            original_bytes = (temp / file_name).read_bytes()
            store = RecordingBackupStore(temp)
            config = default_generator_configs()["configs"][0]
            for key in list(config["writeFields"]):
                config["writeFields"][key] = False
            preview = store.preview_generator(file_name, config, "parse-failure-seed")
            original_parse = server.FBChunks.parse
            call_count = {"count": 0}

            def parse_with_rebuild_failure(data: bytes) -> object:
                call_count["count"] += 1
                if call_count["count"] == 2:
                    raise AppError("simulated rebuilt-output parse failure", 500)
                return original_parse(data)

            with self.assertRaises(AppError):
                with patch(
                    "server.patch_recruits_payload",
                    side_effect=lambda payload, patches, mode="generator": (payload + b"changed-before-parse", []),
                ), patch("server.FBChunks.parse", side_effect=parse_with_rebuild_failure):
                    store.apply_generator(
                        file_name,
                        config,
                        "parse-failure-seed",
                        preview["previewId"],
                        preview["configHash"],
                        True,
                    )

            self.assertFalse(store.backup_called)
            self.assertEqual((temp / file_name).read_bytes(), original_bytes)

    def test_generator_preview_endpoint_uses_temp_save_copy(self) -> None:
        store = SaveStore(SAVE_DIR)
        dynasty_files = [path for path in store.editable_files() if path.name.startswith("DYNASTY-")]
        if not dynasty_files:
            self.skipTest("Local dynasty save is not available")

        temp_name = f"DYNASTY-CODEX-PREVIEW-{next(tempfile._get_candidate_names())}"
        temp_path = SAVE_DIR / temp_name
        shutil.copy2(dynasty_files[0], temp_path)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            port = httpd.server_address[1]
            config = default_generator_configs()["configs"][0]
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/generator/preview",
                data=json.dumps({"file": temp_name, "config": config, "seed": "endpoint-seed"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
        finally:
            httpd.shutdown()
            thread.join(timeout=5)
            httpd.server_close()
            temp_path.unlink(missing_ok=True)

        self.assertTrue(payload["valid"], payload["errors"])
        self.assertEqual(payload["file"]["name"], temp_name)
        self.assertEqual(payload["seed"], "endpoint-seed")
        self.assertGreaterEqual(payload["summary"]["count"], 1000)
        self.assertGreater(payload["summary"]["diffCount"], 0)
        self.assertTrue(payload["validationReport"]["valid"], payload["validationReport"]["errors"])

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
            new_jersey = 99 if target["jersey_number"] != 99 else 98
            new_physical_rank = "Gold" if target["physical_rank_1"] != "Gold" else "Silver"

            result = store.patch_recruit(
                file_name,
                target["id"],
                {
                    "dev_trait": "College_Star",
                    "dealbreaker": "PlayingTime",
                    "physical_rank_1": new_physical_rank,
                    "mental_ability_1": "TheNatural",
                    "mental_rank_1": "Gold",
                    "jersey_number": new_jersey,
                    "weight_lbs": new_weight,
                    "speed": new_speed,
                    "position": target["position"],
                    "national_rank": target["national_rank"],
                },
            )
            self.assertTrue(Path(result["backup"]["backup"]).is_file())
            self.assertEqual(result["player"]["dev_trait"], "College_Star")
            self.assertEqual(result["player"]["dealbreaker"], "PlayingTime")
            self.assertEqual(result["player"]["physical_rank_1"], new_physical_rank)
            self.assertEqual(result["player"]["mental_ability_1"], "TheNatural")
            self.assertEqual(result["player"]["mental_rank_1"], "Gold")
            self.assertEqual(result["player"]["jersey_number"], new_jersey)
            self.assertEqual(result["player"]["weight_lbs"], new_weight)
            self.assertEqual(result["player"]["speed"], new_speed)
            updated = store.get_recruits(file_name, limit=5)
            updated_target = next(row for row in updated["players"] if row["id"] == target["id"])
            self.assertEqual(updated_target["dev_trait"], "College_Star")
            self.assertEqual(updated_target["dealbreaker"], "PlayingTime")
            self.assertEqual(updated_target["physical_rank_1"], new_physical_rank)
            self.assertEqual(updated_target["mental_ability_1"], "TheNatural")
            self.assertEqual(updated_target["mental_rank_1"], "Gold")
            self.assertEqual(updated_target["jersey_number"], new_jersey)
            self.assertEqual(updated_target["weight_lbs"], new_weight)
            self.assertEqual(updated_target["speed"], new_speed)


if __name__ == "__main__":
    unittest.main()
