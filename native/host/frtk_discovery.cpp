#include "frtk_discovery.h"

#include <algorithm>
#include <array>
#include <limits>
#include <map>
#include <set>
#include <tuple>

namespace cfb27::frtk {
namespace {

constexpr std::size_t kMaxFingerprintMatches = 8;

struct Candidate {
  TableDescriptor descriptor;
};

bool AddOverflows(std::uintptr_t left, std::size_t right) {
  return right > std::numeric_limits<std::uintptr_t>::max() - left;
}

bool MultiplyOverflows(std::size_t left, std::size_t right) {
  return left != 0 && right > std::numeric_limits<std::size_t>::max() / left;
}

std::optional<std::size_t> PairStride(const RowFingerprint& first,
                                      const ScanObservation& first_match,
                                      const RowFingerprint& second,
                                      const ScanObservation& second_match) {
  if (second.row_index <= first.row_index ||
      second_match.address <= first_match.address) {
    return std::nullopt;
  }
  const auto row_delta = second.row_index - first.row_index;
  const auto address_delta = second_match.address - first_match.address;
  if (address_delta % row_delta != 0) return std::nullopt;
  const auto stride = address_delta / row_delta;
  if (stride == 0 || stride > std::numeric_limits<std::size_t>::max()) {
    return std::nullopt;
  }
  return static_cast<std::size_t>(stride);
}

bool MaskedMatches(const RowFingerprint& fingerprint,
                   const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() != fingerprint.pattern.size() ||
      fingerprint.mask.size() != fingerprint.pattern.size()) {
    return false;
  }
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    if ((bytes[i] & fingerprint.mask[i]) !=
        (fingerprint.pattern[i] & fingerprint.mask[i])) {
      return false;
    }
  }
  return true;
}

void Reject(TableDiscovery& table, TableState state, std::string code) {
  table.state = state;
  table.descriptor.reset();
  table.evidence.push_back({.code = std::move(code)});
}

std::uint32_t ReadBigEndian(std::span<const std::uint8_t> bytes) {
  std::uint32_t value{};
  for (std::size_t i = 0; i < bytes.size() && i < sizeof(value); ++i) {
    value = (value << 8) | bytes[i];
  }
  return value;
}

}  // namespace

const TableDiscovery* DiscoveryResult::FindTableByUniqueId(
    std::uint32_t unique_id) const {
  const auto found = std::find_if(
      tables.begin(), tables.end(), [unique_id](const TableDiscovery& table) {
        return table.unique_id == unique_id;
      });
  return found == tables.end() ? nullptr : &*found;
}

DiscoveryResult DiscoverTables(const ProfileBundle& profile,
                               DiscoveryBackend& backend,
                               const DiscoveryDeadline& deadline) {
  DiscoveryResult result;
  const auto timed_out = [] {
    return DiscoveryResult{.valid = false, .code = "OPERATION_TIMEOUT"};
  };
  std::set<std::uint32_t> unique_ids;
  std::set<std::uint16_t> table_ids;
  for (const auto& profile_table : profile.tables) {
    if (!unique_ids.insert(profile_table.unique_id).second) {
      result.valid = false;
      result.code = "DUPLICATE_UNIQUE_ID";
      result.tables.clear();
      return result;
    }
    if (!table_ids.insert(profile_table.table_id).second) {
      result.valid = false;
      result.code = "DUPLICATE_BUILD_TABLE_ID";
      result.tables.clear();
      return result;
    }
    result.tables.push_back({.unique_id = profile_table.unique_id});
  }

  using FingerprintKey =
      std::pair<std::vector<std::uint8_t>, std::vector<std::uint8_t>>;
  std::map<FingerprintKey, ScanObservationResult> scan_cache;

  for (std::size_t table_index = 0; table_index < profile.tables.size();
       ++table_index) {
    if (deadline.Expired()) return timed_out();
    const auto& profile_table = profile.tables[table_index];
    auto& discovered = result.tables[table_index];
    if (profile_table.rows.size() < 3 || profile_table.record_size == 0) {
      Reject(discovered, TableState::kMissing, "INSUFFICIENT_FINGERPRINTS");
      continue;
    }

    std::vector<ScanObservationResult> scans;
    scans.reserve(profile_table.rows.size());
    bool scan_incomplete = false;
    for (const auto& fingerprint : profile_table.rows) {
      if (deadline.Expired()) return timed_out();
      const FingerprintKey key{fingerprint.pattern, fingerprint.mask};
      auto [cached, inserted] = scan_cache.try_emplace(key);
      if (inserted) {
        cached->second = backend.Scan(fingerprint, kMaxFingerprintMatches,
                                      deadline);
      }
      if (cached->second.code == "OPERATION_TIMEOUT" || deadline.Expired()) {
        return timed_out();
      }
      scans.push_back(cached->second);
      scan_incomplete = scan_incomplete || !scans.back().complete;
    }
    if (scan_incomplete) {
      Reject(discovered, TableState::kMissing, "SCAN_INCOMPLETE");
      continue;
    }

    std::map<std::uintptr_t, Candidate> structural_candidates;
    bool allocation_invalid = false;
    for (std::size_t a = 0; a + 2 < profile_table.rows.size(); ++a) {
      for (std::size_t b = a + 1; b + 1 < profile_table.rows.size(); ++b) {
        for (std::size_t c = b + 1; c < profile_table.rows.size(); ++c) {
          for (const auto& ma : scans[a].matches) {
            if (deadline.Expired()) return timed_out();
            for (const auto& mb : scans[b].matches) {
              for (const auto& mc : scans[c].matches) {
                const auto ab = PairStride(profile_table.rows[a], ma,
                                           profile_table.rows[b], mb);
                const auto ac = PairStride(profile_table.rows[a], ma,
                                           profile_table.rows[c], mc);
                const auto bc = PairStride(profile_table.rows[b], mb,
                                           profile_table.rows[c], mc);
                if (!ab || !ac || !bc || *ab != *ac || *ab != *bc ||
                    *ab != profile_table.record_size) {
                  continue;
                }
                if (ma.allocation_base != mb.allocation_base ||
                    ma.allocation_base != mc.allocation_base ||
                    ma.allocation_size != mb.allocation_size ||
                    ma.allocation_size != mc.allocation_size) {
                  continue;
                }
                if (MultiplyOverflows(profile_table.rows[a].row_index, *ab)) {
                  allocation_invalid = true;
                  continue;
                }
                const auto first_offset =
                    static_cast<std::size_t>(profile_table.rows[a].row_index) *
                    *ab;
                if (ma.address < first_offset) {
                  allocation_invalid = true;
                  continue;
                }
                const auto base = ma.address - first_offset;
                if (MultiplyOverflows(profile_table.capacity, *ab)) {
                  allocation_invalid = true;
                  continue;
                }
                const auto extent =
                    static_cast<std::size_t>(profile_table.capacity) * *ab;
                if (AddOverflows(base, extent) ||
                    base < ma.allocation_base ||
                    ma.allocation_size >
                        std::numeric_limits<std::uintptr_t>::max() -
                            ma.allocation_base ||
                    base + extent > ma.allocation_base + ma.allocation_size ||
                    !backend.AllocationExists(base, extent, deadline)) {
                  allocation_invalid = true;
                  continue;
                }
                structural_candidates.emplace(
                    base,
                    Candidate{.descriptor = {
                                  .unique_id = profile_table.unique_id,
                                  .base = base,
                                  .stride = *ab,
                                  .capacity = profile_table.capacity,
                                  .allocation_base = ma.allocation_base,
                                  .allocation_size = ma.allocation_size}});
              }
            }
          }
        }
      }
    }

    std::vector<Candidate> stable_candidates;
    bool unstable = false;
    for (const auto& [base, candidate] : structural_candidates) {
      if (deadline.Expired()) return timed_out();
      std::vector<ReadRequest> requests;
      for (const auto& fingerprint : profile_table.rows) {
        if (MultiplyOverflows(fingerprint.row_index,
                              candidate.descriptor.stride) ||
            AddOverflows(base, fingerprint.row_index *
                                   candidate.descriptor.stride)) {
          requests.clear();
          break;
        }
        requests.push_back(
            {.address = base + fingerprint.row_index *
                                   candidate.descriptor.stride,
             .length = fingerprint.pattern.size()});
      }
      std::vector<std::vector<std::uint8_t>> bytes;
      bool stable = requests.size() == profile_table.rows.size() &&
                    backend.ReadBatch(requests, bytes) &&
                    bytes.size() == profile_table.rows.size();
      for (std::size_t i = 0; stable && i < bytes.size(); ++i) {
        stable = MaskedMatches(profile_table.rows[i], bytes[i]);
      }
      if (stable) {
        stable_candidates.push_back(candidate);
      } else {
        unstable = true;
      }
    }

    if (stable_candidates.size() == 1) {
      discovered.state = TableState::kResolved;
      discovered.descriptor = stable_candidates.front().descriptor;
      discovered.evidence.push_back(
          {.code = "THREE_ROW_LAYOUT_STABLE",
           .fingerprint_count = profile_table.rows.size()});
    } else if (stable_candidates.size() > 1) {
      Reject(discovered, TableState::kAmbiguous, "MULTIPLE_STABLE_LAYOUTS");
    } else if (unstable) {
      Reject(discovered, TableState::kUnstable, "FINGERPRINT_REREAD_CHANGED");
    } else if (allocation_invalid) {
      Reject(discovered, TableState::kAllocationInvalid,
             "TABLE_EXTENT_OUTSIDE_ALLOCATION");
    } else {
      Reject(discovered, TableState::kMissing, "NO_CONSISTENT_LAYOUT");
    }
  }

  // Relationships are deliberately a second phase: no relationship bytes are
  // read until all participating tables have independent structural results.
  std::vector<bool> independently_resolved;
  independently_resolved.reserve(result.tables.size());
  for (const auto& table : result.tables) {
    independently_resolved.push_back(table.state == TableState::kResolved);
  }
  for (std::size_t source_index = 0; source_index < profile.tables.size();
       ++source_index) {
    if (deadline.Expired()) return timed_out();
    const auto& source_profile = profile.tables[source_index];
    auto& source = result.tables[source_index];
    if (source.state != TableState::kResolved) continue;
    for (const auto& relationship : source_profile.relationships) {
      const auto target_profile = std::find_if(
          profile.tables.begin(), profile.tables.end(),
          [&](const TableProfile& table) {
            return table.table_id == relationship.target_table_id;
          });
      if (target_profile == profile.tables.end()) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_BUILD_TABLE_ID_UNKNOWN");
        break;
      }
      const auto target_index =
          static_cast<std::size_t>(target_profile - profile.tables.begin());
      const auto& target = result.tables[target_index];
      if (!independently_resolved[target_index]) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_TARGET_UNRESOLVED");
        break;
      }

      const auto* field = profile.schema.FindField(source_profile.table_id,
                                                    relationship.field_name);
      if (!field) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_FIELD_MISSING");
        break;
      }
      if (field->encoding != "packed-reference" ||
          field->storage_bytes != 4 || field->bit_offset != 0 ||
          field->bit_width != 32) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_FIELD_NOT_PACKED_REFERENCE");
        break;
      }
      if (!field->reference_table_id ||
          *field->reference_table_id != relationship.target_table_id) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_FIELD_TARGET_MISMATCH");
        break;
      }
      if (field->byte_offset > source_profile.record_size ||
          field->storage_bytes >
              source_profile.record_size - field->byte_offset ||
          relationship.source_row >= source_profile.capacity) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_FIELD_INVALID");
        break;
      }
      const auto address = source.descriptor->base +
                           relationship.source_row * source.descriptor->stride +
                           field->byte_offset;
      const std::array requests{
          ReadRequest{address, field->storage_bytes}};
      std::vector<std::vector<std::uint8_t>> bytes;
      if (!backend.ReadBatch(requests, bytes) || bytes.size() != 1 ||
          bytes[0].size() != field->storage_bytes) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_READ_FAILED");
        break;
      }
      const auto decoded = DecodePackedReference(ReadBigEndian(bytes[0]));
      if (decoded.table_id != relationship.target_table_id ||
          decoded.row_index != relationship.target_row ||
          target.unique_id != target_profile->unique_id) {
        Reject(source, TableState::kRelationshipFailed,
               "RELATIONSHIP_REFERENCE_MISMATCH");
        break;
      }
      source.evidence.push_back({.code = "RELATIONSHIP_VALIDATED"});
    }
  }
  return result;
}

}  // namespace cfb27::frtk
