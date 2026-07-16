#include "../host/native_call.h"

#include <windows.h>

#include <cstdint>
#include <iostream>
#include <vector>

namespace {

__declspec(noinline) std::uint64_t SumEight(
    std::uint64_t a, std::uint64_t b, std::uint64_t c, std::uint64_t d,
    std::uint64_t e, std::uint64_t f, std::uint64_t g, std::uint64_t h) {
  return a + b + c + d + e + f + g + h;
}

__declspec(noinline) std::uint64_t RaiseFault() {
  RaiseException(0xE0424242, 0, 0, nullptr);
  return 0;
}

void Require(bool condition, const char* message) {
  if (!condition) throw message;
}

}  // namespace

int main() {
  try {
    const auto target = reinterpret_cast<std::uintptr_t>(&SumEight);
    Require(cfb27::native_call::IsExecutableAddress(target),
            "test function was not accepted as executable code");
    const std::vector<std::uint64_t> arguments{1, 2, 3, 4, 5, 6, 7, 8};
    const auto result = cfb27::native_call::Invoke(target, arguments);
    Require(result.status == cfb27::native_call::Status::kOk,
            "eight-argument call failed");
    Require(result.value == 36, "eight-argument return value is wrong");

    const auto fault = cfb27::native_call::Invoke(
        reinterpret_cast<std::uintptr_t>(&RaiseFault), {});
    Require(fault.status == cfb27::native_call::Status::kException,
            "structured exception was not captured");
    Require(fault.fault_code == 0xE0424242,
            "structured exception code was not preserved");

    const auto invalid = cfb27::native_call::Invoke(1, {});
    Require(invalid.status == cfb27::native_call::Status::kInvalidTarget,
            "invalid target was accepted");

    const std::vector<std::uint64_t> excessive(9, 0);
    const auto too_many = cfb27::native_call::Invoke(target, excessive);
    Require(too_many.status == cfb27::native_call::Status::kTooManyArguments,
            "excessive argument list was accepted");

    std::cout << "native call smoke passed\n";
    return 0;
  } catch (const char* error) {
    std::cerr << "native call smoke failed: " << error << '\n';
    return 1;
  }
}
