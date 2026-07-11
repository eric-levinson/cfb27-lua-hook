#include <windows.h>

#include <atomic>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace {

constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27SubmitProbe.";
constexpr std::uintptr_t kEnterEditResponseVtableRva = 0x0B230A78;
constexpr std::uintptr_t kPlayerPayloadVtableRva = 0x0B037270;
constexpr std::size_t kResponseSize = 0x888;
constexpr std::size_t kResponsePayloadOffset = 0xE0;
constexpr std::size_t kPrimaryPlayerIdOffset = 0xD0;
constexpr std::size_t kSecondaryPlayerIdOffset = 0x28C;

constexpr std::pair<std::string_view, std::size_t> kRatingOffsets[] = {
    {"overall", 0x220}, {"speed", 0x29D}, {"acceleration", 0x10},
    {"strength", 0x2A1}, {"agility", 0x12}, {"awareness", 0x13},
    {"jumping", 0x1F6}, {"carrying", 0x19}, {"break_tackle", 0x17},
    {"trucking", 0x2AE}, {"bc_vision", 0x14}, {"stiff_arm", 0x2A0},
};

std::atomic<bool> g_running{true};
std::atomic<std::uint64_t> g_validations{0};

bool IsAccessible(const void* address, std::size_t size, bool require_writable = false) {
  MEMORY_BASIC_INFORMATION info{};
  if (!VirtualQuery(address, &info, sizeof(info))) return false;
  if (info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) return false;
  constexpr DWORD readable = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  constexpr DWORD writable = PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  const auto start = reinterpret_cast<std::uintptr_t>(address);
  const auto end = start + size;
  const auto region_end = reinterpret_cast<std::uintptr_t>(info.BaseAddress) + info.RegionSize;
  return end <= region_end && (info.Protect & (require_writable ? writable : readable));
}

std::optional<std::size_t> RatingOffset(std::string_view field) {
  for (const auto& [name, offset] : kRatingOffsets) if (field == name) return offset;
  return std::nullopt;
}

struct ValidatedSource {
  std::uint8_t* response{};
  std::uint8_t* payload{};
  std::size_t rating_offset{};
};

std::optional<ValidatedSource> ValidateSource(std::uintptr_t address, std::uint32_t player_id,
                                               std::string_view field, int expected,
                                               std::string& error) {
  const auto offset = RatingOffset(field);
  if (!offset) { error = "unsupported rating field"; return std::nullopt; }
  if (expected < 0 || expected > (field == "overall" ? 100 : 99)) {
    error = "expected rating is outside the supported range"; return std::nullopt;
  }
  auto* response = reinterpret_cast<std::uint8_t*>(address);
  if (!IsAccessible(response, kResponseSize)) { error = "response address is not readable"; return std::nullopt; }
  const auto game_base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
  if (*reinterpret_cast<std::uintptr_t*>(response) != game_base + kEnterEditResponseVtableRva) {
    error = "EnterEditResponse vtable identity check failed"; return std::nullopt;
  }
  auto* payload = response + kResponsePayloadOffset;
  if (*reinterpret_cast<std::uintptr_t*>(payload) != game_base + kPlayerPayloadVtableRva) {
    error = "embedded player payload vtable identity check failed"; return std::nullopt;
  }
  const auto first_id = *reinterpret_cast<std::uint32_t*>(payload + kPrimaryPlayerIdOffset);
  const auto second_id = *reinterpret_cast<std::uint32_t*>(payload + kSecondaryPlayerIdOffset);
  if (first_id != player_id || second_id != player_id) {
    error = "embedded player identity check failed"; return std::nullopt;
  }
  if (payload[*offset] != static_cast<std::uint8_t>(expected)) {
    error = "embedded rating does not match the expected value"; return std::nullopt;
  }
  ++g_validations;
  return ValidatedSource{response, payload, *offset};
}

std::string StatusJson() {
  std::ostringstream out;
  out << "{\"ok\":true,\"validationOnly\":true,\"validations\":" << g_validations.load() << "}";
  return out.str();
}

std::string HandleCommand(const std::string& command) {
  std::istringstream input(command);
  std::string verb;
  input >> verb;
  if (verb == "PING" || verb == "STATUS") return StatusJson();
  if (verb != "VALIDATE") return "{\"ok\":false,\"error\":\"validation-only probe; dispatch is disabled\"}";

  std::uintptr_t response_address = 0;
  std::uint32_t player_id = 0;
  std::string field;
  int expected = -1;
  int value = -1;
  input >> response_address >> player_id >> field >> expected >> value;
  if (!input || value < 0 || value > (field == "overall" ? 100 : 99)) {
    return "{\"ok\":false,\"error\":\"expected address, player id, field, expected, and value\"}";
  }
  std::string error;
  const auto source = ValidateSource(response_address, player_id, field, expected, error);
  if (!source) return "{\"ok\":false,\"error\":\"" + error + "\"}";
  std::ostringstream out;
  out << "{\"ok\":true,\"playerId\":" << player_id
      << ",\"field\":\"" << field << "\",\"expected\":" << expected
      << ",\"value\":" << value << ",\"payloadOffset\":" << source->rating_offset
      << ",\"dispatchDisabled\":true}";
  return out.str();
}

void PipeServer() {
  const std::wstring pipe_name = std::wstring(kPipePrefix) + std::to_wstring(GetCurrentProcessId());
  while (g_running.load()) {
    HANDLE pipe = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
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
    }
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
  }
}

DWORD WINAPI MainThread(void*) { PipeServer(); return 0; }

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    if (HANDLE thread = CreateThread(nullptr, 0, MainThread, nullptr, 0, nullptr)) CloseHandle(thread);
  } else if (reason == DLL_PROCESS_DETACH) {
    g_running.store(false);
  }
  return TRUE;
}
