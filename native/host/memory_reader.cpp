#include "memory_reader.h"

#include <algorithm>
#include <charconv>
#include <limits>
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

ScanResult ScanPrivateMemory(const ScanRequest& request) {
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
  auto cursor = reinterpret_cast<std::uintptr_t>(system_info.lpMinimumApplicationAddress);
  const auto maximum = reinterpret_cast<std::uintptr_t>(system_info.lpMaximumApplicationAddress);
  const auto page_size = static_cast<std::uintptr_t>(system_info.dwPageSize);
  std::vector<std::uint8_t> region_bytes;
  region_bytes.reserve(kMaxRegionBytes);
  result.matches.reserve(request.max_matches + 1);

  while (cursor <= maximum) {
    MEMORY_BASIC_INFORMATION info{};
    if (VirtualQuery(reinterpret_cast<const void*>(cursor), &info, sizeof(info)) != sizeof(info)) {
      if (maximum - cursor < page_size) break;
      cursor += page_size;
      continue;
    }

    const auto region_base = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
    std::uintptr_t next = maximum;
    bool last_region = true;
    if (!AddOverflows(region_base, info.RegionSize)) {
      next = region_base + info.RegionSize;
      last_region = next <= cursor || next > maximum;
    }

    if (IsEligiblePrivateReadableRegion(info)) {
      const auto scan_size = std::min(info.RegionSize, kMaxRegionBytes);
      if (scan_size > kMaxScanBytes - result.scanned_bytes) {
        result.code = "SCAN_LIMIT_EXCEEDED";
        return result;
      }

      region_bytes.resize(scan_size);
      SIZE_T copied = 0;
      if (ReadProcessMemory(GetCurrentProcess(), info.BaseAddress, region_bytes.data(), scan_size,
                            &copied) &&
          copied == scan_size) {
        result.scanned_bytes += scan_size;
        if (scan_size >= request.pattern.size()) {
          const auto last_offset = scan_size - request.pattern.size();
          for (std::size_t offset = 0; offset <= last_offset; ++offset) {
            const auto match_address = region_base + offset;
            if (OverlapsRange(match_address, request.pattern.size(), request.pattern.data(),
                              request.pattern.size()) ||
                OverlapsRange(match_address, request.pattern.size(), region_bytes.data(),
                              region_bytes.capacity()) ||
                OverlapsMatchContext(match_address, request.pattern.size(), result) ||
                !PatternMatches(region_bytes.data() + offset, request)) {
              continue;
            }

            const auto context_start = offset > request.context_before
                                           ? offset - request.context_before
                                           : std::size_t{0};
            const auto after_start = offset + request.pattern.size();
            const auto context_end = request.context_after > scan_size - after_start
                                         ? scan_size
                                         : after_start + request.context_after;
            ScanMatch match;
            match.address = FormatAddress(match_address);
            match.region_base = FormatAddress(region_base);
            match.region_size = info.RegionSize;
            match.protection = info.Protect;
            match.context_address = FormatAddress(region_base + context_start);
            match.context.assign(region_bytes.begin() + context_start,
                                 region_bytes.begin() + context_end);
            result.matches.push_back(std::move(match));

            if (result.matches.size() > request.max_matches) {
              result.code = "TOO_MANY_MATCHES";
              return result;
            }
          }
        }
      }
    }

    if (last_region) break;
    cursor = next;
  }

  result.complete = true;
  return result;
}

}  // namespace cfb27::memory
