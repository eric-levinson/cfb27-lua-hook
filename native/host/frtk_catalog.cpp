#include "frtk_catalog.h"

#include <algorithm>
#include <limits>
#include <set>

namespace cfb27::frtk {
namespace {

bool AddOverflows(std::uintptr_t left, std::size_t right) {
  return right > std::numeric_limits<std::uintptr_t>::max() - left;
}

bool MultiplyOverflows(std::size_t left, std::size_t right) {
  return left != 0 && right > std::numeric_limits<std::size_t>::max() / left;
}

bool MaskedMatches(const RowFingerprint& fingerprint,
                   const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() != fingerprint.pattern.size() ||
      fingerprint.mask.size() != fingerprint.pattern.size()) {
    return false;
  }
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    if ((bytes[index] & fingerprint.mask[index]) !=
        (fingerprint.pattern[index] & fingerprint.mask[index])) {
      return false;
    }
  }
  return true;
}

std::uint32_t ReadBigEndian(const std::vector<std::uint8_t>& bytes) {
  std::uint32_t value{};
  for (std::size_t index = 0; index < bytes.size() && index < 4; ++index) {
    value = (value << 8) | bytes[index];
  }
  return value;
}

constexpr std::size_t kMaximumBatchRanges = 64;
constexpr std::size_t kMaximumBatchBytes = 256 * 1024;

struct BoundedReadResult {
  bool requests_valid{true};
  std::vector<std::vector<std::uint8_t>> bytes;
  std::vector<bool> failed;
};

BoundedReadResult ReadBoundedBatches(
    DiscoveryBackend& backend, std::span<const ReadRequest> requests) {
  BoundedReadResult result;
  result.bytes.resize(requests.size());
  result.failed.resize(requests.size());
  for (const auto& request : requests) {
    if (request.length == 0 || request.length > kMaximumBatchBytes ||
        AddOverflows(request.address, request.length)) {
      result.requests_valid = false;
      return result;
    }
  }
  for (std::size_t begin = 0; begin < requests.size();) {
    std::size_t count{};
    std::size_t total_bytes{};
    while (begin + count < requests.size() && count < kMaximumBatchRanges) {
      const auto length = requests[begin + count].length;
      if (length > kMaximumBatchBytes - total_bytes) break;
      total_bytes += length;
      ++count;
    }
    std::vector<std::vector<std::uint8_t>> chunk;
    const auto bounded = requests.subspan(begin, count);
    bool valid = count != 0 && backend.ReadBatch(bounded, chunk) &&
                 chunk.size() == count;
    for (std::size_t index = 0; valid && index < count; ++index) {
      valid = chunk[index].size() == requests[begin + index].length;
    }
    for (std::size_t index = 0; index < count; ++index) {
      result.failed[begin + index] = !valid;
      if (valid) result.bytes[begin + index] = std::move(chunk[index]);
    }
    begin += count;
  }
  return result;
}

}  // namespace

void SessionCatalog::AdvanceGeneration() {
  ++generation_;
  if (generation_ == 0) ++generation_;
}

std::uint64_t SessionCatalog::Install(const ProfileBundle& profile,
                                      const DiscoveryResult& discovery) {
  AdvanceGeneration();
  entries_.clear();
  schema_ = profile.schema;
  game_ready_ = true;
  if (!discovery.valid) return generation_;

  for (const auto& table : profile.tables) {
    const auto* installed_schema = profile.schema.FindTable(table.table_id);
    if (!installed_schema || installed_schema->unique_id != table.unique_id ||
        installed_schema->capacity != table.capacity ||
        installed_schema->record_size != table.record_size) {
      continue;
    }
    const auto found = std::find_if(
        discovery.tables.begin(), discovery.tables.end(),
        [&](const TableDiscovery& candidate) {
          return candidate.unique_id == table.unique_id;
        });
    if (found == discovery.tables.end() ||
        found->state != TableState::kResolved || !found->descriptor) {
      continue;
    }
    const auto& discovered = *found->descriptor;
    if (discovered.unique_id != table.unique_id ||
        discovered.stride > std::numeric_limits<std::uint32_t>::max() ||
        discovered.capacity != table.capacity ||
        discovered.stride != table.record_size) {
      continue;
    }
    entries_.push_back({
        .descriptor = {.unique_id = table.unique_id,
                       .session_table_id = table.table_id,
                       .base_address = discovered.base,
                       .stride = static_cast<std::uint32_t>(discovered.stride),
                       .capacity = discovered.capacity,
                       .allocation_base = discovered.allocation_base,
                       .allocation_size = discovered.allocation_size,
                       .profile_id = profile.profile_id,
                       .lifecycle_generation = generation_,
                       .authority_status = installed_schema->authority_status,
                       .evidence = found->evidence},
        .profile = table});
  }
  return generation_;
}

std::optional<TableHandle> SessionCatalog::GetHandle(
    std::uint32_t unique_id) const {
  const auto found = std::find_if(entries_.begin(), entries_.end(),
                                  [unique_id](const Entry& entry) {
                                    return entry.descriptor.unique_id == unique_id;
                                  });
  if (found == entries_.end()) return std::nullopt;
  return TableHandle{unique_id, generation_};
}

const CatalogDescriptor* SessionCatalog::Resolve(TableHandle handle) const {
  if (handle.generation != generation_) return nullptr;
  const auto found = std::find_if(entries_.begin(), entries_.end(),
                                  [&](const Entry& entry) {
                                    return entry.descriptor.unique_id ==
                                               handle.unique_id &&
                                           entry.descriptor.lifecycle_generation ==
                                               generation_;
                                  });
  return found == entries_.end() ? nullptr : &found->descriptor;
}

void SessionCatalog::Invalidate() {
  AdvanceGeneration();
  entries_.clear();
}

void SessionCatalog::AdvanceLifecycle(bool game_ready) {
  if (!game_ready && game_ready_) {
    Invalidate();
    game_ready_ = false;
  } else if (game_ready) {
    game_ready_ = true;
  }
}

bool SessionCatalog::Revalidate(DiscoveryBackend& backend,
                                CatalogEvidenceSnapshot* snapshot) {
  if (snapshot) *snapshot = {};
  if (entries_.empty()) return false;

  enum class CheckKind { kSentinel, kRelationship };
  struct Check {
    CheckKind kind;
    std::uint32_t source_unique_id;
    const RowFingerprint* sentinel{};
    const RelationshipConstraint* relationship{};
  };

  std::set<std::uint32_t> quarantined;
  std::vector<ReadRequest> requests;
  std::vector<Check> checks;
  for (const auto& entry : entries_) {
    const auto& descriptor = entry.descriptor;
    if (!backend.AllocationExists(descriptor.allocation_base,
                                  descriptor.allocation_size)) {
      quarantined.insert(descriptor.unique_id);
      continue;
    }
    for (const auto& sentinel : entry.profile.rows) {
      if (sentinel.row_index >= descriptor.capacity ||
          MultiplyOverflows(sentinel.row_index, descriptor.stride)) {
        quarantined.insert(descriptor.unique_id);
        continue;
      }
      const auto offset =
          static_cast<std::size_t>(sentinel.row_index) * descriptor.stride;
      if (AddOverflows(descriptor.base_address, offset)) {
        quarantined.insert(descriptor.unique_id);
        continue;
      }
      requests.push_back({descriptor.base_address + offset,
                          sentinel.pattern.size()});
      checks.push_back({CheckKind::kSentinel, descriptor.unique_id, &sentinel});
    }
    for (const auto& relationship : entry.profile.relationships) {
      const auto* field = schema_.FindField(descriptor.session_table_id,
                                            relationship.field_name);
      const auto target = std::find_if(
          entries_.begin(), entries_.end(), [&](const Entry& candidate) {
            return candidate.descriptor.session_table_id ==
                   relationship.target_table_id;
          });
      if (!field || field->encoding != "packed-reference" ||
          relationship.source_row >= descriptor.capacity ||
          target == entries_.end() ||
          relationship.target_row >= target->descriptor.capacity ||
          MultiplyOverflows(relationship.source_row, descriptor.stride)) {
        quarantined.insert(descriptor.unique_id);
        continue;
      }
      const auto row_offset =
          static_cast<std::size_t>(relationship.source_row) * descriptor.stride;
      if (AddOverflows(descriptor.base_address, row_offset) ||
          AddOverflows(descriptor.base_address + row_offset,
                       field->byte_offset)) {
        quarantined.insert(descriptor.unique_id);
        continue;
      }
      requests.push_back({descriptor.base_address + row_offset +
                              field->byte_offset,
                          field->storage_bytes});
      checks.push_back(
          {CheckKind::kRelationship, descriptor.unique_id, nullptr,
           &relationship});
    }
  }

  const auto first = ReadBoundedBatches(backend, requests);
  const auto second = first.requests_valid
                          ? ReadBoundedBatches(backend, requests)
                          : BoundedReadResult{.requests_valid = false};
  if (!first.requests_valid || !second.requests_valid) {
    for (const auto& check : checks) quarantined.insert(check.source_unique_id);
  }
  for (std::size_t index = 0; index < checks.size() &&
                              first.requests_valid && second.requests_valid;
       ++index) {
    const auto& check = checks[index];
    if (first.failed[index] || second.failed[index] ||
        first.bytes[index] != second.bytes[index]) {
      quarantined.insert(check.source_unique_id);
      continue;
    }
    if (check.kind == CheckKind::kSentinel) {
      if (!MaskedMatches(*check.sentinel, first.bytes[index])) {
        quarantined.insert(check.source_unique_id);
      }
    } else {
      if (first.bytes[index].size() != 4) {
        quarantined.insert(check.source_unique_id);
        continue;
      }
      const auto decoded = DecodePackedReference(ReadBigEndian(first.bytes[index]));
      if (decoded.table_id != check.relationship->target_table_id ||
          decoded.row_index != check.relationship->target_row) {
        quarantined.insert(check.source_unique_id);
      }
    }
  }

  bool closure_changed = true;
  while (closure_changed) {
    closure_changed = false;
    for (const auto& entry : entries_) {
      if (quarantined.contains(entry.descriptor.unique_id)) continue;
      for (const auto& relationship : entry.profile.relationships) {
        const auto target = std::find_if(
            entries_.begin(), entries_.end(), [&](const Entry& candidate) {
              return candidate.descriptor.session_table_id ==
                     relationship.target_table_id;
            });
        if (target == entries_.end() ||
            quarantined.contains(target->descriptor.unique_id)) {
          quarantined.insert(entry.descriptor.unique_id);
          closure_changed = true;
          break;
        }
      }
    }
  }

  if (quarantined.empty()) {
    if (snapshot) {
      snapshot->lifecycle_generation = generation_;
      snapshot->active_unique_ids.reserve(entries_.size());
      for (const auto& entry : entries_) {
        snapshot->active_unique_ids.push_back(entry.descriptor.unique_id);
      }
      std::sort(snapshot->active_unique_ids.begin(),
                snapshot->active_unique_ids.end());
      snapshot->guards.reserve(requests.size());
      for (std::size_t index = 0; index < requests.size(); ++index) {
        snapshot->guards.push_back(
            {.address = requests[index].address,
             .expected = first.bytes[index]});
      }
    }
    return true;
  }
  AdvanceGeneration();
  std::erase_if(entries_, [&](const Entry& entry) {
    return quarantined.contains(entry.descriptor.unique_id);
  });
  for (auto& entry : entries_) {
    entry.descriptor.lifecycle_generation = generation_;
  }
  return false;
}

bool SessionCatalog::EvidenceIsActive(
    const CatalogEvidenceSnapshot& snapshot) const {
  if (snapshot.lifecycle_generation == 0 ||
      snapshot.lifecycle_generation != generation_ || entries_.empty()) {
    return false;
  }
  std::vector<std::uint32_t> active;
  active.reserve(entries_.size());
  for (const auto& entry : entries_) {
    if (entry.descriptor.lifecycle_generation != generation_) return false;
    active.push_back(entry.descriptor.unique_id);
  }
  std::sort(active.begin(), active.end());
  return active == snapshot.active_unique_ids;
}

bool SessionCatalog::IsActiveReferenceTarget(
    std::uint16_t session_table_id, std::uint32_t row,
    std::uint64_t generation) const {
  if (generation != generation_) return false;
  const auto target = std::find_if(
      entries_.begin(), entries_.end(), [&](const Entry& entry) {
        return entry.descriptor.session_table_id == session_table_id &&
               entry.descriptor.lifecycle_generation == generation_;
      });
  return target != entries_.end() && row < target->descriptor.capacity;
}

std::optional<std::uint32_t> SessionCatalog::ActiveUniqueId(
    std::uint16_t session_table_id, std::uint32_t row,
    std::uint64_t generation) const {
  if (generation != generation_) return std::nullopt;
  const auto found = std::find_if(entries_.begin(), entries_.end(),
                                  [&](const Entry& entry) {
    return entry.descriptor.session_table_id == session_table_id &&
           entry.descriptor.lifecycle_generation == generation_ &&
           row < entry.descriptor.capacity;
  });
  return found == entries_.end()
             ? std::nullopt
             : std::optional<std::uint32_t>(found->descriptor.unique_id);
}

std::optional<std::uint16_t> SessionCatalog::ActiveTableId(
    std::uint32_t unique_id, std::uint32_t row,
    std::uint64_t generation) const {
  if (generation != generation_) return std::nullopt;
  const auto found = std::find_if(entries_.begin(), entries_.end(),
                                  [&](const Entry& entry) {
    return entry.descriptor.unique_id == unique_id &&
           entry.descriptor.lifecycle_generation == generation_ &&
           row < entry.descriptor.capacity;
  });
  return found == entries_.end()
             ? std::nullopt
             : std::optional<std::uint16_t>(
                   found->descriptor.session_table_id);
}

std::vector<CatalogSummary> SessionCatalog::Summaries() const {
  std::vector<CatalogSummary> result;
  result.reserve(entries_.size());
  for (const auto& entry : entries_) {
    result.push_back({.unique_id = entry.descriptor.unique_id,
                      .capacity = entry.descriptor.capacity,
                      .profile_id = entry.descriptor.profile_id,
                      .lifecycle_generation =
                          entry.descriptor.lifecycle_generation,
                      .evidence = entry.descriptor.evidence});
  }
  return result;
}

}  // namespace cfb27::frtk
