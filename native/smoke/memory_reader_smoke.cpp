#include "../host/memory_reader.h"

#include <windows.h>

#include <cstdint>
#include <cstring>
#include <algorithm>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using cfb27::memory::FormatAddress;
using cfb27::memory::ReadMemoryBatch;
using cfb27::memory::ScanPrivateMemory;

std::uintptr_t g_fail_read_at{};
std::uintptr_t g_scan_destination{};
bool g_attempted_scan_buffer_read{};

bool TestRead(const void* source, void* destination, std::size_t length,
              std::size_t& copied) {
  copied = 0;
  const auto begin = reinterpret_cast<std::uintptr_t>(source);
  if (g_scan_destination == 0) {
    g_scan_destination = reinterpret_cast<std::uintptr_t>(destination);
  } else if (g_scan_destination >= begin && g_scan_destination - begin < length) {
    g_attempted_scan_buffer_read = true;
  }
  if (g_fail_read_at >= begin && g_fail_read_at - begin < length) return false;
  std::memcpy(destination, source, length);
  copied = length;
  return true;
}

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<std::uint8_t> HexBytes(const std::string& text) {
  Require(text.size() % 2 == 0, "even hex byte text");
  std::vector<std::uint8_t> bytes;
  bytes.reserve(text.size() / 2);
  for (std::size_t i = 0; i < text.size(); i += 2) {
    bytes.push_back(static_cast<std::uint8_t>(std::stoul(text.substr(i, 2), nullptr, 16)));
  }
  return bytes;
}

class Allocation {
 public:
  Allocation(std::size_t size, DWORD protection = PAGE_READWRITE)
      : address_(VirtualAlloc(nullptr, size, MEM_RESERVE | MEM_COMMIT, protection)) {
    Require(address_ != nullptr, "VirtualAlloc");
  }

  ~Allocation() {
    if (address_) VirtualFree(address_, 0, MEM_RELEASE);
  }

  Allocation(const Allocation&) = delete;
  Allocation& operator=(const Allocation&) = delete;

  void* get() const { return address_; }

 private:
  void* address_{};
};

void TestAddressParsing() {
  const auto value = reinterpret_cast<std::uintptr_t>(&TestAddressParsing);
  const auto formatted = FormatAddress(value);
  Require(cfb27::memory::ParseAddress(formatted) == value, "address round trip");
  Require(!cfb27::memory::ParseAddress("0xnot-hex"), "invalid hex address");
  Require(!cfb27::memory::ParseAddress("0x10000000000000000"), "overflowing hex address");
}

void TestRegionEligibility() {
  MEMORY_BASIC_INFORMATION info{};
  info.State = MEM_COMMIT;
  info.Type = MEM_PRIVATE;
  info.Protect = PAGE_READWRITE;
  info.RegionSize = 4096;
  Require(cfb27::memory::IsEligiblePrivateReadableRegion(info), "private readable region");

  info.Protect = PAGE_NOACCESS;
  Require(!cfb27::memory::IsEligiblePrivateReadableRegion(info), "PAGE_NOACCESS rejection");
  info.Protect = PAGE_READWRITE;
  info.Type = MEM_IMAGE;
  Require(!cfb27::memory::IsEligiblePrivateReadableRegion(info), "MEM_IMAGE rejection");
}

void TestScanAndRead() {
  constexpr std::size_t kAllocationSize = 64 * 1024;
  Allocation allocation(kAllocationSize);
  auto sentinel = HexBytes("CFB27A1100A1B2C3D4E5F60718293A4B");
  auto other = HexBytes("CFB27A220102030405060708090A0B0C");
  std::memcpy(static_cast<std::uint8_t*>(allocation.get()) + 128, sentinel.data(), sentinel.size());
  std::memcpy(static_cast<std::uint8_t*>(allocation.get()) + 4096, other.data(), other.size());
  SecureZeroMemory(sentinel.data(), sentinel.size());
  sentinel.clear();
  sentinel.shrink_to_fit();
  other.clear();
  other.shrink_to_fit();

  const auto scan = ScanPrivateMemory({
      .pattern = HexBytes("CFB27A1100A1B2C3D4E5F60718293A4B"),
      .mask = std::vector<std::uint8_t>(16, 0xFF),
      .max_matches = 2,
      .context_before = 4,
      .context_after = 4,
  });
  Require(scan.complete && scan.matches.size() == 1, "unique private match");
  Require(scan.matches[0].context.size() == 24, "bounded context");

  sentinel = HexBytes("CFB27A1100A1B2C3D4E5F60718293A4B");
  const auto read = ReadMemoryBatch({
      {FormatAddress(reinterpret_cast<std::uintptr_t>(allocation.get()) + 128), 16},
  });
  Require(read.ok && read.ranges.size() == 1 && read.ranges[0].bytes == sentinel,
          "batch read");

  const auto short_pattern = ScanPrivateMemory({
      .pattern = std::vector<std::uint8_t>(7, 0x11),
      .mask = std::vector<std::uint8_t>(7, 0xFF),
      .max_matches = 1,
  });
  Require(!short_pattern.complete, "7-byte pattern rejection");

  const auto excessive_matches = ScanPrivateMemory({
      .pattern = std::vector<std::uint8_t>(8, 0x11),
      .mask = std::vector<std::uint8_t>(8, 0xFF),
      .max_matches = 65,
  });
  Require(!excessive_matches.complete, "65 requested matches rejection");
}

void TestScanExcludesMaskBuffer() {
  cfb27::memory::ScanRequest request{
      .pattern = std::vector<std::uint8_t>(4096, 0xFF),
      .mask = std::vector<std::uint8_t>(4096, 0xFF),
      .max_matches = 2,
  };
  const auto mask_begin = reinterpret_cast<std::uintptr_t>(request.mask.data());
  const auto mask_end = mask_begin + request.mask.size();

  g_scan_destination = 0;
  g_attempted_scan_buffer_read = false;
  const auto scan = ScanPrivateMemory(request, TestRead);
  Require(scan.complete, "mask buffer exclusion scan completes");
  Require(!g_attempted_scan_buffer_read, "dedicated scan buffer excluded from traversal");
  for (const auto& match : scan.matches) {
    const auto address = cfb27::memory::ParseAddress(match.address);
    Require(address && (*address < mask_begin || *address >= mask_end),
            "scan returned request mask buffer");
  }
}

std::size_t CountAddress(const std::vector<cfb27::memory::ScanMatch>& matches,
                         const void* address) {
  const auto expected = reinterpret_cast<std::uintptr_t>(address);
  return static_cast<std::size_t>(std::count_if(
      matches.begin(), matches.end(), [expected](const auto& match) {
        return cfb27::memory::ParseAddress(match.address) == expected;
      }));
}

void TestPagedLargeRegionAndBoundaries() {
  constexpr std::size_t kLargeBytes = 80ull * 1024 * 1024;
  Allocation large(kLargeBytes);
  auto* bytes = static_cast<std::uint8_t*>(large.get());
  const auto sentinel = HexBytes("92F4C76B19A35DE804286ACE13579BDF");
  const std::vector<std::uint8_t> mask(sentinel.size(), 0xFF);
  const auto chunk_boundary = cfb27::memory::kScanChunkBytes - 4;
  const auto page_boundary = cfb27::memory::kMaxScanPageBytes - 4;
  const auto old_tail = (64ull * 1024 * 1024) + 128;
  std::memcpy(bytes + chunk_boundary, sentinel.data(), sentinel.size());
  std::memcpy(bytes + page_boundary, sentinel.data(), sentinel.size());
  std::memcpy(bytes + old_tail, sentinel.data(), sentinel.size());

  cfb27::memory::ScanRequest request{
      .pattern = sentinel,
      .mask = mask,
      .max_matches = 8,
      .context_before = 4,
      .context_after = 4,
      .cursor = FormatAddress(reinterpret_cast<std::uintptr_t>(bytes)),
  };
  std::vector<cfb27::memory::ScanMatch> matches;
  std::set<std::string> cursors;
  bool completed = false;
  for (std::size_t pages = 0; pages < 4096; ++pages) {
    const auto input_cursor = cfb27::memory::ParseAddress(*request.cursor);
    Require(input_cursor.has_value(), "page input cursor is valid");
    const auto result = ScanPrivateMemory(request);
    Require(result.code.empty(), "large-region page succeeds");
    Require(result.scanned_bytes <= cfb27::memory::kMaxScanPageBytes,
            "scan page is bounded");
    matches.insert(matches.end(), result.matches.begin(), result.matches.end());
    if (result.complete) {
      Require(!result.next_cursor.has_value(), "complete page has no cursor");
      completed = true;
      break;
    }
    Require(result.next_cursor.has_value(), "partial page has cursor");
    const auto next_cursor = cfb27::memory::ParseAddress(*result.next_cursor);
    Require(next_cursor && *next_cursor > *input_cursor,
            "every partial page advances beyond its input cursor");
    Require(cursors.insert(*result.next_cursor).second,
            "partial page cursor is never repeated");
    request.cursor = result.next_cursor;
  }
  Require(completed, "paged scan terminates");
  Require(CountAddress(matches, bytes + chunk_boundary) == 1,
          "chunk-boundary match found once");
  Require(CountAddress(matches, bytes + page_boundary) == 1,
          "page-boundary match found once");
  Require(CountAddress(matches, bytes + old_tail) == 1,
          "large-region tail found once");

  request.cursor = FormatAddress(reinterpret_cast<std::uintptr_t>(bytes));
  g_scan_destination = 0;
  g_attempted_scan_buffer_read = false;
  g_fail_read_at = reinterpret_cast<std::uintptr_t>(bytes);
  const auto failed = ScanPrivateMemory(request, TestRead);
  Require(failed.code == "MEMORY_ACCESS_DENIED", "eligible read failure is explicit");
  Require(!failed.complete, "failed read is never complete");
  Require(!failed.next_cursor.has_value(), "failed read cannot advance cursor");
  g_fail_read_at = 0;
}

void TestInvalidPageCursors() {
  SYSTEM_INFO system_info{};
  GetSystemInfo(&system_info);
  const auto maximum =
      reinterpret_cast<std::uintptr_t>(system_info.lpMaximumApplicationAddress);
  const auto above_maximum = FormatAddress(maximum + 1);
  const auto result = ScanPrivateMemory({
      .pattern = HexBytes("A1B2C3D4E5F60718"),
      .mask = std::vector<std::uint8_t>(8, 0xFF),
      .max_matches = 1,
      .cursor = above_maximum,
  });
  Require(!result.complete && result.code == "INVALID_REQUEST",
          "cursor above system maximum rejected");

  const auto overflowing = ScanPrivateMemory({
      .pattern = HexBytes("A1B2C3D4E5F60718"),
      .mask = std::vector<std::uint8_t>(8, 0xFF),
      .max_matches = 1,
      .cursor = "0x10000000000000000",
  });
  Require(!overflowing.complete && overflowing.code == "INVALID_REQUEST",
          "overflowing cursor rejected");

  const auto canonical = FormatAddress(maximum - 0xA);
  auto lowercase_digit = canonical;
  std::transform(lowercase_digit.begin() + 2, lowercase_digit.end(),
                 lowercase_digit.begin() + 2, [](unsigned char character) {
                   return static_cast<char>(std::tolower(character));
                 });
  const std::vector<std::string> noncanonical{
      canonical.substr(2),
      "0x0" + canonical.substr(2),
      lowercase_digit,
      "0X" + canonical.substr(2),
  };
  for (const auto& cursor : noncanonical) {
    const auto rejected = ScanPrivateMemory({
        .pattern = HexBytes("A1B2C3D4E5F60718"),
        .mask = std::vector<std::uint8_t>(8, 0xFF),
        .max_matches = 1,
        .cursor = cursor,
    });
    Require(!rejected.complete && rejected.code == "INVALID_REQUEST",
            "noncanonical cursor rejected");
  }
}

void TestTerminalCompletionPrecedesPageBudget() {
  using cfb27::memory::detail::ClassifyScanPageBoundary;
  using cfb27::memory::detail::ScanPageBoundary;

  Require(ClassifyScanPageBoundary(0x2000, 0x1FFF,
                                   cfb27::memory::kMaxScanPageBytes) ==
              ScanPageBoundary::kComplete,
          "terminal completion wins when page budget is reached exactly");
  Require(ClassifyScanPageBoundary(0x1FFF, 0x1FFF,
                                   cfb27::memory::kMaxScanPageBytes) ==
              ScanPageBoundary::kIncomplete,
          "exhausted budget remains incomplete before terminal traversal");
}

void TestDeniedReads() {
  SYSTEM_INFO system_info{};
  GetSystemInfo(&system_info);
  const auto page_size = static_cast<std::size_t>(system_info.dwPageSize);
  void* reserved = VirtualAlloc(nullptr, page_size * 2, MEM_RESERVE, PAGE_NOACCESS);
  Require(reserved != nullptr, "reserve cross-region pages");
  Require(VirtualAlloc(reserved, page_size, MEM_COMMIT, PAGE_READWRITE) == reserved,
          "commit readable page");
  Require(VirtualAlloc(static_cast<std::uint8_t*>(reserved) + page_size, page_size,
                       MEM_COMMIT, PAGE_NOACCESS) != nullptr,
          "commit noaccess page");

  const auto cross_region = ReadMemoryBatch({
      {FormatAddress(reinterpret_cast<std::uintptr_t>(reserved) + page_size - 8), 16},
  });
  Require(!cross_region.ok && cross_region.code == "MEMORY_ACCESS_DENIED" &&
              cross_region.ranges.empty(),
          "cross-region read rejection");

  const auto noaccess = ReadMemoryBatch({
      {FormatAddress(reinterpret_cast<std::uintptr_t>(reserved) + page_size), 1},
  });
  Require(!noaccess.ok && noaccess.code == "MEMORY_ACCESS_DENIED" &&
              noaccess.ranges.empty(),
          "PAGE_NOACCESS read rejection");
  VirtualFree(reserved, 0, MEM_RELEASE);

  const auto invalid = ReadMemoryBatch({{"0xnot-hex", 1}});
  Require(!invalid.ok && invalid.ranges.empty(), "invalid batch address rejection");
  const auto overflowing = ReadMemoryBatch({{"0xfffffffffffffff8", 16}});
  Require(!overflowing.ok && overflowing.ranges.empty(), "overflowing batch address rejection");
}

void TestPagedScanBeyondOldAggregateLimit() {
  constexpr std::size_t kRegionSize = 64ull * 1024 * 1024;
  std::vector<void*> regions;
  regions.reserve(9);
  for (int i = 0; i < 9; ++i) {
    void* region = VirtualAlloc(nullptr, kRegionSize, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    Require(region != nullptr, "allocate aggregate scan region");
    regions.push_back(region);
  }
  std::sort(regions.begin(), regions.end(), [](const void* left, const void* right) {
    return reinterpret_cast<std::uintptr_t>(left) <
           reinterpret_cast<std::uintptr_t>(right);
  });

  auto sentinel = HexBytes("D13C579B2468ACE00123456789ABCDEF");
  constexpr std::size_t kTargetOffset = cfb27::memory::kMaxScanPageBytes + 1024;
  std::memcpy(static_cast<std::uint8_t*>(regions.back()) + kTargetOffset, sentinel.data(),
              sentinel.size());
  cfb27::memory::ScanRequest request{
      .pattern = sentinel,
      .mask = std::vector<std::uint8_t>(16, 0xFF),
      .max_matches = 1,
      .cursor = FormatAddress(reinterpret_cast<std::uintptr_t>(regions.front())),
  };
  SecureZeroMemory(sentinel.data(), sentinel.size());
  sentinel.clear();
  sentinel.shrink_to_fit();
  bool found = false;
  for (std::size_t page = 0; page < 4096; ++page) {
    const auto result = ScanPrivateMemory(request);
    Require(result.code.empty(), "aggregate continuation succeeds");
    Require(result.scanned_bytes <= cfb27::memory::kMaxScanPageBytes,
            "aggregate continuation page bounded");
    if (CountAddress(result.matches,
                     static_cast<std::uint8_t*>(regions.back()) + kTargetOffset) == 1) {
      found = true;
      break;
    }
    if (result.complete) break;
    Require(result.next_cursor.has_value(), "aggregate continuation cursor");
    request.cursor = result.next_cursor;
  }
  Require(found, "target after 512 MiB is reachable");

  for (void* region : regions) VirtualFree(region, 0, MEM_RELEASE);
}

}  // namespace

int main() {
  try {
    TestAddressParsing();
    TestRegionEligibility();
    TestScanAndRead();
    TestScanExcludesMaskBuffer();
    TestPagedLargeRegionAndBoundaries();
    TestInvalidPageCursors();
    TestTerminalCompletionPrecedesPageBudget();
    TestDeniedReads();
    TestPagedScanBeyondOldAggregateLimit();
    std::cout << "memory reader smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "memory reader smoke failed: " << error.what() << '\n';
    return 1;
  }
}
