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

RowFingerprint LiveFingerprint(const RowFingerprint& canonical) {
  auto live = canonical;
  for (std::size_t start = 0; start < live.pattern.size(); start += 4) {
    const auto end = (std::min)(start + 4, live.pattern.size());
    std::reverse(live.pattern.begin() + start, live.pattern.begin() + end);
    std::reverse(live.mask.begin() + start, live.mask.begin() + end);
  }
  return live;
}

std::uint32_t ReadBigEndian(const std::vector<std::uint8_t>& bytes) {
  std::uint32_t value{};
  for (std::size_t index = 0; index < bytes.size() && index < 4; ++index) {
    value = (value << 8) | bytes[index];
  }
  return value;
}

std::uint32_t ReadLittleEndian(const std::vector<std::uint8_t>& bytes) {
  std::uint32_t value{};
  for (std::size_t index = 0; index < bytes.size() && index < 4; ++index) {
    value |= static_cast<std::uint32_t>(bytes[index]) << (index * 8);
  }
  return value;
}

std::optional<std::uintptr_t> ReadLittleEndianPointer(
    const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() != sizeof(std::uint64_t)) return std::nullopt;
  std::uint64_t value{};
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8);
  }
  if (value == 0 || value > std::numeric_limits<std::uintptr_t>::max()) {
    return std::nullopt;
  }
  return static_cast<std::uintptr_t>(value);
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
    const bool indexed =
        discovered.storage == TableStorage::kIndexedReferenceArray;
    const bool storage_valid =
        indexed
            ? discovered.stride == sizeof(std::uint64_t) &&
                  discovered.virtual_target_table_id.has_value() &&
                  discovered.virtual_width != 0 &&
                  table.record_size == discovered.virtual_width * 4
            : discovered.stride == table.record_size;
    if (discovered.unique_id != table.unique_id ||
        discovered.stride > std::numeric_limits<std::uint32_t>::max() ||
        discovered.capacity != table.capacity ||
        !storage_valid) {
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
                       .storage = discovered.storage,
                       .virtual_target_table_id =
                           discovered.virtual_target_table_id,
                       .virtual_width = discovered.virtual_width,
                       .profile_id = profile.profile_id,
                       .lifecycle_generation = generation_,
                       .authority_status = discovered.direct_write_verified
                                               ? AuthorityStatus::kDirectVerified
                                               : installed_schema->authority_status,
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
    TableStorage storage{TableStorage::kCanonicalRecords};
    const RowFingerprint* sentinel{};
    const RelationshipConstraint* relationship{};
  };

  std::set<std::uint32_t> quarantined;
  std::vector<ReadRequest> requests;
  std::vector<Check> checks;
  std::vector<CatalogEvidenceGuard> indexed_guards;
  for (const auto& entry : entries_) {
    const auto& descriptor = entry.descriptor;
    if (!backend.AllocationExists(descriptor.allocation_base,
                                  descriptor.allocation_size)) {
      quarantined.insert(descriptor.unique_id);
      continue;
    }
    if (descriptor.storage == TableStorage::kIndexedReferenceArray) {
      bool valid = descriptor.virtual_target_table_id.has_value() &&
                   descriptor.virtual_width != 0;
      for (const auto& relationship : entry.profile.relationships) {
        const auto* field = schema_.FindField(descriptor.session_table_id,
                                              relationship.field_name);
        valid = valid && field && field->byte_offset % 4 == 0 &&
                relationship.target_table_id ==
                    descriptor.virtual_target_table_id &&
                relationship.target_row ==
                    relationship.source_row * descriptor.virtual_width +
                        field->byte_offset / 4;
      }
      std::vector<ReadRequest> slot_requests;
      for (const auto& sentinel : entry.profile.rows) {
        if (sentinel.row_index >= descriptor.capacity ||
            AddOverflows(descriptor.base_address,
                         sentinel.row_index * descriptor.stride)) {
          valid = false;
          break;
        }
        slot_requests.push_back(
            {descriptor.base_address + sentinel.row_index * descriptor.stride,
             sizeof(std::uint64_t)});
      }
      const auto slots_first = valid
                                   ? ReadBoundedBatches(backend, slot_requests)
                                   : BoundedReadResult{.requests_valid = false};
      const auto slots_second = slots_first.requests_valid
                                    ? ReadBoundedBatches(backend, slot_requests)
                                    : BoundedReadResult{
                                          .requests_valid = false};
      valid = valid && slots_first.requests_valid &&
              slots_second.requests_valid &&
              slots_first.bytes == slots_second.bytes &&
              std::none_of(slots_first.failed.begin(), slots_first.failed.end(),
                           [](bool failed) { return failed; }) &&
              std::none_of(slots_second.failed.begin(), slots_second.failed.end(),
                           [](bool failed) { return failed; });
      std::vector<ReadRequest> wrapper_requests;
      if (valid) {
        for (const auto& slot : slots_first.bytes) {
          const auto wrapper = ReadLittleEndianPointer(slot);
          if (!wrapper || AddOverflows(*wrapper, 28)) {
            valid = false;
            break;
          }
          wrapper_requests.push_back({*wrapper, 28});
        }
      }
      const auto wrappers_first = valid
                                      ? ReadBoundedBatches(backend,
                                                           wrapper_requests)
                                      : BoundedReadResult{
                                            .requests_valid = false};
      const auto wrappers_second = wrappers_first.requests_valid
                                       ? ReadBoundedBatches(backend,
                                                            wrapper_requests)
                                       : BoundedReadResult{
                                             .requests_valid = false};
      valid = valid && wrappers_first.requests_valid &&
              wrappers_second.requests_valid &&
              wrappers_first.bytes == wrappers_second.bytes &&
              std::none_of(wrappers_first.failed.begin(),
                           wrappers_first.failed.end(),
                           [](bool failed) { return failed; }) &&
              std::none_of(wrappers_second.failed.begin(),
                           wrappers_second.failed.end(),
                           [](bool failed) { return failed; });
      std::optional<std::uint64_t> wrapper_type;
      for (std::size_t index = 0; valid && index < wrappers_first.bytes.size();
           ++index) {
        const auto& wrapper = wrappers_first.bytes[index];
        if (wrapper.size() != 28) {
          valid = false;
          break;
        }
        std::vector<std::uint8_t> type_bytes(wrapper.begin(),
                                             wrapper.begin() + 8);
        const auto type = ReadLittleEndianPointer(type_bytes);
        std::vector<std::uint8_t> row_bytes(wrapper.begin() + 24,
                                            wrapper.end());
        if (!type || (wrapper_type && *wrapper_type != *type) ||
            ReadLittleEndian(row_bytes) != entry.profile.rows[index].row_index) {
          valid = false;
          break;
        }
        wrapper_type = *type;
      }
      if (!valid) {
        quarantined.insert(descriptor.unique_id);
        continue;
      }
      for (std::size_t index = 0; index < slot_requests.size(); ++index) {
        indexed_guards.push_back(
            {.address = slot_requests[index].address,
             .expected = slots_first.bytes[index]});
      }
      for (std::size_t index = 0; index < wrapper_requests.size(); ++index) {
        indexed_guards.push_back(
            {.address = wrapper_requests[index].address,
             .expected = wrappers_first.bytes[index]});
      }
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
      checks.push_back({CheckKind::kSentinel, descriptor.unique_id,
                        descriptor.storage, &sentinel});
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
          {CheckKind::kRelationship, descriptor.unique_id, descriptor.storage,
           nullptr,
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
      const auto expected =
          check.storage == TableStorage::kWordSwappedRecords
              ? LiveFingerprint(*check.sentinel)
              : *check.sentinel;
      if (!MaskedMatches(expected, first.bytes[index])) {
        quarantined.insert(check.source_unique_id);
      }
    } else {
      if (first.bytes[index].size() != 4) {
        quarantined.insert(check.source_unique_id);
        continue;
      }
      const auto encoded =
          check.storage == TableStorage::kWordSwappedRecords
              ? ReadLittleEndian(first.bytes[index])
              : ReadBigEndian(first.bytes[index]);
      const auto decoded = DecodePackedReference(encoded);
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
      snapshot->guards.insert(snapshot->guards.end(), indexed_guards.begin(),
                              indexed_guards.end());
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
                      .authority_status =
                          entry.descriptor.authority_status,
                      .profile_id = entry.descriptor.profile_id,
                      .lifecycle_generation =
                          entry.descriptor.lifecycle_generation,
                      .evidence = entry.descriptor.evidence});
  }
  return result;
}

}  // namespace cfb27::frtk
