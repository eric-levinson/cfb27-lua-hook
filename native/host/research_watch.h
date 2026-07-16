#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace cfb27::research_watch {

constexpr std::size_t kMaxSlots = 4;
constexpr std::size_t kMaxHits = 128;
constexpr std::size_t kStackWords = 256;
constexpr std::size_t kPointerWords = 8;

enum class Kind : std::uint8_t {
  kWrite,
  kExecute,
};

enum class ArmStatus {
  kOk,
  kInvalidAddress,
  kNoSlot,
  kNoThreads,
  kHandlerFailed,
};

struct ArmResult {
  ArmStatus status{ArmStatus::kInvalidAddress};
  std::size_t slot{};
  std::size_t thread_count{};
};

struct PointerSnapshot {
  std::array<std::uint64_t, kPointerWords> words{};
  std::size_t count{};
};

struct Hit {
  std::size_t slot{};
  std::uint32_t thread_id{};
  std::uintptr_t rip{};
  std::uintptr_t rsp{};
  std::uint64_t rax{};
  std::uint64_t rbx{};
  std::uint64_t rbp{};
  std::uint64_t rsi{};
  std::uint64_t rdi{};
  std::uint64_t rcx{};
  std::uint64_t rdx{};
  std::uint64_t r8{};
  std::uint64_t r9{};
  std::uint64_t r10{};
  std::uint64_t r11{};
  PointerSnapshot rbx_memory{};
  PointerSnapshot rsi_memory{};
  PointerSnapshot rdi_memory{};
  PointerSnapshot rcx_memory{};
  PointerSnapshot rdx_memory{};
  PointerSnapshot r8_memory{};
  PointerSnapshot r9_memory{};
  std::array<std::uint64_t, kStackWords> stack{};
  std::size_t stack_count{};
};

struct Snapshot {
  std::vector<Hit> hits;
  std::uint64_t dropped{};
};

ArmResult Arm(Kind kind, std::uintptr_t address, std::size_t length = 4);
Snapshot Collect(bool clear);
std::size_t Disarm();
const char* ArmStatusCode(ArmStatus status);

}  // namespace cfb27::research_watch
