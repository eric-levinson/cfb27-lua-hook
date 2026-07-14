#pragma once

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace cfb27::memory {

class MappedBytes {
 public:
  MappedBytes() = default;
  ~MappedBytes();
  MappedBytes(MappedBytes&&) noexcept;
  MappedBytes& operator=(MappedBytes&&) noexcept;
  MappedBytes(const MappedBytes&) = delete;
  MappedBytes& operator=(const MappedBytes&) = delete;
  static std::optional<MappedBytes> Allocate(std::size_t size);
  static std::optional<MappedBytes> FromUpperHex(std::string_view text);
  static std::optional<MappedBytes> CopyFrom(std::span<const std::uint8_t> bytes);
  const std::uint8_t* data() const;
  std::uint8_t* data();
  std::size_t size() const;
  bool empty() const;
  std::span<const std::uint8_t> bytes() const;
  std::span<std::uint8_t> mutable_bytes();

 private:
  HANDLE mapping_{};
  std::uint8_t* view_{};
  std::size_t size_{};
};

constexpr std::size_t kMinPatternBytes = 8;
constexpr std::size_t kMinFrtkPatternBytes = 4;
constexpr std::size_t kMaxPatternBytes = 4096;
constexpr std::size_t kMaxMatches = 64;
constexpr std::size_t kMaxContextBytes = 512;
constexpr std::size_t kScanChunkBytes = 4ull * 1024 * 1024;
constexpr std::size_t kMaxScanPageBytes = 32ull * 1024 * 1024;
constexpr std::size_t kMaxReadRanges = 64;
constexpr std::size_t kMaxReadRangeBytes = 64ull * 1024;
constexpr std::size_t kMaxReadBytes = 256ull * 1024;
constexpr std::uint64_t kMaxSafeDiagnosticCounter = 9007199254740991ull;

std::optional<MappedBytes> DecodeScanHex(std::string_view text);

namespace detail {

struct MatchStatistics {
  std::size_t candidates_checked{};
  std::size_t selected_byte_comparisons{};
};

class MaskedPatternMatcher {
 public:
  struct Check {
    std::size_t offset{};
    std::uint8_t mask{};
    std::uint8_t value{};
  };

  [[nodiscard]] std::size_t selected_byte_count() const;
  [[nodiscard]] std::size_t anchor_offset() const;
  [[nodiscard]] std::optional<std::size_t> FindNext(
      std::span<const std::uint8_t> bytes, std::size_t first_candidate,
      std::size_t candidate_end, MatchStatistics* statistics = nullptr) const;

 private:
  friend std::optional<MaskedPatternMatcher> CompileMaskedPattern(
      std::span<const std::uint8_t>, std::span<const std::uint8_t>);
  std::size_t pattern_size_{};
  std::vector<Check> checks_;
};

std::optional<MaskedPatternMatcher> CompileMaskedPattern(
    std::span<const std::uint8_t> pattern,
    std::span<const std::uint8_t> mask);

enum class ScanPageBoundary {
  kContinue,
  kIncomplete,
  kComplete,
};

constexpr ScanPageBoundary ClassifyScanPageBoundary(
    std::uintptr_t cursor, std::uintptr_t maximum, std::size_t scanned_bytes) {
  if (cursor > maximum) return ScanPageBoundary::kComplete;
  if (scanned_bytes == kMaxScanPageBytes) return ScanPageBoundary::kIncomplete;
  return ScanPageBoundary::kContinue;
}

}  // namespace detail

enum class ScanPurpose {
  kPublicRaw,
  kFrtkInternal,
};

struct ReadRange {
  std::string address;
  std::size_t length{};
};

struct ReadResult {
  std::string address;
  std::vector<std::uint8_t> bytes;
};

struct BatchReadResult {
  bool ok{};
  std::string code;
  std::vector<ReadResult> ranges;
};

struct ScanRequest {
  MappedBytes pattern;
  MappedBytes mask;
  std::size_t max_matches{};
  std::size_t context_before{};
  std::size_t context_after{};
  std::optional<std::string> cursor;
  bool include_allocation_metadata{};
  ScanPurpose purpose{ScanPurpose::kPublicRaw};
  std::function<bool()> should_cancel;
};

using ScanReadFunction = bool (*)(const void* source, void* destination,
                                  std::size_t length, std::size_t& copied);
using ScanQueryFunction = SIZE_T (*)(const void* address,
                                     MEMORY_BASIC_INFORMATION* information,
                                     SIZE_T length);

struct AllocationMetadata {
  std::string base;
  std::size_t size{};
  DWORD protection{};
  std::size_t offset{};
};

struct ScanMatch {
  std::string address;
  std::string region_base;
  std::size_t region_size{};
  DWORD protection{};
  std::string context_address;
  MappedBytes context;
  std::optional<AllocationMetadata> allocation;
};

struct ScanResult {
  bool complete{};
  std::string code;
  std::size_t scanned_bytes{};
  std::uint64_t progress_scanned_bytes{};
  std::uint64_t chunks_scanned{};
  std::uint64_t candidate_windows{};
  std::optional<std::string> next_cursor;
  std::vector<ScanMatch> matches;
};

std::optional<std::uintptr_t> ParseAddress(std::string_view text);
std::string FormatAddress(std::uintptr_t address);
bool IsEligiblePrivateReadableRegion(const MEMORY_BASIC_INFORMATION& info);
BatchReadResult ReadMemoryBatch(const std::vector<ReadRange>& ranges);
ScanResult ScanPrivateMemory(const ScanRequest& request,
                             ScanReadFunction read = nullptr,
                             ScanQueryFunction query = nullptr);

}  // namespace cfb27::memory
