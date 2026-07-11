#include <windows.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <sstream>
#include <string>
#include <thread>

extern "C" {
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>
}

namespace {

constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27ResponseGuard.";
constexpr std::uintptr_t kEnterEditResponseVtableRva = 0x0B230A78;
constexpr std::uintptr_t kPlayerPayloadVtableRva = 0x0B037270;
constexpr std::size_t kResponseSize = 0x888;
constexpr std::size_t kResponsePayloadOffset = 0xE0;
constexpr std::size_t kPrimaryPlayerIdOffset = 0xD0;
constexpr std::size_t kSecondaryPlayerIdOffset = 0x28C;

struct RatingField { const char* name; std::size_t offset; };
constexpr std::array kRatings{
    RatingField{"overall",0x220}, RatingField{"speed",0x29D},
    RatingField{"acceleration",0x10}, RatingField{"strength",0x2A1},
    RatingField{"agility",0x12}, RatingField{"awareness",0x13},
    RatingField{"jumping",0x1F6}, RatingField{"carrying",0x19},
    RatingField{"break_tackle",0x17}, RatingField{"trucking",0x2AE},
    RatingField{"bc_vision",0x14}, RatingField{"stiff_arm",0x2A0},
};

std::atomic<bool> g_running{true};
std::atomic<bool> g_armed{false};
std::atomic<std::uint32_t> g_player_id{0};
std::atomic<int> g_expected{-1};
std::atomic<int> g_value{-1};
std::atomic<std::size_t> g_rating_offset{0};
std::atomic<std::uint64_t> g_guard_events{0};
std::atomic<std::uint64_t> g_captures{0};
std::atomic<std::uint64_t> g_applies{0};
std::atomic<std::uintptr_t> g_last_response{0};
std::atomic<int> g_last_observed{-1};
std::uintptr_t g_game_base{};
std::uint8_t* g_guard_page{};
DWORD g_original_protection{};
PVOID g_handler{};
thread_local bool g_rearm_after_step = false;

const RatingField* FindRating(const std::string& name) {
  for (const auto& rating : kRatings) if (name == rating.name) return &rating;
  return nullptr;
}

bool IsAccessible(const void* address, std::size_t size, bool writable = false) {
  MEMORY_BASIC_INFORMATION info{};
  if (!VirtualQuery(address, &info, sizeof(info))) return false;
  if (info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) return false;
  constexpr DWORD readable = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  constexpr DWORD writeable = PAGE_READWRITE | PAGE_WRITECOPY |
                              PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  const auto end = reinterpret_cast<std::uintptr_t>(address) + size;
  const auto region_end = reinterpret_cast<std::uintptr_t>(info.BaseAddress) + info.RegionSize;
  return end <= region_end && (info.Protect & (writable ? writeable : readable));
}

bool ArmGuard() {
  DWORD previous = 0;
  if (!VirtualProtect(g_guard_page, 0x1000, g_original_protection | PAGE_GUARD, &previous)) return false;
  g_armed.store(true, std::memory_order_release);
  return true;
}

bool TryCapture(std::uintptr_t candidate) {
  auto* response = reinterpret_cast<std::uint8_t*>(candidate);
  if (!IsAccessible(response, kResponseSize)) return false;
  if (*reinterpret_cast<std::uintptr_t*>(response) != g_game_base + kEnterEditResponseVtableRva) return false;
  auto* payload = response + kResponsePayloadOffset;
  if (*reinterpret_cast<std::uintptr_t*>(payload) != g_game_base + kPlayerPayloadVtableRva) return false;
  const auto player_id = g_player_id.load(std::memory_order_relaxed);
  if (*reinterpret_cast<std::uint32_t*>(payload + kPrimaryPlayerIdOffset) != player_id ||
      *reinterpret_cast<std::uint32_t*>(payload + kSecondaryPlayerIdOffset) != player_id) return false;
  const auto offset = g_rating_offset.load(std::memory_order_relaxed);
  const int observed = payload[offset];
  g_last_response.store(candidate, std::memory_order_relaxed);
  g_last_observed.store(observed, std::memory_order_relaxed);
  ++g_captures;
  if (observed == g_expected.load(std::memory_order_relaxed) && IsAccessible(payload + offset, 1, true)) {
    payload[offset] = static_cast<std::uint8_t>(g_value.load(std::memory_order_relaxed));
    if (payload[offset] == static_cast<std::uint8_t>(g_value.load(std::memory_order_relaxed))) ++g_applies;
  }
  g_armed.store(false, std::memory_order_release);
  return true;
}

LONG CALLBACK GuardHandler(EXCEPTION_POINTERS* pointers) {
  const auto code = pointers->ExceptionRecord->ExceptionCode;
  if (code == STATUS_GUARD_PAGE_VIOLATION && g_armed.load(std::memory_order_acquire)) {
    ++g_guard_events;
    const auto* context = pointers->ContextRecord;
    const std::array<std::uintptr_t, 8> candidates{
        context->Rcx, context->Rdx, context->R8, context->R9,
        context->Rax, context->Rbx, context->Rsi, context->Rdi,
    };
    for (const auto candidate : candidates) {
      if (candidate && TryCapture(candidate)) break;
    }
    if (g_armed.load(std::memory_order_acquire)) {
      pointers->ContextRecord->EFlags |= 0x100;
      g_rearm_after_step = true;
    }
    return EXCEPTION_CONTINUE_EXECUTION;
  }
  if (code == STATUS_SINGLE_STEP && g_rearm_after_step) {
    g_rearm_after_step = false;
    if (g_armed.load(std::memory_order_acquire)) {
      DWORD ignored = 0;
      VirtualProtect(g_guard_page, 0x1000, g_original_protection | PAGE_GUARD, &ignored);
    }
    return EXCEPTION_CONTINUE_EXECUTION;
  }
  return EXCEPTION_CONTINUE_SEARCH;
}

bool Queue(std::uint32_t player_id, const std::string& field, int expected, int value, std::string& error) {
  const auto* rating = FindRating(field);
  if (!rating) { error = "unsupported rating"; return false; }
  const int maximum = field == "overall" ? 100 : 99;
  if (!player_id || expected < 0 || expected > maximum || value < 0 || value > maximum) {
    error = "invalid player id or rating value"; return false;
  }
  g_player_id.store(player_id);
  g_rating_offset.store(rating->offset);
  g_expected.store(expected);
  g_value.store(value);
  if (!ArmGuard()) { error = "could not arm response vtable guard"; return false; }
  return true;
}

int LuaQueueRating(lua_State* state) {
  const auto player_id = static_cast<std::uint32_t>(luaL_checkinteger(state, 1));
  const std::string field = luaL_checkstring(state, 2);
  const int expected = static_cast<int>(luaL_checkinteger(state, 3));
  const int value = static_cast<int>(luaL_checkinteger(state, 4));
  std::string error;
  if (!Queue(player_id, field, expected, value, error)) return luaL_error(state, "%s", error.c_str());
  lua_pushboolean(state, 1);
  return 1;
}

bool RunLua(const std::filesystem::path& path, std::string& result) {
  lua_State* state = luaL_newstate();
  if (!state) { result = "could not create Lua state"; return false; }
  luaL_openlibs(state);
  lua_newtable(state);
  lua_pushcfunction(state, LuaQueueRating);
  lua_setfield(state, -2, "queue_rating");
  lua_setglobal(state, "cfb");
  const int code = luaL_dofile(state, path.string().c_str());
  if (code != LUA_OK) result = lua_tostring(state, -1) ? lua_tostring(state, -1) : "Lua error";
  else result = "ok";
  lua_close(state);
  return code == LUA_OK;
}

std::string StatusJson() {
  std::ostringstream out;
  out << "{\"ok\":true,\"armed\":" << (g_armed.load() ? "true" : "false")
      << ",\"guardEvents\":" << g_guard_events.load()
      << ",\"captures\":" << g_captures.load()
      << ",\"applies\":" << g_applies.load()
      << ",\"lastResponse\":" << g_last_response.load()
      << ",\"lastObserved\":" << g_last_observed.load()
      << ",\"playerId\":" << g_player_id.load() << '}';
  return out.str();
}

std::string HandleCommand(const std::string& command) {
  std::istringstream input(command);
  std::string verb;
  input >> verb;
  if (verb == "PING" || verb == "STATUS") return StatusJson();
  if (verb == "CLEAR") { g_armed.store(false); return StatusJson(); }
  if (verb == "QUEUE") {
    std::uint32_t player_id = 0;
    std::string field;
    int expected = -1, value = -1;
    input >> player_id >> field >> expected >> value;
    std::string error;
    if (!input || !Queue(player_id, field, expected, value, error))
      return "{\"ok\":false,\"error\":\"" + error + "\"}";
    return StatusJson();
  }
  if (verb == "RUN") {
    std::string path;
    std::getline(input >> std::ws, path);
    std::string result;
    const bool ok = RunLua(std::filesystem::u8path(path), result);
    return std::string("{\"ok\":") + (ok ? "true" : "false") + ",\"result\":\"" + result + "\"}";
  }
  return "{\"ok\":false,\"error\":\"unknown command\"}";
}

void PipeServer() {
  const std::wstring name = std::wstring(kPipePrefix) + std::to_wstring(GetCurrentProcessId());
  while (g_running.load()) {
    HANDLE pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 64 * 1024, 64 * 1024, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return;
    if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
      char buffer[64 * 1024]{};
      DWORD read = 0;
      if (ReadFile(pipe, buffer, sizeof(buffer) - 1, &read, nullptr)) {
        const auto response = HandleCommand(std::string(buffer, read));
        DWORD written = 0;
        WriteFile(pipe, response.data(), static_cast<DWORD>(response.size()), &written, nullptr);
      }
      FlushFileBuffers(pipe);
      DisconnectNamedPipe(pipe);
    }
    CloseHandle(pipe);
  }
}

DWORD WINAPI Start(void*) {
  g_game_base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
  const auto vtable = g_game_base + kEnterEditResponseVtableRva;
  g_guard_page = reinterpret_cast<std::uint8_t*>(vtable & ~std::uintptr_t{0xFFF});
  MEMORY_BASIC_INFORMATION info{};
  if (!VirtualQuery(g_guard_page, &info, sizeof(info))) return 1;
  g_original_protection = info.Protect & ~PAGE_GUARD;
  g_handler = AddVectoredExceptionHandler(1, GuardHandler);
  std::thread(PipeServer).detach();
  return g_handler ? 0 : 1;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    if (HANDLE thread = CreateThread(nullptr, 0, Start, nullptr, 0, nullptr)) CloseHandle(thread);
  }
  return TRUE;
}
