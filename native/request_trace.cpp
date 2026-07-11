#include <windows.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
#include <thread>

namespace {

#ifdef CFB27_REQUEST_TRACE_SECONDARY
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27RequestTrace2.";
#else
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\CFB27RequestTrace.";
#endif

struct TraceTarget {
  const char* name;
  std::uintptr_t rva;
  std::array<std::uint8_t, 20> prologue;
  std::size_t prologue_size;
};

#ifdef CFB27_REQUEST_TRACE_SECONDARY
constexpr std::array kTargets{
    TraceTarget{"secondary_80bdb90", 0x080BDB90,
                {0x48,0x89,0x5C,0x24,0x08,0x57,0x48,0x83,0xEC,0x20,0x48,0x8B,0xF9,0x48,0x8B,0x49,0x10}, 17},
    TraceTarget{"secondary_80c0fd0", 0x080C0FD0,
                {0x40,0x53,0x48,0x83,0xEC,0x20,0x45,0x33,0xC9,0x45,0x33,0xC0,0x33,0xD2,0x48,0x8B,0xD9}, 17},
    TraceTarget{"secondary_80c4280", 0x080C4280,
                {0x48,0x89,0x5C,0x24,0x18,0x55,0x56,0x57,0x48,0x8B,0xEC,0x48,0x83,0xEC,0x20}, 15},
    TraceTarget{"secondary_80b9da0", 0x080B9DA0,
                {0x48,0x89,0x5C,0x24,0x18,0x48,0x89,0x6C,0x24,0x20,0x56,0x57,0x41,0x57,0x48,0x83,0xEC,0x50}, 18},
    TraceTarget{"secondary_801cad0", 0x0801CAD0,
                {0x48,0x89,0x5C,0x24,0x08,0x48,0x89,0x74,0x24,0x10,0x57,0x48,0x83,0xEC,0x20}, 15},
    TraceTarget{"secondary_801c890", 0x0801C890,
                {0x48,0x89,0x6C,0x24,0x18,0x56,0x57,0x41,0x56,0x48,0x83,0xEC,0x20,0x48,0x8B,0x01}, 16},
    TraceTarget{"secondary_7de38e0", 0x07DE38E0,
                {0x40,0x56,0x48,0x83,0xEC,0x40,0xC7,0x44,0x24,0x28,0x00,0x00,0x00,0x00}, 14},
};
#else
constexpr std::array kTargets{
    TraceTarget{"candidate_80b9890", 0x080B9890,
                {0x48,0x89,0x5C,0x24,0x08,0x48,0x89,0x74,0x24,0x10,0x48,0x89,0x7C,0x24,0x18}, 15},
    TraceTarget{"candidate_80c8240", 0x080C8240,
                {0x48,0x89,0x5C,0x24,0x08,0x48,0x89,0x74,0x24,0x10,0x57,0x48,0x83,0xEC,0x20}, 15},
    TraceTarget{"candidate_80c7290", 0x080C7290,
                {0x48,0x8B,0xC4,0x48,0x89,0x58,0x08,0x57,0x48,0x81,0xEC,0x90,0x00,0x00,0x00}, 15},
    TraceTarget{"candidate_80c8ec0", 0x080C8EC0,
                {0x48,0x89,0x5C,0x24,0x08,0x48,0x89,0x6C,0x24,0x10,0x48,0x89,0x74,0x24,0x18}, 15},
    TraceTarget{"candidate_80c1b30", 0x080C1B30,
                {0x48,0x89,0x5C,0x24,0x08,0x48,0x89,0x6C,0x24,0x10,0x48,0x89,0x74,0x24,0x18}, 15},
    TraceTarget{"candidate_80c22e0", 0x080C22E0,
                {0x48,0x89,0x5C,0x24,0x08,0x57,0x48,0x83,0xEC,0x20,0x80,0x7C,0x24,0x50,0x00}, 15},
    TraceTarget{"candidate_80c2550", 0x080C2550,
                {0x48,0x89,0x5C,0x24,0x08,0x48,0x89,0x6C,0x24,0x10,0x48,0x89,0x74,0x24,0x18}, 15},
    TraceTarget{"candidate_80b9c10", 0x080B9C10,
                {0x48,0x89,0x5C,0x24,0x08,0x57,0x48,0x83,0xEC,0x20,0x8B,0xFA,0x48,0x8B,0xD9}, 15},
};
#endif

alignas(8) volatile LONG64 g_counts[kTargets.size()]{};
std::array<bool, kTargets.size()> g_installed{};
std::atomic<bool> g_running{true};

void WriteAbsoluteJump(std::uint8_t* destination, const void* target) {
  destination[0] = 0xFF;
  destination[1] = 0x25;
  std::memset(destination + 2, 0, 4);
  *reinterpret_cast<const void**>(destination + 6) = target;
}

bool InstallCounterHook(std::size_t index, std::uintptr_t game_base) {
  const auto& target = kTargets[index];
  auto* entry = reinterpret_cast<std::uint8_t*>(game_base + target.rva);
  if (!std::equal(target.prologue.begin(), target.prologue.begin() + target.prologue_size, entry)) return false;

  // pushfq; push rax; mov rax,<counter>; lock inc qword ptr [rax];
  // pop rax; popfq; copied prologue; absolute jump back.
  constexpr std::size_t prefix_size = 18;
  constexpr std::size_t jump_size = 14;
  const std::size_t stub_size = prefix_size + target.prologue_size + jump_size;
  auto* stub = static_cast<std::uint8_t*>(
      VirtualAlloc(nullptr, stub_size, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE));
  if (!stub) return false;
  std::size_t cursor = 0;
  stub[cursor++] = 0x9C;
  stub[cursor++] = 0x50;
  stub[cursor++] = 0x48;
  stub[cursor++] = 0xB8;
  *reinterpret_cast<const void**>(stub + cursor) =
      const_cast<LONG64*>(reinterpret_cast<const volatile LONG64*>(&g_counts[index]));
  cursor += 8;
  stub[cursor++] = 0xF0;
  stub[cursor++] = 0x48;
  stub[cursor++] = 0xFF;
  stub[cursor++] = 0x00;
  stub[cursor++] = 0x58;
  stub[cursor++] = 0x9D;
  std::memcpy(stub + cursor, target.prologue.data(), target.prologue_size);
  cursor += target.prologue_size;
  WriteAbsoluteJump(stub + cursor, entry + target.prologue_size);

  DWORD previous = 0;
  if (!VirtualProtect(entry, target.prologue_size, PAGE_EXECUTE_READWRITE, &previous)) {
    VirtualFree(stub, 0, MEM_RELEASE);
    return false;
  }
  WriteAbsoluteJump(entry, stub);
  for (std::size_t offset = 14; offset < target.prologue_size; ++offset) entry[offset] = 0x90;
  FlushInstructionCache(GetCurrentProcess(), entry, target.prologue_size);
  DWORD ignored = 0;
  VirtualProtect(entry, target.prologue_size, previous, &ignored);
  return true;
}

std::string StatusJson() {
  std::ostringstream out;
  out << "{\"ok\":true,\"targets\":[";
  for (std::size_t index = 0; index < kTargets.size(); ++index) {
    if (index) out << ',';
    out << "{\"name\":\"" << kTargets[index].name << "\",\"rva\":"
        << kTargets[index].rva << ",\"installed\":"
        << (g_installed[index] ? "true" : "false") << ",\"calls\":"
        << static_cast<unsigned long long>(g_counts[index]) << '}';
  }
  out << "]}";
  return out.str();
}

void PipeServer() {
  const std::wstring pipe_name = std::wstring(kPipePrefix) + std::to_wstring(GetCurrentProcessId());
  while (g_running.load()) {
    HANDLE pipe = CreateNamedPipeW(pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
                                   PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                                   1, 64 * 1024, 64 * 1024, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return;
    if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
      char buffer[256]{};
      DWORD read = 0;
      if (ReadFile(pipe, buffer, sizeof(buffer) - 1, &read, nullptr)) {
        if (std::string(buffer, read).starts_with("CLEAR")) {
          for (auto& count : g_counts) InterlockedExchange64(&count, 0);
        }
        const auto response = StatusJson();
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
  const auto game_base = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
  for (std::size_t index = 0; index < kTargets.size(); ++index) {
    g_installed[index] = InstallCounterHook(index, game_base);
  }
  std::thread(PipeServer).detach();
  return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    const HANDLE thread = CreateThread(nullptr, 0, Start, nullptr, 0, nullptr);
    if (thread) CloseHandle(thread);
  }
  return TRUE;
}
