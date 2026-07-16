#include "../host/board_mutation.h"

#include <iostream>

int main() {
  using cfb27::board_mutation::Invoke;
  using cfb27::board_mutation::Operation;
  using cfb27::board_mutation::Status;

  const auto invalid = Invoke(Operation::kAdd, 0x20000, 0);
  if (invalid.status != Status::kInvalidArgument) return 1;

  const auto unloaded = Invoke(Operation::kRemove, 1, 1);
  if (unloaded.status != Status::kRecruitingNotLoaded) return 2;

  if (std::string(cfb27::board_mutation::StatusCode(Status::kBoardFull)) !=
      "BOARD_FULL") return 3;

  std::cout << "board mutation smoke passed\n";
  return 0;
}
