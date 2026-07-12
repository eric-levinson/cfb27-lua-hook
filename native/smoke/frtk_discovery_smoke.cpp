#include "../host/frtk_discovery.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstring>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
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
    std::memcpy(bytes.data(), &encoded, sizeof(encoded));
    Put(table_base + source_row * 8 + 4, bytes);
  }

  ScanObservationResult Scan(const RowFingerprint& fingerprint,
                             std::size_t max_matches) override {
    ++scan_count;
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

  bool AllocationExists(std::uintptr_t base, std::size_t size) override {
    ++allocation_checks;
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
  std::size_t read_batch_count{};
  std::size_t last_batch_size{};
  std::size_t max_batch_size{};
  std::size_t allocation_checks{};
  bool mutate_reread{};
};

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
    TestGraphAndRelocation();
    TestAmbiguityAndStaleCopies();
    TestStructuralRejections();
    TestStabilityAndRelationships();
    TestPersistentUniqueIdentityAndBuildLocalReferences();
    TestDistinctFingerprintsScanOnceGlobally();
    TestRelationshipsUseIndependentResolutionSnapshot();
    TestSchemaAuthoritativeRelationshipFields();
    std::cout << "frtk discovery smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk discovery smoke failed: " << error.what() << '\n';
    return 1;
  }
}
