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
constexpr std::size_t kMaximumDescriptorBlobBytes = 64ull * 1024 * 1024;
constexpr std::size_t kMaximumReadRangeBytes = 64ull * 1024;
constexpr std::size_t kMaximumBatchBytes = 256ull * 1024;
constexpr std::uint32_t kPlayerUniqueId = 1612938518u;
constexpr std::uint32_t kRecruitUniqueId = 1873209313u;
constexpr std::uint32_t kProspectTargetSchoolUniqueId = 3789266353u;

struct Candidate {
  TableDescriptor descriptor;
};

struct IndexedArrayLayout {
  std::uint16_t target_table_id{};
  std::uint32_t width{};
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

std::uint32_t ReadLittleEndian(std::span<const std::uint8_t> bytes) {
  std::uint32_t value{};
  for (std::size_t index = 0;
       index < bytes.size() && index < sizeof(value); ++index) {
    value |= static_cast<std::uint32_t>(bytes[index]) << (index * 8);
  }
  return value;
}

void SaturatingAdd(std::uint64_t& target, std::uint64_t value) {
  target = value > kMaxSafeDiagnosticCounter - target
               ? kMaxSafeDiagnosticCounter
               : target + value;
}

void AddCounters(DiscoveryCounters& target, const DiscoveryCounters& value) {
  SaturatingAdd(target.pages_scanned, value.pages_scanned);
  SaturatingAdd(target.chunks_scanned, value.chunks_scanned);
  SaturatingAdd(target.scanned_bytes, value.scanned_bytes);
  SaturatingAdd(target.candidate_windows, value.candidate_windows);
  const auto match_cap = static_cast<std::uint64_t>(kMaxFingerprintMatches);
  target.capped_matches =
      target.capped_matches >= match_cap ||
              value.capped_matches >= match_cap - target.capped_matches
          ? match_cap
          : target.capped_matches + value.capped_matches;
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

std::optional<std::uintptr_t> ReadLittleEndianPointer(
    std::span<const std::uint8_t> bytes) {
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

bool ReadContiguous(DiscoveryBackend& backend, std::uintptr_t address,
                    std::size_t length, const DiscoveryDeadline& deadline,
                    std::vector<std::uint8_t>& output) {
  output.clear();
  output.reserve(length);
  std::size_t completed{};
  while (completed < length) {
    if (deadline.Expired()) return false;
    std::vector<ReadRequest> requests;
    std::size_t batch_bytes{};
    while (completed + batch_bytes < length &&
           batch_bytes < kMaximumBatchBytes) {
      const auto request_length = (std::min)(
          kMaximumReadRangeBytes,
          length - completed - batch_bytes);
      requests.push_back({address + completed + batch_bytes, request_length});
      batch_bytes += request_length;
    }
    std::vector<std::vector<std::uint8_t>> bytes;
    if (!backend.ReadBatch(requests, bytes) || bytes.size() != requests.size()) {
      return false;
    }
    for (std::size_t index = 0; index < bytes.size(); ++index) {
      if (bytes[index].size() != requests[index].length) return false;
      output.insert(output.end(), bytes[index].begin(), bytes[index].end());
    }
    completed += batch_bytes;
  }
  return output.size() == length;
}

std::vector<std::size_t> FindMaskedOffsets(
    const std::vector<std::uint8_t>& bytes,
    const RowFingerprint& fingerprint) {
  std::vector<std::size_t> offsets;
  if (fingerprint.pattern.empty() ||
      fingerprint.pattern.size() != fingerprint.mask.size() ||
      fingerprint.pattern.size() > bytes.size()) {
    return offsets;
  }
  for (std::size_t offset = 0;
       offset + fingerprint.pattern.size() <= bytes.size(); ++offset) {
    bool match = true;
    for (std::size_t index = 0; index < fingerprint.pattern.size(); ++index) {
      if ((bytes[offset + index] & fingerprint.mask[index]) !=
          (fingerprint.pattern[index] & fingerprint.mask[index])) {
        match = false;
        break;
      }
    }
    if (match) offsets.push_back(offset);
    if (offsets.size() == kMaxFingerprintMatches) break;
  }
  return offsets;
}

TableDiscovery DiscoverWordSwappedDescriptor(
    const TableProfile& table, const ScanObservationResult& scan,
    DiscoveryBackend& backend, const DiscoveryDeadline& deadline) {
  TableDiscovery result{.unique_id = table.unique_id};
  if (!scan.complete) {
    Reject(result, TableState::kMissing, "DESCRIPTOR_SCAN_INCOMPLETE");
    return result;
  }
  std::map<std::uintptr_t, TableDescriptor> candidates;
  bool unstable{};
  bool allocation_invalid{};
  for (const auto& match : scan.matches) {
    const std::size_t end_pointer_offset =
        table.unique_id == kPlayerUniqueId ? 28 : 36;
    if (deadline.Expired() ||
        AddOverflows(match.address,
                     end_pointer_offset + sizeof(std::uint64_t))) {
      break;
    }
    const std::array pointer_requests{
        ReadRequest{match.address + 12, sizeof(std::uint64_t)},
        ReadRequest{match.address + end_pointer_offset,
                    sizeof(std::uint64_t)}};
    std::vector<std::vector<std::uint8_t>> pointer_bytes;
    if (!backend.ReadBatch(pointer_requests, pointer_bytes) ||
        pointer_bytes.size() != pointer_requests.size()) {
      unstable = true;
      continue;
    }
    const auto blob_start = ReadLittleEndianPointer(pointer_bytes[0]);
    const auto blob_end = ReadLittleEndianPointer(pointer_bytes[1]);
    if (!blob_start || !blob_end || *blob_end <= *blob_start) {
      allocation_invalid = true;
      continue;
    }
    const auto blob_size = *blob_end - *blob_start;
    if (blob_size > kMaximumDescriptorBlobBytes ||
        MultiplyOverflows(table.capacity, table.record_size) ||
        table.capacity * table.record_size > blob_size ||
        !backend.AllocationExists(*blob_start, blob_size, deadline)) {
      allocation_invalid = true;
      continue;
    }
    std::vector<std::uint8_t> blob;
    if (!ReadContiguous(backend, *blob_start, blob_size, deadline, blob)) {
      unstable = true;
      continue;
    }
    std::vector<RowFingerprint> live_rows;
    live_rows.reserve(table.rows.size());
    for (const auto& row : table.rows) live_rows.push_back(LiveFingerprint(row));
    const auto first_offsets = FindMaskedOffsets(blob, live_rows.front());
    for (const auto first_offset : first_offsets) {
      const auto first_row_offset =
          static_cast<std::size_t>(table.rows.front().row_index) *
          table.record_size;
      if (first_offset < first_row_offset) continue;
      const auto base_offset = first_offset - first_row_offset;
      const auto extent = static_cast<std::size_t>(table.capacity) *
                          table.record_size;
      if (base_offset > blob.size() || extent > blob.size() - base_offset) {
        continue;
      }
      bool consistent = true;
      for (std::size_t index = 0; index < table.rows.size(); ++index) {
        const auto offset = base_offset +
            static_cast<std::size_t>(table.rows[index].row_index) *
                table.record_size;
        std::vector<std::uint8_t> record(
            blob.begin() + offset,
            blob.begin() + offset + live_rows[index].pattern.size());
        if (!MaskedMatches(live_rows[index], record)) {
          consistent = false;
          break;
        }
      }
      if (!consistent) continue;
      const auto base = *blob_start + base_offset;
      std::vector<ReadRequest> rereads;
      for (const auto& row : table.rows) {
        rereads.push_back({base + static_cast<std::size_t>(row.row_index) *
                                      table.record_size,
                           row.pattern.size()});
      }
      std::vector<std::vector<std::uint8_t>> reread_bytes;
      bool stable = backend.ReadBatch(rereads, reread_bytes) &&
                    reread_bytes.size() == live_rows.size();
      for (std::size_t index = 0; stable && index < live_rows.size(); ++index) {
        stable = MaskedMatches(live_rows[index], reread_bytes[index]);
      }
      if (!stable) {
        unstable = true;
        continue;
      }
      candidates.emplace(
          base, TableDescriptor{.unique_id = table.unique_id,
                                .base = base,
                                .stride = table.record_size,
                                .capacity = table.capacity,
                                .allocation_base = *blob_start,
                                .allocation_size = blob_size,
                                .storage = TableStorage::kWordSwappedRecords,
                                .direct_write_verified =
                                    table.unique_id == kRecruitUniqueId ||
                                    table.unique_id ==
                                        kProspectTargetSchoolUniqueId});
    }
  }
  if (candidates.size() == 1) {
    result.state = TableState::kResolved;
    result.descriptor = candidates.begin()->second;
    result.evidence.push_back({.code = "LIVE_DESCRIPTOR_LAYOUT_STABLE",
                               .fingerprint_count = table.rows.size()});
  } else if (candidates.size() > 1) {
    Reject(result, TableState::kAmbiguous, "MULTIPLE_LIVE_DESCRIPTORS");
  } else if (unstable) {
    Reject(result, TableState::kUnstable, "LIVE_DESCRIPTOR_REREAD_CHANGED");
  } else if (allocation_invalid) {
    Reject(result, TableState::kAllocationInvalid,
           "LIVE_DESCRIPTOR_EXTENT_INVALID");
  } else {
    Reject(result, TableState::kMissing, "LIVE_DESCRIPTOR_NOT_FOUND");
  }
  return result;
}

std::optional<IndexedArrayLayout> DetectIndexedArray(
    const ProfileBundle& profile, const TableProfile& table) {
  const auto* schema = profile.schema.FindTable(table.table_id);
  if (!schema || schema->fields.empty() ||
      schema->record_size != schema->fields.size() * 4) {
    return std::nullopt;
  }
  std::optional<std::uint16_t> target;
  std::set<std::uint32_t> ordinals;
  for (const auto& field : schema->fields) {
    if (field.encoding != "packed-reference" || field.storage_bytes != 4 ||
        field.bit_offset != 0 || field.bit_width != 32 ||
        !field.reference_table_id || field.byte_offset % 4 != 0) {
      return std::nullopt;
    }
    const auto ordinal = field.byte_offset / 4;
    if (ordinal >= schema->fields.size() || !ordinals.insert(ordinal).second) {
      return std::nullopt;
    }
    if (!target) target = field.reference_table_id;
    if (*target != *field.reference_table_id) return std::nullopt;
  }
  for (const auto& relationship : table.relationships) {
    const auto* field =
        profile.schema.FindField(table.table_id, relationship.field_name);
    if (!field || relationship.target_table_id != *target ||
        relationship.target_row !=
            relationship.source_row * schema->fields.size() +
                field->byte_offset / 4) {
      return std::nullopt;
    }
  }
  return IndexedArrayLayout{*target,
                            static_cast<std::uint32_t>(schema->fields.size())};
}

bool DescriptorCandidateHasValidExtent(
    const TableProfile& table,
    const std::optional<IndexedArrayLayout>& indexed,
    const ScanObservation& observation, DiscoveryBackend& backend,
    const DiscoveryDeadline& deadline) {
  const std::size_t start_offset = indexed ? 20 : 12;
  const std::size_t end_offset =
      indexed ? 28 : table.unique_id == kPlayerUniqueId ? 28 : 36;
  if (AddOverflows(observation.address,
                   end_offset + sizeof(std::uint64_t))) {
    return false;
  }
  const std::array requests{
      ReadRequest{observation.address + start_offset, sizeof(std::uint64_t)},
      ReadRequest{observation.address + end_offset, sizeof(std::uint64_t)}};
  std::vector<std::vector<std::uint8_t>> bytes;
  if (!backend.ReadBatch(requests, bytes) || bytes.size() != requests.size()) {
    return false;
  }
  const auto start = ReadLittleEndianPointer(bytes[0]);
  const auto end = ReadLittleEndianPointer(bytes[1]);
  if (!start || !end || *end <= *start) return false;
  const auto extent = *end - *start;
  if (indexed) {
    if (MultiplyOverflows(table.capacity, sizeof(std::uint64_t)) ||
        extent != table.capacity * sizeof(std::uint64_t)) {
      return false;
    }
  } else {
    if (MultiplyOverflows(table.capacity, table.record_size) ||
        extent > kMaximumDescriptorBlobBytes ||
        table.capacity * table.record_size > extent) {
      return false;
    }
  }
  return backend.AllocationExists(*start, extent, deadline);
}

TableDiscovery DiscoverIndexedDescriptor(
    const TableProfile& table, const IndexedArrayLayout& layout,
    const ScanObservationResult& scan, DiscoveryBackend& backend,
    const DiscoveryDeadline& deadline) {
  TableDiscovery result{.unique_id = table.unique_id};
  if (!scan.complete) {
    Reject(result, TableState::kMissing, "DESCRIPTOR_SCAN_INCOMPLETE");
    return result;
  }
  std::map<std::uintptr_t, TableDescriptor> candidates;
  bool unstable{};
  bool allocation_invalid{};
  for (const auto& match : scan.matches) {
    if (deadline.Expired() || AddOverflows(match.address, 36)) break;
    const std::array pointer_requests{
        ReadRequest{match.address + 20, sizeof(std::uint64_t)},
        ReadRequest{match.address + 28, sizeof(std::uint64_t)}};
    std::vector<std::vector<std::uint8_t>> pointer_bytes;
    if (!backend.ReadBatch(pointer_requests, pointer_bytes) ||
        pointer_bytes.size() != pointer_requests.size()) {
      unstable = true;
      continue;
    }
    const auto slots_start = ReadLittleEndianPointer(pointer_bytes[0]);
    const auto slots_end = ReadLittleEndianPointer(pointer_bytes[1]);
    if (!slots_start || !slots_end || *slots_end <= *slots_start ||
        MultiplyOverflows(table.capacity, sizeof(std::uint64_t)) ||
        *slots_end - *slots_start !=
            table.capacity * sizeof(std::uint64_t) ||
        !backend.AllocationExists(*slots_start, *slots_end - *slots_start,
                                  deadline)) {
      allocation_invalid = true;
      continue;
    }
    std::vector<ReadRequest> slot_requests;
    for (const auto& row : table.rows) {
      if (row.row_index >= table.capacity) {
        slot_requests.clear();
        break;
      }
      slot_requests.push_back(
          {*slots_start + row.row_index * sizeof(std::uint64_t),
           sizeof(std::uint64_t)});
    }
    std::vector<std::vector<std::uint8_t>> slots_first;
    std::vector<std::vector<std::uint8_t>> slots_second;
    if (slot_requests.size() != table.rows.size() ||
        !backend.ReadBatch(slot_requests, slots_first) ||
        !backend.ReadBatch(slot_requests, slots_second) ||
        slots_first != slots_second ||
        slots_first.size() != table.rows.size()) {
      unstable = true;
      continue;
    }
    std::vector<ReadRequest> wrapper_requests;
    for (const auto& slot : slots_first) {
      const auto wrapper = ReadLittleEndianPointer(slot);
      if (!wrapper || AddOverflows(*wrapper, 28)) {
        wrapper_requests.clear();
        break;
      }
      wrapper_requests.push_back({*wrapper, 28});
    }
    std::vector<std::vector<std::uint8_t>> wrappers_first;
    std::vector<std::vector<std::uint8_t>> wrappers_second;
    if (wrapper_requests.size() != table.rows.size() ||
        !backend.ReadBatch(wrapper_requests, wrappers_first) ||
        !backend.ReadBatch(wrapper_requests, wrappers_second) ||
        wrappers_first != wrappers_second ||
        wrappers_first.size() != table.rows.size()) {
      unstable = true;
      continue;
    }
    bool valid = true;
    std::optional<std::uintptr_t> wrapper_type;
    for (std::size_t index = 0; index < wrappers_first.size(); ++index) {
      if (wrappers_first[index].size() != 28) {
        valid = false;
        break;
      }
      const auto type = ReadLittleEndianPointer(std::span(
          wrappers_first[index].data(), sizeof(std::uint64_t)));
      const auto wrapper_row = ReadLittleEndian(std::span(
          wrappers_first[index].data() + 24, sizeof(std::uint32_t)));
      if (!type || (wrapper_type && *wrapper_type != *type) ||
          wrapper_row != table.rows[index].row_index) {
        valid = false;
        break;
      }
      wrapper_type = type;
    }
    if (!valid) {
      unstable = true;
      continue;
    }
    candidates.emplace(
        *slots_start,
        TableDescriptor{.unique_id = table.unique_id,
                        .base = *slots_start,
                        .stride = sizeof(std::uint64_t),
                        .capacity = table.capacity,
                        .allocation_base = *slots_start,
                        .allocation_size = *slots_end - *slots_start,
                        .storage = TableStorage::kIndexedReferenceArray,
                        .virtual_target_table_id = layout.target_table_id,
                        .virtual_width = layout.width});
  }
  if (candidates.size() == 1) {
    result.state = TableState::kResolved;
    result.descriptor = candidates.begin()->second;
    result.evidence.push_back({.code = "LIVE_INDEXED_ARRAY_STABLE",
                               .fingerprint_count = table.rows.size()});
  } else if (candidates.size() > 1) {
    Reject(result, TableState::kAmbiguous, "MULTIPLE_LIVE_DESCRIPTORS");
  } else if (unstable) {
    Reject(result, TableState::kUnstable, "LIVE_ARRAY_REREAD_CHANGED");
  } else if (allocation_invalid) {
    Reject(result, TableState::kAllocationInvalid,
           "LIVE_ARRAY_EXTENT_INVALID");
  } else {
    Reject(result, TableState::kMissing, "LIVE_DESCRIPTOR_NOT_FOUND");
  }
  return result;
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
  const auto started = std::chrono::steady_clock::now();
  DiscoveryCounters counters;
  std::uint64_t completed_fingerprints{};
  const auto timed_out = [&](DiscoveryStage stage,
                             std::optional<std::uint32_t> table_unique_id,
                             std::optional<std::size_t> fingerprint_ordinal) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
    return DiscoveryResult{
        .valid = false,
        .code = "OPERATION_TIMEOUT",
        .timeout = DiscoveryTimeoutDetails{
            .stage = stage,
            .table_unique_id = table_unique_id,
            .fingerprint_ordinal = fingerprint_ordinal,
            .completed_fingerprint_count = completed_fingerprints,
            .elapsed_milliseconds = static_cast<std::uint64_t>((std::min)(
                static_cast<std::uint64_t>((std::max)(elapsed, 0ll)),
                kMaxSafeDiagnosticCounter)),
            .counters = counters}};
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
    const auto& profile_table = profile.tables[table_index];
    if (deadline.Expired()) {
      return timed_out(DiscoveryStage::kScan, profile_table.unique_id,
                       profile_table.rows.empty()
                           ? std::nullopt
                           : std::optional<std::size_t>(0));
    }
    auto& discovered = result.tables[table_index];
    if (profile_table.rows.size() < 3 || profile_table.record_size == 0) {
      Reject(discovered, TableState::kMissing, "INSUFFICIENT_FINGERPRINTS");
      continue;
    }

    const auto indexed = DetectIndexedArray(profile, profile_table);
    const auto descriptor_scan = backend.ScanTableDescriptor(
        profile_table.table_id, profile_table.unique_id,
        kMaxFingerprintMatches,
        [&](const ScanObservation& observation) {
          return DescriptorCandidateHasValidExtent(
              profile_table, indexed, observation, backend, deadline);
        },
        deadline);
    if (descriptor_scan.code != "DESCRIPTOR_SCAN_UNSUPPORTED") {
      AddCounters(counters, descriptor_scan.counters);
      if (descriptor_scan.code == "OPERATION_TIMEOUT" || deadline.Expired()) {
        return timed_out(DiscoveryStage::kScan, profile_table.unique_id,
                         std::nullopt);
      }
      discovered = indexed
                       ? DiscoverIndexedDescriptor(profile_table, *indexed,
                                                   descriptor_scan, backend,
                                                   deadline)
                       : DiscoverWordSwappedDescriptor(
                             profile_table, descriptor_scan, backend, deadline);
      if (deadline.Expired()) {
        return timed_out(DiscoveryStage::kReread, profile_table.unique_id,
                         std::nullopt);
      }
      continue;
    }

    std::vector<ScanObservationResult> scans;
    scans.reserve(profile_table.rows.size());
    bool scan_incomplete = false;
    for (std::size_t fingerprint_index = 0;
         fingerprint_index < profile_table.rows.size(); ++fingerprint_index) {
      const auto& fingerprint = profile_table.rows[fingerprint_index];
      if (deadline.Expired())
        return timed_out(DiscoveryStage::kScan, profile_table.unique_id,
                         fingerprint_index);
      const FingerprintKey key{fingerprint.pattern, fingerprint.mask};
      auto [cached, inserted] = scan_cache.try_emplace(key);
      if (inserted) {
        cached->second = backend.Scan(fingerprint, kMaxFingerprintMatches,
                                      deadline);
        AddCounters(counters, cached->second.counters);
      }
      if (cached->second.code == "OPERATION_TIMEOUT" || deadline.Expired()) {
        return timed_out(DiscoveryStage::kScan, profile_table.unique_id,
                         fingerprint_index);
      }
      scans.push_back(cached->second);
      scan_incomplete = scan_incomplete || !scans.back().complete;
      SaturatingAdd(completed_fingerprints, 1);
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
            if (deadline.Expired())
              return timed_out(DiscoveryStage::kAllocation,
                               profile_table.unique_id, std::nullopt);
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
                const bool extent_valid =
                    !AddOverflows(base, extent) &&
                    base >= ma.allocation_base &&
                    ma.allocation_size <=
                        std::numeric_limits<std::uintptr_t>::max() -
                            ma.allocation_base &&
                    base + extent <= ma.allocation_base + ma.allocation_size;
                const bool allocation_exists =
                    extent_valid && backend.AllocationExists(base, extent, deadline);
                if (deadline.Expired())
                  return timed_out(DiscoveryStage::kAllocation,
                                   profile_table.unique_id, std::nullopt);
                if (!allocation_exists) {
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
      if (deadline.Expired())
        return timed_out(DiscoveryStage::kReread, profile_table.unique_id,
                         std::nullopt);
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
    const auto& source_profile = profile.tables[source_index];
    if (deadline.Expired())
      return timed_out(DiscoveryStage::kRelationship,
                       source_profile.unique_id, std::nullopt);
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
      if (source.descriptor->storage ==
          TableStorage::kIndexedReferenceArray) {
        const auto ordinal = field->byte_offset / 4;
        const bool mapped = source.descriptor->virtual_target_table_id ==
                                relationship.target_table_id &&
                            ordinal < source.descriptor->virtual_width &&
                            relationship.target_row ==
                                relationship.source_row *
                                        source.descriptor->virtual_width +
                                    ordinal;
        if (!mapped) {
          Reject(source, TableState::kRelationshipFailed,
                 "RELATIONSHIP_REFERENCE_MISMATCH");
          break;
        }
        source.evidence.push_back({.code = "RELATIONSHIP_VALIDATED"});
        continue;
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
      const auto encoded =
          source.descriptor->storage == TableStorage::kWordSwappedRecords
              ? ReadLittleEndian(bytes[0])
              : ReadBigEndian(bytes[0]);
      const auto decoded = DecodePackedReference(encoded);
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
