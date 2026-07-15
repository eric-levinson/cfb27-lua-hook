#include "native_call.h"

#include <windows.h>

namespace cfb27::native_call {
namespace {

using Word = std::uint64_t;

Word Dispatch(std::uintptr_t address, std::span<const Word> arguments) {
  switch (arguments.size()) {
    case 0:
      return reinterpret_cast<Word (*)()>(address)();
    case 1:
      return reinterpret_cast<Word (*)(Word)>(address)(arguments[0]);
    case 2:
      return reinterpret_cast<Word (*)(Word, Word)>(address)(
          arguments[0], arguments[1]);
    case 3:
      return reinterpret_cast<Word (*)(Word, Word, Word)>(address)(
          arguments[0], arguments[1], arguments[2]);
    case 4:
      return reinterpret_cast<Word (*)(Word, Word, Word, Word)>(address)(
          arguments[0], arguments[1], arguments[2], arguments[3]);
    case 5:
      return reinterpret_cast<Word (*)(Word, Word, Word, Word, Word)>(address)(
          arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
    case 6:
      return reinterpret_cast<Word (*)(Word, Word, Word, Word, Word, Word)>(address)(
          arguments[0], arguments[1], arguments[2], arguments[3], arguments[4],
          arguments[5]);
    case 7:
      return reinterpret_cast<Word (*)(Word, Word, Word, Word, Word, Word, Word)>(
          address)(arguments[0], arguments[1], arguments[2], arguments[3],
                   arguments[4], arguments[5], arguments[6]);
    case 8:
      return reinterpret_cast<
          Word (*)(Word, Word, Word, Word, Word, Word, Word, Word)>(address)(
          arguments[0], arguments[1], arguments[2], arguments[3], arguments[4],
          arguments[5], arguments[6], arguments[7]);
    default:
      return 0;
  }
}

Result InvokeGuarded(std::uintptr_t address,
                     std::span<const Word> arguments) {
  Result result{.status = Status::kOk};
#if defined(_MSC_VER)
  __try {
    result.value = Dispatch(address, arguments);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    result.status = Status::kException;
    result.fault_code = static_cast<std::uint32_t>(GetExceptionCode());
  }
#else
  result.value = Dispatch(address, arguments);
#endif
  return result;
}

}  // namespace

bool IsExecutableAddress(std::uintptr_t address) {
  if (!address) return false;
  MEMORY_BASIC_INFORMATION info{};
  if (VirtualQuery(reinterpret_cast<const void*>(address), &info, sizeof(info)) !=
          sizeof(info) ||
      info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) {
    return false;
  }
  constexpr DWORD executable = PAGE_EXECUTE | PAGE_EXECUTE_READ |
                               PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  return (info.Protect & executable) != 0;
}

Result Invoke(std::uintptr_t address, std::span<const std::uint64_t> arguments) {
  if (arguments.size() > kMaxArguments) {
    return {.status = Status::kTooManyArguments};
  }
  if (!IsExecutableAddress(address)) {
    return {.status = Status::kInvalidTarget};
  }
  return InvokeGuarded(address, arguments);
}

}  // namespace cfb27::native_call
