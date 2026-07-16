#pragma once

#include <cstdint>

namespace cfb27::board_mutation {

enum class Operation { kAdd, kRemove };

enum class Status {
  kApplied,
  kUnchanged,
  kInvalidArgument,
  kRecruitingNotLoaded,
  kRuntimeAmbiguous,
  kTableDiscoveryFailed,
  kBoardStateInvalid,
  kBoardFull,
  kNativeCallFailed,
  kPostconditionFailed,
};

struct Result {
  Status status{Status::kInvalidArgument};
  Operation operation{Operation::kAdd};
  std::uint32_t recruit_row{};
  std::uint32_t team_row{};
  std::uint32_t membership_row{};
  std::uint32_t board_slot{UINT32_MAX};
  std::uint32_t target_row{UINT32_MAX};
  std::uint32_t active_pitch_row{UINT32_MAX};
  std::uint64_t call_value{};
  std::uint32_t fault_code{};
};

Result Invoke(Operation operation, std::uint32_t recruit_row,
              std::uint32_t team_row);
const char* StatusCode(Status status);

}  // namespace cfb27::board_mutation
