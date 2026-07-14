#pragma once

#include "frtk_profile.h"

#include <cstddef>
#include <cstdint>
#include <chrono>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace cfb27::frtk {

class DiscoveryDeadline {
 public:
  DiscoveryDeadline() = default;
  explicit DiscoveryDeadline(std::chrono::steady_clock::time_point deadline)
      : deadline_(deadline) {}
  [[nodiscard]] bool Expired() const {
    return std::chrono::steady_clock::now() >= deadline_;
  }
  [[nodiscard]] std::chrono::steady_clock::time_point time_point() const {
    return deadline_;
  }

 private:
  std::chrono::steady_clock::time_point deadline_{
      std::chrono::steady_clock::time_point::max()};
};

struct ScanObservation {
  std::uintptr_t address{};
  std::uintptr_t allocation_base{};
  std::size_t allocation_size{};
};

struct ScanObservationResult {
  bool complete{};
  std::string code;
  std::vector<ScanObservation> matches;
  struct Counters {
    std::uint64_t pages_scanned{};
    std::uint64_t chunks_scanned{};
    std::uint64_t scanned_bytes{};
    std::uint64_t candidate_windows{};
    std::uint64_t capped_matches{};
  } counters;
};

using DescriptorMatchFilter =
    std::function<bool(const ScanObservation& observation)>;

using DiscoveryCounters = ScanObservationResult::Counters;
constexpr std::uint64_t kMaxSafeDiagnosticCounter = 9007199254740991ull;

enum class DiscoveryStage { kScan, kAllocation, kRelationship, kReread };

struct DiscoveryTimeoutDetails {
  DiscoveryStage stage{DiscoveryStage::kScan};
  std::optional<std::uint32_t> table_unique_id;
  std::optional<std::size_t> fingerprint_ordinal;
  std::uint64_t completed_fingerprint_count{};
  std::uint64_t elapsed_milliseconds{};
  DiscoveryCounters counters;
};

struct ReadRequest {
  std::uintptr_t address{};
  std::size_t length{};
};

class DiscoveryBackend {
 public:
  virtual ~DiscoveryBackend() = default;
  virtual ScanObservationResult ScanTableDescriptor(
      std::uint16_t, std::uint32_t, std::size_t,
      const DescriptorMatchFilter&,
      const DiscoveryDeadline&) {
    return {.complete = true, .code = "DESCRIPTOR_SCAN_UNSUPPORTED"};
  }
  virtual ScanObservationResult Scan(const RowFingerprint& fingerprint,
                                     std::size_t max_matches,
                                     const DiscoveryDeadline& deadline) = 0;
  virtual bool ReadBatch(
      std::span<const ReadRequest> requests,
      std::vector<std::vector<std::uint8_t>>& out) = 0;
  virtual bool AllocationExists(std::uintptr_t base, std::size_t size,
                                const DiscoveryDeadline& deadline = {}) = 0;
};

enum class TableState {
  kResolved,
  kMissing,
  kAmbiguous,
  kUnstable,
  kRelationshipFailed,
  kAllocationInvalid,
};

struct DiscoveryEvidence {
  std::string code;
  std::size_t fingerprint_count{};
};

enum class TableStorage {
  kCanonicalRecords,
  kWordSwappedRecords,
  kIndexedReferenceArray,
};

struct TableDescriptor {
  std::uint32_t unique_id{};
  std::uintptr_t base{};
  std::size_t stride{};
  std::uint32_t capacity{};
  std::uintptr_t allocation_base{};
  std::size_t allocation_size{};
  TableStorage storage{TableStorage::kCanonicalRecords};
  std::optional<std::uint16_t> virtual_target_table_id;
  std::uint32_t virtual_width{};
  bool direct_write_verified{};
};

struct TableDiscovery {
  std::uint32_t unique_id{};
  TableState state{TableState::kMissing};
  std::optional<TableDescriptor> descriptor;
  std::vector<DiscoveryEvidence> evidence;
};

struct DiscoveryResult {
  bool valid{true};
  std::string code;
  std::vector<TableDiscovery> tables;
  std::optional<DiscoveryTimeoutDetails> timeout;

  [[nodiscard]] const TableDiscovery* FindTableByUniqueId(
      std::uint32_t unique_id) const;
};

DiscoveryResult DiscoverTables(const ProfileBundle& profile,
                               DiscoveryBackend& backend,
                               const DiscoveryDeadline& deadline = {});

}  // namespace cfb27::frtk
