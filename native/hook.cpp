#include <windows.h>
#include <MinHook.h>

#include <array>
#include <algorithm>
#include <atomic>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

extern "C" {
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>
}

namespace {

constexpr std::uintptr_t kSubmitEditPlayerRequestFactoryRva = 0x08A15DE0;
constexpr std::uint64_t kCaptureLifetimeMs = 10'000;
constexpr std::uint32_t kRequestPayloadOffset = 0x28;
#ifdef CFB27_DIRECT_FAST
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27LiveEditorDirectFast.";
#elif defined(CFB27_FALLBACK_PIPE)
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27LiveEditorFallback.";
#elif defined(CFB27_DIRECT_ONLY)
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27LiveEditorDirect.";
#else
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27LiveEditor.";
#endif

struct RatingField {
  const char* name;
  std::uint32_t request_offset;
};

// Blaze::DynastyMode::CreatePlayer::SubmitEditPlayerRequest, full build
// 9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8.
constexpr std::array kRatingFields{
    RatingField{"overall", 0x220}, RatingField{"speed", 0x29D},
    RatingField{"acceleration", 0x010}, RatingField{"strength", 0x2A1},
    RatingField{"agility", 0x012}, RatingField{"awareness", 0x013},
    RatingField{"jumping", 0x1F6}, RatingField{"injury", 0x1F3},
    RatingField{"stamina", 0x29F}, RatingField{"toughness", 0x2AC},
    RatingField{"carrying", 0x019}, RatingField{"break_tackle", 0x017},
    RatingField{"trucking", 0x2AE}, RatingField{"bc_vision", 0x014},
    RatingField{"stiff_arm", 0x2A0}, RatingField{"spin_move", 0x29E},
    RatingField{"juke_move", 0x1F5}, RatingField{"break_sack", 0x016},
    RatingField{"run_block", 0x299}, RatingField{"pass_block", 0x223},
    RatingField{"impact_blocking", 0x1F2}, RatingField{"run_block_power", 0x298},
    RatingField{"run_block_finesse", 0x297}, RatingField{"pass_block_power", 0x222},
    RatingField{"pass_block_finesse", 0x221}, RatingField{"lead_block", 0x21A},
    RatingField{"throw_power", 0x2AA}, RatingField{"throw_under_pressure", 0x2AB},
    RatingField{"throw_accuracy_short", 0x2A8}, RatingField{"throw_accuracy_mid", 0x2A6},
    RatingField{"throw_accuracy_deep", 0x2A5}, RatingField{"throw_on_the_run", 0x2A9},
    RatingField{"play_action", 0x225}, RatingField{"tackle", 0x2A3},
    RatingField{"power_moves", 0x288}, RatingField{"finesse_moves", 0x1D2},
    RatingField{"block_shedding", 0x015}, RatingField{"pursuit", 0x292},
    RatingField{"play_recognition", 0x22A}, RatingField{"man_coverage", 0x21E},
    RatingField{"zone_coverage", 0x2B2}, RatingField{"hit_power", 0x1F1},
    RatingField{"press", 0x290}, RatingField{"catching", 0x01A},
    RatingField{"spectacular_catch", 0x29C}, RatingField{"catch_in_traffic", 0x01B},
    RatingField{"short_route_running", 0x296}, RatingField{"medium_route_running", 0x295},
    RatingField{"deep_route_running", 0x294}, RatingField{"kick_power", 0x1F8},
    RatingField{"kick_accuracy", 0x1F7}, RatingField{"kick_return", 0x1F9},
};

struct PendingOverride {
  std::string field;
  std::uint32_t offset{};
  int expected{-1};
  int value{-1};
  bool applied{false};
};

using FactoryFn = void*(__fastcall*)(void*, void*, void*);
FactoryFn g_original_factory = nullptr;
std::atomic<void*> g_last_request{nullptr};
std::atomic<std::uint64_t> g_capture_expires{0};
std::atomic<bool> g_running{true};
std::atomic<std::uint64_t> g_capture_count{0};
std::atomic<std::uint64_t> g_apply_count{0};
std::atomic<bool> g_request_hook_ready{false};
std::atomic<int> g_min_hook_initialize_status{-1};
std::atomic<int> g_min_hook_create_status{-1};
std::atomic<int> g_min_hook_enable_status{-1};
std::atomic<bool> g_absolute_hook_fallback{false};
std::mutex g_override_mutex;
std::optional<PendingOverride> g_pending;
std::mutex g_log_mutex;
std::filesystem::path g_log_path;

void Log(std::string_view message);

constexpr std::array<std::uint8_t, 15> kFactoryPrologue{
    0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x74,
    0x24, 0x10, 0x57, 0x48, 0x83, 0xEC, 0x20,
};

void WriteAbsoluteJump(std::uint8_t* destination, const void* target) {
  destination[0] = 0xFF;
  destination[1] = 0x25;
  std::memset(destination + 2, 0, 4);
  *reinterpret_cast<const void**>(destination + 6) = target;
}

bool InstallAbsoluteHookFallback(void* target, const void* detour, void** original) {
  auto* entry = static_cast<std::uint8_t*>(target);
  if (!std::equal(kFactoryPrologue.begin(), kFactoryPrologue.end(), entry)) {
    Log("absolute-hook fallback rejected unexpected factory prologue");
    return false;
  }
  constexpr std::size_t jump_size = 14;
  const std::size_t trampoline_size = kFactoryPrologue.size() + jump_size;
  auto* trampoline = static_cast<std::uint8_t*>(
      VirtualAlloc(nullptr, trampoline_size, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE));
  if (!trampoline) {
    Log("absolute-hook fallback could not allocate trampoline");
    return false;
  }
  std::memcpy(trampoline, entry, kFactoryPrologue.size());
  WriteAbsoluteJump(trampoline + kFactoryPrologue.size(), entry + kFactoryPrologue.size());

  DWORD previous = 0;
  if (!VirtualProtect(entry, kFactoryPrologue.size(), PAGE_EXECUTE_READWRITE, &previous)) {
    VirtualFree(trampoline, 0, MEM_RELEASE);
    Log("absolute-hook fallback could not change target protection");
    return false;
  }
  WriteAbsoluteJump(entry, detour);
  entry[jump_size] = 0x90;
  FlushInstructionCache(GetCurrentProcess(), entry, kFactoryPrologue.size());
  DWORD ignored = 0;
  VirtualProtect(entry, kFactoryPrologue.size(), previous, &ignored);
  *original = trampoline;
  return true;
}

void Log(std::string_view message) {
  std::lock_guard lock(g_log_mutex);
  if (g_log_path.empty()) return;
  std::ofstream stream(g_log_path, std::ios::app);
  stream << GetTickCount64() << " " << message << "\n";
}

const RatingField* FindRating(std::string_view name) {
  for (const auto& field : kRatingFields) {
    if (name == field.name) return &field;
  }
  return nullptr;
}

bool IsWritable(const void* address, std::size_t size) {
  MEMORY_BASIC_INFORMATION info{};
  if (!VirtualQuery(address, &info, sizeof(info))) return false;
  if (info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) return false;
  constexpr DWORD writable = PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  const auto start = reinterpret_cast<std::uintptr_t>(address);
  const auto end = start + size;
  const auto region_end = reinterpret_cast<std::uintptr_t>(info.BaseAddress) + info.RegionSize;
  return (info.Protect & writable) != 0 && end <= region_end;
}

bool IsReadableRegion(const MEMORY_BASIC_INFORMATION& info) {
  if (info.State != MEM_COMMIT || info.Type != MEM_PRIVATE || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) return false;
  constexpr DWORD readable = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  return (info.Protect & readable) != 0;
}

std::optional<std::vector<std::uint8_t>> DecodeHex(std::string_view text) {
  if (text.empty() || text.size() % 2 != 0) return std::nullopt;
  std::vector<std::uint8_t> bytes(text.size() / 2);
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    unsigned int value = 0;
    const char pair[] = {text[index * 2], text[index * 2 + 1], '\0'};
    const auto parsed = std::from_chars(pair, pair + 2, value, 16);
    if (parsed.ec != std::errc{} || parsed.ptr != pair + 2) return std::nullopt;
    bytes[index] = static_cast<std::uint8_t>(value);
  }
  return bytes;
}

struct RecordPatchResult {
  bool ok{false};
  std::uintptr_t address{0};
  std::size_t matches{0};
  std::size_t changed_bytes{0};
  std::string error;
};

RecordPatchResult PatchRecordAt(std::uintptr_t address,
                                const std::vector<std::uint8_t>& before,
                                const std::vector<std::uint8_t>& after) {
  RecordPatchResult result;
  result.address = address;
  result.matches = 1;
  if (before.size() != after.size() || before.size() < 32 || before.size() > 4096) {
    result.error = "record images must have the same size between 32 and 4096 bytes";
    return result;
  }
  std::vector<std::size_t> changed_offsets;
  for (std::size_t index = 0; index < before.size(); ++index) {
    if (before[index] != after[index]) changed_offsets.push_back(index);
  }
  if (changed_offsets.empty()) {
    result.error = "record patch does not change any bytes";
    return result;
  }
  auto* target = reinterpret_cast<std::uint8_t*>(address);
  if (!IsWritable(target, before.size()) || !std::equal(before.begin(), before.end(), target)) {
    result.error = "Player record identity check failed at the supplied address";
    return result;
  }
  for (const auto offset : changed_offsets) target[offset] = after[offset];
  if (!std::equal(after.begin(), after.end(), target)) {
    for (const auto offset : changed_offsets) target[offset] = before[offset];
    result.error = "Player record read-back failed; changes were rolled back";
    return result;
  }
  result.ok = true;
  result.changed_bytes = changed_offsets.size();
  Log("patched guarded Player record at " + std::to_string(address) +
      " (" + std::to_string(result.changed_bytes) + " byte(s))");
  return result;
}

RecordPatchResult PatchExactRecord(const std::vector<std::uint8_t>& before,
                                   const std::vector<std::uint8_t>& after) {
  RecordPatchResult result;
  if (before.size() != after.size() || before.size() < 32 || before.size() > 4096) {
    result.error = "record images must have the same size between 32 and 4096 bytes";
    return result;
  }
  std::vector<std::size_t> changed_offsets;
  for (std::size_t index = 0; index < before.size(); ++index) {
    if (before[index] != after[index]) changed_offsets.push_back(index);
  }
  if (changed_offsets.empty()) {
    result.error = "record patch does not change any bytes";
    return result;
  }

  SYSTEM_INFO system{};
  GetSystemInfo(&system);
  auto cursor = reinterpret_cast<std::uintptr_t>(system.lpMinimumApplicationAddress);
  const auto maximum = reinterpret_cast<std::uintptr_t>(system.lpMaximumApplicationAddress);
  const auto searcher = std::boyer_moore_searcher(before.begin(), before.end());
  std::vector<std::uintptr_t> matches;
  while (cursor < maximum && matches.size() < 2) {
    MEMORY_BASIC_INFORMATION info{};
    if (!VirtualQuery(reinterpret_cast<void*>(cursor), &info, sizeof(info))) break;
    const auto region_start = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
    const auto region_end = region_start + info.RegionSize;
    if (IsReadableRegion(info) && info.RegionSize >= before.size()) {
      auto* begin = reinterpret_cast<const std::uint8_t*>(region_start);
      auto* end = reinterpret_cast<const std::uint8_t*>(region_end);
      auto* found = std::search(begin, end, searcher);
      while (found != end && matches.size() < 2) {
        matches.push_back(reinterpret_cast<std::uintptr_t>(found));
        found = std::search(found + 1, end, searcher);
      }
    }
    if (region_end <= cursor) break;
    cursor = region_end;
  }
  result.matches = matches.size();
  if (matches.size() != 1) {
    result.error = matches.empty() ? "exact Player record was not found" : "Player record identity was not unique";
    return result;
  }

  return PatchRecordAt(matches[0], before, after);
}

bool TryApply(void* request) {
  if (!request) return false;
  std::lock_guard lock(g_override_mutex);
  if (!g_pending || g_pending->applied) return false;
  // Rating offsets are relative to the embedded PlayerInfo payload. The TDF
  // request object has a 0x28-byte object header before that payload.
  auto* target = reinterpret_cast<std::uint8_t*>(request) + kRequestPayloadOffset + g_pending->offset;
  if (!IsWritable(target, 1)) return false;
  if (*target != static_cast<std::uint8_t>(g_pending->expected)) return false;
  *target = static_cast<std::uint8_t>(g_pending->value);
  if (*target != static_cast<std::uint8_t>(g_pending->value)) return false;
  g_pending->applied = true;
  ++g_apply_count;
  Log("applied " + g_pending->field + " " + std::to_string(g_pending->expected) + " -> " + std::to_string(g_pending->value));
  return true;
}

void* __fastcall FactoryDetour(void* first, void* second, void* placement) {
  void* request = g_original_factory(first, second, placement);
  g_last_request.store(request, std::memory_order_release);
  g_capture_expires.store(GetTickCount64() + kCaptureLifetimeMs, std::memory_order_release);
  ++g_capture_count;
  TryApply(request);
  return request;
}

void WatchCapturedRequest() {
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
  while (g_running.load()) {
    const auto now = GetTickCount64();
    if (now <= g_capture_expires.load(std::memory_order_acquire)) {
      TryApply(g_last_request.load(std::memory_order_acquire));
      SwitchToThread();
    } else {
      Sleep(2);
    }
  }
}

bool QueueOverride(std::string_view field_name, int expected, int value, std::string& error) {
  const auto* field = FindRating(field_name);
  if (!field) {
    error = "unknown rating field";
    return false;
  }
  const int maximum = field_name == "overall" ? 100 : 99;
  if (expected < 0 || expected > maximum || value < 0 || value > maximum) {
    error = "rating values are outside the supported range";
    return false;
  }
  std::lock_guard lock(g_override_mutex);
  g_pending = PendingOverride{std::string(field_name), field->request_offset, expected, value, false};
  return true;
}

int LuaQueueRating(lua_State* state) {
  const char* field = luaL_checkstring(state, 1);
  const int expected = static_cast<int>(luaL_checkinteger(state, 2));
  const int value = static_cast<int>(luaL_checkinteger(state, 3));
  std::string error;
  if (!QueueOverride(field, expected, value, error)) return luaL_error(state, "%s", error.c_str());
  lua_pushboolean(state, 1);
  return 1;
}

int LuaStatus(lua_State* state) {
  lua_newtable(state);
  lua_pushinteger(state, static_cast<lua_Integer>(g_capture_count.load()));
  lua_setfield(state, -2, "captures");
  lua_pushinteger(state, static_cast<lua_Integer>(g_apply_count.load()));
  lua_setfield(state, -2, "applies");
  std::lock_guard lock(g_override_mutex);
  lua_pushboolean(state, g_pending && g_pending->applied);
  lua_setfield(state, -2, "applied");
  return 1;
}

int LuaPatchRecord(lua_State* state) {
  const std::string_view before_text = luaL_checkstring(state, 1);
  const std::string_view after_text = luaL_checkstring(state, 2);
  const auto before = DecodeHex(before_text);
  const auto after = DecodeHex(after_text);
  if (!before || !after) return luaL_error(state, "record images must be hexadecimal strings");
  const auto result = PatchExactRecord(*before, *after);
  if (!result.ok) return luaL_error(state, "%s", result.error.c_str());
  lua_newtable(state);
  lua_pushinteger(state, static_cast<lua_Integer>(result.address));
  lua_setfield(state, -2, "address");
  lua_pushinteger(state, static_cast<lua_Integer>(result.changed_bytes));
  lua_setfield(state, -2, "changed_bytes");
  return 1;
}

bool RunLuaFile(const std::filesystem::path& path, std::string& result) {
  if (!std::filesystem::is_regular_file(path)) {
    result = "script file was not found";
    return false;
  }
  lua_State* state = luaL_newstate();
  if (!state) {
    result = "could not create Lua state";
    return false;
  }
  luaL_openlibs(state);
  lua_newtable(state);
  lua_pushcfunction(state, LuaQueueRating);
  lua_setfield(state, -2, "queue_rating");
  lua_pushcfunction(state, LuaStatus);
  lua_setfield(state, -2, "status");
  lua_pushcfunction(state, LuaPatchRecord);
  lua_setfield(state, -2, "patch_record");
  lua_setglobal(state, "cfb");
  const std::string native_path = path.string();
  const int code = luaL_dofile(state, native_path.c_str());
  if (code != LUA_OK) result = lua_tostring(state, -1) ? lua_tostring(state, -1) : "Lua error";
  else result = "ok";
  lua_close(state);
  return code == LUA_OK;
}

std::string StatusJson() {
  std::ostringstream out;
  out << "{\"ok\":true,\"captures\":" << g_capture_count.load()
      << ",\"applies\":" << g_apply_count.load()
      << ",\"requestHookReady\":" << (g_request_hook_ready.load() ? "true" : "false")
      << ",\"minHookInitializeStatus\":" << g_min_hook_initialize_status.load()
      << ",\"minHookCreateStatus\":" << g_min_hook_create_status.load()
      << ",\"minHookEnableStatus\":" << g_min_hook_enable_status.load()
      << ",\"absoluteHookFallback\":" << (g_absolute_hook_fallback.load() ? "true" : "false");
  {
    std::lock_guard lock(g_override_mutex);
    out << ",\"queued\":" << (g_pending ? "true" : "false")
        << ",\"applied\":" << (g_pending && g_pending->applied ? "true" : "false");
    if (g_pending) out << ",\"field\":\"" << g_pending->field << "\"";
  }
  out << "}";
  return out.str();
}

std::string HandleCommand(std::string command) {
  while (!command.empty() && (command.back() == '\r' || command.back() == '\n')) command.pop_back();
  std::istringstream input(command);
  std::string verb;
  input >> verb;
  if (verb == "PING" || verb == "STATUS") return StatusJson();
  if (verb == "CLEAR") {
    std::lock_guard lock(g_override_mutex);
    g_pending.reset();
    return "{\"ok\":true}";
  }
  if (verb == "QUEUE") {
    std::string field;
    int expected = -1;
    int value = -1;
    input >> field >> expected >> value;
    std::string error;
    if (!QueueOverride(field, expected, value, error)) return "{\"ok\":false,\"error\":\"" + error + "\"}";
    return StatusJson();
  }
  if (verb == "PATCH") {
    std::string before_text;
    std::string after_text;
    input >> before_text >> after_text;
    const auto before = DecodeHex(before_text);
    const auto after = DecodeHex(after_text);
    if (!before || !after) return "{\"ok\":false,\"error\":\"record images must be hexadecimal strings\"}";
    const auto result = PatchExactRecord(*before, *after);
    if (!result.ok) return "{\"ok\":false,\"error\":\"" + result.error + "\",\"matches\":" + std::to_string(result.matches) + "}";
    std::ostringstream response;
    response << "{\"ok\":true,\"address\":" << result.address
             << ",\"changedBytes\":" << result.changed_bytes << "}";
    return response.str();
  }
  if (verb == "PATCH_AT") {
    std::string address_text;
    std::string before_text;
    std::string after_text;
    input >> address_text >> before_text >> after_text;
    std::uintptr_t address = 0;
    const auto parsed_address = std::from_chars(address_text.data(), address_text.data() + address_text.size(), address, 10);
    const auto before = DecodeHex(before_text);
    const auto after = DecodeHex(after_text);
    if (parsed_address.ec != std::errc{} || !before || !after) {
      return "{\"ok\":false,\"error\":\"PATCH_AT requires a decimal address and two hexadecimal record images\"}";
    }
    const auto result = PatchRecordAt(address, *before, *after);
    if (!result.ok) return "{\"ok\":false,\"error\":\"" + result.error + "\"}";
    std::ostringstream response;
    response << "{\"ok\":true,\"address\":" << result.address
             << ",\"changedBytes\":" << result.changed_bytes << "}";
    return response.str();
  }
  if (verb == "RUN") {
    std::string raw_path;
    std::getline(input >> std::ws, raw_path);
    std::string result;
    const bool ok = RunLuaFile(std::filesystem::u8path(raw_path), result);
    return std::string("{\"ok\":") + (ok ? "true" : "false") + ",\"result\":\"" + result + "\"}";
  }
  return "{\"ok\":false,\"error\":\"unknown command\"}";
}

void PipeServer() {
  const std::wstring pipe_name = std::wstring(kPipePrefix) + std::to_wstring(GetCurrentProcessId());
  while (g_running.load()) {
    HANDLE pipe = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
                                   PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                                   1, 64 * 1024, 64 * 1024, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) break;
    if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
      std::array<char, 64 * 1024> buffer{};
      DWORD read = 0;
      if (ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size() - 1), &read, nullptr)) {
        const std::string response = HandleCommand(std::string(buffer.data(), read));
        DWORD written = 0;
        WriteFile(pipe, response.data(), static_cast<DWORD>(response.size()), &written, nullptr);
      }
      FlushFileBuffers(pipe);
      DisconnectNamedPipe(pipe);
    }
    CloseHandle(pipe);
  }
}

DWORD WINAPI StartHook(void* module_value) {
  const auto module = static_cast<HMODULE>(module_value);
  wchar_t module_path[MAX_PATH]{};
  GetModuleFileNameW(module, module_path, MAX_PATH);
  g_log_path = std::filesystem::path(module_path).replace_extension(L".log");
  Log("starting CFB27 live hook");

#ifndef CFB27_DIRECT_ONLY
  const auto game_base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
  void* target = reinterpret_cast<void*>(game_base + kSubmitEditPlayerRequestFactoryRva);
  const auto initialize_status = MH_Initialize();
  g_min_hook_initialize_status.store(static_cast<int>(initialize_status));
  MH_STATUS create_status = MH_ERROR_NOT_INITIALIZED;
  MH_STATUS enable_status = MH_ERROR_NOT_INITIALIZED;
  if (initialize_status == MH_OK || initialize_status == MH_ERROR_ALREADY_INITIALIZED) {
    create_status = MH_CreateHook(target, &FactoryDetour, reinterpret_cast<void**>(&g_original_factory));
    if (create_status == MH_OK || create_status == MH_ERROR_ALREADY_CREATED) {
      enable_status = MH_EnableHook(target);
    }
  }
  g_min_hook_create_status.store(static_cast<int>(create_status));
  g_min_hook_enable_status.store(static_cast<int>(enable_status));
  g_request_hook_ready.store(
      (create_status == MH_OK || create_status == MH_ERROR_ALREADY_CREATED) &&
      (enable_status == MH_OK || enable_status == MH_ERROR_ENABLED));
  if (!g_request_hook_ready.load() && create_status == MH_ERROR_MEMORY_ALLOC) {
    const bool installed = InstallAbsoluteHookFallback(
        target, reinterpret_cast<const void*>(&FactoryDetour), reinterpret_cast<void**>(&g_original_factory));
    g_absolute_hook_fallback.store(installed);
    g_request_hook_ready.store(installed);
  }
  Log("MinHook status initialize=" + std::to_string(static_cast<int>(initialize_status)) +
      " create=" + std::to_string(static_cast<int>(create_status)) +
      " enable=" + std::to_string(static_cast<int>(enable_status)));
  if (!g_request_hook_ready.load()) Log("failed to install SubmitEditPlayerRequest hook; diagnostic pipe remains available");
#else
  Log("direct-record test mode; request detour intentionally disabled");
#endif

  std::thread watcher(WatchCapturedRequest);
  std::thread pipe(PipeServer);
  watcher.detach();
  pipe.detach();
  Log("hook ready");
  return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    if (HANDLE thread = CreateThread(nullptr, 0, StartHook, module, 0, nullptr)) CloseHandle(thread);
  }
  return TRUE;
}
