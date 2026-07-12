#include "memory_transaction.h"

#include <windows.h>

#include <algorithm>
#include <charconv>
#include <limits>
#include <optional>
#include <string_view>
#include <system_error>

namespace cfb27::memory {
namespace {

struct PreparedOperation {
  std::uintptr_t address{};
  std::vector<std::uint8_t> original;
};

struct Range {
  std::uintptr_t begin{};
  std::uintptr_t end{};
};

bool IsValidTransactionId(std::string_view id) {
  if (id.empty() || id.size() > 64) return false;
  return std::all_of(id.begin(), id.end(), [](const char character) {
    return (character >= 'A' && character <= 'Z') ||
           (character >= 'a' && character <= 'z') ||
           (character >= '0' && character <= '9') || character == '.' ||
           character == '_' || character == '-';
  });
}

std::optional<std::uintptr_t> ParseAddress(std::string_view text) {
  if (text.size() <= 2 || text[0] != '0' || text[1] != 'x' ||
      (text.size() > 3 && text[2] == '0') ||
      !std::all_of(text.begin() + 2, text.end(), [](const char character) {
        return (character >= '0' && character <= '9') ||
               (character >= 'A' && character <= 'F');
      })) {
    return std::nullopt;
  }
  std::uintptr_t address{};
  const char* first = text.data() + 2;
  const char* last = text.data() + text.size();
  const auto [end, error] = std::from_chars(first, last, address, 16);
  if (error != std::errc{} || end != last) return std::nullopt;
  return address;
}

TransactionResult Rejected(std::string code) {
  return {.status = TransactionStatus::kRejected, .code = std::move(code)};
}

TransactionResult RollBack(
    const std::vector<PreparedOperation>& prepared,
    const std::vector<std::size_t>& attempted,
    std::vector<OperationResult> results, MemoryBackend& backend) {
  bool restored = true;
  for (auto iterator = attempted.rbegin(); iterator != attempted.rend();
       ++iterator) {
    const auto index = *iterator;
    if (!backend.Write(prepared[index].address, prepared[index].original)) {
      restored = false;
    }
    results[index].applied = false;
    results[index].verified = false;
  }

  for (const auto index : attempted) {
    std::vector<std::uint8_t> readback(prepared[index].original.size());
    if (!backend.Read(prepared[index].address, readback) ||
        readback != prepared[index].original) {
      restored = false;
    }
  }

  return {
      .status = restored ? TransactionStatus::kRolledBackVerified
                         : TransactionStatus::kRollbackUnverified,
      .code = restored ? "rolled_back_verified" : "rollback_unverified",
      .operations = std::move(results),
  };
}

bool IsReadableProtection(DWORD protection) {
  const DWORD base = protection & 0xFF;
  return base == PAGE_READONLY || base == PAGE_READWRITE ||
         base == PAGE_WRITECOPY || base == PAGE_EXECUTE_READ ||
         base == PAGE_EXECUTE_READWRITE || base == PAGE_EXECUTE_WRITECOPY;
}

bool IsWritableProtection(DWORD protection) {
  const DWORD base = protection & 0xFF;
  return base == PAGE_READWRITE || base == PAGE_WRITECOPY ||
         base == PAGE_EXECUTE_READWRITE || base == PAGE_EXECUTE_WRITECOPY;
}

}  // namespace

bool ProcessMemoryBackend::Validate(std::uintptr_t address, std::size_t size,
                                    bool writable) {
  if (size == 0 || address > std::numeric_limits<std::uintptr_t>::max() - size) {
    return false;
  }
  const auto end = address + size;
  auto cursor = address;
  while (cursor < end) {
    MEMORY_BASIC_INFORMATION info{};
    if (VirtualQuery(reinterpret_cast<const void*>(cursor), &info,
                     sizeof(info)) != sizeof(info) ||
        info.State != MEM_COMMIT || (info.Protect & PAGE_GUARD) != 0 ||
        (info.Protect & PAGE_NOACCESS) != 0 ||
        !IsReadableProtection(info.Protect) ||
        (writable && !IsWritableProtection(info.Protect))) {
      return false;
    }
    const auto region_begin = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
    if (info.RegionSize >
        std::numeric_limits<std::uintptr_t>::max() - region_begin) {
      return false;
    }
    const auto region_end = region_begin + info.RegionSize;
    if (region_end <= cursor) return false;
    cursor = std::min(end, region_end);
  }
  return true;
}

bool ProcessMemoryBackend::Read(std::uintptr_t address,
                                std::span<std::uint8_t> output) {
  SIZE_T copied{};
  return ReadProcessMemory(GetCurrentProcess(),
                           reinterpret_cast<const void*>(address),
                           output.data(), output.size(), &copied) != FALSE &&
         copied == output.size();
}

bool ProcessMemoryBackend::Write(std::uintptr_t address,
                                 std::span<const std::uint8_t> input) {
  SIZE_T copied{};
  return WriteProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(address),
                            input.data(), input.size(), &copied) != FALSE &&
         copied == input.size();
}

TransactionResult RunTransaction(const TransactionRequest& request,
                                 MemoryBackend& backend) {
  if (!IsValidTransactionId(request.transaction_id)) {
    return Rejected("invalid_transaction_id");
  }
  if (request.operations.empty() ||
      request.operations.size() > kMaxTransactionOperations) {
    return Rejected("invalid_operation_count");
  }

  std::size_t aggregate_bytes{};
  std::vector<PreparedOperation> prepared(request.operations.size());
  std::vector<Range> ranges;
  ranges.reserve(request.operations.size());
  for (std::size_t index = 0; index < request.operations.size(); ++index) {
    const auto& operation = request.operations[index];
    if (operation.expected.empty() ||
        operation.expected.size() != operation.replacement.size() ||
        operation.replacement.size() > kMaxOperationBytes) {
      return Rejected("invalid_operation_size");
    }
    if (aggregate_bytes >
        kMaxTransactionBytes - operation.replacement.size()) {
      return Rejected("transaction_too_large");
    }
    aggregate_bytes += operation.replacement.size();

    const auto address = ParseAddress(operation.address);
    if (!address || *address > std::numeric_limits<std::uintptr_t>::max() -
                                    operation.replacement.size()) {
      return Rejected("invalid_address");
    }
    prepared[index].address = *address;
    ranges.push_back({*address, *address + operation.replacement.size()});
  }

  std::sort(ranges.begin(), ranges.end(), [](const Range& left,
                                             const Range& right) {
    return left.begin < right.begin;
  });
  for (std::size_t index = 1; index < ranges.size(); ++index) {
    if (ranges[index].begin < ranges[index - 1].end) {
      return Rejected("overlapping_operations");
    }
  }

  for (std::size_t index = 0; index < prepared.size(); ++index) {
    if (!backend.Validate(prepared[index].address,
                          request.operations[index].replacement.size(), true)) {
      return Rejected("invalid_memory_range");
    }
  }
  for (std::size_t index = 0; index < prepared.size(); ++index) {
    prepared[index].original.resize(request.operations[index].expected.size());
    if (!backend.Read(prepared[index].address, prepared[index].original)) {
      return Rejected("preflight_read_failed");
    }
  }
  for (std::size_t index = 0; index < prepared.size(); ++index) {
    if (prepared[index].original != request.operations[index].expected) {
      return Rejected("expected_mismatch");
    }
  }

  std::vector<OperationResult> results;
  results.reserve(request.operations.size());
  for (std::size_t index = 0; index < request.operations.size(); ++index) {
    results.push_back({.index = index});
  }

  std::vector<std::size_t> attempted;
  attempted.reserve(request.operations.size());
  for (std::size_t index = 0; index < request.operations.size(); ++index) {
    attempted.push_back(index);
    if (!backend.Write(prepared[index].address,
                       request.operations[index].replacement)) {
      return RollBack(prepared, attempted, std::move(results), backend);
    }
    results[index].applied = true;
    std::vector<std::uint8_t> readback(
        request.operations[index].replacement.size());
    if (!backend.Read(prepared[index].address, readback) ||
        readback != request.operations[index].replacement) {
      return RollBack(prepared, attempted, std::move(results), backend);
    }
    results[index].verified = true;
  }

  return {
      .status = TransactionStatus::kAppliedVerified,
      .code = "applied_verified",
      .operations = std::move(results),
  };
}

}  // namespace cfb27::memory
