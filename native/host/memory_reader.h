#pragma once

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace cfb27::memory {

constexpr std::size_t kMinPatternBytes = 8;
constexpr std::size_t kMaxPatternBytes = 4096;
constexpr std::size_t kMaxMatches = 64;
constexpr std::size_t kMaxContextBytes = 512;
constexpr std::size_t kMaxRegionBytes = 64ull * 1024 * 1024;
constexpr std::size_t kMaxScanBytes = 512ull * 1024 * 1024;
constexpr std::size_t kMaxReadRanges = 64;
constexpr std::size_t kMaxReadRangeBytes = 64ull * 1024;
constexpr std::size_t kMaxReadBytes = 256ull * 1024;

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
  std::vector<std::uint8_t> pattern;
  std::vector<std::uint8_t> mask;
  std::size_t max_matches{};
  std::size_t context_before{};
  std::size_t context_after{};
};

struct ScanMatch {
  std::string address;
  std::string region_base;
  std::size_t region_size{};
  DWORD protection{};
  std::string context_address;
  std::vector<std::uint8_t> context;
};

struct ScanResult {
  bool complete{};
  std::string code;
  std::size_t scanned_bytes{};
  std::vector<ScanMatch> matches;
};

std::optional<std::uintptr_t> ParseAddress(std::string_view text);
std::string FormatAddress(std::uintptr_t address);
bool IsEligiblePrivateReadableRegion(const MEMORY_BASIC_INFORMATION& info);
BatchReadResult ReadMemoryBatch(const std::vector<ReadRange>& ranges);
ScanResult ScanPrivateMemory(const ScanRequest& request);

}  // namespace cfb27::memory
