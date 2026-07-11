from __future__ import annotations

import importlib.util
import gzip
import hashlib
import json
import os
import subprocess
import shutil
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import server
import live_process
from live_process import (
    LIVE_PLAYER_DUPLICATE_OFFSETS,
    LIVE_PLAYER_ID_OFFSET,
    LIVE_PLAYER_OBJECT_SIZE,
    LIVE_PLAYER_RATING_OFFSETS,
    configured_game_dir,
    decode_live_player_object,
    executable_build,
    live_rating_write_addresses,
)
from native_hook import native_artifacts, resolve_lua_script
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
    read_dotenv_values,
    resolve_save_dir,
    parse_player_records,
    patch_player_payload,
    patch_recruits_payload,
    preview_recruiting_plan,
    validate_recruit_patch_capabilities,
    validate_generated_preview_class,
)


SAVE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"


def load_upstream_import_module():
    spec = importlib.util.spec_from_file_location("upstream_import", APP_DIR / "tools" / "upstream_import.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_upstream_tuning_export_module():
    spec = importlib.util.spec_from_file_location(
        "upstream_tuning_export",
        APP_DIR / "tools" / "upstream_tuning_export.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_upstream_decode_maps_module():
    spec = importlib.util.spec_from_file_location(
        "upstream_decode_maps",
        APP_DIR / "tools" / "upstream_decode_maps.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_upstream_label_confidence_module():
    spec = importlib.util.spec_from_file_location(
        "upstream_label_confidence",
        APP_DIR / "tools" / "upstream_label_confidence.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_recruiting_probe_module():
    spec = importlib.util.spec_from_file_location(
        "recruiting_probe",
        APP_DIR / "tools" / "recruiting_probe.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_recruiting_diff_module():
    spec = importlib.util.spec_from_file_location("recruiting_diff", APP_DIR / "tools" / "recruiting_diff.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class EditorTests(unittest.TestCase):
    def test_startup_lua_host_client_reports_status_and_evaluates_in_process(self) -> None:
        import native_hook

        calls = []
        with patch(
            "native_hook._hook_command_to_pipe",
            side_effect=lambda pid, command, **kwargs: calls.append((pid, command, kwargs))
            or {"ok": True, "ready": True},
        ):
            status = native_hook.startup_lua_status(321)
            evaluated = native_hook.eval_startup_lua(321, 'cfb.log("hello")')
        self.assertTrue(status["loaded"])
        self.assertTrue(status["ready"])
        self.assertTrue(evaluated["ok"])
        self.assertEqual(calls[0][1], "STATUS")
        self.assertEqual(calls[1][1], 'EVAL cfb.log("hello")')
        self.assertTrue(all(call[2]["pipe_prefix"] == native_hook.LUA_HOST_PIPE_PREFIX for call in calls))

    def test_startup_hook_install_preserves_mmc_proxy_and_is_reversible(self) -> None:
        import startup_hook

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            game_dir = root / "game"
            third_party = root / "tools" / "ThirdParty"
            artifacts = root / "artifacts"
            game_dir.mkdir()
            third_party.mkdir(parents=True)
            artifacts.mkdir()
            mmc_bytes = b"original-mmc-cryptbase"
            proxy_bytes = b"cfb27-startup-proxy"
            host_bytes = b"cfb27-lua-host"
            (game_dir / "CryptBase.dll").write_bytes(mmc_bytes)
            (third_party / "CryptBase.dll").write_bytes(mmc_bytes)
            proxy = artifacts / "cfb27_cryptbase_proxy.dll"
            host = artifacts / "cfb27_lua_host.dll"
            autorun = artifacts / "autorun.lua"
            proxy.write_bytes(proxy_bytes)
            host.write_bytes(host_bytes)
            autorun.write_text('cfb.log("autorun")', encoding="utf-8")
            expected_hash = hashlib.sha256(mmc_bytes).hexdigest().upper()

            with patch("startup_hook.running_game_processes", return_value=[]):
                result = startup_hook.install_startup_hook(
                    game_dir,
                    third_party.parent,
                    proxy,
                    host,
                    autorun_script=autorun,
                    expected_mmc_sha256=expected_hash,
                )
            self.assertTrue(result["installed"])
            self.assertEqual((game_dir / "MMCBase.dll").read_bytes(), mmc_bytes)
            self.assertEqual((third_party / "MMCBase.dll").read_bytes(), mmc_bytes)
            self.assertEqual((game_dir / "CryptBase.dll").read_bytes(), proxy_bytes)
            self.assertEqual((third_party / "CryptBase.dll").read_bytes(), proxy_bytes)
            self.assertEqual((game_dir / "CFB27LiveEditor" / "cfb27_lua_host.dll").read_bytes(), host_bytes)
            self.assertEqual(
                (game_dir / "CFB27LiveEditor" / "scripts" / "autorun.lua").read_text(encoding="utf-8"),
                'cfb.log("autorun")',
            )

            with patch("startup_hook.running_game_processes", return_value=[]):
                restored = startup_hook.uninstall_startup_hook(game_dir, third_party.parent)
            self.assertTrue(restored["restored"])
            self.assertEqual((game_dir / "CryptBase.dll").read_bytes(), mmc_bytes)
            self.assertEqual((third_party / "CryptBase.dll").read_bytes(), mmc_bytes)

    def test_startup_lua_host_contract_uses_mmc_proxy_chain_without_remote_injection(self) -> None:
        host_path = APP_DIR / "native" / "lua_host.cpp"
        proxy_path = APP_DIR / "native" / "cryptbase_proxy.cpp"
        exports_path = APP_DIR / "native" / "cryptbase_proxy.def"
        self.assertTrue(host_path.is_file())
        self.assertTrue(proxy_path.is_file())
        self.assertTrue(exports_path.is_file())
        host = host_path.read_text(encoding="utf-8")
        proxy = proxy_path.read_text(encoding="utf-8")
        exports = exports_path.read_text(encoding="utf-8")
        cmake = (APP_DIR / "native" / "CMakeLists.txt").read_text(encoding="utf-8")
        self.assertIn("CFB27LuaHost.", host)
        self.assertIn("9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8", host)
        self.assertIn("LuaAobScan", host)
        self.assertIn("LuaReadU8", host)
        self.assertIn("LuaWriteU8", host)
        self.assertIn("LuaOn", host)
        self.assertIn('FireEvent("game_ready")', host)
        self.assertIn("RunAutorun", host)
        self.assertIn("cfb27_lua_host.dll", proxy)
        self.assertIn("CFB27LiveEditor", proxy)
        self.assertIn("SystemFunction001=MMCBase.SystemFunction001", exports)
        self.assertIn("add_library(cfb27_lua_host SHARED lua_host.cpp)", cmake)
        self.assertIn("add_library(cfb27_cryptbase_proxy SHARED cryptbase_proxy.cpp cryptbase_proxy.def)", cmake)
        self.assertNotIn("CreateRemoteThread", host)
        self.assertNotIn("CreateRemoteThread", proxy)

    def test_startup_lua_host_does_not_allocate_executable_hash_buffer_on_thread_stack(self) -> None:
        host_source = (APP_DIR / "native" / "lua_host.cpp").read_text(encoding="utf-8")
        sha_start = host_source.index("std::string Sha256File")
        sha_end = host_source.index("bool VerifySupportedBuild", sha_start)
        sha_source = host_source[sha_start:sha_end]

        self.assertNotIn("std::array<char, 1024 * 1024>", sha_source)
        self.assertIn("std::vector<char> buffer", sha_source)

    def test_startup_lua_host_preserves_multiline_eval_payloads(self) -> None:
        host_source = (APP_DIR / "native" / "lua_host.cpp").read_text(encoding="utf-8")
        eval_start = host_source.index('if (verb == "EVAL")')
        eval_end = host_source.index('return "{\\"ok\\":false', eval_start)
        eval_source = host_source[eval_start:eval_end]

        self.assertIn("std::getline(input >> std::ws, script, '\\0')", eval_source)

    def test_native_hook_contract_includes_request_detour_lua_and_guarded_record_patch(self) -> None:
        hook_source = (APP_DIR / "native" / "hook.cpp").read_text(encoding="utf-8")
        cmake = (APP_DIR / "native" / "CMakeLists.txt").read_text(encoding="utf-8")
        self.assertIn("kSubmitEditPlayerRequestFactoryRva = 0x08A15DE0", hook_source)
        self.assertIn("FactoryDetour", hook_source)
        self.assertIn("kRequestPayloadOffset + g_pending->offset", hook_source)
        self.assertIn('verb == "PATCH_AT"', hook_source)
        self.assertIn('lua_setfield(state, -2, "queue_rating")', hook_source)
        self.assertIn('lua_setfield(state, -2, "patch_record")', hook_source)
        self.assertIn("lua-5.4.8.tar.gz", cmake)
        self.assertIn("4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae", cmake)
        self.assertTrue(resolve_lua_script("speed_test.lua").is_file())
        with self.assertRaises(PermissionError):
            resolve_lua_script("../outside.lua")
        artifacts = native_artifacts()
        self.assertTrue(str(artifacts["dll"]).endswith("cfb27_live_hook.dll"))
        self.assertTrue(str(artifacts["injector"]).endswith("cfb27_hook_injector.exe"))

    def test_full_cfb27_schema_exposes_dynasty_player_edit_permission(self) -> None:
        schema_path = APP_DIR / "schema" / "CFB27_809_0.gz"
        with gzip.open(schema_path, "rt", encoding="utf-8") as stream:
            schema = json.load(stream)
        league_setting = schema["schemaMap"]["LeagueSetting"]
        ability = next(item for item in league_setting["attributes"] if item["name"] == "AbilityEditControls")
        self.assertEqual(ability["type"], "AbilityEditControlOptions")
        members = {
            item["_name"]: item["_value"]
            for item in schema["enumMap"]["AbilityEditControlOptions"]["_members"]
        }
        self.assertEqual(members, {"NONE": 0, "COMMISHONLY": 1, "ANY": 2, "MAX": 3})

    def test_full_cfb27_schema_exposes_franchise_admin_levels(self) -> None:
        schema_path = APP_DIR / "schema" / "CFB27_809_0.gz"
        with gzip.open(schema_path, "rt", encoding="utf-8") as stream:
            schema = json.load(stream)
        franchise_user = schema["schemaMap"]["FranchiseUser"]
        admin = next(item for item in franchise_user["attributes"] if item["name"] == "AdminLevel")
        self.assertEqual(admin["type"], "AdminLevel")
        self.assertEqual(schema["enumMap"]["AdminLevel"]["_maxLength"], 2)
        members = {
            item["_name"]: item["_value"]
            for item in schema["enumMap"]["AdminLevel"]["_members"]
        }
        self.assertEqual(members, {"Owner": 0, "Commissioner": 1, "None": 2})

    def test_live_rating_write_addresses_cover_primary_and_duplicate_bytes(self) -> None:
        primary, duplicate = live_rating_write_addresses(0x10000000, "speed")
        self.assertEqual(primary, 0x10000164)
        self.assertEqual(duplicate, 0x10000165)
        overall_primary, overall_duplicate = live_rating_write_addresses(0x10000000, "overall")
        self.assertEqual(overall_primary, 0x1000010C)
        self.assertEqual(overall_duplicate, 0x1000010F)

    def test_live_rating_write_plan_accepts_verified_mixed_generations(self) -> None:
        objects = [
            {"address": 0x1000, "playerId": 25130, "ratings": {"speed": 86}, "duplicateRatingBytesValid": True},
            {"address": 0x2000, "playerId": 25130, "ratings": {"speed": 87}, "duplicateRatingBytesValid": True},
            {"address": 0x3000, "playerId": 25130, "ratings": {"speed": 82}, "duplicateRatingBytesValid": True},
        ]

        self.assertTrue(hasattr(live_process, "plan_live_rating_object_writes"))
        plan = live_process.plan_live_rating_object_writes(objects, 25130, "speed", 90)

        self.assertEqual([item["before"] for item in plan], [86, 87, 82])
        self.assertEqual([item["after"] for item in plan], [90, 90, 90])
        self.assertEqual([item["address"] for item in plan], [0x1000, 0x2000, 0x3000])

    def test_live_object_address_limit_covers_current_cache_generations(self) -> None:
        self.assertTrue(hasattr(live_process, "normalize_live_object_addresses"))
        addresses = [0x1000 + (index * 0x100) for index in range(17)]
        self.assertEqual(live_process.normalize_live_object_addresses(addresses), addresses)
        with self.assertRaisesRegex(ValueError, "One to 64"):
            live_process.normalize_live_object_addresses(range(65))

    def test_live_rating_write_plan_rejects_identity_or_integrity_mismatch(self) -> None:
        self.assertTrue(hasattr(live_process, "plan_live_rating_object_writes"))
        wrong_player = [
            {"address": 0x1000, "playerId": 99999, "ratings": {"speed": 86}, "duplicateRatingBytesValid": True},
        ]
        corrupt_duplicate = [
            {"address": 0x1000, "playerId": 25130, "ratings": {"speed": 86}, "duplicateRatingBytesValid": False},
        ]

        with self.assertRaisesRegex(RuntimeError, "Player ID changed"):
            live_process.plan_live_rating_object_writes(wrong_player, 25130, "speed", 90)
        with self.assertRaisesRegex(RuntimeError, "duplicate integrity failed"):
            live_process.plan_live_rating_object_writes(corrupt_duplicate, 25130, "speed", 90)

    def test_apply_live_rating_layers_writes_before_arming_fallback(self) -> None:
        self.assertTrue(hasattr(server, "apply_live_rating_layers"))
        discovery_queries = []

        def discover_player(_name, query, player_row=None):
            self.assertTrue(query)
            discovery_queries.append(query)
            return {
                "player": {
                    "row": player_row,
                    "playerId": 25130,
                    "firstName": "Kaelan",
                    "lastName": "Chudzinski",
                    "ratings": {"overall": 86, "speed": 87, "acceleration": 86, "agility": 84, "awareness": 83},
                },
                "discovery": {
                    "objects": [{"address": 0x1000}, {"address": 0x2000}],
                },
            }

        store = SimpleNamespace(
            validate_filename=lambda _name: Path("active-dynasty"),
            discover_live_player=discover_player,
        )
        patch_result = {
            "expectedBefore": 87,
            "player": {"playerId": 25130, "firstName": "Kaelan", "lastName": "Chudzinski"},
            "field": "speed",
            "value": 82,
        }
        calls = []
        with (
            patch("server.attach_hook", side_effect=lambda _pid: calls.append("attach-hook")),
            patch("server.player_rating_patch", return_value=patch_result),
            patch(
                "server.write_live_player_rating",
                side_effect=lambda *_args: calls.append("direct-write") or {"verified": True, "bytesWritten": 4},
            ),
            patch("server.attach_response_guard", side_effect=lambda _pid: calls.append("attach-guard")),
            patch(
                "server.queue_response_rating",
                side_effect=lambda *_args: calls.append("queue-guard") or {"queued": True},
            ),
            patch("server.unlock_dynasty_player_editing", return_value={"ok": True}),
            patch("server.start_dynasty_unlock_monitor", return_value={"running": True}),
            patch(
                "server.discover_live_player_objects",
                return_value={"count": 2, "objects": [{"address": 0x1000}, {"address": 0x2000}]},
            ),
        ):
            result = server.apply_live_rating_layers(store, "active-dynasty", 6228, 100, "speed", 87, 82)

        self.assertEqual(calls, ["attach-hook", "direct-write", "attach-guard", "queue-guard"])
        self.assertEqual(discovery_queries, ["Chudzinski"])
        self.assertTrue(result["directWrite"]["verified"])
        self.assertEqual(result["refresh"], "instant-pending-verification")

    def test_live_apply_ui_prefers_direct_write_message(self) -> None:
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
        start = app_js.index("async function writeLiveRating")
        end = app_js.index("async function discoverLivePlayer", start)
        live_apply = app_js[start:end]

        self.assertIn("response.directWrite?.verified", live_apply)
        self.assertIn("response.discovery", live_apply)
        self.assertIn("move the roster cursor away and back once", live_apply)
        self.assertNotIn("Reopen the player screen to verify", live_apply)

    def test_live_editor_exposes_persistent_lua_console_without_engineering_clutter(self) -> None:
        index_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

        self.assertIn('id="luaHostState"', index_html)
        self.assertIn('id="luaScriptInput"', index_html)
        self.assertIn('id="runLuaBtn"', index_html)
        self.assertIn("/api/live/lua/status", app_js)
        self.assertIn("/api/live/lua/eval", app_js)
        self.assertIn("async function runLuaSnippet", app_js)
        self.assertNotIn("CreateRemoteThread", index_html)

    def test_live_apply_endpoint_uses_layered_transaction(self) -> None:
        source = (APP_DIR / "server.py").read_text(encoding="utf-8")
        endpoint = source[source.index('if self.path == "/api/live/hook/apply-rating"') :]
        endpoint = endpoint[: endpoint.index('if self.path == "/api/live/hook/run-script"')]
        self.assertIn("apply_live_rating_layers(", endpoint)
        self.assertNotIn("queue_response_rating(", endpoint)

    def test_live_player_layout_decodes_verified_rating_pairs(self) -> None:
        data = bytearray(LIVE_PLAYER_OBJECT_SIZE)
        data[LIVE_PLAYER_ID_OFFSET : LIVE_PLAYER_ID_OFFSET + 4] = (25130).to_bytes(4, "little")
        expected = {
            "overall": 86,
            "speed": 82,
            "acceleration": 86,
            "strength": 77,
            "agility": 84,
            "awareness": 83,
            "change_of_direction": 80,
        }
        for field, value in expected.items():
            data[LIVE_PLAYER_RATING_OFFSETS[field]] = value
            data[LIVE_PLAYER_DUPLICATE_OFFSETS[field]] = value
        decoded = decode_live_player_object(bytes(data), 0x12340000)
        self.assertEqual(decoded["playerId"], 25130)
        self.assertEqual({field: decoded["ratings"][field] for field in expected}, expected)
        self.assertTrue(decoded["duplicateRatingBytesValid"])
        self.assertEqual(decoded["addressHex"], "0x12340000")

    def test_live_process_build_fingerprint_and_game_dir_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            game_dir = Path(temp_dir)
            executable = game_dir / "CollegeFB27.exe"
            executable.write_bytes(b"MZ-test-build")
            build = executable_build(executable)
            self.assertTrue(build["exists"])
            self.assertEqual(build["size"], len(b"MZ-test-build"))
            self.assertEqual(len(build["sha256"]), 64)
            self.assertFalse(build["recognized"])
            self.assertEqual(configured_game_dir({"CFB27_GAME_DIR": temp_dir}), game_dir.resolve())

    def test_live_status_endpoint_is_read_only(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        payload = {
            "supportedPlatform": True,
            "mode": "read-only-discovery",
            "writeEligible": False,
            "writeBlockers": ["test guard"],
        }
        try:
            with patch("server.live_status", return_value=payload):
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/live/status") as response:
                    self.assertEqual(json.loads(response.read()), payload)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def test_startup_lua_status_endpoint_reports_persistent_host(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        expected = {
            "loaded": True,
            "ready": True,
            "supportedBuild": True,
            "writesAllowed": True,
            "ticks": 12,
        }
        try:
            with (
                patch("server.live_status", return_value={"gameProcesses": [{"pid": 6228}]}),
                patch("server.startup_lua_status", return_value=expected, create=True) as status_mock,
            ):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/live/lua/status") as response:
                        status_code = response.status
                        payload = json.loads(response.read())
                except urllib.error.HTTPError as exc:
                    status_code = exc.code
                    payload = json.loads(exc.read())
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

        self.assertEqual(status_code, 200)
        self.assertEqual(payload, expected)
        status_mock.assert_called_once_with(6228)

    def test_startup_lua_eval_endpoint_executes_in_persistent_host(self) -> None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        expected = {"ok": True, "result": "ok", "transport": "startup-lua-host"}
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/live/lua/eval",
            data=json.dumps({"script": 'cfb.log("from editor")'}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with (
                patch("server.live_status", return_value={"gameProcesses": [{"pid": 6228}]}),
                patch("server.startup_lua_status", return_value={"loaded": True, "ready": True}),
                patch("server.eval_startup_lua", return_value=expected, create=True) as eval_mock,
            ):
                try:
                    with urllib.request.urlopen(request) as response:
                        status_code = response.status
                        payload = json.loads(response.read())
                except urllib.error.HTTPError as exc:
                    status_code = exc.code
                    payload = json.loads(exc.read())
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

        self.assertEqual(status_code, 200)
        self.assertEqual(payload, expected)
        eval_mock.assert_called_once_with(6228, 'cfb.log("from editor")')

    def test_resolve_save_dir_defaults_to_app_parent(self) -> None:
        self.assertEqual(resolve_save_dir({}), APP_DIR.parent.resolve())

    def test_resolve_save_dir_uses_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            self.assertEqual(
                resolve_save_dir({"CFB27_SAVE_DIR": temp_dir}),
                Path(temp_dir).resolve(),
            )

    def test_resolve_save_dir_reads_dotenv_when_env_is_unset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv = Path(temp_dir) / ".env"
            save_dir = Path(temp_dir) / "live saves"
            dotenv.write_text(f'CFB27_SAVE_DIR = "{save_dir}"\n', encoding="utf-8")
            with patch.dict(os.environ, {"CFB27_SAVE_DIR": ""}):
                self.assertEqual(resolve_save_dir(dotenv_path=dotenv), save_dir.resolve())

    def test_read_dotenv_values_strips_quotes_and_spacing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dotenv = Path(temp_dir) / ".env"
            dotenv.write_text('CFB27_SAVE_DIR = "C:\\Saves"\n# ignored\n', encoding="utf-8")
            self.assertEqual(read_dotenv_values(dotenv), {"CFB27_SAVE_DIR": "C:\\Saves"})

    def test_spa_shell_exposes_generator_default_and_supporting_views(self) -> None:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        app_js = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

        self.assertIn('data-view-tab="generator"', html)
        self.assertIn('data-view="generator"', html)
        self.assertLess(html.index('data-view-tab="generator"'), html.index('data-view-tab="configs"'))
        view_sections = {
            "configs": 'data-view="configs"',
            "recruit-editor": 'data-view="recruit-editor"',
            "live": 'data-view="live"',
            "save-tools": 'data-view="save-tools"',
            "schema": 'data-view="schema"',
            "tables": 'data-view="tables"',
            "roster": 'data-view="roster"',
        }
        for view, section in view_sections.items():
            self.assertIn(f'data-view-tab="{view}"', html)
            self.assertIn(section, html)

        self.assertIn('id="generatorEngineSelect" aria-label="Generator engine" hidden', html)
        self.assertIn('<option value="home-dogs">Home Dogs</option>', html)
        self.assertNotIn("Local Legacy", html)
        self.assertIn('id="exportPatchBtn" type="button" disabled hidden', html)
        self.assertNotIn('data-view="generator configs"', html)
        self.assertIn('activeView: "recruiting"', app_js)
        self.assertIn('return "recruiting";', app_js)
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

    def test_recruiting_diff_tool_names_local_board_fixture_targets(self) -> None:
        before = APP_DIR / ".requirements" / "ref-data" / "pre-season-0" / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
        after = APP_DIR / ".requirements" / "ref-data" / "week-0" / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
        schema = APP_DIR / "schema" / "CFB27_schema_for_madden_franchise.gz"
        if not before.is_file() or not after.is_file() or not schema.is_file():
            self.skipTest("Local recruiting fixture pair or generated schema is not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            output_json = Path(temp_dir) / "recruiting-diff.json"
            output_md = Path(temp_dir) / "recruiting-diff.md"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(APP_DIR / "tools" / "recruiting_diff.py"),
                    "--before",
                    str(before),
                    "--after",
                    str(after),
                    "--before-label",
                    "pre-season-0",
                    "--after-label",
                    "week-0",
                    "--user-team",
                    "Oregon",
                    "--output-json",
                    str(output_json),
                    "--output-md",
                    str(output_md),
                ],
                cwd=APP_DIR,
                check=True,
                capture_output=True,
                text=True,
                timeout=180,
            )
            summary = json.loads(completed.stdout)
            report = json.loads(output_json.read_text(encoding="utf-8"))
            markdown = output_md.read_text(encoding="utf-8")

        names = {target["name"] for target in report["boardTargets"]}
        self.assertTrue({"Isaac Bynum", "Kamryn Ekanem", "Kenyon Tabor"}.issubset(names))
        self.assertTrue(summary["readOnly"])
        self.assertGreater(report["tableDiffs"]["UserRecruitTarget"]["changedRowCount"], 0)
        self.assertIn("addedRowDetails", report["tableDiffs"]["UserRecruitTarget"])
        self.assertIn("RecruitingActionFeedbackEntry[]", report["tableDiffs"])
        self.assertIn("RecruitingActionBonus[]", report["tableDiffs"])
        self.assertEqual(report["saveComparison"], {"sameSaveBytes": False, "samePayloadBytes": False})
        self.assertEqual(report["fixtureContext"]["userTeam"], "Oregon")
        self.assertEqual(report["boardCandidates"][0]["row"], 87)
        self.assertEqual(report["boardCandidates"][0]["userRecruitTargetRows"], [0, 1, 2])
        self.assertEqual(report["boardCandidates"][0]["derivedAfterTargetCount"], 3)
        self.assertEqual(report["boardCandidates"][0]["derivedVisibleHours"]["afterUsed"], 725)
        self.assertEqual(report["boardCandidates"][0]["derivedAfterScheduledVisitCount"], 0)
        self.assertEqual(report["visitEvidence"]["scheduledTargetCountAfter"], 0)
        by_name = {target["name"]: target for target in report["boardTargets"]}
        self.assertEqual(by_name["Isaac Bynum"]["after"]["selectedActionHours"], 15)
        self.assertIn("SearchSocialMedia", by_name["Isaac Bynum"]["userRecruitTargetChanges"])
        bynum_interaction = by_name["Isaac Bynum"]["prospectInteractionChanges"][0]
        self.assertEqual(
            bynum_interaction["analysis"]["rawByteDiffs"],
            [{"byte": 11, "before": 0, "after": 16, "beforeHex": "00", "afterHex": "10", "xor": 16}],
        )
        self.assertIn("not independent visit-scheduling evidence", bynum_interaction["analysis"]["conclusion"])
        self.assertIn("Isaac Bynum", markdown)
        self.assertIn("Save Comparison", markdown)
        self.assertIn("Prospect Interaction Bit Notes", markdown)
        self.assertIn("Scheduled Visit Evidence", markdown)

    def test_recruiting_diff_tool_reports_week_three_visit_evidence(self) -> None:
        before = APP_DIR / ".requirements" / "ref-data" / "week-3" / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
        after = APP_DIR / ".requirements" / "ref-data" / "week-3" / "bynum-after" / "DYNASTY-JUL02-07h43m00-AUTOSAVE"
        schema = APP_DIR / "schema" / "CFB27_schema_for_madden_franchise.gz"
        if not before.is_file() or not after.is_file() or not schema.is_file():
            self.skipTest("Local week-3 recruiting fixture pair or generated schema is not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            output_json = Path(temp_dir) / "recruiting-diff.json"
            output_md = Path(temp_dir) / "recruiting-diff.md"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(APP_DIR / "tools" / "recruiting_diff.py"),
                    "--before",
                    str(before),
                    "--after",
                    str(after),
                    "--before-label",
                    "week-3",
                    "--after-label",
                    "week-3-bynum-after",
                    "--user-team",
                    "Oregon",
                    "--output-json",
                    str(output_json),
                    "--output-md",
                    str(output_md),
                ],
                cwd=APP_DIR,
                check=True,
                capture_output=True,
                text=True,
                timeout=180,
            )
            summary = json.loads(completed.stdout)
            report = json.loads(output_json.read_text(encoding="utf-8"))
            markdown = output_md.read_text(encoding="utf-8")

        self.assertEqual(report["saveComparison"], {"sameSaveBytes": True, "samePayloadBytes": True})
        self.assertEqual(report["boardCandidates"][0]["row"], 87)
        self.assertEqual(report["boardCandidates"][0]["derivedAfterTargetCount"], 5)
        self.assertEqual(report["boardCandidates"][0]["derivedAfterScheduledVisitCount"], 2)
        self.assertEqual(report["visitEvidence"]["scheduledTargetCountBefore"], 2)
        self.assertEqual(report["visitEvidence"]["scheduledTargetCountAfter"], 2)
        self.assertEqual(report["visitEvidence"]["unchangedScheduledTargetRows"], [3, 4])
        self.assertEqual(summary["visitEvidence"]["unchangedScheduledTargetRows"], [3, 4])
        by_name = {target["name"]: target for target in report["visitEvidence"]["targets"]}
        self.assertEqual(by_name["Miles Duck"]["after"]["scheduledVisit"]["row"], 206)
        self.assertEqual(by_name["Miles Duck"]["after"]["scheduledVisit"]["weekNumber"], 5)
        self.assertTrue(by_name["Miles Duck"]["afterConsistency"]["consistent"])
        self.assertEqual(by_name["Marquis Fenner"]["after"]["scheduledVisit"]["row"], 207)
        self.assertEqual(by_name["Marquis Fenner"]["after"]["scheduledVisit"]["weekNumber"], 6)
        self.assertTrue(by_name["Marquis Fenner"]["afterConsistency"]["consistent"])
        self.assertIn("Miles Duck", markdown)
        self.assertIn("Scheduled Visit Evidence", markdown)

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
        self.assertTrue(any(diff["field"] == "Player.ProspectStarRating" for diff in first["diffs"]))
        self.assertTrue(
            any(item["field"] == "Player.ProspectStarRating" for item in first["summary"]["diffFields"])
        )
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
        sample_patches = patches[:2]
        patched_payload, updated_players = patch_recruits_payload(payload, sample_patches, mode="generator")
        self.assertNotEqual(patched_payload, payload)
        self.assertEqual(len(updated_players), 2)
        expected_stars = {
            str(patch["source"]["recruitRow"]): patch["changes"].get("star_rating")
            for patch in sample_patches
            if patch["changes"].get("star_rating")
        }
        for player in updated_players:
            expected_star = expected_stars.get(str(player["recruit_index"]))
            if expected_star:
                self.assertEqual(player.get("star_rating"), expected_star)

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

    def test_generator_apply_development_writes_stay_preview_only(self) -> None:
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
                self.assertEqual(preview["summary"]["diffCount"], 0)
                self.assertGreater(preview["summary"]["skippedFieldCount"], 0)

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
            self.assertEqual(result["appliedRecruitCount"], 0)
            self.assertEqual(result["changedFieldCount"], 0)
            self.assertEqual(result["readBackMismatches"], [])
            self.assertEqual(result["writeMode"], "copy")
            self.assertTrue(Path(result["targetPath"]).is_file())
            self.assertEqual((temp / file_name).read_bytes(), original_bytes)
            self.assertEqual(Path(result["targetPath"]).read_bytes(), original_bytes)
            source_container = FBChunks.parse(original_bytes)
            target_bytes = Path(result["targetPath"]).read_bytes()
            target_container = FBChunks.parse(target_bytes)
            self.assertEqual(
                target_bytes[target_container.payload_offset + target_container.chunk1_budget :],
                original_bytes[source_container.payload_offset + source_container.chunk1_budget :],
            )

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
            config["writeFields"]["body"] = True
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

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_store = SaveStore(Path(temp_dir))
            temp_name = f"DYNASTY-CODEX-PREVIEW-{next(tempfile._get_candidate_names())}"
            shutil.copy2(dynasty_files[0], Path(temp_dir) / temp_name)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            with patch.object(server, "STORE", temp_store):
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
                self.assertGreater(container.chunk1_compressed_size, 0)
                self.assertGreaterEqual(container.chunk1_budget, container.chunk1_compressed_size)
                self.assertEqual(
                    len(container.source),
                    container.payload_offset + container.chunk1_compressed_size + len(container.tail),
                )

    def test_no_edit_rebuild_reparses(self) -> None:
        store = SaveStore(SAVE_DIR)
        for path in store.editable_files():
            with self.subTest(path=path.name):
                container = FBChunks.parse(path.read_bytes())
                rebuilt = container.rebuild(container.decompressed_payload)
                reparsed = FBChunks.parse(rebuilt)
                self.assertEqual(reparsed.decompressed_payload, container.decompressed_payload)
                self.assertEqual(len(rebuilt), len(container.source))
                self.assertEqual(
                    rebuilt[container.payload_offset + container.chunk1_budget :],
                    container.source[container.payload_offset + container.chunk1_budget :],
                )
                self.assertEqual(
                    int.from_bytes(rebuilt[14:18], "little"),
                    int.from_bytes(container.source[14:18], "little"),
                )

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
        self.assertEqual(len(rebuilt), len(container.source))
        self.assertEqual(
            rebuilt[container.payload_offset + container.chunk1_budget :],
            container.source[container.payload_offset + container.chunk1_budget :],
        )

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

    def test_recruiting_preview_validates_weekly_action_hour_delta(self) -> None:
        board = {
            "saveFingerprint": "abc",
            "counters": {"hoursUsed": 25, "hoursMax": 1000},
            "targets": [
                {
                    "id": "UserRecruitTarget:9",
                    "name": "Stanley Herron",
                    "actionBooleans": {"SendTheHouse": False},
                    "provenance": {"userRecruitTargetRow": 9},
                }
            ],
            "writeGates": {"actions": "preview-only"},
        }
        result = preview_recruiting_plan(
            board,
            [
                {
                    "type": "set-weekly-action",
                    "targetId": "UserRecruitTarget:9",
                    "userRecruitTargetRow": 9,
                    "actionField": "SendTheHouse",
                    "enabled": True,
                    "hoursDelta": 50,
                }
            ],
            expected_fingerprint="abc",
        )

        self.assertTrue(result["valid"])
        self.assertFalse(result["writeEnabled"])
        self.assertEqual(result["hourSummary"]["plannedDelta"], 50)
        self.assertEqual(result["hourSummary"]["projectedUsed"], 75)
        self.assertEqual(result["plannedTargets"][0]["status"], "validated-preview-write-gated")
        self.assertEqual(result["plannedTargets"][0]["actionField"], "SendTheHouse")

    def test_upstream_import_manifest_requires_source_metadata(self) -> None:
        upstream_import = load_upstream_import_module()
        with self.assertRaises(ValueError) as missing:
            upstream_import.validate_manifest_sources({
                "sources": [
                    {
                        "repo": "bphit4/FB-Roster-Editor",
                        "url": "https://github.com/bphit4/FB-Roster-Editor",
                    }
                ]
            })
        self.assertIn("sources[0].commit", str(missing.exception))
        self.assertIn("sources[0].archiveSha256", str(missing.exception))

    def test_upstream_import_normalizes_extra_color_csv_columns(self) -> None:
        upstream_import = load_upstream_import_module()
        rows = upstream_import.json_safe_csv_rows([
            {"Team": "NC State", "Color 1": "#CC0000", None: ["#FFFFFF"]}
        ])
        self.assertEqual(rows, [{"Team": "NC State", "Color 1": "#CC0000", "_extra": ["#FFFFFF"]}])

    def test_upstream_import_generates_zip_based_research_artifacts(self) -> None:
        fb_zip = APP_DIR / ".requirements" / "upstream-cache" / "FB-Roster-Editor-main.zip"
        manager_zip = APP_DIR / ".requirements" / "upstream-cache" / "My-CFB-Dynasty-Manager-main.zip"
        if not fb_zip.is_file() or not manager_zip.is_file():
            self.skipTest("Local upstream repository ZIPs are not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(APP_DIR / "tools" / "upstream_import.py"),
                    "--fb-roster-zip",
                    str(fb_zip),
                    "--dynasty-manager-zip",
                    str(manager_zip),
                    "--output-dir",
                    temp_dir,
                    "--tuning-export-dir",
                    str(Path(temp_dir) / "missing-exports"),
                    "--generated-at",
                    "2026-07-05T00:00:00Z",
                ],
                cwd=APP_DIR,
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
            stdout = json.loads(completed.stdout)
            manifest = json.loads((Path(temp_dir) / "upstream-import-manifest.json").read_text(encoding="utf-8"))
            tuning = json.loads((Path(temp_dir) / "upstream-cfb27-tuning-summary.json").read_text(encoding="utf-8"))
            schema = json.loads((Path(temp_dir) / "upstream-cfb27-schema-snapshot.json").read_text(encoding="utf-8"))
            team = json.loads((Path(temp_dir) / "upstream-team-workflow-summary.json").read_text(encoding="utf-8"))

        self.assertIn("manifest", stdout)
        self.assertEqual(manifest["kind"], "cfb27.upstreamImportManifest.v1")
        self.assertEqual(manifest["sources"][0]["commit"], "9e91540e9ff72a6aa953a21ec86a122f8278e82d")
        self.assertEqual(manifest["sources"][1]["commit"], "a98f7b40cef3392b3cdfc49dd2040f47221a49b8")
        self.assertFalse(manifest["safety"]["writeRecipesEnabled"])
        self.assertGreaterEqual(tuning["relevantTableCount"], 90)
        self.assertIn("action", tuning["groups"])
        self.assertGreaterEqual(len(tuning["missingTableExports"]), 1)
        self.assertTrue(any(item["name"] == "UserRecruitTarget" for item in schema["schemas"]))
        self.assertGreaterEqual(team["fbsTeamRows"], 100)
        self.assertGreaterEqual(team["logoAssetCount"], 100)

    def test_upstream_tuning_export_resolves_nested_fb_roster_root(self) -> None:
        upstream_export = load_upstream_tuning_export_module()
        root = APP_DIR / ".requirements" / "upstream-cache" / "FB-Roster-Editor"
        if not root.is_dir():
            self.skipTest("Local extracted FB-Roster-Editor directory is not available")
        resolved = upstream_export.resolve_fb_roster_root(root)
        self.assertEqual(resolved.name, "FB-Roster-Editor-main")
        self.assertTrue((resolved / "backend" / "tools" / "madden_franchise_bridge.mjs").is_file())

    def test_upstream_tuning_export_generates_recruiting_tables_and_csvs(self) -> None:
        root = APP_DIR / ".requirements" / "upstream-cache" / "FB-Roster-Editor"
        if not root.is_dir():
            self.skipTest("Local extracted FB-Roster-Editor directory is not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            aggregate_path = Path(temp_dir) / "upstream-cfb27-recruiting-tuning-tables.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(APP_DIR / "tools" / "upstream_tuning_export.py"),
                    "--fb-roster-dir",
                    str(root),
                    "--output-dir",
                    temp_dir,
                    "--aggregate-output",
                    str(aggregate_path),
                ],
                cwd=APP_DIR,
                check=True,
                capture_output=True,
                text=True,
                timeout=300,
            )
            manifest = json.loads(completed.stdout)
            aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))

        self.assertEqual(manifest["failedExportCount"], 0)
        self.assertGreaterEqual(manifest["exportedTableCount"], 90)
        self.assertEqual(manifest["exportedTableCount"], manifest["csvTableCount"])
        action_type = next(
            table for table in aggregate["tables"]
            if table["actualName"] == "RecruitingActionTypeEnumTableEntry"
        )
        labels = {record["LongName"] for record in action_type["records"]}
        self.assertIn("Contact Friends and Family", labels)
        self.assertIn("DM the Player", labels)

    def test_upstream_decode_maps_match_known_weekly_action_costs(self) -> None:
        source = APP_DIR / ".requirements" / "research" / "upstream-cfb27-recruiting-tuning-tables.json"
        if not source.is_file():
            self.skipTest("Local upstream recruiting tuning table artifact is not available")
        upstream_decode = load_upstream_decode_maps_module()
        maps = upstream_decode.build_decode_maps(source)
        weekly = maps["weeklyActionFields"]
        self.assertEqual(weekly["SearchSocialMedia"]["upstream"]["cost"], 5)
        self.assertEqual(weekly["SearchSocialMedia"]["upstream"]["action"]["shortName"], "Social Media")
        self.assertEqual(weekly["ContactHighSchoolCoaches"]["upstream"]["cost"], 10)
        self.assertEqual(weekly["ContactHighSchoolCoaches"]["upstream"]["action"]["shortName"], "DM Player")
        self.assertEqual(weekly["ContactFriendsAndFamily"]["upstream"]["cost"], 25)
        self.assertEqual(weekly["SendTheHouse"]["upstream"]["cost"], 50)
        self.assertEqual(weekly["SendTheHouse"]["status"], "validated-multi-source")
        active_visit = maps["derived"]["activeVisitInfoActivityLowNibble"]
        self.assertEqual(active_visit["13"]["shortName"], "Tailgate")

    def test_recruiting_diff_enrichment_adds_upstream_action_labels(self) -> None:
        source = APP_DIR / ".requirements" / "research" / "upstream-cfb27-recruiting-tuning-tables.json"
        if not source.is_file():
            self.skipTest("Local upstream recruiting tuning table artifact is not available")
        upstream_decode = load_upstream_decode_maps_module()
        recruiting_diff = load_recruiting_diff_module()
        decode_maps = upstream_decode.build_decode_maps(source)
        report = {
            "before": {
                "label": "before",
                "saveSha256": "A",
                "payloadSha256": "B",
                "payloadBytes": 1,
                "tailBytes": 0,
            },
            "after": {
                "label": "after",
                "saveSha256": "C",
                "payloadSha256": "D",
                "payloadBytes": 1,
                "tailBytes": 0,
            },
            "boardTargets": [
                {
                    "before": {"actionBooleans": {"SearchSocialMedia": False}},
                    "after": {
                        "actionBooleans": {
                            "SearchSocialMedia": True,
                            "ContactHighSchoolCoaches": True,
                            "ContactFriendsAndFamily": False,
                        },
                        "scheduledVisit": {
                            "activity": "00000000000000000000111000101101",
                            "weekType": 1,
                            "weekNumber": 13,
                        },
                        "prospectVisitState": {
                            "visitActivityType": "01110001011010000000000000000000",
                            "visitWeekType": "00010110100000000000000000000000",
                        },
                        "activePitches": [
                            {
                                "field": "ActiveRecruitingPitch0",
                                "row": 1347,
                                "pitch": 0,
                                "intensity": "00000000000000000000000000000000",
                            }
                        ],
                        "recruitingProfile": {
                            "dealbreakerRaw": "10011011101010100101001010011100",
                            "idealPitchRaw": "01000011001010001000000000000000",
                            "motivation1Raw": "0000",
                            "motivation2Raw": "0000",
                            "motivation3Raw": "0000",
                        },
                    },
                }
            ],
            "tableDiffs": {
                "RecruitingActionFeedbackEntry": {
                    "name": "RecruitingActionFeedbackEntry",
                    "addedRowDetails": [
                        {
                            "row": 1,
                            "fields": {
                                "BonusList": "00101101101010100000000000001111",
                                "HoursSpent": 0,
                                "MinInfluenceGain": 0,
                                "IntelUnlocked": 0,
                                "RecruitingActionType": 1,
                                "InfluenceGained": 0,
                                "MaxInfluenceGain": 0,
                            },
                            "references": {
                                "BonusList": {
                                    "tableId": 5845,
                                    "table": "RecruitingActionBonus[]",
                                    "row": 15,
                                }
                            },
                        },
                        {"row": 2, "fields": {"RecruitingActionType": 4}},
                    ],
                    "removedRowDetails": [],
                    "changedRows": [],
                },
                "RecruitingActionBonus": {
                    "name": "RecruitingActionBonus",
                    "addedRowDetails": [
                        {
                            "row": 10,
                            "fields": {
                                "BonusType": "00000000000000000000000101100100",
                                "BonusValueType": 1,
                                "BonusValue": 100,
                            },
                            "references": {
                                "BonusType": {"tableId": 0, "table": None, "row": 356}
                            },
                        }
                    ],
                    "removedRowDetails": [],
                    "changedRows": [],
                },
                "RecruitingActionBonus[]": {
                    "name": "RecruitingActionBonus[]",
                    "addedRowDetails": [
                        {
                            "row": 15,
                            "fields": {
                                "RecruitingActionBonus0": "00100001001001000000000000001010"
                            },
                            "references": {
                                "RecruitingActionBonus0": {
                                    "tableId": 4242,
                                    "table": "RecruitingActionBonus",
                                    "row": 10,
                                }
                            },
                        }
                    ],
                    "removedRowDetails": [],
                    "changedRows": [],
                }
            },
        }
        recruiting_diff.enrich_report_with_decodes(report, decode_maps)
        details = report["boardTargets"][0]["after"]["selectedActionDetails"]
        labels = [item["upstream"]["action"]["shortName"] for item in details]
        self.assertEqual(labels, ["Social Media", "DM Player"])
        profile_decodes = report["boardTargets"][0]["after"]["recruitingProfile"]["decoded"]
        self.assertEqual(profile_decodes["dealbreaker"]["shortName"], "Playing Time")
        self.assertEqual(profile_decodes["dealbreaker"]["decodeMethod"], "player-recruiting-dealbreaker-high-nibble")
        self.assertEqual(profile_decodes["idealPitch"]["shortName"], "The Clutch")
        self.assertEqual(profile_decodes["idealPitch"]["decodeMethod"], "player-ideal-recruiting-pitch-high-five-bits")
        active_pitch = recruiting_diff.decode_field_value(decode_maps, "ActiveRecruitingPitch", "Pitch", 11)
        self.assertEqual(active_pitch["shortName"], "Aspirational Goals")
        decoded = report["tableDiffs"]["RecruitingActionFeedbackEntry"]["addedRowDetails"]
        self.assertEqual(decoded[0]["decodedFields"]["RecruitingActionType"]["shortName"], "Scouting")
        self.assertEqual(decoded[1]["decodedFields"]["RecruitingActionType"]["shortName"], "Schedule Visit")
        visit = report["boardTargets"][0]["after"]["scheduledVisit"]
        self.assertEqual(visit["activityDecoded"]["shortName"], "Tailgate")
        self.assertEqual(visit["activityDecoded"]["decodeMethod"], "active-visit-activity-low-nibble")
        prospect = report["boardTargets"][0]["after"]["prospectVisitState"]
        self.assertEqual(
            prospect["visitActivityTypeDecode"]["status"],
            "unresolved-reference-window",
        )
        self.assertEqual(prospect["visitActivityTypeDecode"]["reference"]["row"], 0)
        evidence = report["recruitingActionEvidence"]
        self.assertEqual(evidence["feedbackEntries"][0]["action"], "Scouting")
        self.assertEqual(evidence["feedbackEntries"][0]["linkedBonuses"][0]["valueType"], "Percentage")
        self.assertEqual(evidence["feedbackEntries"][0]["linkedBonuses"][0]["value"], 100)
        markdown = recruiting_diff.markdown_report(report)
        self.assertIn("Recruiting Action Evidence", markdown)
        self.assertIn("Scouting", markdown)
        self.assertIn("Percentage 100", markdown)
        self.assertIn("UserRecruitTarget Active Pitch State", markdown)
        self.assertIn("1347:0/00000000000000000000000000000000", markdown)
        self.assertFalse(report["upstreamDecodes"]["writeRecipesEnabled"])

    def test_upstream_label_confidence_tracks_validated_and_blocked_families(self) -> None:
        decode_maps = APP_DIR / ".requirements" / "research" / "upstream-cfb27-recruiting-decode-maps.json"
        manual_report = APP_DIR / ".requirements" / "research" / "manual-send-house-scout-visit-diff.json"
        if not decode_maps.is_file() or not manual_report.is_file():
            self.skipTest("Local upstream decode maps or manual recruiting report is not available")
        confidence_tool = load_upstream_label_confidence_module()
        confidence = confidence_tool.build_confidence(decode_maps, [manual_report])
        families = confidence["families"]
        manual = json.loads(manual_report.read_text(encoding="utf-8"))

        self.assertEqual(families["weeklyActions"]["confidence"], "validated-015-read-label")
        weekly_fields = {item["field"] for item in families["weeklyActions"]["evidence"]}
        self.assertIn("SendTheHouse", weekly_fields)
        self.assertFalse(families["weeklyActions"]["blocked"])
        self.assertEqual(
            families["activeVisitActivity"]["confidence"],
            "medium-read-only-fixture-label",
        )
        self.assertTrue(
            any(item["label"] == "Tailgate" for item in families["activeVisitActivity"]["evidence"])
        )
        self.assertEqual(
            families["feedbackActionType"]["confidence"],
            "matched-manual-fixture-read-label",
        )
        self.assertEqual(families["pitchType"]["confidence"], "matched-fixture-read-label")
        self.assertTrue(
            any(item["field"] == "Player.IdealRecruitingPitch" for item in families["pitchType"]["evidence"])
        )
        self.assertEqual(families["motivation"]["confidence"], "matched-fixture-read-label")
        self.assertTrue(
            any(item["field"] == "Player.RecruitingDealbreaker" for item in families["motivation"]["evidence"])
        )
        self.assertEqual(families["scoutingGrade"]["confidence"], "upstream-only-no-fixture-evidence")
        self.assertTrue(
            any(item["action"] == "Scouting" for item in families["feedbackActionType"]["evidence"])
        )
        self.assertTrue(
            any(item["valueType"] == "Percentage" for item in families["bonusValueType"]["evidence"])
        )
        blocker_families = {item["family"] for item in families["unresolvedReferenceWindows"]["evidence"]}
        self.assertIn("RecruitingActionFeedbackEntry.RecruitingActionIntensity", blocker_families)
        self.assertIn("RecruitingActionBonus.BonusType", blocker_families)
        self.assertFalse(confidence["safety"]["validatedWriteRecipesEnabled"])
        self.assertTrue(confidence["safety"]["experimentalProbeWritesEnabled"])
        active_pitch_evidence = [
            item
            for target in manual.get("boardTargets", [])
            for item in ((target.get("after") or {}).get("sameRecruitTargetActivePitches") or [])
        ]
        self.assertGreaterEqual(len(active_pitch_evidence), 1)
        self.assertTrue(all(item["ownershipStatus"] == "ambiguous-read-only" for item in active_pitch_evidence))
        self.assertTrue(any(item.get("referencingBoardRows") for item in active_pitch_evidence))

    def test_recruiting_probe_builds_experimental_action_and_field_patches(self) -> None:
        recruiting_probe = load_recruiting_probe_module()
        args = SimpleNamespace(
            patch_json=None,
            board_row=87,
            no_board_hours=False,
            user_target_row=9,
            action="SendTheHouse",
            disable=False,
            sway_pitch="Aspirational",
            scholarship_status=None,
            commit=True,
            committed_week=7,
            active_pitch_row=42,
            active_pitch_index=0,
            pitch="Aspirational",
            pitch_intensity="Sway",
        )
        patch = recruiting_probe.load_probe_patch(args)
        self.assertEqual(
            patch["patches"],
            [{"userRecruitTargetRow": 9, "actionField": "SendTheHouse", "enabled": True}],
        )
        self.assertEqual(patch["boardRow"], 87)
        self.assertTrue(patch["adjustBoardHours"])
        self.assertEqual(
            patch["fieldPatches"],
            [
                {
                    "table": "UserRecruitTarget",
                    "row": 9,
                    "field": "SwayPitch",
                    "value": "Aspirational",
                    "experimental": True,
                },
                {
                    "table": "UserRecruitTarget",
                    "row": 9,
                    "field": "ScholarshipStatus",
                    "value": "Committed",
                    "experimental": True,
                },
                {
                    "table": "UserRecruitTarget",
                    "row": 9,
                    "field": "CommittedWeekNumber",
                    "value": 7,
                    "experimental": True,
                },
                {
                    "table": "ActiveRecruitingPitch",
                    "row": 42,
                    "field": "Pitch",
                    "value": "Aspirational",
                    "experimental": True,
                },
                {
                    "table": "ActiveRecruitingPitch",
                    "row": 42,
                    "field": "Intensity",
                    "value": "Sway",
                    "experimental": True,
                },
            ],
        )

    def test_recruiting_probe_can_build_active_pitch_discovery_patch(self) -> None:
        recruiting_probe = load_recruiting_probe_module()
        args = SimpleNamespace(
            patch_json=None,
            board_row=87,
            no_board_hours=True,
            user_target_row=9,
            action=None,
            disable=False,
            sway_pitch=None,
            scholarship_status=None,
            commit=False,
            committed_week=None,
            active_pitch_row=None,
            active_pitch_index=1,
            pitch="Aspirational",
            pitch_intensity="Sway",
        )
        patch = recruiting_probe.load_probe_patch(args)
        self.assertEqual(patch["patches"], [])
        self.assertFalse(patch["adjustBoardHours"])
        self.assertEqual(
            patch["fieldPatches"],
            [
                {
                    "table": "ActiveRecruitingPitch",
                    "field": "Pitch",
                    "value": "Aspirational",
                    "experimental": True,
                    "userRecruitTargetRow": 9,
                    "activePitchIndex": 1,
                },
                {
                    "table": "ActiveRecruitingPitch",
                    "field": "Intensity",
                    "value": "Sway",
                    "experimental": True,
                    "userRecruitTargetRow": 9,
                    "activePitchIndex": 1,
                },
            ],
        )

    def test_recruiting_probe_encodes_active_pitch_labels_into_packed_value(self) -> None:
        source = APP_DIR / ".requirements" / "research" / "active-current.frk"
        if not source.is_file():
            self.skipTest("Local active-current payload fixture is not available")
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            patch_path = temp / "active-pitch-labels.json"
            output_path = temp / "active-pitch-labels.frk"
            patch_path.write_text(json.dumps({
                "adjustBoardHours": False,
                "fieldPatches": [
                    {
                        "table": "ActiveRecruitingPitch",
                        "row": 1,
                        "field": "Pitch",
                        "value": "Aspirational",
                    },
                    {
                        "table": "ActiveRecruitingPitch",
                        "row": 1,
                        "field": "Intensity",
                        "value": "Sway",
                    },
                ],
            }), encoding="utf-8")
            completed = subprocess.run(
                [
                    "node",
                    str(APP_DIR / "franchise_helper.js"),
                    "recruiting-probe-action",
                    str(source),
                    str(patch_path),
                    str(output_path),
                ],
                cwd=APP_DIR,
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
        report = json.loads(completed.stdout)
        self.assertEqual(report["changes"][0]["field"], "Pitch")
        self.assertEqual(report["changes"][0]["before"], 8)
        self.assertEqual(report["changes"][0]["after"], 11)
        self.assertEqual(report["changes"][0]["packedAfter"], "00000000000000000000000000001011")
        self.assertEqual(report["changes"][1]["field"], "Intensity")
        self.assertEqual(report["changes"][1]["before"], 0)
        self.assertEqual(report["changes"][1]["after"], 2)
        self.assertEqual(report["changes"][1]["packedAfter"], "00000000000000000000000001001011")

    def test_recruiting_probe_rejects_empty_active_pitch_list_slots(self) -> None:
        source = APP_DIR / ".requirements" / "research" / "active-current.frk"
        if not source.is_file():
            self.skipTest("Local active-current payload fixture is not available")
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            patch_path = temp / "active-pitch-empty-slot.json"
            output_path = temp / "active-pitch-empty-slot.frk"
            patch_path.write_text(json.dumps({
                "adjustBoardHours": False,
                "fieldPatches": [
                    {
                        "table": "ActiveRecruitingPitch",
                        "userRecruitTargetRow": 9,
                        "activePitchIndex": 0,
                        "field": "Pitch",
                        "value": "Aspirational",
                    },
                ],
            }), encoding="utf-8")
            completed = subprocess.run(
                [
                    "node",
                    str(APP_DIR / "franchise_helper.js"),
                    "recruiting-probe-action",
                    str(source),
                    str(patch_path),
                    str(output_path),
                ],
                cwd=APP_DIR,
                capture_output=True,
                text=True,
                timeout=120,
            )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("has no ActivePitches references", completed.stderr)
        self.assertFalse(output_path.exists())

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
