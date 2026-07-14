#include "../host/frtk_discovery.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace cfb27::frtk;
using nlohmann::json;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<std::uint8_t> Record(std::uint16_t table_id,
                                 std::uint32_t row_index) {
  std::vector<std::uint8_t> bytes(8);
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    bytes[i] = static_cast<std::uint8_t>(table_id + row_index * 17 + i * 29);
  }
  return bytes;
}

std::vector<std::uint8_t> LiveWords(
    const std::vector<std::uint8_t>& canonical) {
  auto live = canonical;
  for (std::size_t start = 0; start < live.size(); start += 4) {
    const auto end = (std::min)(start + 4, live.size());
    std::reverse(live.begin() + start, live.begin() + end);
  }
  return live;
}

std::vector<std::uint8_t> LittleEndian32(std::uint32_t value) {
  return {static_cast<std::uint8_t>(value),
          static_cast<std::uint8_t>(value >> 8),
          static_cast<std::uint8_t>(value >> 16),
          static_cast<std::uint8_t>(value >> 24)};
}

std::vector<std::uint8_t> LittleEndianPointer(std::uintptr_t value) {
  std::vector<std::uint8_t> bytes(sizeof(value));
  std::memcpy(bytes.data(), &value, sizeof(value));
  return bytes;
}

TableProfile Table(std::string name, std::uint16_t id, std::uint32_t capacity) {
  TableProfile table{.logical_name = std::move(name),
                     .table_id = id,
                     .unique_id = static_cast<std::uint32_t>(id) * 100 + 7,
                     .capacity = capacity,
                     .record_size = 8};
  for (const auto row : {1u, 3u, 5u}) {
    table.rows.push_back({.row_index = row,
                          .pattern = Record(id, row),
                          .mask = std::vector<std::uint8_t>(8, 0xFF)});
  }
  return table;
}

TableProfile EvidenceTable(std::string name, std::uint16_t table_id,
                           std::uint32_t unique_id,
                           std::uint32_t record_size) {
  auto table = Table(std::move(name), table_id, 10);
  table.unique_id = unique_id;
  table.record_size = record_size;
  for (auto& row : table.rows) {
    row.pattern.resize(record_size,
                       static_cast<std::uint8_t>(row.row_index));
    row.mask.assign(record_size, 0xFF);
  }
  return table;
}

json Field(std::string name, std::string encoding, std::uint32_t offset,
           std::uint32_t storage, std::uint32_t width,
           std::optional<std::uint16_t> reference_table_id = std::nullopt) {
  return {{"name", std::move(name)},
          {"encoding", std::move(encoding)},
          {"byteOffset", offset},
          {"storageBytes", storage},
          {"bitOffset", 0},
          {"bitWidth", width},
          {"minimum", 0},
          {"maximum", width == 32 ? 0xFFFFFFFFull : 0xFFFFull},
          {"referenceTableId",
           reference_table_id ? json(*reference_table_id) : json(nullptr)}};
}

void LoadSchema(ProfileBundle& bundle) {
  json tables = json::array();
  for (const auto& table : bundle.tables) {
    json fields = json::array(
        {Field("SyntheticValue", "unsigned", 0, 2, 16)});
    for (const auto& relationship : table.relationships) {
      fields.push_back(Field(relationship.field_name, "packed-reference", 4,
                             4, 32, relationship.target_table_id));
    }
    tables.push_back({{"logicalName", table.logical_name},
                      {"tableId", table.table_id},
                      {"uniqueId", table.unique_id},
                      {"capacity", table.capacity},
                      {"recordSize", table.record_size},
                      {"authorityStatus", "discovery_only"},
                      {"fields", std::move(fields)}});
  }
  std::sort(tables.begin(), tables.end(), [](const json& left, const json& right) {
    return left.at("tableId").get<std::uint16_t>() <
           right.at("tableId").get<std::uint16_t>();
  });
  std::string error;
  const bool loaded = bundle.schema.Load(
      {{"formatVersion", 1},
       {"schemaIdentity", "synthetic-schema-v1"},
       {"buildIdentity", "synthetic-build-v1"},
       {"tables", std::move(tables)}},
      &error);
  if (!loaded) throw std::runtime_error(error);
}

FieldDefinition& MutableField(ProfileBundle& bundle, std::uint16_t table_id,
                              std::string_view field_name) {
  auto& tables =
      const_cast<std::vector<TableSchema>&>(bundle.schema.tables());
  for (auto& table : tables) {
    if (table.table_id != table_id) continue;
    for (auto& field : table.fields) {
      if (field.name == field_name) return field;
    }
  }
  throw std::runtime_error("fixture schema field missing");
}

ProfileBundle Bundle() {
  ProfileBundle bundle;
  bundle.tables = {Table("Player", 4244, 10), Table("RecruitingBoard", 4251, 10),
                   Table("Recruit", 4269, 10), Table("RecruitTarget", 4288, 10),
                   Table("ProspectTargetSchoolOverflow", 5841, 10)};
  bundle.tables[3].relationships.push_back(
      {.source_row = 3, .field_name = "RecruitRef", .target_table_id = 4269,
       .target_row = 5});
  bundle.tables[4].relationships.push_back(
      {.source_row = 3, .field_name = "OverflowRef", .target_table_id = 5841,
       .target_row = 5});
  LoadSchema(bundle);
  return bundle;
}

class FakeBackend final : public DiscoveryBackend {
 public:
  struct Allocation {
    std::uintptr_t base;
    std::vector<std::uint8_t> bytes;
  };

  void AddAllocation(std::uintptr_t base, std::size_t size) {
    allocations.push_back({base, std::vector<std::uint8_t>(size)});
  }

  void Put(std::uintptr_t address, const std::vector<std::uint8_t>& bytes) {
    auto* allocation = Find(address, bytes.size());
    Require(allocation != nullptr, "fixture write escaped allocation");
    std::copy(bytes.begin(), bytes.end(),
              allocation->bytes.begin() + (address - allocation->base));
  }

  void PutTable(const TableProfile& table, std::uintptr_t base,
                std::size_t allocation_size = 0) {
    AddAllocation(base, allocation_size ? allocation_size
                                        : table.capacity * table.record_size);
    for (const auto& row : table.rows) {
      Put(base + row.row_index * table.record_size, row.pattern);
    }
  }

  void PutReference(std::uintptr_t table_base, std::uint32_t source_row,
                    std::uint16_t target_table, std::uint32_t target_row) {
    std::vector<std::uint8_t> bytes(4);
    const auto encoded = EncodePackedReference({target_table, target_row});
    bytes[0] = static_cast<std::uint8_t>(encoded >> 24);
    bytes[1] = static_cast<std::uint8_t>(encoded >> 16);
    bytes[2] = static_cast<std::uint8_t>(encoded >> 8);
    bytes[3] = static_cast<std::uint8_t>(encoded);
    Put(table_base + source_row * 8 + 4, bytes);
  }

  ScanObservationResult ScanTableDescriptor(
      std::uint16_t table_id, std::uint32_t unique_id,
      std::size_t max_matches, const DescriptorMatchFilter& accept_match,
      const DiscoveryDeadline&) override {
    if (!supports_descriptors) {
      return {.complete = true, .code = "DESCRIPTOR_SCAN_UNSUPPORTED"};
    }
    ++descriptor_scan_count;
    auto pattern = LittleEndian32(table_id);
    const auto unique = LittleEndian32(unique_id);
    pattern.insert(pattern.end(), unique.begin(), unique.end());
    ScanObservationResult result{.complete = true};
    for (const auto& allocation : allocations) {
      for (std::size_t offset = 0;
           offset + pattern.size() <= allocation.bytes.size(); ++offset) {
        if (std::equal(pattern.begin(), pattern.end(),
                       allocation.bytes.begin() + offset)) {
          const ScanObservation observation{allocation.base + offset,
                                            allocation.base,
                                            allocation.bytes.size()};
          if (accept_match && !accept_match(observation)) continue;
          result.matches.push_back(observation);
          if (stop_after_first_descriptor_signature) return result;
          if (result.matches.size() == max_matches) return result;
        }
      }
    }
    return result;
  }

  ScanObservationResult Scan(const RowFingerprint& fingerprint,
                             std::size_t max_matches,
                             const DiscoveryDeadline& deadline) override {
    ++scan_count;
    max_requested_matches = std::max(max_requested_matches, max_matches);
    if (slow_after_scan && scan_count >= slow_after_scan) {
      while (!deadline.Expired()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return {.complete = false, .code = "OPERATION_TIMEOUT",
              .counters = {.pages_scanned = 2, .chunks_scanned = 3,
                           .scanned_bytes = 4096, .candidate_windows = 4,
                           .capped_matches = 1}};
    }
    ScanObservationResult result{.complete = true};
    for (const auto& allocation : allocations) {
      for (std::size_t offset = 0;
           offset + fingerprint.pattern.size() <= allocation.bytes.size(); ++offset) {
        bool match = true;
        for (std::size_t i = 0; i < fingerprint.pattern.size(); ++i) {
          if ((allocation.bytes[offset + i] & fingerprint.mask[i]) !=
              (fingerprint.pattern[i] & fingerprint.mask[i])) {
            match = false;
            break;
          }
        }
        if (match) {
          result.matches.push_back({allocation.base + offset, allocation.base,
                                    allocation.bytes.size()});
          result.counters.capped_matches = (std::min)(
              static_cast<std::uint64_t>(result.matches.size()),
              static_cast<std::uint64_t>(max_matches));
          if (result.matches.size() == max_matches) return result;
        }
      }
    }
    return result;
  }

  bool ReadBatch(std::span<const ReadRequest> requests,
                 std::vector<std::vector<std::uint8_t>>& out) override {
    ++read_batch_count;
    last_batch_size = requests.size();
    max_batch_size = std::max(max_batch_size, requests.size());
    out.clear();
    for (const auto& request : requests) {
      auto* allocation = Find(request.address, request.length);
      if (!allocation) return false;
      const auto offset = request.address - allocation->base;
      out.emplace_back(allocation->bytes.begin() + offset,
                       allocation->bytes.begin() + offset + request.length);
    }
    if (mutate_reread && !out.empty()) out[0][0] ^= 0xFF;
    return true;
  }

  bool AllocationExists(std::uintptr_t base, std::size_t size,
                        const DiscoveryDeadline& deadline) override {
    ++allocation_checks;
    if (slow_allocation) {
      while (!deadline.Expired()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return false;
    }
    return Find(base, size) != nullptr;
  }

  Allocation* Find(std::uintptr_t address, std::size_t size) {
    for (auto& allocation : allocations) {
      if (address >= allocation.base && size <= allocation.bytes.size() &&
          address - allocation.base <= allocation.bytes.size() - size) {
        return &allocation;
      }
    }
    return nullptr;
  }

  std::vector<Allocation> allocations;
  std::size_t scan_count{};
  std::size_t descriptor_scan_count{};
  std::size_t max_requested_matches{};
  std::size_t read_batch_count{};
  std::size_t last_batch_size{};
  std::size_t max_batch_size{};
  std::size_t allocation_checks{};
  bool mutate_reread{};
  std::size_t slow_after_scan{};
  bool slow_allocation{};
  bool supports_descriptors{};
  bool stop_after_first_descriptor_signature{};
};

void InstallLiveDescriptorTable(const TableProfile& table,
                                 FakeBackend& backend,
                                 std::uintptr_t descriptor_base,
                                 std::uintptr_t blob_base,
                                 std::size_t prefix_bytes,
                                 std::size_t suffix_bytes,
                                 std::size_t end_pointer_offset = 36) {
  backend.AddAllocation(descriptor_base, 256);
  backend.supports_descriptors = true;
  backend.AddAllocation(blob_base, prefix_bytes +
                                       table.capacity * table.record_size +
                                       suffix_bytes);
  auto signature = LittleEndian32(table.table_id);
  const auto unique_id = LittleEndian32(table.unique_id);
  signature.insert(signature.end(), unique_id.begin(), unique_id.end());
  backend.Put(descriptor_base + 32, signature);
  backend.Put(descriptor_base + 44, LittleEndianPointer(blob_base));
  backend.Put(descriptor_base + 32 + end_pointer_offset,
              LittleEndianPointer(blob_base + prefix_bytes +
                                  table.capacity * table.record_size +
                                  suffix_bytes));
  for (const auto& row : table.rows) {
    backend.Put(blob_base + prefix_bytes +
                    row.row_index * table.record_size,
                LiveWords(row.pattern));
  }
}

ProfileBundle IndexedArrayBundle() {
  ProfileBundle bundle;
  bundle.tables = {Table("ProspectTargetSchool", 5840, 30)};
  TableProfile array{.logical_name = "ProspectTargetSchool[]",
                     .table_id = 5842,
                     .unique_id = 2332540366,
                     .capacity = 3,
                     .record_size = 8};
  for (std::uint32_t row = 0; row < array.capacity; ++row) {
    std::vector<std::uint8_t> pattern;
    for (std::uint32_t ordinal = 0; ordinal < 2; ++ordinal) {
      const auto encoded = EncodePackedReference({5840, row * 2 + ordinal});
      pattern.push_back(static_cast<std::uint8_t>(encoded >> 24));
      pattern.push_back(static_cast<std::uint8_t>(encoded >> 16));
      pattern.push_back(static_cast<std::uint8_t>(encoded >> 8));
      pattern.push_back(static_cast<std::uint8_t>(encoded));
      array.relationships.push_back(
          {.source_row = row,
           .field_name = ordinal == 0 ? "Target0" : "Target1",
           .target_table_id = 5840,
           .target_row = row * 2 + ordinal});
    }
    array.rows.push_back({.row_index = row,
                          .pattern = std::move(pattern),
                          .mask = std::vector<std::uint8_t>(8, 0xFF)});
  }
  bundle.tables.push_back(std::move(array));
  std::string error;
  const bool loaded = bundle.schema.Load(
      {{"formatVersion", 1},
       {"schemaIdentity", "synthetic-schema-v1"},
       {"buildIdentity", "synthetic-build-v1"},
       {"tables",
        json::array(
            {{{"logicalName", bundle.tables[0].logical_name},
              {"tableId", bundle.tables[0].table_id},
              {"uniqueId", bundle.tables[0].unique_id},
              {"capacity", bundle.tables[0].capacity},
              {"recordSize", bundle.tables[0].record_size},
              {"authorityStatus", "discovery_only"},
              {"fields", json::array({Field("SyntheticValue", "unsigned", 0,
                                                   2, 16)})}},
             {{"logicalName", bundle.tables[1].logical_name},
              {"tableId", bundle.tables[1].table_id},
              {"uniqueId", bundle.tables[1].unique_id},
              {"capacity", bundle.tables[1].capacity},
              {"recordSize", bundle.tables[1].record_size},
              {"authorityStatus", "discovery_only"},
              {"fields",
               json::array({Field("Target0", "packed-reference", 0, 4, 32,
                                        5840),
                            Field("Target1", "packed-reference", 4, 4, 32,
                                  5840)})}}})}},
      &error);
  if (!loaded) throw std::runtime_error(error);
  return bundle;
}

void InstallLiveIndexedArray(const TableProfile& table, FakeBackend& backend,
                             std::uintptr_t descriptor_base,
                             std::uintptr_t slots_base,
                             std::uintptr_t wrappers_base) {
  backend.AddAllocation(descriptor_base, 256);
  backend.AddAllocation(slots_base, table.capacity * 8);
  backend.AddAllocation(wrappers_base, table.capacity * 32);
  backend.supports_descriptors = true;
  auto signature = LittleEndian32(table.table_id);
  const auto unique_id = LittleEndian32(table.unique_id);
  signature.insert(signature.end(), unique_id.begin(), unique_id.end());
  backend.Put(descriptor_base + 32, signature);
  backend.Put(descriptor_base + 52, LittleEndianPointer(slots_base));
  backend.Put(descriptor_base + 60,
              LittleEndianPointer(slots_base + table.capacity * 8));
  for (std::uint32_t row = 0; row < table.capacity; ++row) {
    const auto wrapper = wrappers_base + row * 32;
    backend.Put(slots_base + row * 8, LittleEndianPointer(wrapper));
    backend.Put(wrapper, LittleEndianPointer(0xABCDEF00));
    backend.Put(wrapper + 24, LittleEndian32(row));
  }
}

const TableDiscovery& State(const DiscoveryResult& result,
                            std::uint32_t unique_id) {
  const auto* table = result.FindTableByUniqueId(unique_id);
  Require(table != nullptr, "result omitted table");
  return *table;
}

void InstallGraph(ProfileBundle& bundle, FakeBackend& backend,
                  std::uintptr_t start = 0x100000) {
  for (std::size_t i = 0; i < bundle.tables.size(); ++i) {
    backend.PutTable(bundle.tables[i], start + i * 0x1000);
  }
  const auto target_base = start + 3 * 0x1000;
  const auto overflow_base = start + 4 * 0x1000;
  backend.PutReference(target_base, 3, 4269, 5);
  backend.PutReference(overflow_base, 3, 5841, 5);
  bundle.tables[3].rows[1].pattern = backend.allocations[3].bytes;
  bundle.tables[3].rows[1].pattern.resize(8);
  bundle.tables[3].rows[1].pattern.assign(
      backend.allocations[3].bytes.begin() + 24,
      backend.allocations[3].bytes.begin() + 32);
  bundle.tables[4].rows[1].pattern.assign(
      backend.allocations[4].bytes.begin() + 24,
      backend.allocations[4].bytes.begin() + 32);
}

void PutReferenceAt(FakeBackend& backend, ProfileBundle& bundle,
                    std::size_t table_index, std::uintptr_t table_base,
                    std::uint32_t byte_offset, std::uint16_t target_table,
                    std::uint32_t target_row) {
  const auto encoded = EncodePackedReference({target_table, target_row});
  std::vector<std::uint8_t> bytes(4);
  std::memcpy(bytes.data(), &encoded, sizeof(encoded));
  backend.Put(table_base + 3 * 8 + byte_offset, bytes);
  const auto* allocation = backend.Find(table_base, 8 * 10);
  Require(allocation != nullptr, "fixture relationship allocation missing");
  bundle.tables[table_index].rows[1].pattern.assign(
      allocation->bytes.begin() + 24, allocation->bytes.begin() + 32);
}

void TestGraphAndRelocation() {
  auto bundle = Bundle();
  FakeBackend backend;
  InstallGraph(bundle, backend);
  auto result = DiscoverTables(bundle, backend);
  for (const auto& table : bundle.tables) {
    Require(State(result, table.unique_id).state == TableState::kResolved,
            "valid graph did not resolve");
  }
  Require(State(result, 424407).descriptor->base == 0x100000,
          "wrong derived player base");
  Require(backend.scan_count == bundle.tables.size() * 3,
          "fingerprint was not scanned exactly once");
  Require(backend.max_batch_size >= 3, "candidate rereads were not batched");

  FakeBackend relocated;
  InstallGraph(bundle, relocated, 0x900000);
  result = DiscoverTables(bundle, relocated);
  Require(State(result, 424407).descriptor->base == 0x900000,
          "relocated table retained stale base");
}

void TestLiveDescriptorAndWordOrderDiscovery() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  LoadSchema(bundle);
  FakeBackend backend;
  InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                             48, 16);

  const auto result = DiscoverTables(bundle, backend);
  const auto& table = State(result, bundle.tables[0].unique_id);
  Require(table.state == TableState::kResolved,
          "live descriptor table did not resolve");
  Require(table.descriptor && table.descriptor->base == 0x600030,
          "live descriptor table derived the wrong record base");
  Require(table.descriptor->stride == bundle.tables[0].record_size,
          "live descriptor table derived the wrong stride");
  Require(table.descriptor->storage == TableStorage::kWordSwappedRecords,
          "live descriptor table did not retain word-order metadata");
  Require(backend.descriptor_scan_count == 1 && backend.scan_count == 0,
          "live descriptor discovery performed global row scans");
}

void TestEvidenceBackedDirectWriteAuthority() {
  const std::array verified{
      std::tuple{"Recruit", 4269u, 1873209313u, 24u},
      std::tuple{"ProspectTargetSchool", 5840u, 3789266353u, 4u},
      std::tuple{"UserRecruitTarget", 4168u, 3987156317u, 36u},
      std::tuple{"ActiveVisitInfo", 4176u, 3093586546u, 4u},
      std::tuple{"ActiveRecruitingPitch", 4190u, 1559900276u, 4u},
      std::tuple{"RecruitingBoard", 4251u, 220276943u, 12u},
  };
  for (const auto& [name, table_id, unique_id, record_size] : verified) {
    ProfileBundle bundle;
    bundle.tables = {EvidenceTable(name, static_cast<std::uint16_t>(table_id),
                                   unique_id, record_size)};
    LoadSchema(bundle);
    FakeBackend backend;
    InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                               48, 16);
    const auto result = DiscoverTables(bundle, backend);
    Require(State(result, unique_id).descriptor->direct_write_verified,
            "verified table did not receive direct authority");
  }

  ProfileBundle mismatch;
  mismatch.tables = {
      EvidenceTable("UserRecruitTarget", 4168, 3987156317u, 35)};
  LoadSchema(mismatch);
  FakeBackend backend;
  InstallLiveDescriptorTable(mismatch.tables[0], backend, 0x700000, 0x800000,
                             48, 16);
  const auto result = DiscoverTables(mismatch, backend);
  Require(!State(result, 3987156317u).descriptor->direct_write_verified,
          "wrong record size received direct authority");
}

void TestLiveDescriptorSkipsInvalidSignatureCopy() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  LoadSchema(bundle);
  FakeBackend backend;
  backend.AddAllocation(0x400000, 256);
  backend.supports_descriptors = true;
  backend.stop_after_first_descriptor_signature = true;
  auto signature = LittleEndian32(bundle.tables[0].table_id);
  const auto unique_id = LittleEndian32(bundle.tables[0].unique_id);
  signature.insert(signature.end(), unique_id.begin(), unique_id.end());
  backend.Put(0x400020, signature);
  InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                             48, 16);

  const auto result = DiscoverTables(bundle, backend);
  const auto& table = State(result, bundle.tables[0].unique_id);
  Require(table.state == TableState::kResolved && table.descriptor &&
              table.descriptor->base == 0x600030,
          "live descriptor scan stopped on an invalid signature copy");
}

void TestLiveDescriptorAcceptsAlternateEndPointerOffset() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  bundle.tables[0].unique_id = 1612938518;
  LoadSchema(bundle);
  FakeBackend backend;
  InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                             48, 16, 28);

  const auto result = DiscoverTables(bundle, backend);
  const auto& table = State(result, bundle.tables[0].unique_id);
  Require(table.state == TableState::kResolved && table.descriptor &&
              table.descriptor->base == 0x600030,
          "live descriptor rejected the alternate end-pointer layout");
}

void TestLiveDescriptorRelationshipWordOrder() {
  ProfileBundle bundle;
  bundle.tables = {Table("Recruit", 4269, 10),
                   Table("RecruitTarget", 4288, 10)};
  bundle.tables[1].relationships.push_back(
      {.source_row = 3, .field_name = "RecruitRef", .target_table_id = 4269,
       .target_row = 5});
  const auto encoded = EncodePackedReference({4269, 5});
  auto& relationship_row = bundle.tables[1].rows[1].pattern;
  relationship_row[4] = static_cast<std::uint8_t>(encoded >> 24);
  relationship_row[5] = static_cast<std::uint8_t>(encoded >> 16);
  relationship_row[6] = static_cast<std::uint8_t>(encoded >> 8);
  relationship_row[7] = static_cast<std::uint8_t>(encoded);
  LoadSchema(bundle);
  FakeBackend backend;
  InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                             32, 16);
  InstallLiveDescriptorTable(bundle.tables[1], backend, 0x510000, 0x610000,
                             40, 8);

  const auto result = DiscoverTables(bundle, backend);
  Require(State(result, bundle.tables[0].unique_id).state ==
              TableState::kResolved,
          "live relationship target did not resolve");
  Require(State(result, bundle.tables[1].unique_id).state ==
              TableState::kResolved,
          "live relationship source did not decode word-swapped reference");
}

void TestLiveIndexedReferenceArrayDiscovery() {
  auto bundle = IndexedArrayBundle();
  FakeBackend backend;
  InstallLiveDescriptorTable(bundle.tables[0], backend, 0x500000, 0x600000,
                             32, 16);
  InstallLiveIndexedArray(bundle.tables[1], backend, 0x510000, 0x620000,
                          0x630000);

  const auto result = DiscoverTables(bundle, backend);
  const auto& array = State(result, bundle.tables[1].unique_id);
  Require(array.state == TableState::kResolved && array.descriptor,
          "live indexed reference array did not resolve");
  Require(array.descriptor->storage == TableStorage::kIndexedReferenceArray &&
              array.descriptor->base == 0x620000 &&
              array.descriptor->stride == 8 &&
              array.descriptor->virtual_target_table_id == 5840 &&
              array.descriptor->virtual_width == 2,
          "live indexed reference array metadata was incorrect");
}

void TestAmbiguityAndStaleCopies() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  FakeBackend duplicated;
  duplicated.PutTable(bundle.tables[0], 0x100000);
  duplicated.PutTable(bundle.tables[0], 0x200000);
  Require(State(DiscoverTables(bundle, duplicated), 424407).state ==
              TableState::kAmbiguous,
          "duplicated full table was selected");

  FakeBackend stale;
  stale.PutTable(bundle.tables[0], 0x300000);
  for (std::size_t i = 0; i < 3; ++i) {
    stale.AddAllocation(0x400000 + i * 0x1000, 64);
    stale.Put(0x400000 + i * 0x1000 + 7, bundle.tables[0].rows[i].pattern);
  }
  Require(State(DiscoverTables(bundle, stale), 424407).state ==
              TableState::kResolved,
          "isolated stale fingerprint copies prevented resolution");
}

void TestStructuralRejections() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  FakeBackend truncated;
  truncated.PutTable(bundle.tables[0], 0x100000, 6 * 8);
  Require(State(DiscoverTables(bundle, truncated), 424407).state ==
              TableState::kAllocationInvalid,
          "truncated capacity was not classified");

  FakeBackend cross;
  for (std::size_t i = 0; i < 3; ++i) {
    cross.AddAllocation(0x200000 + i * 0x1000, 128);
    cross.Put(0x200000 + i * 0x1000 + bundle.tables[0].rows[i].row_index * 8,
              bundle.tables[0].rows[i].pattern);
  }
  Require(State(DiscoverTables(bundle, cross), 424407).state !=
              TableState::kResolved,
          "cross-allocation rows resolved");

  FakeBackend spacing;
  spacing.AddAllocation(0x300000, 256);
  spacing.Put(0x300008, bundle.tables[0].rows[0].pattern);
  spacing.Put(0x300028, bundle.tables[0].rows[1].pattern);
  spacing.Put(0x300058, bundle.tables[0].rows[2].pattern);
  Require(State(DiscoverTables(bundle, spacing), 424407).state ==
              TableState::kMissing,
          "inconsistent row spacing resolved");

  FakeBackend wrong_stride;
  wrong_stride.AddAllocation(0x400000, 256);
  for (const auto& row : bundle.tables[0].rows) {
    wrong_stride.Put(0x400000 + row.row_index * 16, row.pattern);
  }
  Require(State(DiscoverTables(bundle, wrong_stride), 424407).state ==
              TableState::kMissing,
          "stride different from record size resolved");
}

void TestStabilityAndRelationships() {
  auto bundle = Bundle();
  FakeBackend unstable;
  InstallGraph(bundle, unstable);
  unstable.mutate_reread = true;
  Require(State(DiscoverTables(bundle, unstable), 424407).state ==
              TableState::kUnstable,
          "changed reread bytes resolved");

  auto broken_bundle = Bundle();
  FakeBackend broken;
  InstallGraph(broken_bundle, broken);
  broken.PutReference(0x103000, 3, 4269, 4);
  broken_bundle.tables[3].rows[1].pattern.assign(
      broken.allocations[3].bytes.begin() + 24,
      broken.allocations[3].bytes.begin() + 32);
  Require(State(DiscoverTables(broken_bundle, broken), 428807).state ==
              TableState::kRelationshipFailed,
          "broken packed reference resolved");

  auto overflow_bundle = Bundle();
  FakeBackend overflow;
  InstallGraph(overflow_bundle, overflow);
  Require(State(DiscoverTables(overflow_bundle, overflow), 584107).state ==
              TableState::kResolved,
          "valid table 5841 packed reference was rejected");
}

void TestPersistentUniqueIdentityAndBuildLocalReferences() {
  auto bundle = Bundle();
  auto& recruit = bundle.tables[2];
  recruit.table_id = 5000;
  for (auto& row : recruit.rows) row.pattern = Record(5000, row.row_index);
  bundle.tables[3].relationships[0].target_table_id = 5000;
  LoadSchema(bundle);
  FakeBackend backend;
  InstallGraph(bundle, backend);
  backend.PutReference(0x103000, 3, 5000, 5);
  bundle.tables[3].rows[1].pattern.assign(
      backend.allocations[3].bytes.begin() + 24,
      backend.allocations[3].bytes.begin() + 32);
  auto result = DiscoverTables(bundle, backend);
  Require(State(result, 426907).state == TableState::kResolved,
          "changed build-local table ID broke persistent unique identity");
  Require(State(result, 428807).state == TableState::kResolved,
          "changed build-local packed-reference route was not followed");

  auto duplicate = Bundle();
  duplicate.tables[1].unique_id = duplicate.tables[0].unique_id;
  FakeBackend duplicate_backend;
  InstallGraph(duplicate, duplicate_backend);
  auto duplicate_result = DiscoverTables(duplicate, duplicate_backend);
  Require(!duplicate_result.valid &&
              duplicate_result.code == "DUPLICATE_UNIQUE_ID",
          "duplicate persistent unique IDs did not fail closed");

  auto wrong = Bundle();
  FakeBackend wrong_backend;
  InstallGraph(wrong, wrong_backend);
  wrong_backend.PutReference(0x103000, 3, 5000, 5);
  wrong.tables[3].rows[1].pattern.assign(
      wrong_backend.allocations[3].bytes.begin() + 24,
      wrong_backend.allocations[3].bytes.begin() + 32);
  Require(State(DiscoverTables(wrong, wrong_backend), 428807).state ==
              TableState::kRelationshipFailed,
          "wrong build-local table ID mapping passed relationship validation");
}

void TestDistinctFingerprintsScanOnceGlobally() {
  auto bundle = Bundle();
  bundle.tables.resize(2);
  bundle.tables[1].rows[0].pattern = bundle.tables[0].rows[0].pattern;
  bundle.tables[1].rows[0].mask = bundle.tables[0].rows[0].mask;
  FakeBackend backend;
  backend.PutTable(bundle.tables[0], 0x100000);
  backend.PutTable(bundle.tables[1], 0x200000);
  (void)DiscoverTables(bundle, backend);
  Require(backend.scan_count == 5,
          "identical fingerprint bytes and mask were scanned more than once");
  Require(backend.max_requested_matches == 8,
          "discovery requested more than eight matches for a fingerprint");
}

void TestDeadlineRejectsPartialDiscovery() {
  auto bundle = Bundle();
  FakeBackend backend;
  InstallGraph(bundle, backend);
  backend.slow_after_scan = 4;
  const auto started = std::chrono::steady_clock::now();
  const auto result = DiscoverTables(
      bundle, backend,
      DiscoveryDeadline(std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(25)));
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started);
  Require(!result.valid && result.code == "OPERATION_TIMEOUT",
          "deadline returns deterministic discovery timeout");
  Require(result.tables.empty(), "deadline does not publish partial tables");
  Require(result.timeout.has_value(), "deadline includes sanitized progress");
  Require(result.timeout->stage == DiscoveryStage::kScan,
          "deadline identifies scan stage");
  Require(result.timeout->table_unique_id == bundle.tables[1].unique_id,
          "deadline identifies only the public table Unique ID");
  Require(result.timeout->fingerprint_ordinal == 0,
          "deadline identifies zero-based fingerprint ordinal");
  Require(result.timeout->completed_fingerprint_count == 3,
          "deadline reports completed fingerprint count");
  Require(result.timeout->counters.pages_scanned == 2 &&
              result.timeout->counters.chunks_scanned == 3 &&
              result.timeout->counters.scanned_bytes == 4096 &&
              result.timeout->counters.candidate_windows == 4 &&
              result.timeout->counters.capped_matches == 4,
          "deadline reports bounded cumulative scan counters");
  Require(result.timeout->elapsed_milliseconds <= kMaxSafeDiagnosticCounter,
          "deadline elapsed time is a bounded safe integer");
  Require(elapsed < std::chrono::milliseconds(500),
          "native deadline terminates well before SDK timeout");
}

void TestDeadlineCapsCumulativeMatchesAcrossFingerprints() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  FakeBackend backend;
  for (std::uintptr_t base : {0x100000u, 0x200000u, 0x300000u, 0x400000u}) {
    backend.PutTable(bundle.tables[0], base);
  }
  backend.slow_after_scan = 3;
  const auto result = DiscoverTables(
      bundle, backend,
      DiscoveryDeadline(std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(25)));
  Require(!result.valid && result.code == "OPERATION_TIMEOUT" &&
              result.timeout.has_value(),
          "multi-fingerprint deadline returns timeout progress");
  Require(result.timeout->fingerprint_ordinal == 2 &&
              result.timeout->completed_fingerprint_count == 2,
          "multi-fingerprint deadline preserves scan progress");
  Require(result.timeout->counters.capped_matches == 8,
          "cumulative timeout matches saturate at the public native cap");
}

void TestDeadlineBoundsAllocationValidation() {
  auto bundle = Bundle();
  bundle.tables.resize(1);
  FakeBackend backend;
  backend.PutTable(bundle.tables[0], 0x100000);
  backend.slow_allocation = true;
  const auto result = DiscoverTables(
      bundle, backend,
      DiscoveryDeadline(std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(25)));
  Require(!result.valid && result.code == "OPERATION_TIMEOUT" &&
              result.tables.empty(),
          "allocation validation deadline publishes no partial table");
  Require(result.timeout &&
              result.timeout->stage == DiscoveryStage::kAllocation &&
              result.timeout->table_unique_id == bundle.tables[0].unique_id &&
              !result.timeout->fingerprint_ordinal.has_value() &&
              result.timeout->completed_fingerprint_count == 3,
          "allocation deadline reports phase without fingerprint identity");
}

void TestRelationshipsUseIndependentResolutionSnapshot() {
  auto bundle = Bundle();
  bundle.tables[4].relationships[0].target_table_id = 4288;
  bundle.tables[4].relationships[0].target_row = 5;
  LoadSchema(bundle);
  FakeBackend backend;
  InstallGraph(bundle, backend);
  backend.PutReference(0x103000, 3, 4269, 4);
  backend.PutReference(0x104000, 3, 4288, 5);
  bundle.tables[3].rows[1].pattern.assign(
      backend.allocations[3].bytes.begin() + 24,
      backend.allocations[3].bytes.begin() + 32);
  bundle.tables[4].rows[1].pattern.assign(
      backend.allocations[4].bytes.begin() + 24,
      backend.allocations[4].bytes.begin() + 32);
  const auto result = DiscoverTables(bundle, backend);
  Require(State(result, 428807).state == TableState::kRelationshipFailed,
          "broken source relationship was not rejected");
  Require(State(result, 584107).state == TableState::kResolved,
          "relationship validation depended on another relationship outcome");
}

void TestSchemaAuthoritativeRelationshipFields() {
  {
    auto bundle = Bundle();
    FakeBackend backend;
    InstallGraph(bundle, backend);
    Require(State(DiscoverTables(bundle, backend), 428807).state ==
                TableState::kResolved,
            "valid packed reference at nonzero schema offset failed");
  }
  {
    auto bundle = Bundle();
    FakeBackend backend;
    InstallGraph(bundle, backend);
    bundle.tables[3].relationships[0].field_name = "RecruitRefTypo";
    PutReferenceAt(backend, bundle, 3, 0x103000, 0, 4269, 5);
    Require(State(DiscoverTables(bundle, backend), 428807).state ==
                TableState::kRelationshipFailed,
            "missing relationship field used an implicit offset");
  }
  {
    auto bundle = Bundle();
    auto& field = MutableField(bundle, 4288, "SyntheticValue");
    field.storage_bytes = 4;
    field.bit_width = 32;
    field.maximum = 0xFFFFFFFFll;
    bundle.tables[3].relationships[0].field_name = "SyntheticValue";
    FakeBackend backend;
    InstallGraph(bundle, backend);
    PutReferenceAt(backend, bundle, 3, 0x103000, 0, 4269, 5);
    Require(State(DiscoverTables(bundle, backend), 428807).state ==
                TableState::kRelationshipFailed,
            "non-reference field validated a packed relationship");
  }
  {
    auto bundle = Bundle();
    MutableField(bundle, 4288, "RecruitRef").reference_table_id = 5841;
    FakeBackend backend;
    InstallGraph(bundle, backend);
    Require(State(DiscoverTables(bundle, backend), 428807).state ==
                TableState::kRelationshipFailed,
            "wrong schema reference target validated");
  }
  {
    auto bundle = Bundle();
    MutableField(bundle, 4288, "RecruitRef").byte_offset = 7;
    FakeBackend backend;
    InstallGraph(bundle, backend);
    Require(State(DiscoverTables(bundle, backend), 428807).state ==
                TableState::kRelationshipFailed,
            "out-of-record relationship field validated");
  }
  {
    auto bundle = Bundle();
    MutableField(bundle, 4288, "RecruitRef").bit_width = 31;
    FakeBackend backend;
    InstallGraph(bundle, backend);
    Require(State(DiscoverTables(bundle, backend), 428807).state ==
                TableState::kRelationshipFailed,
            "non-32-bit packed relationship field validated");
  }
}

}  // namespace

int main() {
  try {
    TestLiveDescriptorAndWordOrderDiscovery();
    TestEvidenceBackedDirectWriteAuthority();
    TestLiveDescriptorSkipsInvalidSignatureCopy();
    TestLiveDescriptorAcceptsAlternateEndPointerOffset();
    TestLiveDescriptorRelationshipWordOrder();
    TestLiveIndexedReferenceArrayDiscovery();
    TestGraphAndRelocation();
    TestAmbiguityAndStaleCopies();
    TestStructuralRejections();
    TestStabilityAndRelationships();
    TestPersistentUniqueIdentityAndBuildLocalReferences();
    TestDistinctFingerprintsScanOnceGlobally();
    TestDeadlineRejectsPartialDiscovery();
    TestDeadlineCapsCumulativeMatchesAcrossFingerprints();
    TestDeadlineBoundsAllocationValidation();
    TestRelationshipsUseIndependentResolutionSnapshot();
    TestSchemaAuthoritativeRelationshipFields();
    std::cout << "frtk discovery smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk discovery smoke failed: " << error.what() << '\n';
    return 1;
  }
}
