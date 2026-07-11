#include "memory_reader.h"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <limits>
#include <memory>
#include <system_error>
#include <utility>

namespace cfb27::memory {
namespace {

constexpr char kInvalidRequest[] = "INVALID_REQUEST";
constexpr char kMemoryAccessDenied[] = "MEMORY_ACCESS_DENIED";

bool AddOverflows(std::uintptr_t left, std::size_t right) {
  return right > std::numeric_limits<std::uintptr_t>::max() - left;
}

bool SizeAddOverflows(std::size_t left, std::size_t right) {
  return right > std::numeric_limits<std::size_t>::max() - left;
}

bool IsReadableProtection(DWORD protection) {
  if ((protection & (PAGE_GUARD | PAGE_NOACCESS)) != 0) return false;
  switch (protection & 0xFF) {
    case PAGE_READONLY:
    case PAGE_READWRITE:
    case PAGE_WRITECOPY:
    case PAGE_EXECUTE_READ:
    case PAGE_EXECUTE_READWRITE:
    case PAGE_EXECUTE_WRITECOPY:
      return true;
    default:
      return false;
  }
}

struct ValidatedRead {
  std::uintptr_t address{};
  std::size_t length{};
  std::string formatted_address;
};

bool IsWithinOneEligibleRegion(std::uintptr_t address, std::size_t length) {
  MEMORY_BASIC_INFORMATION info{};
  if (VirtualQuery(reinterpret_cast<const void*>(address), &info, sizeof(info)) != sizeof(info) ||
      !IsEligiblePrivateReadableRegion(info)) {
    return false;
  }
  const auto base = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
  if (address < base || AddOverflows(base, info.RegionSize) || AddOverflows(address, length)) {
    return false;
  }
  return address + length <= base + info.RegionSize;
}

bool PatternMatches(const std::uint8_t* bytes, const ScanRequest& request) {
  for (std::size_t i = 0; i < request.pattern.size(); ++i) {
    if ((bytes[i] & request.mask[i]) != (request.pattern[i] & request.mask[i])) return false;
  }
  return true;
}

bool OverlapsRange(std::uintptr_t candidate, std::size_t candidate_length,
                   const void* excluded_data, std::size_t excluded_length) {
  if (excluded_data == nullptr || excluded_length == 0) return false;
  const auto excluded = reinterpret_cast<std::uintptr_t>(excluded_data);
  if (AddOverflows(candidate, candidate_length) || AddOverflows(excluded, excluded_length)) {
    return false;
  }
  return candidate < excluded + excluded_length && excluded < candidate + candidate_length;
}

bool OverlapsMatchContext(std::uintptr_t candidate, std::size_t candidate_length,
                          const ScanResult& result) {
  for (const auto& match : result.matches) {
    if (OverlapsRange(candidate, candidate_length, match.context.data(),
                      match.context.capacity())) {
      return true;
    }
  }
  return false;
}

bool ProductionRead(const void* source, void* destination, std::size_t length,
                    std::size_t& copied) {
  SIZE_T process_copied = 0;
  const bool ok = ReadProcessMemory(GetCurrentProcess(), source, destination, length,
                                    &process_copied) != FALSE;
  copied = static_cast<std::size_t>(process_copied);
  return ok;
}

struct VirtualFreeDeleter {
  void operator()(std::uint8_t* allocation) const {
    if (allocation != nullptr) VirtualFree(allocation, 0, MEM_RELEASE);
  }
};

}  // namespace

std::optional<std::uintptr_t> ParseAddress(std::string_view text) {
  if (text.size() >= 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) {
    text.remove_prefix(2);
  }
  if (text.empty()) return std::nullopt;

  std::uintptr_t address{};
  const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), address, 16);
  if (error != std::errc{} || end != text.data() + text.size()) return std::nullopt;
  return address;
}

std::string FormatAddress(std::uintptr_t address) {
  char digits[sizeof(std::uintptr_t) * 2]{};
  const auto [end, error] = std::to_chars(std::begin(digits), std::end(digits), address, 16);
  if (error != std::errc{}) return {};
  std::string formatted("0x");
  formatted.append(digits, end);
  std::transform(formatted.begin() + 2, formatted.end(), formatted.begin() + 2,
                 [](unsigned char character) {
                   return static_cast<char>(std::toupper(character));
                 });
  return formatted;
}

bool IsEligiblePrivateReadableRegion(const MEMORY_BASIC_INFORMATION& info) {
  return info.State == MEM_COMMIT && info.Type == MEM_PRIVATE && info.RegionSize != 0 &&
         IsReadableProtection(info.Protect);
}

BatchReadResult ReadMemoryBatch(const std::vector<ReadRange>& ranges) {
  BatchReadResult result;
  if (ranges.empty() || ranges.size() > kMaxReadRanges) {
    result.code = kInvalidRequest;
    return result;
  }

  std::vector<ValidatedRead> validated;
  validated.reserve(ranges.size());
  std::size_t total_bytes = 0;
  for (const auto& range : ranges) {
    const auto address = ParseAddress(range.address);
    if (!address || range.length == 0 || range.length > kMaxReadRangeBytes ||
        SizeAddOverflows(total_bytes, range.length) ||
        total_bytes + range.length > kMaxReadBytes) {
      result.code = kInvalidRequest;
      return result;
    }
    if (AddOverflows(*address, range.length) ||
        !IsWithinOneEligibleRegion(*address, range.length)) {
      result.code = kMemoryAccessDenied;
      return result;
    }
    total_bytes += range.length;
    validated.push_back({*address, range.length, FormatAddress(*address)});
  }

  std::vector<ReadResult> read_results;
  read_results.reserve(validated.size());
  for (const auto& range : validated) {
    ReadResult read{range.formatted_address, std::vector<std::uint8_t>(range.length)};
    SIZE_T copied = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<const void*>(range.address),
                           read.bytes.data(), read.bytes.size(), &copied) ||
        copied != read.bytes.size()) {
      result.code = kMemoryAccessDenied;
      return result;
    }
    read_results.push_back(std::move(read));
  }

  result.ok = true;
  result.ranges = std::move(read_results);
  return result;
}

ScanResult ScanPrivateMemory(const ScanRequest& request, ScanReadFunction read) {
  ScanResult result;
  if (request.pattern.size() < kMinPatternBytes ||
      request.pattern.size() > kMaxPatternBytes ||
      request.mask.size() != request.pattern.size() || request.max_matches == 0 ||
      request.max_matches > kMaxMatches ||
      SizeAddOverflows(request.context_before, request.context_after) ||
      request.context_before + request.context_after > kMaxContextBytes) {
    result.code = kInvalidRequest;
    return result;
  }

  SYSTEM_INFO system_info{};
  GetSystemInfo(&system_info);
  const auto minimum =
      reinterpret_cast<std::uintptr_t>(system_info.lpMinimumApplicationAddress);
  const auto maximum = reinterpret_cast<std::uintptr_t>(system_info.lpMaximumApplicationAddress);
  auto cursor = minimum;
  if (request.cursor) {
    const auto parsed = ParseAddress(*request.cursor);
    if (!parsed || FormatAddress(*parsed) != *request.cursor || *parsed < minimum ||
        *parsed > maximum) {
      result.code = kInvalidRequest;
      return result;
    }
    cursor = *parsed;
  }

  const auto buffer_capacity = kScanChunkBytes + request.pattern.size() - 1;
  std::unique_ptr<std::uint8_t, VirtualFreeDeleter> scan_buffer(
      static_cast<std::uint8_t*>(VirtualAlloc(nullptr, buffer_capacity,
                                               MEM_RESERVE | MEM_COMMIT,
                                               PAGE_READWRITE)));
  if (!scan_buffer) {
    result.code = kMemoryAccessDenied;
    return result;
  }
  const auto buffer_begin = reinterpret_cast<std::uintptr_t>(scan_buffer.get());
  const auto buffer_end = buffer_begin + buffer_capacity;
  const auto read_chunk = read != nullptr ? read : ProductionRead;
  result.matches.reserve(request.max_matches + 1);

  while (cursor <= maximum) {
    MEMORY_BASIC_INFORMATION info{};
    if (VirtualQuery(reinterpret_cast<const void*>(cursor), &info, sizeof(info)) != sizeof(info)) {
      result.code = kMemoryAccessDenied;
      return result;
    }

    const auto region_base = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
    if (AddOverflows(region_base, info.RegionSize)) {
      result.code = kInvalidRequest;
      return result;
    }
    const auto region_end = region_base + info.RegionSize;
    if (region_end <= cursor) {
      result.code = kInvalidRequest;
      return result;
    }

    const bool is_scan_buffer =
        cursor < buffer_end && buffer_begin < region_end;
    if (!IsEligiblePrivateReadableRegion(info) || is_scan_buffer) {
      if (region_end > maximum) {
        result.complete = true;
        return result;
      }
      cursor = region_end;
      continue;
    }

    const auto remaining_budget = kMaxScanPageBytes - result.scanned_bytes;
    if (remaining_budget == 0) {
      result.next_cursor = FormatAddress(cursor);
      return result;
    }
    const auto unique_bytes = std::min({
        region_end - cursor,
        static_cast<std::uintptr_t>(kScanChunkBytes),
        static_cast<std::uintptr_t>(remaining_budget),
    });
    const auto after_unique = cursor + unique_bytes;
    const auto lookahead = std::min<std::uintptr_t>(
        request.pattern.size() - 1, region_end - after_unique);
    const auto read_bytes = static_cast<std::size_t>(unique_bytes + lookahead);
    std::size_t copied = 0;
    if (!read_chunk(reinterpret_cast<const void*>(cursor), scan_buffer.get(), read_bytes,
                    copied) || copied != read_bytes) {
      result.code = kMemoryAccessDenied;
      return result;
    }

    if (read_bytes >= request.pattern.size()) {
      const auto last_offset = read_bytes - request.pattern.size();
      for (std::size_t offset = 0; offset <= last_offset; ++offset) {
        const auto match_address = cursor + offset;
        if (match_address >= after_unique) break;
        if (OverlapsRange(match_address, request.pattern.size(), request.pattern.data(),
                          request.pattern.size()) ||
            OverlapsRange(match_address, request.pattern.size(), request.mask.data(),
                          request.mask.size()) ||
            OverlapsMatchContext(match_address, request.pattern.size(), result) ||
            !PatternMatches(scan_buffer.get() + offset, request)) {
          continue;
        }

        const auto context_start = offset > request.context_before
                                       ? offset - request.context_before
                                       : std::size_t{0};
        const auto after_start = offset + request.pattern.size();
        const auto context_end = request.context_after > read_bytes - after_start
                                     ? read_bytes
                                     : after_start + request.context_after;
        ScanMatch match;
        match.address = FormatAddress(match_address);
        match.region_base = FormatAddress(region_base);
        match.region_size = info.RegionSize;
        match.protection = info.Protect;
        match.context_address = FormatAddress(cursor + context_start);
        match.context.assign(scan_buffer.get() + context_start,
                             scan_buffer.get() + context_end);
        result.matches.push_back(std::move(match));

        if (result.matches.size() > request.max_matches) {
          result.code = "TOO_MANY_MATCHES";
          return result;
        }
      }
    }

    result.scanned_bytes += static_cast<std::size_t>(unique_bytes);
    cursor = after_unique;
    switch (detail::ClassifyScanPageBoundary(cursor, maximum,
                                             result.scanned_bytes)) {
      case detail::ScanPageBoundary::kComplete:
        result.complete = true;
        return result;
      case detail::ScanPageBoundary::kIncomplete:
        result.next_cursor = FormatAddress(cursor);
        return result;
      case detail::ScanPageBoundary::kContinue:
        break;
    }

    if (cursor == region_end && region_end > maximum) break;
  }

  result.complete = true;
  return result;
}

}  // namespace cfb27::memory
