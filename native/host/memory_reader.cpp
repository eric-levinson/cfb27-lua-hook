#include "memory_reader.h"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cstring>
#include <limits>
#include <system_error>
#include <unordered_map>
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

void SaturatingIncrement(std::uint64_t& value) {
  if (value < kMaxSafeDiagnosticCounter) ++value;
}

void SaturatingAdd(std::uint64_t& target, std::uint64_t value) {
  target = value > kMaxSafeDiagnosticCounter - target
               ? kMaxSafeDiagnosticCounter
               : target + value;
}

bool IsMappedReadableStorage(const void* pointer) {
  MEMORY_BASIC_INFORMATION info{};
  return pointer != nullptr &&
         VirtualQuery(pointer, &info, sizeof(info)) == sizeof(info) &&
         info.State == MEM_COMMIT && info.Type == MEM_MAPPED &&
         IsReadableProtection(info.Protect);
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
                      match.context.size())) {
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

}  // namespace

std::size_t detail::MaskedPatternMatcher::selected_byte_count() const {
  return checks_.size();
}

std::size_t detail::MaskedPatternMatcher::anchor_offset() const {
  return checks_.empty() ? 0 : checks_.front().offset;
}

std::optional<std::size_t> detail::MaskedPatternMatcher::FindNext(
    std::span<const std::uint8_t> bytes, std::size_t first_candidate,
    std::size_t candidate_end, MatchStatistics* statistics) const {
  if (first_candidate >= candidate_end || pattern_size_ > bytes.size() ||
      candidate_end > bytes.size() - pattern_size_ + 1) {
    return std::nullopt;
  }
  if (checks_.empty()) return first_candidate;
  auto candidate = first_candidate;
  while (candidate < candidate_end) {
    const auto& anchor = checks_.front();
    if (anchor.mask == 0xFF) {
      const auto* begin = bytes.data() + candidate + anchor.offset;
      const auto count = candidate_end - candidate;
      const auto* found = static_cast<const std::uint8_t*>(
          std::memchr(begin, anchor.value, count));
      if (found == nullptr) return std::nullopt;
      candidate += static_cast<std::size_t>(found - begin);
    }
    if (statistics) ++statistics->candidates_checked;
    bool matches = true;
    for (const auto& check : checks_) {
      if (statistics) ++statistics->selected_byte_comparisons;
      if ((bytes[candidate + check.offset] & check.mask) != check.value) {
        matches = false;
        break;
      }
    }
    if (matches) return candidate;
    ++candidate;
  }
  return std::nullopt;
}

std::optional<detail::MaskedPatternMatcher> detail::CompileMaskedPattern(
    std::span<const std::uint8_t> pattern,
    std::span<const std::uint8_t> mask) {
  if (pattern.empty() || pattern.size() != mask.size()) return std::nullopt;
  MaskedPatternMatcher matcher;
  matcher.pattern_size_ = pattern.size();
  for (std::size_t offset = 0; offset < mask.size(); ++offset) {
    if (mask[offset] == 0) continue;
    matcher.checks_.push_back(
        {.offset = offset, .mask = mask[offset],
         .value = static_cast<std::uint8_t>(pattern[offset] & mask[offset])});
  }
  const auto full_anchor = std::find_if(
      matcher.checks_.begin(), matcher.checks_.end(),
      [](const auto& check) { return check.mask == 0xFF; });
  if (full_anchor != matcher.checks_.end()) {
    std::iter_swap(matcher.checks_.begin(), full_anchor);
  }
  return matcher;
}

MappedBytes::~MappedBytes() {
  if (view_ != nullptr) {
    SecureZeroMemory(view_, size_);
    UnmapViewOfFile(view_);
  }
  if (mapping_ != nullptr) CloseHandle(mapping_);
}

namespace {

SIZE_T ProductionQuery(const void* address, MEMORY_BASIC_INFORMATION* information,
                       SIZE_T length) {
  return VirtualQuery(address, information, length);
}

struct AllocationExtent {
  std::size_t size{};
  DWORD protection{};
};

std::optional<AllocationMetadata> ResolveAllocationMetadata(
    std::uintptr_t match_address, const MEMORY_BASIC_INFORMATION& match_info,
    std::uintptr_t maximum, ScanQueryFunction query,
    std::unordered_map<std::uintptr_t, AllocationExtent>& extents,
    const std::function<bool()>& should_cancel) {
  const auto allocation_base =
      reinterpret_cast<std::uintptr_t>(match_info.AllocationBase);
  if (allocation_base == 0 || match_address < allocation_base) return std::nullopt;

  auto cached = extents.find(allocation_base);
  if (cached == extents.end()) {
    auto cursor = allocation_base;
    std::size_t allocation_size = 0;
    DWORD allocation_protection = 0;
    bool first = true;
    while (cursor <= maximum) {
      if (should_cancel && should_cancel()) return std::nullopt;
      MEMORY_BASIC_INFORMATION info{};
      if (query(reinterpret_cast<const void*>(cursor), &info, sizeof(info)) !=
          sizeof(info)) {
        return std::nullopt;
      }
      const auto base = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
      const auto queried_allocation =
          reinterpret_cast<std::uintptr_t>(info.AllocationBase);
      if (queried_allocation != allocation_base) break;
      if (base != cursor || info.RegionSize == 0 ||
          AddOverflows(base, info.RegionSize) ||
          SizeAddOverflows(allocation_size, info.RegionSize)) {
        return std::nullopt;
      }
      if (first) {
        allocation_protection = info.AllocationProtect;
        first = false;
      }
      allocation_size += info.RegionSize;
      const auto next = base + info.RegionSize;
      if (next <= cursor) return std::nullopt;
      if (next > maximum) {
        const auto capped_size = maximum - allocation_base + 1;
        allocation_size = static_cast<std::size_t>(capped_size);
        cursor = next;
        break;
      }
      cursor = next;
    }
    if (first || allocation_size == 0) return std::nullopt;
    cached = extents.emplace(allocation_base,
                             AllocationExtent{allocation_size,
                                              allocation_protection}).first;
  }

  const auto offset_value = match_address - allocation_base;
  if (offset_value > std::numeric_limits<std::size_t>::max()) return std::nullopt;
  const auto offset = static_cast<std::size_t>(offset_value);
  if (offset >= cached->second.size) return std::nullopt;
  return AllocationMetadata{
      FormatAddress(allocation_base), cached->second.size,
      cached->second.protection, offset};
}

}  // namespace

MappedBytes::MappedBytes(MappedBytes&& other) noexcept
    : mapping_(std::exchange(other.mapping_, nullptr)),
      view_(std::exchange(other.view_, nullptr)),
      size_(std::exchange(other.size_, 0)) {}

MappedBytes& MappedBytes::operator=(MappedBytes&& other) noexcept {
  if (this == &other) return *this;
  if (view_ != nullptr) {
    SecureZeroMemory(view_, size_);
    UnmapViewOfFile(view_);
  }
  if (mapping_ != nullptr) CloseHandle(mapping_);
  mapping_ = std::exchange(other.mapping_, nullptr);
  view_ = std::exchange(other.view_, nullptr);
  size_ = std::exchange(other.size_, 0);
  return *this;
}

std::optional<MappedBytes> MappedBytes::Allocate(std::size_t size) {
  if (size == 0) return std::nullopt;
  const auto size64 = static_cast<std::uint64_t>(size);
  MappedBytes result;
  result.mapping_ = CreateFileMappingW(
      INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
      static_cast<DWORD>(size64 >> 32), static_cast<DWORD>(size64), nullptr);
  if (result.mapping_ == nullptr) return std::nullopt;
  result.view_ = static_cast<std::uint8_t*>(
      MapViewOfFile(result.mapping_, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, size));
  result.size_ = size;
  if (result.view_ == nullptr || !IsMappedReadableStorage(result.view_)) return std::nullopt;
  return result;
}

std::optional<MappedBytes> MappedBytes::FromUpperHex(std::string_view text) {
  if (text.empty() || text.size() % 2 != 0) return std::nullopt;
  auto decoded = Allocate(text.size() / 2);
  if (!decoded) return std::nullopt;
  auto nibble = [](char character) -> std::optional<std::uint8_t> {
    if (character >= '0' && character <= '9') {
      return static_cast<std::uint8_t>(character - '0');
    }
    if (character >= 'A' && character <= 'F') {
      return static_cast<std::uint8_t>(character - 'A' + 10);
    }
    return std::nullopt;
  };
  for (std::size_t index = 0; index < text.size(); index += 2) {
    const auto high = nibble(text[index]);
    const auto low = nibble(text[index + 1]);
    if (!high || !low) return std::nullopt;
    decoded->view_[index / 2] = static_cast<std::uint8_t>((*high << 4) | *low);
  }
  return decoded;
}

std::optional<MappedBytes> DecodeScanHex(std::string_view text) {
  if (text.size() > kMaxPatternBytes * 2) return std::nullopt;
  return MappedBytes::FromUpperHex(text);
}

std::optional<MappedBytes> MappedBytes::CopyFrom(
    std::span<const std::uint8_t> bytes) {
  auto copy = Allocate(bytes.size());
  if (!copy) return std::nullopt;
  std::copy(bytes.begin(), bytes.end(), copy->view_);
  return copy;
}

const std::uint8_t* MappedBytes::data() const { return view_; }
std::uint8_t* MappedBytes::data() { return view_; }
std::size_t MappedBytes::size() const { return size_; }
bool MappedBytes::empty() const { return size_ == 0; }
std::span<const std::uint8_t> MappedBytes::bytes() const { return {view_, size_}; }
std::span<std::uint8_t> MappedBytes::mutable_bytes() { return {view_, size_}; }

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

ScanResult ScanPrivateMemory(const ScanRequest& request, ScanReadFunction read,
                             ScanQueryFunction query) {
  ScanResult result;
  const auto minimum_pattern_bytes =
      request.purpose == ScanPurpose::kFrtkInternal ? kMinFrtkPatternBytes
                                                    : kMinPatternBytes;
  const auto matcher = detail::CompileMaskedPattern(request.pattern.bytes(),
                                                     request.mask.bytes());
  if (request.pattern.size() < minimum_pattern_bytes ||
      request.pattern.size() > kMaxPatternBytes ||
      request.mask.size() != request.pattern.size() || request.max_matches == 0 ||
      request.max_matches > kMaxMatches ||
      SizeAddOverflows(request.context_before, request.context_after) ||
      request.context_before + request.context_after > kMaxContextBytes ||
      !matcher) {
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
  auto scan_buffer = MappedBytes::Allocate(buffer_capacity);
  if (!scan_buffer) {
    result.code = kMemoryAccessDenied;
    return result;
  }
  const auto buffer_begin = reinterpret_cast<std::uintptr_t>(scan_buffer->data());
  const auto buffer_end = buffer_begin + buffer_capacity;
  const auto read_chunk = read != nullptr ? read : ProductionRead;
  const auto query_region = query != nullptr ? query : ProductionQuery;
  std::unordered_map<std::uintptr_t, AllocationExtent> allocation_extents;
  result.matches.reserve(request.max_matches + 1);

  while (cursor <= maximum) {
    if (request.should_cancel && request.should_cancel()) {
      result.matches.clear();
      result.code = "OPERATION_TIMEOUT";
      return result;
    }
    MEMORY_BASIC_INFORMATION info{};
    if (query_region(reinterpret_cast<const void*>(cursor), &info, sizeof(info)) != sizeof(info)) {
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
    if (request.should_cancel && request.should_cancel()) {
      result.matches.clear();
      result.code = "OPERATION_TIMEOUT";
      return result;
    }
    std::size_t copied = 0;
    if (!read_chunk(reinterpret_cast<const void*>(cursor), scan_buffer->data(), read_bytes,
                    copied) || copied != read_bytes) {
      result.code = kMemoryAccessDenied;
      return result;
    }
    SaturatingIncrement(result.chunks_scanned);
    SaturatingAdd(result.progress_scanned_bytes,
                  static_cast<std::uint64_t>(unique_bytes));

    if (read_bytes >= request.pattern.size()) {
      const auto last_offset = read_bytes - request.pattern.size();
      constexpr std::size_t kCancellationCandidateWindow = 4096;
      std::size_t offset = 0;
      while (offset <= last_offset) {
        if (request.should_cancel && request.should_cancel()) {
          result.matches.clear();
          result.code = "OPERATION_TIMEOUT";
          return result;
        }
        const auto candidate_end = std::min(
            last_offset + 1, offset + kCancellationCandidateWindow);
        SaturatingIncrement(result.candidate_windows);
        const auto found = matcher->FindNext(scan_buffer->bytes(), offset,
                                             candidate_end);
        if (!found) {
          offset = candidate_end;
          continue;
        }
        offset = *found;
        const auto match_address = cursor + offset;
        if (match_address >= after_unique) break;
        if (OverlapsRange(match_address, request.pattern.size(), request.pattern.data(),
                          request.pattern.size()) ||
            OverlapsRange(match_address, request.pattern.size(), request.mask.data(),
                          request.mask.size()) ||
            OverlapsMatchContext(match_address, request.pattern.size(), result)) {
          ++offset;
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
        auto context = MappedBytes::CopyFrom(std::span<const std::uint8_t>(
            scan_buffer->data() + context_start, context_end - context_start));
        if (!context) {
          result.code = kMemoryAccessDenied;
          return result;
        }
        match.context = std::move(*context);
        if (request.include_allocation_metadata) {
          match.allocation = ResolveAllocationMetadata(
              match_address, info, maximum, query_region, allocation_extents,
              request.should_cancel);
          if (!match.allocation) {
            result.matches.clear();
            result.code = request.should_cancel && request.should_cancel()
                              ? "OPERATION_TIMEOUT"
                              : kMemoryAccessDenied;
            return result;
          }
        }
        result.matches.push_back(std::move(match));

        if (result.matches.size() > request.max_matches) {
          result.code = "TOO_MANY_MATCHES";
          return result;
        }
        ++offset;
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
