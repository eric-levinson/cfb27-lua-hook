#include "../host/memory_reader.h"

#include <windows.h>

#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using cfb27::memory::FormatAddress;
using cfb27::memory::ReadMemoryBatch;
using cfb27::memory::ScanPrivateMemory;

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

void TestAggregateScanLimit() {
  constexpr std::size_t kRegionSize = 64ull * 1024 * 1024;
  std::vector<void*> regions;
  regions.reserve(9);
  for (int i = 0; i < 9; ++i) {
    void* region = VirtualAlloc(nullptr, kRegionSize, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    Require(region != nullptr, "allocate aggregate scan region");
    regions.push_back(region);
  }

  const auto result = ScanPrivateMemory({
      .pattern = HexBytes("D13C579B2468ACE00123456789ABCDEF"),
      .mask = std::vector<std::uint8_t>(16, 0xFF),
      .max_matches = 1,
  });
  Require(!result.complete && result.code == "SCAN_LIMIT_EXCEEDED" &&
              result.scanned_bytes <= cfb27::memory::kMaxScanBytes,
          "aggregate scan limit");

  for (void* region : regions) VirtualFree(region, 0, MEM_RELEASE);
}

}  // namespace

int main() {
  try {
    TestAddressParsing();
    TestRegionEligibility();
    TestScanAndRead();
    TestDeniedReads();
    TestAggregateScanLimit();
    std::cout << "memory reader smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "memory reader smoke failed: " << error.what() << '\n';
    return 1;
  }
}
