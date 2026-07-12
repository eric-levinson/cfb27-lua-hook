#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>

#include "memory_reader.h"
#include "memory_transaction.h"
#include "protocol.h"
#include "telemetry.h"

#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <initializer_list>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <vector>

extern "C" {
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>
}

namespace {

constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27LuaHost.";
constexpr wchar_t kV1PipePrefix[] = L"\\\\.\\pipe\\CFB27LuaHost.v1.";
constexpr char kHostVersion[] = "0.2.0-dev.2";
constexpr std::uintmax_t kSupportedExecutableSize = 247845776;
constexpr char kSupportedExecutableSha256[] = "9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8";
constexpr DWORD kTickMilliseconds = 100;

struct Callback {
  std::string event;
  int reference{};
};

struct HostEvent {
  std::uint64_t cursor{};
  std::int64_t timestamp_ms{};
  std::string type;
  cfb27::protocol::Json payload;
};

struct LogEntry {
  std::int64_t timestamp_ms{};
  std::string message;
};

std::atomic<bool> g_running{true};
std::atomic<bool> g_ready{false};
std::atomic<bool> g_supported_build{false};
std::atomic<bool> g_session_writes_disabled{false};
std::atomic<std::uint64_t> g_scripts_run{0};
std::atomic<std::uint64_t> g_ticks{0};
std::mutex g_lua_mutex;
std::mutex g_host_write_mutex;
std::mutex g_event_mutex;
std::mutex g_file_log_mutex;
lua_State* g_lua{};
std::vector<Callback> g_callbacks;
std::filesystem::path g_host_directory;
std::filesystem::path g_log_path;
std::string g_last_error;
std::deque<HostEvent> g_events;
std::deque<LogEntry> g_logs;
std::uint64_t g_next_event_cursor{1};
std::atomic<std::int64_t> g_last_tick_event_ms{0};

std::int64_t NowMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

void AppendEvent(std::string type, cfb27::protocol::Json payload,
                 std::int64_t timestamp_ms = NowMilliseconds()) {
  std::lock_guard lock(g_event_mutex);
  g_events.push_back({g_next_event_cursor++, timestamp_ms, std::move(type), std::move(payload)});
  while (g_events.size() > 1024) g_events.pop_front();
}

std::string JsonEscape(std::string_view value) {
  std::ostringstream out;
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (character < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(character) << std::dec;
        } else {
          out << character;
        }
    }
  }
  return out.str();
}

void Log(std::string_view message) {
  const auto timestamp_ms = NowMilliseconds();
  {
    std::lock_guard lock(g_file_log_mutex);
    std::ofstream stream(g_log_path, std::ios::app);
    if (stream) stream << message << '\n';
  }
  {
    std::lock_guard lock(g_event_mutex);
    g_logs.push_back({timestamp_ms, std::string(message)});
    while (g_logs.size() > 512) g_logs.pop_front();
    g_events.push_back({g_next_event_cursor++, timestamp_ms, "log", {{"message", message}}});
    while (g_events.size() > 1024) g_events.pop_front();
  }
}

bool EndsWithInsensitive(std::wstring value, const wchar_t* suffix) {
  const std::wstring expected(suffix);
  if (value.size() < expected.size()) return false;
  return _wcsicmp(value.c_str() + value.size() - expected.size(), expected.c_str()) == 0;
}

std::string Sha256File(const std::filesystem::path& path) {
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_HASH_HANDLE hash{};
  DWORD object_size = 0, hash_size = 0, copied = 0;
  std::vector<std::uint8_t> object;
  std::vector<std::uint8_t> digest;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return {};
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
        reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &copied, 0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
        reinterpret_cast<PUCHAR>(&hash_size), sizeof(hash_size), &copied, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0); return {};
  }
  object.resize(object_size);
  digest.resize(hash_size);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0); return {};
  }
  std::ifstream stream(path, std::ios::binary);
  std::vector<char> buffer(1024 * 1024);
  while (stream) {
    stream.read(buffer.data(), buffer.size());
    const auto count = stream.gcount();
    if (count > 0 && BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()),
                                   static_cast<ULONG>(count), 0) != 0) {
      BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); return {};
    }
  }
  if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) != 0) digest.clear();
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  std::ostringstream encoded;
  encoded << std::uppercase << std::hex << std::setfill('0');
  for (const auto byte : digest) encoded << std::setw(2) << static_cast<int>(byte);
  return encoded.str();
}

bool VerifySupportedBuild() {
  wchar_t executable[MAX_PATH]{};
  if (!GetModuleFileNameW(nullptr, executable, MAX_PATH) ||
      !EndsWithInsensitive(executable, L"CollegeFB27.exe")) return false;
  WIN32_FILE_ATTRIBUTE_DATA data{};
  if (!GetFileAttributesExW(executable, GetFileExInfoStandard, &data)) return false;
  const auto size = (static_cast<std::uintmax_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
  return size == kSupportedExecutableSize && Sha256File(executable) == kSupportedExecutableSha256;
}

bool SupportedBuild() {
  return g_supported_build.load(std::memory_order_acquire);
}

bool EnvironmentIsOne(const wchar_t* name) {
  wchar_t value[2]{};
  return GetEnvironmentVariableW(name, value, static_cast<DWORD>(std::size(value))) == 1 &&
         value[0] == L'1';
}

bool SmokeWritesAllowed() {
  wchar_t executable[MAX_PATH]{};
  if (!GetModuleFileNameW(nullptr, executable, MAX_PATH)) return false;
  const auto name = std::filesystem::path(executable).filename().wstring();
  if (_wcsicmp(name.c_str(), L"cfb27_protocol_smoke.exe") != 0) return false;
  return EnvironmentIsOne(L"CFB27_SMOKE_ALLOW_WRITES");
}

bool SmokeRollbackUnverifiedRequested() {
  return SmokeWritesAllowed() &&
         EnvironmentIsOne(L"CFB27_SMOKE_FORCE_ROLLBACK_UNVERIFIED");
}

bool SmokeHoldRollbackRequested() {
  return SmokeRollbackUnverifiedRequested() &&
         EnvironmentIsOne(L"CFB27_SMOKE_HOLD_ROLLBACK");
}

bool SmokeApplyFailureRequested() {
  return SmokeWritesAllowed() &&
         EnvironmentIsOne(L"CFB27_SMOKE_FORCE_APPLY_FAILURE");
}

bool RealAnticheatIsRunning() {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return true;
  PROCESSENTRY32W entry{sizeof(entry)};
  bool found = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      const std::wstring name(entry.szExeFile);
      if ((name.find(L"Javelin") != std::wstring::npos ||
           name.find(L"EAAntiCheat") != std::wstring::npos ||
           name.find(L"EAAnticheat") != std::wstring::npos) &&
          entry.th32ProcessID != GetCurrentProcessId()) {
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
        if (!process) { found = true; break; }
        wchar_t path[MAX_PATH]{};
        DWORD path_size = MAX_PATH;
        if (QueryFullProcessImageNameW(process, 0, path, &path_size)) {
          WIN32_FILE_ATTRIBUTE_DATA data{};
          if (!GetFileAttributesExW(path, GetFileExInfoStandard, &data)) found = true;
          else {
            const auto bytes = (static_cast<ULONGLONG>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
            found = bytes >= 1024 * 1024;
          }
        } else found = true;
        CloseHandle(process);
        if (found) break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}

bool WriteEnvironmentAllowed() {
  return (SupportedBuild() || SmokeWritesAllowed()) && !RealAnticheatIsRunning();
}

class SmokeRollbackUnverifiedBackend final : public cfb27::memory::MemoryBackend {
 public:
  explicit SmokeRollbackUnverifiedBackend(cfb27::memory::MemoryBackend& backend)
      : backend_(backend) {}

  bool Validate(std::uintptr_t address, std::size_t size, bool writable) override {
    return backend_.Validate(address, size, writable);
  }

  bool Read(std::uintptr_t address, std::span<std::uint8_t> output) override {
    ++reads_;
    if (reads_ >= 2) {
      if (reads_ == 2 && SmokeHoldRollbackRequested()) Sleep(500);
      return false;
    }
    return backend_.Read(address, output);
  }

  bool Write(std::uintptr_t address,
             std::span<const std::uint8_t> input) override {
    return backend_.Write(address, input);
  }

 private:
  cfb27::memory::MemoryBackend& backend_;
  std::size_t reads_{};
};

class SmokeApplyFailureBackend final : public cfb27::memory::MemoryBackend {
 public:
  explicit SmokeApplyFailureBackend(cfb27::memory::MemoryBackend& backend)
      : backend_(backend) {}

  bool Validate(std::uintptr_t address, std::size_t size, bool writable) override {
    return backend_.Validate(address, size, writable);
  }

  bool Read(std::uintptr_t address, std::span<std::uint8_t> output) override {
    return backend_.Read(address, output);
  }

  bool Write(std::uintptr_t address,
             std::span<const std::uint8_t> input) override {
    if (++writes_ == 1) return false;
    return backend_.Write(address, input);
  }

 private:
  cfb27::memory::MemoryBackend& backend_;
  std::size_t writes_{};
};

bool IsAccessible(std::uintptr_t address, std::size_t size, bool writable) {
  if (!address || !size || address + size < address) return false;
  MEMORY_BASIC_INFORMATION info{};
  if (!VirtualQuery(reinterpret_cast<void*>(address), &info, sizeof(info))) return false;
  if (info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) return false;
  constexpr DWORD readable = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  constexpr DWORD writeable = PAGE_READWRITE | PAGE_WRITECOPY |
                              PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  const auto end = reinterpret_cast<std::uintptr_t>(info.BaseAddress) + info.RegionSize;
  return address + size <= end && (info.Protect & (writable ? writeable : readable));
}

int LuaModuleBase(lua_State* state) {
  lua_pushinteger(state, reinterpret_cast<lua_Integer>(GetModuleHandleW(nullptr)));
  return 1;
}

int LuaReadU8(lua_State* state) {
  const auto address = static_cast<std::uintptr_t>(luaL_checkinteger(state, 1));
  if (!IsAccessible(address, 1, false)) return luaL_error(state, "address is not readable");
  lua_pushinteger(state, *reinterpret_cast<const std::uint8_t*>(address));
  return 1;
}

int LuaWriteU8(lua_State* state) {
  const auto address = static_cast<std::uintptr_t>(luaL_checkinteger(state, 1));
  const int expected = static_cast<int>(luaL_checkinteger(state, 2));
  const int value = static_cast<int>(luaL_checkinteger(state, 3));
  const char* error = nullptr;
  bool verified = false;
  {
    std::lock_guard write_lock(g_host_write_mutex);
    if (g_session_writes_disabled.load(std::memory_order_acquire)) {
      error = "session writes are disabled";
    } else if (!SupportedBuild() && !SmokeWritesAllowed()) {
      error = "unsupported College Football 27 build";
    } else if (RealAnticheatIsRunning()) {
      error = "writes are disabled while EA anticheat is running";
    } else if (expected < 0 || expected > 255 || value < 0 || value > 255) {
      error = "byte values must be between 0 and 255";
    } else if (!IsAccessible(address, 1, true)) {
      error = "address is not writable";
    } else {
      auto* target = reinterpret_cast<std::uint8_t*>(address);
      if (*target != static_cast<std::uint8_t>(expected)) {
        error = "expected byte does not match live memory";
      } else {
        *target = static_cast<std::uint8_t>(value);
        verified = *target == static_cast<std::uint8_t>(value);
      }
    }
  }
  if (error) return luaL_error(state, "%s", error);
  lua_pushboolean(state, verified);
  return 1;
}

struct PatternByte { std::uint8_t value{}; bool wildcard{}; };

std::optional<std::vector<PatternByte>> ParsePattern(std::string_view text) {
  std::istringstream input{std::string(text)};
  std::vector<PatternByte> pattern;
  std::string token;
  while (input >> token) {
    if (token == "?" || token == "??") { pattern.push_back({0, true}); continue; }
    if (token.size() != 2) return std::nullopt;
    unsigned int value = 0;
    const auto parsed = std::from_chars(token.data(), token.data() + token.size(), value, 16);
    if (parsed.ec != std::errc{} || parsed.ptr != token.data() + token.size() || value > 255)
      return std::nullopt;
    pattern.push_back({static_cast<std::uint8_t>(value), false});
  }
  if (pattern.empty() || pattern.size() > 4096) return std::nullopt;
  return pattern;
}

int LuaAobScan(lua_State* state) {
  const std::string_view text = luaL_checkstring(state, 1);
  const int requested = static_cast<int>(luaL_optinteger(state, 2, 32));
  const auto pattern = ParsePattern(text);
  if (!pattern) return luaL_error(state, "invalid AOB pattern");
  const std::size_t maximum = static_cast<std::size_t>((requested < 1) ? 1 : (requested > 256 ? 256 : requested));
  const auto module = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
  const auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(module);
  const auto nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(module + dos->e_lfanew);
  const auto image_end = module + nt->OptionalHeader.SizeOfImage;
  std::vector<std::uintptr_t> matches;
  auto cursor = module;
  while (cursor < image_end && matches.size() < maximum) {
    MEMORY_BASIC_INFORMATION info{};
    if (!VirtualQuery(reinterpret_cast<void*>(cursor), &info, sizeof(info))) break;
    const auto region_start = (std::max)(cursor, reinterpret_cast<std::uintptr_t>(info.BaseAddress));
    const auto region_end = (std::min)(image_end,
        reinterpret_cast<std::uintptr_t>(info.BaseAddress) + info.RegionSize);
    if (IsAccessible(region_start, region_end - region_start, false) &&
        region_end - region_start >= pattern->size()) {
      const auto* bytes = reinterpret_cast<const std::uint8_t*>(region_start);
      const auto length = region_end - region_start;
      for (std::size_t offset = 0; offset + pattern->size() <= length && matches.size() < maximum; ++offset) {
        bool equal = true;
        for (std::size_t index = 0; index < pattern->size(); ++index) {
          if (!(*pattern)[index].wildcard && bytes[offset + index] != (*pattern)[index].value) {
            equal = false; break;
          }
        }
        if (equal) matches.push_back(region_start + offset);
      }
    }
    if (region_end <= cursor) break;
    cursor = region_end;
  }
  lua_newtable(state);
  for (std::size_t index = 0; index < matches.size(); ++index) {
    lua_pushinteger(state, static_cast<lua_Integer>(matches[index]));
    lua_rawseti(state, -2, static_cast<lua_Integer>(index + 1));
  }
  return 1;
}

int LuaLog(lua_State* state) {
  Log(luaL_checkstring(state, 1));
  return 0;
}

bool AddLuaTelemetryBytes(std::size_t bytes, std::size_t& total, std::string& error) {
  constexpr std::size_t kMaxSerializedBytes = 16 * 1024;
  if (bytes > kMaxSerializedBytes - total) {
    error = "serialized telemetry payload must not exceed 16 KiB";
    return false;
  }
  total += bytes;
  return true;
}

bool AddLuaTelemetryValueBytes(const cfb27::protocol::Json& value,
                               std::size_t& total, std::string& error) {
  try {
    return AddLuaTelemetryBytes(value.dump().size(), total, error);
  } catch (const std::exception&) {
    error = "telemetry strings must contain valid UTF-8";
    return false;
  }
}

bool IsForbiddenTelemetryKey(std::string_view key) {
  return key == "address" || key == "addressHex" || key == "regionBase" ||
         key == "bytesHex" || key == "contextAddress" || key == "contextHex";
}

bool LuaToTelemetryJson(lua_State* state, int index, std::size_t depth,
                        std::unordered_set<const void*>& visiting,
                        std::size_t& serialized_bytes,
                        cfb27::protocol::Json& output, std::string& error) {
  using Json = cfb27::protocol::Json;
  constexpr std::size_t kMaxDepth = 4;
  constexpr std::size_t kMaxObjectKeys = 64;
  constexpr std::size_t kMaxArrayEntries = 128;
  constexpr std::size_t kMaxStringBytes = 1024;

  index = lua_absindex(state, index);
  switch (lua_type(state, index)) {
    case LUA_TNIL:
      output = nullptr;
      return AddLuaTelemetryValueBytes(output, serialized_bytes, error);
    case LUA_TBOOLEAN:
      output = lua_toboolean(state, index) != 0;
      return AddLuaTelemetryValueBytes(output, serialized_bytes, error);
    case LUA_TNUMBER:
      if (lua_isinteger(state, index)) {
        output = lua_tointeger(state, index);
        return AddLuaTelemetryValueBytes(output, serialized_bytes, error);
      } else {
        const auto value = lua_tonumber(state, index);
        if (!std::isfinite(value)) {
          error = "telemetry numbers must be finite";
          return false;
        }
        output = value;
        return AddLuaTelemetryValueBytes(output, serialized_bytes, error);
      }
    case LUA_TSTRING: {
      std::size_t length = 0;
      const char* value = lua_tolstring(state, index, &length);
      if (length > kMaxStringBytes) {
        error = "telemetry strings must not exceed 1024 bytes";
        return false;
      }
      output = std::string(value, length);
      return AddLuaTelemetryValueBytes(output, serialized_bytes, error);
    }
    case LUA_TTABLE:
      break;
    default:
      error = "telemetry payload contains an unsupported Lua value";
      return false;
  }

  if (depth > kMaxDepth) {
    error = "telemetry payload depth must not exceed 4";
    return false;
  }
  const void* identity = lua_topointer(state, index);
  if (!visiting.insert(identity).second) {
    error = "telemetry payload contains a table cycle";
    return false;
  }
  if (!AddLuaTelemetryBytes(2, serialized_bytes, error)) {
    visiting.erase(identity);
    return false;
  }

  bool saw_array_key = false;
  bool saw_object_key = false;
  std::vector<std::pair<std::size_t, Json>> array_items;
  Json object = Json::object();
  bool valid = true;
  lua_pushnil(state);
  while (lua_next(state, index) != 0) {
    if (lua_type(state, -2) == LUA_TNUMBER && lua_isinteger(state, -2)) {
      if (saw_object_key) {
        error = "telemetry tables must not mix array and object keys";
        lua_pop(state, 1);
        valid = false;
        break;
      }
      saw_array_key = true;
      const auto key = lua_tointeger(state, -2);
      if (key < 1 || static_cast<std::uint64_t>(key) > kMaxArrayEntries) {
        error = "telemetry arrays must be dense and contain at most 128 entries";
        lua_pop(state, 1);
        valid = false;
        break;
      }
      if (!array_items.empty() && !AddLuaTelemetryBytes(1, serialized_bytes, error)) {
        lua_pop(state, 1);
        valid = false;
        break;
      }
    } else if (lua_type(state, -2) == LUA_TSTRING) {
      if (saw_array_key) {
        error = "telemetry tables must not mix array and object keys";
        lua_pop(state, 1);
        valid = false;
        break;
      }
      saw_object_key = true;
      std::size_t key_length = 0;
      const char* key = lua_tolstring(state, -2, &key_length);
      if (key_length > kMaxStringBytes || object.size() >= kMaxObjectKeys) {
        error = "telemetry objects must contain at most 64 bounded string keys";
        lua_pop(state, 1);
        valid = false;
        break;
      }
      const std::string key_text(key, key_length);
      if (IsForbiddenTelemetryKey(key_text)) {
        error = "telemetry payloads must not contain address or raw-byte keys";
        lua_pop(state, 1);
        valid = false;
        break;
      }
      Json encoded_key = key_text;
      const std::size_t punctuation = object.empty() ? 1 : 2;
      if (!AddLuaTelemetryValueBytes(encoded_key, serialized_bytes, error) ||
          !AddLuaTelemetryBytes(punctuation, serialized_bytes, error)) {
        lua_pop(state, 1);
        valid = false;
        break;
      }
    } else {
      error = "telemetry object keys must be strings";
      lua_pop(state, 1);
      valid = false;
      break;
    }
    Json item;
    if (!LuaToTelemetryJson(state, -1, depth + 1, visiting, serialized_bytes,
                            item, error)) {
      lua_pop(state, 1);
      valid = false;
      break;
    }
    if (saw_array_key) {
      array_items.emplace_back(
          static_cast<std::size_t>(lua_tointeger(state, -2)), std::move(item));
    } else {
      std::size_t key_length = 0;
      const char* key = lua_tolstring(state, -2, &key_length);
      object[std::string(key, key_length)] = std::move(item);
    }
    lua_pop(state, 1);
  }
  if (!valid) {
    lua_settop(state, lua_gettop(state) - 1);
    visiting.erase(identity);
    return false;
  }

  if (saw_array_key) {
    if (array_items.size() > kMaxArrayEntries) {
      error = "telemetry arrays must not exceed 128 entries";
      visiting.erase(identity);
      return false;
    }
    std::sort(array_items.begin(), array_items.end(),
              [](const auto& left, const auto& right) { return left.first < right.first; });
    output = Json::array();
    for (std::size_t item_index = 0; item_index < array_items.size(); ++item_index) {
      if (array_items[item_index].first != item_index + 1) {
        error = "telemetry arrays must not be sparse";
        visiting.erase(identity);
        return false;
      }
      output.push_back(std::move(array_items[item_index].second));
    }
  } else {
    output = std::move(object);
  }
  visiting.erase(identity);
  return true;
}

int LuaEmit(lua_State* state) {
  if (lua_gettop(state) != 2 || lua_type(state, 1) != LUA_TSTRING) {
    return luaL_error(state, "cfb.emit requires a telemetry type and payload");
  }
  std::size_t type_length = 0;
  const char* type_value = lua_tolstring(state, 1, &type_length);
  const std::string type(type_value, type_length);
  if (!cfb27::telemetry::IsTelemetryTypeRegistered(type)) {
    return luaL_error(state, "telemetry type is not registered");
  }

  cfb27::protocol::Json payload;
  std::string error;
  std::unordered_set<const void*> visiting;
  std::size_t serialized_bytes = 0;
  if (!LuaToTelemetryJson(state, 2, 1, visiting, serialized_bytes, payload, error) ||
      !cfb27::telemetry::ValidateTelemetryPayload(payload, error)) {
    return luaL_error(state, "%s", error.c_str());
  }
  AppendEvent(type, std::move(payload));
  lua_pushboolean(state, 1);
  return 1;
}

int LuaOn(lua_State* state) {
  const std::string event = luaL_checkstring(state, 1);
  luaL_checktype(state, 2, LUA_TFUNCTION);
  if (event != "game_ready" && event != "tick") return luaL_error(state, "unsupported event");
  lua_pushvalue(state, 2);
  g_callbacks.push_back({event, luaL_ref(state, LUA_REGISTRYINDEX)});
  lua_pushboolean(state, 1);
  return 1;
}

void FireEvent(const std::string& event) {
  std::lock_guard lock(g_lua_mutex);
  if (!g_lua) return;
  for (const auto& callback : g_callbacks) {
    if (callback.event != event) continue;
    lua_rawgeti(g_lua, LUA_REGISTRYINDEX, callback.reference);
    if (lua_pcall(g_lua, 0, 0, 0) != LUA_OK) {
      g_last_error = lua_tostring(g_lua, -1) ? lua_tostring(g_lua, -1) : "Lua callback error";
      Log(g_last_error);
      lua_pop(g_lua, 1);
    }
  }
}

void RegisterApi(lua_State* state) {
  lua_newtable(state);
  lua_pushcfunction(state, LuaModuleBase); lua_setfield(state, -2, "module_base");
  lua_pushcfunction(state, LuaReadU8); lua_setfield(state, -2, "read_u8");
  lua_pushcfunction(state, LuaWriteU8); lua_setfield(state, -2, "write_u8");
  lua_pushcfunction(state, LuaAobScan); lua_setfield(state, -2, "aob_scan");
  lua_pushcfunction(state, LuaLog); lua_setfield(state, -2, "log");
  lua_pushcfunction(state, LuaEmit); lua_setfield(state, -2, "emit");
  lua_pushcfunction(state, LuaOn); lua_setfield(state, -2, "on");
  lua_setglobal(state, "cfb");
}

bool RunLuaText(std::string_view text, const char* chunk_name, std::string& result) {
  std::lock_guard lock(g_lua_mutex);
  if (!g_lua) { result = "Lua host is not initialized"; return false; }
  int code = luaL_loadbuffer(g_lua, text.data(), text.size(), chunk_name);
  if (code == LUA_OK) code = lua_pcall(g_lua, 0, LUA_MULTRET, 0);
  if (code != LUA_OK) {
    result = lua_tostring(g_lua, -1) ? lua_tostring(g_lua, -1) : "Lua error";
    g_last_error = result;
    lua_pop(g_lua, 1);
    return false;
  }
  result = "ok";
  g_last_error.clear();
  lua_settop(g_lua, 0);
  ++g_scripts_run;
  return true;
}

bool RunLuaFile(const std::filesystem::path& path, std::string& result) {
  if (!std::filesystem::is_regular_file(path)) { result = "script file was not found"; return false; }
  std::ifstream stream(path, std::ios::binary);
  const std::string text((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
  return RunLuaText(text, path.string().c_str(), result);
}

void RunAutorun() {
  const auto script = g_host_directory / L"scripts" / L"autorun.lua";
  if (!std::filesystem::is_regular_file(script)) return;
  std::string result;
  if (!RunLuaFile(script, result)) Log("autorun failed: " + result);
}

std::string StatusJson() {
  std::ostringstream out;
  out << "{\"ok\":true,\"ready\":" << (g_ready.load() ? "true" : "false")
      << ",\"supportedBuild\":" << (SupportedBuild() ? "true" : "false")
      << ",\"writesAllowed\":" << ((SupportedBuild() && !RealAnticheatIsRunning()) ? "true" : "false")
      << ",\"scriptsRun\":" << g_scripts_run.load()
      << ",\"ticks\":" << g_ticks.load()
      << ",\"lastError\":\"" << JsonEscape(g_last_error) << "\"}";
  return out.str();
}

cfb27::protocol::Json SuccessResponse(
    const std::string& id, cfb27::protocol::Json result) {
  return {
      {"protocol", cfb27::protocol::kVersion},
      {"id", id},
      {"ok", true},
      {"result", std::move(result)},
  };
}

std::optional<std::size_t> ReadLimit(
    const cfb27::protocol::Json& params, std::size_t default_value) {
  if (!params.contains("limit")) return default_value;
  if (params["limit"].is_number_unsigned()) {
    const auto value = params["limit"].get<std::uint64_t>();
    if (value < 1 || value > 256) return std::nullopt;
    return static_cast<std::size_t>(value);
  }
  if (params["limit"].is_number_integer()) {
    const auto value = params["limit"].get<std::int64_t>();
    if (value < 1 || value > 256) return std::nullopt;
    return static_cast<std::size_t>(value);
  }
  return std::nullopt;
}

bool HasOnlyKeys(const cfb27::protocol::Json& value,
                 std::initializer_list<std::string_view> allowed) {
  for (const auto& [key, unused] : value.items()) {
    if (std::find(allowed.begin(), allowed.end(), key) == allowed.end()) return false;
  }
  return true;
}

std::optional<std::size_t> ReadUnsigned(
    const cfb27::protocol::Json& params, std::string_view key,
    std::size_t minimum, std::size_t maximum) {
  const auto found = params.find(std::string(key));
  if (found == params.end()) return std::nullopt;
  std::uint64_t value = 0;
  if (found->is_number_unsigned()) {
    value = found->get<std::uint64_t>();
  } else if (found->is_number_integer()) {
    const auto signed_value = found->get<std::int64_t>();
    if (signed_value < 0) return std::nullopt;
    value = static_cast<std::uint64_t>(signed_value);
  } else {
    return std::nullopt;
  }
  if (value < minimum || value > maximum ||
      value > std::numeric_limits<std::size_t>::max()) return std::nullopt;
  return static_cast<std::size_t>(value);
}

std::optional<std::vector<std::uint8_t>> HexToBytes(
    const cfb27::protocol::Json& value) {
  if (!value.is_string()) return std::nullopt;
  const auto& text = value.get_ref<const std::string&>();
  if (text.empty() || text.size() % 2 != 0) return std::nullopt;
  auto nibble = [](char character) -> std::optional<std::uint8_t> {
    if (character >= '0' && character <= '9') {
      return static_cast<std::uint8_t>(character - '0');
    }
    if (character >= 'A' && character <= 'F') {
      return static_cast<std::uint8_t>(character - 'A' + 10);
    }
    return std::nullopt;
  };
  std::vector<std::uint8_t> bytes;
  bytes.reserve(text.size() / 2);
  for (std::size_t index = 0; index < text.size(); index += 2) {
    const auto high = nibble(text[index]);
    const auto low = nibble(text[index + 1]);
    if (!high || !low) return std::nullopt;
    bytes.push_back(static_cast<std::uint8_t>((*high << 4) | *low));
  }
  return bytes;
}

std::string BytesToHex(std::span<const std::uint8_t> bytes) {
  constexpr char digits[] = "0123456789ABCDEF";
  std::string encoded(bytes.size() * 2, '0');
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    encoded[index * 2] = digits[bytes[index] >> 4];
    encoded[index * 2 + 1] = digits[bytes[index] & 0x0F];
  }
  return encoded;
}

std::string FormatCanonicalAddress(std::uintptr_t address) {
  char digits[sizeof(address) * 2]{};
  const auto [end, error] = std::to_chars(
      std::begin(digits), std::end(digits), address, 16);
  if (error != std::errc{}) return {};
  std::string result("0x");
  result.reserve(2 + static_cast<std::size_t>(end - digits));
  for (auto current = digits; current != end; ++current) {
    result.push_back(*current >= 'a' && *current <= 'f'
                         ? static_cast<char>(*current - 'a' + 'A')
                         : *current);
  }
  return result;
}

std::optional<std::string> CanonicalAddress(std::string_view text) {
  if (text.size() < 3 || text[0] != '0' || text[1] != 'x') return std::nullopt;
  const auto parsed = cfb27::memory::ParseAddress(text);
  if (!parsed) return std::nullopt;
  const auto formatted = FormatCanonicalAddress(*parsed);
  if (formatted != text) return std::nullopt;
  return formatted;
}

cfb27::protocol::Json MemoryError(
    const std::string& id, std::string_view code) {
  using cfb27::protocol::ErrorResponse;
  if (code == "MEMORY_ACCESS_DENIED") {
    return ErrorResponse(id, "MEMORY_ACCESS_DENIED", "Requested memory is not readable");
  }
  if (code == "SCAN_LIMIT_EXCEEDED") {
    return ErrorResponse(id, "SCAN_LIMIT_EXCEEDED", "Memory scan byte limit exceeded");
  }
  if (code == "TOO_MANY_MATCHES") {
    return ErrorResponse(id, "TOO_MANY_MATCHES", "Memory scan found too many matches");
  }
  return ErrorResponse(id, "INVALID_REQUEST", "Invalid memory request");
}

cfb27::protocol::Json TransactionResultJson(
    std::string_view transaction_id,
    const cfb27::memory::TransactionResult& transaction) {
  using Json = cfb27::protocol::Json;
  Json operations = Json::array();
  for (const auto& operation : transaction.operations) {
    operations.push_back({
        {"index", operation.index},
        {"applied", operation.applied},
        {"verified", operation.verified},
    });
  }
  return {
      {"transactionId", transaction_id},
      {"status", transaction.code},
      {"operations", std::move(operations)},
  };
}

cfb27::protocol::Json TransactionRejected(
    const std::string& id, std::string_view engine_code) {
  using cfb27::protocol::ErrorResponse;
  if (engine_code == "expected_mismatch") {
    return ErrorResponse(id, "MEMORY_MISMATCH",
                         "Live memory does not match the transaction preflight");
  }
  if (engine_code == "invalid_memory_range" ||
      engine_code == "preflight_read_failed") {
    return ErrorResponse(id, "MEMORY_ACCESS_DENIED",
                         "Transaction memory is not accessible for writing");
  }
  if (engine_code == "invalid_operation_count" ||
      engine_code == "invalid_operation_size" ||
      engine_code == "transaction_too_large") {
    return ErrorResponse(id, "TRANSACTION_LIMIT_EXCEEDED",
                         "Transaction exceeds an operation or byte limit");
  }
  return ErrorResponse(id, "INVALID_REQUEST", "Invalid writeTransaction request");
}

cfb27::protocol::Json LogsResult(std::size_t limit) {
  cfb27::protocol::Json logs = cfb27::protocol::Json::array();
  std::lock_guard lock(g_event_mutex);
  const std::size_t begin = g_logs.size() > limit ? g_logs.size() - limit : 0;
  for (std::size_t index = begin; index < g_logs.size(); ++index) {
    logs.push_back({
        {"timestampMs", g_logs[index].timestamp_ms},
        {"message", g_logs[index].message},
    });
  }
  return {{"logs", std::move(logs)}};
}

cfb27::protocol::Json EventsResult(std::uint64_t after, std::size_t limit) {
  cfb27::protocol::Json events = cfb27::protocol::Json::array();
  std::uint64_t next_cursor = after;
  std::lock_guard lock(g_event_mutex);
  for (const auto& event : g_events) {
    if (event.cursor <= after) continue;
    events.push_back({
        {"cursor", event.cursor},
        {"type", event.type},
        {"timestampMs", event.timestamp_ms},
        {"payload", event.payload},
    });
    next_cursor = event.cursor;
    if (events.size() >= limit) break;
  }
  return {{"events", std::move(events)}, {"nextCursor", next_cursor}};
}

cfb27::protocol::Json HandleV1Request(const cfb27::protocol::Json& request) {
  using cfb27::protocol::ErrorResponse;
  using Json = cfb27::protocol::Json;

  const std::string id = request.is_object() && request.contains("id") &&
      request["id"].is_string() ? request["id"].get<std::string>() : "";
  if (!request.is_object() ||
      !HasOnlyKeys(request, {"protocol", "id", "command", "params"}) ||
      !request.contains("protocol") ||
      !request["protocol"].is_number_integer() ||
      request["protocol"].get<int>() != static_cast<int>(cfb27::protocol::kVersion) ||
      !request.contains("id") || !request["id"].is_string() ||
      !request.contains("command") || !request["command"].is_string()) {
    return ErrorResponse(id, "INVALID_REQUEST",
                         "Request is missing protocol, id, or command");
  }

  const std::string command = request["command"].get<std::string>();
  const Json params = request.contains("params") ? request["params"] : Json::object();
  if (!params.is_object()) {
    return ErrorResponse(id, "INVALID_REQUEST", "Request params must be an object");
  }

  const bool supported = SupportedBuild();
  const bool session_writes_disabled =
      g_session_writes_disabled.load(std::memory_order_acquire);
  const bool writes_allowed = !session_writes_disabled && WriteEnvironmentAllowed();
  if (command == "hello") {
    return SuccessResponse(id, {
        {"protocolVersion", cfb27::protocol::kVersion},
        {"hostVersion", kHostVersion},
        {"supportedBuild", supported},
        {"writesAllowed", writes_allowed},
        {"capabilities", {"status", "runScript", "evaluate", "logs", "events",
                          "memoryScan", "memoryScanAllocationMetadata", "memoryRead",
                          "memoryWriteTransaction",
                          "telemetry"}},
    });
  }

  if (command == "status") {
    std::string last_error;
    {
      std::lock_guard lock(g_lua_mutex);
      last_error = g_last_error;
    }
    return SuccessResponse(id, {
        {"ready", g_ready.load(std::memory_order_acquire)},
        {"supportedBuild", supported},
        {"writesAllowed", writes_allowed},
        {"sessionWritesDisabled", session_writes_disabled},
        {"scriptsRun", g_scripts_run.load(std::memory_order_acquire)},
        {"ticks", g_ticks.load(std::memory_order_acquire)},
        {"lastError", std::move(last_error)},
    });
  }

  if (command == "writeTransaction") {
    std::lock_guard write_lock(g_host_write_mutex);
    if (g_session_writes_disabled.load(std::memory_order_acquire)) {
      return ErrorResponse(id, "SESSION_WRITES_DISABLED",
                           "Writes are disabled for the remainder of this host session");
    }
    if (!SupportedBuild() && !SmokeWritesAllowed()) {
      return ErrorResponse(id, "UNSUPPORTED_BUILD",
                           "Memory writes require the exact supported build");
    }
    if (RealAnticheatIsRunning()) {
      return ErrorResponse(id, "MEMORY_ACCESS_DENIED",
                           "Writes are disabled while EA anticheat is running");
    }
    if (!HasOnlyKeys(params, {"transactionId", "operations"}) ||
        !params.contains("transactionId") || !params["transactionId"].is_string() ||
        !params.contains("operations") || !params["operations"].is_array()) {
      return ErrorResponse(id, "INVALID_REQUEST", "Invalid writeTransaction params");
    }
    cfb27::memory::TransactionRequest transaction_request{
        .transaction_id = params["transactionId"].get<std::string>(),
    };
    transaction_request.operations.reserve(params["operations"].size());
    std::size_t aggregate_bytes = 0;
    for (const auto& operation : params["operations"]) {
      if (!operation.is_object() ||
          !HasOnlyKeys(operation, {"address", "expectedHex", "replacementHex"}) ||
          !operation.contains("address") || !operation["address"].is_string() ||
          !operation.contains("expectedHex") ||
          !operation.contains("replacementHex")) {
        return ErrorResponse(id, "INVALID_REQUEST", "Invalid transaction operation");
      }
      const auto address =
          CanonicalAddress(operation["address"].get_ref<const std::string&>());
      auto expected = HexToBytes(operation["expectedHex"]);
      auto replacement = HexToBytes(operation["replacementHex"]);
      if (!address || !expected || !replacement ||
          expected->size() != replacement->size()) {
        return ErrorResponse(id, "INVALID_REQUEST", "Invalid transaction operation");
      }
      if (replacement->size() > cfb27::memory::kMaxOperationBytes ||
          aggregate_bytes >
              cfb27::memory::kMaxTransactionBytes - replacement->size()) {
        return ErrorResponse(id, "TRANSACTION_LIMIT_EXCEEDED",
                             "Transaction exceeds the byte limit");
      }
      aggregate_bytes += replacement->size();
      transaction_request.operations.push_back({
          .address = std::move(*address),
          .expected = std::move(*expected),
          .replacement = std::move(*replacement),
      });
    }

    cfb27::memory::ProcessMemoryBackend process_backend;
    cfb27::memory::TransactionResult transaction;
    if (SmokeRollbackUnverifiedRequested()) {
      SmokeRollbackUnverifiedBackend smoke_backend(process_backend);
      transaction = cfb27::memory::RunTransaction(transaction_request, smoke_backend);
    } else if (SmokeApplyFailureRequested()) {
      SmokeApplyFailureBackend smoke_backend(process_backend);
      transaction = cfb27::memory::RunTransaction(transaction_request, smoke_backend);
    } else {
      transaction = cfb27::memory::RunTransaction(transaction_request, process_backend);
    }
    if (transaction.status == cfb27::memory::TransactionStatus::kRejected) {
      return TransactionRejected(id, transaction.code);
    }
    const auto result = TransactionResultJson(
        transaction_request.transaction_id, transaction);
    if (transaction.status ==
        cfb27::memory::TransactionStatus::kRollbackUnverified) {
      g_session_writes_disabled.store(true, std::memory_order_release);
      return ErrorResponse(id, "ROLLBACK_VERIFICATION_FAILED",
                           "Transaction rollback could not be verified", result);
    }
    if (transaction.status ==
        cfb27::memory::TransactionStatus::kRolledBackVerified) {
      return ErrorResponse(id, "TRANSACTION_APPLY_FAILED",
                           "Transaction failed and was rolled back", result);
    }
    return SuccessResponse(id, result);
  }

  if (command == "registerTelemetry") {
    if (!HasOnlyKeys(params, {"types"}) || !params.contains("types") ||
        !params["types"].is_array() || params["types"].empty() ||
        params["types"].size() > 16) {
      return ErrorResponse(id, "INVALID_REQUEST", "Invalid registerTelemetry params");
    }
    std::vector<std::string> types;
    types.reserve(params["types"].size());
    for (const auto& type : params["types"]) {
      if (!type.is_string()) {
        return ErrorResponse(id, "INVALID_REQUEST", "Telemetry types must be strings");
      }
      types.push_back(type.get<std::string>());
    }
    std::string error;
    if (!cfb27::telemetry::RegisterTelemetryTypes(types, error)) {
      return ErrorResponse(id, "INVALID_REQUEST", std::move(error));
    }
    return SuccessResponse(id, {{"types", std::move(types)}});
  }

  if (command == "scanMemory") {
    if (params.contains("allowUnsupportedBuild") &&
        !params["allowUnsupportedBuild"].is_boolean()) {
      return ErrorResponse(id, "INVALID_REQUEST",
                           "allowUnsupportedBuild must be a boolean");
    }
    if (params.contains("includeAllocationMetadata") &&
        !params["includeAllocationMetadata"].is_boolean()) {
      return ErrorResponse(id, "INVALID_REQUEST",
                           "includeAllocationMetadata must be a boolean");
    }
    const bool allow_unsupported = params.contains("allowUnsupportedBuild") &&
        params["allowUnsupportedBuild"].get<bool>();
    if (!supported && !allow_unsupported) {
      return ErrorResponse(id, "UNSUPPORTED_BUILD",
                           "Memory scanning requires a supported build or explicit override");
    }
    if (!HasOnlyKeys(params, {"patternHex", "maskHex", "maxMatches", "contextBefore",
                              "contextAfter", "allowUnsupportedBuild", "cursor",
                              "includeAllocationMetadata"}) ||
        !params.contains("patternHex") || !params.contains("maskHex")) {
      return ErrorResponse(id, "INVALID_REQUEST", "Invalid scanMemory params");
    }
    auto pattern = params["patternHex"].is_string()
        ? cfb27::memory::DecodeScanHex(
              params["patternHex"].get_ref<const std::string&>())
        : std::nullopt;
    auto mask = params["maskHex"].is_string()
        ? cfb27::memory::DecodeScanHex(
              params["maskHex"].get_ref<const std::string&>())
        : std::nullopt;
    const auto max_matches = ReadUnsigned(
        params, "maxMatches", 1, cfb27::memory::kMaxMatches);
    const auto context_before = ReadUnsigned(
        params, "contextBefore", 0, cfb27::memory::kMaxContextBytes);
    const auto context_after = ReadUnsigned(
        params, "contextAfter", 0, cfb27::memory::kMaxContextBytes);
    if (!pattern || pattern->size() < cfb27::memory::kMinPatternBytes ||
        pattern->size() > cfb27::memory::kMaxPatternBytes || !mask ||
        mask->size() != pattern->size() || !max_matches || !context_before ||
        !context_after || *context_before > cfb27::memory::kMaxContextBytes - *context_after) {
      return ErrorResponse(id, "INVALID_REQUEST", "Invalid scanMemory params");
    }

    std::optional<std::string> cursor;
    if (params.contains("cursor")) {
      if (!params["cursor"].is_string()) {
        return ErrorResponse(id, "INVALID_REQUEST", "Invalid scanMemory params");
      }
      cursor = CanonicalAddress(params["cursor"].get_ref<const std::string&>());
      if (!cursor) {
        return ErrorResponse(id, "INVALID_REQUEST", "Invalid scanMemory params");
      }
    }

    const auto scan = cfb27::memory::ScanPrivateMemory({
        .pattern = std::move(*pattern),
        .mask = std::move(*mask),
        .max_matches = *max_matches,
        .context_before = *context_before,
        .context_after = *context_after,
        .cursor = std::move(cursor),
        .include_allocation_metadata =
            params.value("includeAllocationMetadata", false),
    });
    if (!scan.code.empty()) return MemoryError(id, scan.code);

    Json matches = Json::array();
    for (const auto& match : scan.matches) {
      const auto address = cfb27::memory::ParseAddress(match.address);
      const auto region_base = cfb27::memory::ParseAddress(match.region_base);
      const auto context_address = cfb27::memory::ParseAddress(match.context_address);
      if (!address || !region_base || !context_address) {
        return ErrorResponse(id, "MEMORY_ACCESS_DENIED", "Memory scan returned an invalid address");
      }
      Json response_match{
          {"address", FormatCanonicalAddress(*address)},
          {"regionBase", FormatCanonicalAddress(*region_base)},
          {"regionSize", match.region_size},
          {"protection", match.protection},
          {"contextAddress", FormatCanonicalAddress(*context_address)},
          {"contextHex", BytesToHex(match.context.bytes())},
      };
      if (match.allocation) {
        const auto allocation_base =
            cfb27::memory::ParseAddress(match.allocation->base);
        if (!allocation_base) {
          return ErrorResponse(id, "MEMORY_ACCESS_DENIED",
                               "Memory scan returned an invalid allocation address");
        }
        response_match["allocationBase"] =
            FormatCanonicalAddress(*allocation_base);
        response_match["allocationSize"] = match.allocation->size;
        response_match["allocationProtect"] = match.allocation->protection;
        response_match["offsetInAllocation"] = match.allocation->offset;
      }
      matches.push_back(std::move(response_match));
    }
    return SuccessResponse(id, {
        {"supportedBuild", supported},
        {"complete", scan.complete},
        {"nextCursor", scan.next_cursor ? Json(*scan.next_cursor) : Json(nullptr)},
        {"scannedBytes", scan.scanned_bytes},
        {"matches", std::move(matches)},
    });
  }

  if (command == "readMemory") {
    if (params.contains("allowUnsupportedBuild") &&
        !params["allowUnsupportedBuild"].is_boolean()) {
      return ErrorResponse(id, "INVALID_REQUEST",
                           "allowUnsupportedBuild must be a boolean");
    }
    const bool allow_unsupported = params.contains("allowUnsupportedBuild") &&
        params["allowUnsupportedBuild"].get<bool>();
    if (!supported && !allow_unsupported) {
      return ErrorResponse(id, "UNSUPPORTED_BUILD",
                           "Memory reads require a supported build or explicit override");
    }
    if (!HasOnlyKeys(params, {"ranges", "allowUnsupportedBuild"}) ||
        !params.contains("ranges") || !params["ranges"].is_array() ||
        params["ranges"].empty() ||
        params["ranges"].size() > cfb27::memory::kMaxReadRanges) {
      return ErrorResponse(id, "INVALID_REQUEST", "Invalid readMemory params");
    }

    std::vector<cfb27::memory::ReadRange> ranges;
    ranges.reserve(params["ranges"].size());
    std::size_t total_bytes = 0;
    for (const auto& range : params["ranges"]) {
      if (!range.is_object() || !HasOnlyKeys(range, {"address", "length"}) ||
          !range.contains("address") || !range["address"].is_string()) {
        return ErrorResponse(id, "INVALID_REQUEST", "Invalid readMemory range");
      }
      const auto address = CanonicalAddress(range["address"].get_ref<const std::string&>());
      const auto length = ReadUnsigned(
          range, "length", 1, cfb27::memory::kMaxReadRangeBytes);
      if (!address || !length || total_bytes > cfb27::memory::kMaxReadBytes - *length) {
        return ErrorResponse(id, "INVALID_REQUEST", "Invalid readMemory range");
      }
      total_bytes += *length;
      ranges.push_back({*address, *length});
    }

    const auto read = cfb27::memory::ReadMemoryBatch(ranges);
    if (!read.ok) return MemoryError(id, read.code);
    Json results = Json::array();
    for (const auto& range : read.ranges) {
      const auto address = cfb27::memory::ParseAddress(range.address);
      if (!address) {
        return ErrorResponse(id, "MEMORY_ACCESS_DENIED", "Memory read returned an invalid address");
      }
      results.push_back({
          {"address", FormatCanonicalAddress(*address)},
          {"length", range.bytes.size()},
          {"bytesHex", BytesToHex(range.bytes)},
      });
    }
    return SuccessResponse(id, {
        {"supportedBuild", supported},
        {"ranges", std::move(results)},
    });
  }

  if (command == "logs") {
    const auto limit = ReadLimit(params, 100);
    if (!limit) return ErrorResponse(id, "INVALID_REQUEST", "limit must be an integer from 1 to 256");
    return SuccessResponse(id, LogsResult(*limit));
  }

  if (command == "events") {
    const auto limit = ReadLimit(params, 100);
    if (!limit) return ErrorResponse(id, "INVALID_REQUEST", "limit must be an integer from 1 to 256");
    std::uint64_t after = 0;
    if (params.contains("after")) {
      if (!params["after"].is_number_unsigned() &&
          !(params["after"].is_number_integer() && params["after"].get<std::int64_t>() >= 0)) {
        return ErrorResponse(id, "INVALID_REQUEST", "after must be a nonnegative integer");
      }
      after = params["after"].get<std::uint64_t>();
    }
    return SuccessResponse(id, EventsResult(after, *limit));
  }

  std::string source;
  std::string chunk_name;
  if (command == "runScript") {
    if (!params.contains("name") || !params["name"].is_string() ||
        !params.contains("source") || !params["source"].is_string()) {
      return ErrorResponse(id, "INVALID_REQUEST",
                           "runScript requires string name and source params");
    }
    chunk_name = params["name"].get<std::string>();
    source = params["source"].get<std::string>();
  } else if (command == "evaluate") {
    if (!params.contains("source") || !params["source"].is_string()) {
      return ErrorResponse(id, "INVALID_REQUEST",
                           "evaluate requires a string source param");
    }
    chunk_name = "evaluate";
    source = params["source"].get<std::string>();
  } else {
    return ErrorResponse(id, "INVALID_REQUEST", "Unknown command", {{"command", command}});
  }

  std::string result;
  if (!RunLuaText(source, chunk_name.c_str(), result)) {
    return ErrorResponse(id, "SCRIPT_ERROR", result);
  }
  return SuccessResponse(id, {{"status", "ok"}});
}

std::string HandleCommand(std::string command) {
  while (!command.empty() && (command.back() == '\r' || command.back() == '\n')) command.pop_back();
  std::istringstream input(command);
  std::string verb;
  input >> verb;
  if (verb == "PING" || verb == "STATUS") return StatusJson();
  if (verb == "RUN") {
    std::string path;
    std::getline(input >> std::ws, path);
    std::string result;
    const bool ok = RunLuaFile(std::filesystem::u8path(path), result);
    return std::string("{\"ok\":") + (ok ? "true" : "false") +
           ",\"result\":\"" + JsonEscape(result) + "\"}";
  }
  if (verb == "EVAL") {
    std::string script;
    std::getline(input >> std::ws, script, '\0');
    std::string result;
    const bool ok = RunLuaText(script, "pipe", result);
    return std::string("{\"ok\":") + (ok ? "true" : "false") +
           ",\"result\":\"" + JsonEscape(result) + "\"}";
  }
  return "{\"ok\":false,\"error\":\"unknown command\"}";
}

void PipeServer() {
  const std::wstring pipe_name = std::wstring(kPipePrefix) + std::to_wstring(GetCurrentProcessId());
  while (g_running.load()) {
    HANDLE pipe = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1, 64 * 1024, 64 * 1024, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return;
    if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
      std::array<char, 64 * 1024> buffer{};
      DWORD read = 0;
      if (ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size() - 1), &read, nullptr)) {
        const auto response = HandleCommand(std::string(buffer.data(), read));
        DWORD written = 0;
        WriteFile(pipe, response.data(), static_cast<DWORD>(response.size()), &written, nullptr);
      }
      FlushFileBuffers(pipe);
      DisconnectNamedPipe(pipe);
    }
    CloseHandle(pipe);
  }
}

void TickLoop() {
  while (g_running.load()) {
    Sleep(kTickMilliseconds);
    ++g_ticks;
    FireEvent("tick");
    const auto now = NowMilliseconds();
    auto previous = g_last_tick_event_ms.load(std::memory_order_relaxed);
    if (now - previous >= 1000 &&
        g_last_tick_event_ms.compare_exchange_strong(previous, now, std::memory_order_relaxed)) {
      AppendEvent("tick", {{"ticks", g_ticks.load(std::memory_order_relaxed)}}, now);
    }
  }
}

DWORD WINAPI Start(void* module_value) {
  const auto module = static_cast<HMODULE>(module_value);
  wchar_t path[MAX_PATH]{};
  GetModuleFileNameW(module, path, MAX_PATH);
  g_host_directory = std::filesystem::path(path).parent_path();
  g_log_path = g_host_directory / L"cfb27_lua_host.log";
  g_supported_build.store(VerifySupportedBuild(), std::memory_order_release);
  g_lua = luaL_newstate();
  if (!g_lua) { g_last_error = "could not create Lua state"; return 1; }
  luaL_openlibs(g_lua);
  RegisterApi(g_lua);
  RunAutorun();
  g_ready.store(true);
  FireEvent("game_ready");
  AppendEvent("game_ready", {{"ready", true}});
  std::thread(PipeServer).detach();
  const std::wstring v1_pipe_name =
      std::wstring(kV1PipePrefix) + std::to_wstring(GetCurrentProcessId());
  std::thread([v1_pipe_name] {
    cfb27::protocol::Serve(v1_pipe_name, g_running, HandleV1Request);
  }).detach();
  std::thread(TickLoop).detach();
  Log("CFB27 Lua host ready");
  return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    if (HANDLE thread = CreateThread(nullptr, 0, Start, module, 0, nullptr)) CloseHandle(thread);
  }
  return TRUE;
}
