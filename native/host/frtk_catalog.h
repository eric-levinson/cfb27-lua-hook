#pragma once

#include "frtk_discovery.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace cfb27::frtk {

struct TableHandle {
  std::uint32_t unique_id{};
  std::uint64_t generation{};
};

// Address-bearing descriptors remain host-internal. Public callers retain only
// TableHandle and receive CatalogSummary values.
struct CatalogDescriptor {
  std::uint32_t unique_id{};
  std::uint16_t session_table_id{};
  std::uintptr_t base_address{};
  std::uint32_t stride{};
  std::uint32_t capacity{};
  std::uintptr_t allocation_base{};
  std::size_t allocation_size{};
  std::string profile_id;
  std::uint64_t lifecycle_generation{};
  AuthorityStatus authority_status{AuthorityStatus::kDiscoveryOnly};
  std::vector<DiscoveryEvidence> evidence;
};

struct CatalogSummary {
  std::uint32_t unique_id{};
  std::uint32_t capacity{};
  std::string profile_id;
  std::uint64_t lifecycle_generation{};
  std::vector<DiscoveryEvidence> evidence;
};

struct CatalogEvidenceGuard {
  std::uintptr_t address{};
  std::vector<std::uint8_t> expected;
};

// Native-only authorization evidence. It is deliberately absent from public
// catalog summaries and protocol/Lua result types.
struct CatalogEvidenceSnapshot {
  std::uint64_t lifecycle_generation{};
  std::vector<std::uint32_t> active_unique_ids;
  std::vector<CatalogEvidenceGuard> guards;
};

class SessionCatalog {
 public:
  std::uint64_t Install(const ProfileBundle& profile,
                        const DiscoveryResult& discovery);
  [[nodiscard]] std::optional<TableHandle> GetHandle(
      std::uint32_t unique_id) const;
  [[nodiscard]] const CatalogDescriptor* Resolve(TableHandle handle) const;
  void Invalidate();
  void AdvanceLifecycle(bool game_ready);
  bool Revalidate(DiscoveryBackend& backend,
                  CatalogEvidenceSnapshot* snapshot = nullptr);
  [[nodiscard]] bool EvidenceIsActive(
      const CatalogEvidenceSnapshot& snapshot) const;
  [[nodiscard]] bool IsActiveReferenceTarget(
      std::uint16_t session_table_id, std::uint32_t row,
      std::uint64_t generation) const;
  [[nodiscard]] std::optional<std::uint32_t> ActiveUniqueId(
      std::uint16_t session_table_id, std::uint32_t row,
      std::uint64_t generation) const;
  [[nodiscard]] std::optional<std::uint16_t> ActiveTableId(
      std::uint32_t unique_id, std::uint32_t row,
      std::uint64_t generation) const;

  [[nodiscard]] std::vector<CatalogSummary> Summaries() const;
  [[nodiscard]] std::uint64_t generation() const { return generation_; }

 private:
  struct Entry {
    CatalogDescriptor descriptor;
    TableProfile profile;
  };

  void AdvanceGeneration();

  std::uint64_t generation_{};
  bool game_ready_{true};
  SchemaRegistry schema_;
  std::vector<Entry> entries_;
};

}  // namespace cfb27::frtk
