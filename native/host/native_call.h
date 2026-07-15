#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

namespace cfb27::native_call {

constexpr std::size_t kMaxArguments = 8;

enum class Status {
  kOk,
  kInvalidTarget,
  kTooManyArguments,
  kException,
};

struct Result {
  Status status{Status::kInvalidTarget};
  std::uint64_t value{};
  std::uint32_t fault_code{};
};

bool IsExecutableAddress(std::uintptr_t address);
Result Invoke(std::uintptr_t address, std::span<const std::uint64_t> arguments);

}  // namespace cfb27::native_call
