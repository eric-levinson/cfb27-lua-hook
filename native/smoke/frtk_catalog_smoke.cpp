#include "../host/frtk_catalog.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>

namespace {
using namespace cfb27::frtk;

void Require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

ProfileBundle Bundle() {
  ProfileBundle result;
  result.profile_id = "synthetic-profile";
  result.tables = {
      {.logical_name = "Target", .table_id = 22, .unique_id = 220022,
       .capacity = 4, .record_size = 8,
       .rows = {{.row_index = 0, .pattern = {1, 2}, .mask = {255, 255}},
                {.row_index = 1, .pattern = {3, 4}, .mask = {255, 255}},
                {.row_index = 2, .pattern = {5, 6}, .mask = {255, 255}}}},
      {.logical_name = "Source", .table_id = 33, .unique_id = 330033,
       .capacity = 4, .record_size = 8,
       .rows = {{.row_index = 0, .pattern = {7, 8}, .mask = {255, 255}},
                {.row_index = 1, .pattern = {9, 10}, .mask = {255, 255}},
                {.row_index = 2, .pattern = {11, 12}, .mask = {255, 255}}},
       .relationships = {{.source_row = 1, .field_name = "TargetRef",
                          .target_table_id = 22, .target_row = 2}}},
  };
  std::string error;
  const nlohmann::json schema = {
      {"formatVersion", 1}, {"schemaIdentity", "synthetic-schema"},
      {"buildIdentity", "synthetic-build"},
      {"tables", nlohmann::json::array({
          {{"logicalName", "Target"}, {"tableId", 22}, {"uniqueId", 220022},
           {"capacity", 4}, {"recordSize", 8},
           {"authorityStatus", "discovery_only"},
           {"fields", nlohmann::json::array()}},
          {{"logicalName", "Source"}, {"tableId", 33}, {"uniqueId", 330033},
           {"capacity", 4}, {"recordSize", 8},
           {"authorityStatus", "discovery_only"},
           {"fields", nlohmann::json::array({
               {{"name", "TargetRef"}, {"encoding", "packed-reference"},
                {"byteOffset", 4}, {"storageBytes", 4}, {"bitOffset", 0},
                {"bitWidth", 32}, {"minimum", 0}, {"maximum", 0xFFFFFFFFull},
                {"referenceTableId", 22}}
           })}}
      })}};
  Require(result.schema.Load(schema, &error), error.c_str());
  return result;
}

DiscoveryResult Discovery() {
  return {.tables = {
      {.unique_id = 220022, .state = TableState::kResolved,
       .descriptor = TableDescriptor{.unique_id = 220022, .base = 0x1000,
          .stride = 8, .capacity = 4, .allocation_base = 0x1000,
          .allocation_size = 32}, .evidence = {{"TARGET_OK", 3}}},
      {.unique_id = 330033, .state = TableState::kResolved,
       .descriptor = TableDescriptor{.unique_id = 330033, .base = 0x2000,
          .stride = 8, .capacity = 4, .allocation_base = 0x2000,
          .allocation_size = 32}, .evidence = {{"SOURCE_OK", 3}}}
  }};
}

class Backend final : public DiscoveryBackend {
 public:
  std::map<std::uintptr_t, std::vector<std::uint8_t>> reads;
  bool allocation_ok{true};
  std::size_t batch_calls{};
  std::size_t fail_on_call{};
  std::size_t mutate_on_call{};
  std::size_t maximum_ranges{};
  std::size_t maximum_bytes{};
  ScanObservationResult Scan(const RowFingerprint&, std::size_t,
                             const DiscoveryDeadline&) override {
    return {};
  }
  bool ReadBatch(std::span<const ReadRequest> requests,
                 std::vector<std::vector<std::uint8_t>>& out) override {
    ++batch_calls;
    std::size_t total_bytes{};
    for (const auto& request : requests) total_bytes += request.length;
    maximum_ranges = std::max(maximum_ranges, requests.size());
    maximum_bytes = std::max(maximum_bytes, total_bytes);
    out.clear();
    if (requests.size() > 64 || total_bytes > 256 * 1024 ||
        batch_calls == fail_on_call) {
      return false;
    }
    for (const auto& request : requests) {
      auto found = reads.find(request.address);
      if (found == reads.end() || found->second.size() != request.length) return false;
      out.push_back(found->second);
    }
    if (batch_calls == mutate_on_call && !out.empty() && !out[0].empty()) {
      out[0][0] ^= 0xFF;
    }
    return true;
  }
  bool AllocationExists(std::uintptr_t, std::size_t,
                        const DiscoveryDeadline&) override {
    return allocation_ok;
  }
};

struct EvidenceFixture {
  ProfileBundle profile;
  DiscoveryResult discovery;
  Backend backend;
  std::vector<std::uintptr_t> expected_addresses;
};

EvidenceFixture BoundedEvidenceFixture(std::size_t sentinel_count,
                                       std::size_t relationship_count = 0,
                                       std::size_t record_size = 8) {
  Require(sentinel_count >= 3, "test fixture requires at least three sentinels");
  const auto table_count = (sentinel_count + 7) / 8;
  Require(sentinel_count >= table_count * 3,
          "test fixture cannot satisfy per-table fingerprint minimum");
  EvidenceFixture fixture;
  fixture.profile.profile_id = "bounded-evidence-profile";
  nlohmann::json schema_tables = nlohmann::json::array();
  std::size_t remaining = sentinel_count;
  for (std::size_t index = 0; index < table_count; ++index) {
    const auto tables_left = table_count - index - 1;
    const auto rows = std::min<std::size_t>(8, remaining - tables_left * 3);
    remaining -= rows;
    const auto table_id = static_cast<std::uint16_t>(100 + index);
    const auto unique_id = static_cast<std::uint32_t>(1000 + index);
    const auto base = static_cast<std::uintptr_t>(0x100000 + index * 0x10000);
    TableProfile table{.logical_name = "Table" + std::to_string(index),
                       .table_id = table_id,
                       .unique_id = unique_id,
                       .capacity = static_cast<std::uint32_t>(rows),
                       .record_size = static_cast<std::uint32_t>(record_size)};
    for (std::size_t row = 0; row < rows; ++row) {
      std::vector<std::uint8_t> bytes(
          record_size, static_cast<std::uint8_t>((index + row + 1) & 0xFF));
      table.rows.push_back({.row_index = static_cast<std::uint32_t>(row),
                            .pattern = bytes,
                            .mask = std::vector<std::uint8_t>(record_size, 0xFF)});
      const auto address = base + row * record_size;
      fixture.backend.reads.emplace(address, std::move(bytes));
      fixture.expected_addresses.push_back(address);
    }
    nlohmann::json fields = nlohmann::json::array();
    if (index < relationship_count) {
      table.relationships.push_back(
          {.source_row = 0, .field_name = "TargetRef",
           .target_table_id = 100, .target_row = 0});
      fields.push_back({{"name", "TargetRef"}, {"encoding", "packed-reference"},
                        {"byteOffset", 4}, {"storageBytes", 4}, {"bitOffset", 0},
                        {"bitWidth", 32}, {"minimum", 0}, {"maximum", 0xFFFFFFFFull},
                        {"referenceTableId", 100}});
    }
    schema_tables.push_back(
        {{"logicalName", table.logical_name}, {"tableId", table_id},
         {"uniqueId", unique_id}, {"capacity", table.capacity},
         {"recordSize", record_size}, {"authorityStatus", "discovery_only"},
         {"fields", std::move(fields)}});
    fixture.profile.tables.push_back(std::move(table));
    fixture.discovery.tables.push_back(
        {.unique_id = unique_id, .state = TableState::kResolved,
         .descriptor = TableDescriptor{
             .unique_id = unique_id, .base = base, .stride = record_size,
             .capacity = static_cast<std::uint32_t>(rows),
             .allocation_base = base, .allocation_size = rows * record_size}});
  }
  for (std::size_t index = 0; index < relationship_count; ++index) {
    const auto base = static_cast<std::uintptr_t>(0x100000 + index * 0x10000);
    const auto packed = static_cast<std::uint32_t>(100u << 17);
    const auto address = base + 4;
    fixture.backend.reads[address] = {
        static_cast<std::uint8_t>(packed >> 24),
        static_cast<std::uint8_t>(packed >> 16),
        static_cast<std::uint8_t>(packed >> 8),
        static_cast<std::uint8_t>(packed)};
    const auto insertion = std::find(fixture.expected_addresses.begin(),
                                     fixture.expected_addresses.end(), base);
    fixture.expected_addresses.insert(insertion +
        static_cast<std::ptrdiff_t>(fixture.profile.tables[index].rows.size()), address);
  }
  std::string error;
  Require(fixture.profile.schema.Load(
              {{"formatVersion", 1}, {"schemaIdentity", "bounded-schema"},
               {"buildIdentity", "bounded-build"},
               {"tables", std::move(schema_tables)}}, &error),
          error.c_str());
  return fixture;
}

Backend ValidBackend() {
  Backend backend;
  backend.reads = {{0x1000, {1, 2}}, {0x1008, {3, 4}}, {0x1010, {5, 6}},
                   {0x2000, {7, 8}}, {0x2008, {9, 10}}, {0x2010, {11, 12}},
                   {0x200C, {0, 44, 0, 2}}};
  return backend;
}

ProfileBundle ClosureBundle() {
  ProfileBundle result;
  result.profile_id = "closure-profile";
  result.tables = {
      {.logical_name = "Target", .table_id = 10, .unique_id = 100,
       .capacity = 2, .record_size = 8,
       .rows = {{.row_index = 0, .pattern = {1}, .mask = {255}}}},
      {.logical_name = "Direct", .table_id = 20, .unique_id = 200,
       .capacity = 2, .record_size = 8,
       .relationships = {{.source_row = 0, .field_name = "TargetRef",
                          .target_table_id = 10, .target_row = 0}}},
      {.logical_name = "Transitive", .table_id = 30, .unique_id = 300,
       .capacity = 2, .record_size = 8,
       .relationships = {{.source_row = 0, .field_name = "DirectRef",
                          .target_table_id = 20, .target_row = 0}}},
      {.logical_name = "Unrelated", .table_id = 40, .unique_id = 400,
       .capacity = 2, .record_size = 8},
  };
  auto packed = [](const char* name, unsigned target) {
    return nlohmann::json{{"name", name}, {"encoding", "packed-reference"},
      {"byteOffset", 4}, {"storageBytes", 4}, {"bitOffset", 0},
      {"bitWidth", 32}, {"minimum", 0}, {"maximum", 0xFFFFFFFFull},
      {"referenceTableId", target}};
  };
  nlohmann::json tables = nlohmann::json::array();
  tables.push_back({{"logicalName", "Target"}, {"tableId", 10},
                    {"uniqueId", 100}, {"capacity", 2}, {"recordSize", 8},
                    {"authorityStatus", "discovery_only"},
                    {"fields", nlohmann::json::array()}});
  tables.push_back({{"logicalName", "Direct"}, {"tableId", 20},
                    {"uniqueId", 200}, {"capacity", 2}, {"recordSize", 8},
                    {"authorityStatus", "discovery_only"},
                    {"fields", nlohmann::json::array({packed("TargetRef", 10)})}});
  tables.push_back({{"logicalName", "Transitive"}, {"tableId", 30},
                    {"uniqueId", 300}, {"capacity", 2}, {"recordSize", 8},
                    {"authorityStatus", "discovery_only"},
                    {"fields", nlohmann::json::array({packed("DirectRef", 20)})}});
  tables.push_back({{"logicalName", "Unrelated"}, {"tableId", 40},
                    {"uniqueId", 400}, {"capacity", 2}, {"recordSize", 8},
                    {"authorityStatus", "discovery_only"},
                    {"fields", nlohmann::json::array()}});
  std::string error;
  Require(result.schema.Load({{"formatVersion", 1},
                              {"schemaIdentity", "closure-schema"},
                              {"buildIdentity", "closure-build"},
                              {"tables", std::move(tables)}}, &error),
          error.c_str());
  return result;
}

DiscoveryResult ClosureDiscovery() {
  DiscoveryResult result;
  for (const auto [unique_id, base] :
       {std::pair{100u, std::uintptr_t{0x3000}},
        std::pair{200u, std::uintptr_t{0x4000}},
        std::pair{300u, std::uintptr_t{0x5000}},
        std::pair{400u, std::uintptr_t{0x6000}}}) {
    result.tables.push_back(
        {.unique_id = unique_id, .state = TableState::kResolved,
         .descriptor = TableDescriptor{.unique_id = unique_id, .base = base,
             .stride = 8, .capacity = 2, .allocation_base = base,
             .allocation_size = 16}});
  }
  return result;
}

void TestGenerationAndPublicSurface() {
  SessionCatalog catalog;
  const auto profile = Bundle();
  const auto discovery = Discovery();
  const auto first_generation = catalog.Install(profile, discovery);
  const auto handle = catalog.GetHandle(330033);
  Require(handle && handle->generation == first_generation, "unique-ID lookup failed");
  Require(!catalog.GetHandle(33), "session table ID leaked into public lookup");
  Require(catalog.Resolve(*handle) != nullptr, "current handle did not resolve");
  const auto summaries = catalog.Summaries();
  Require(summaries.size() == 2 && summaries[1].unique_id == 330033,
          "sanitized summaries missing catalog entries");

  const auto second_generation = catalog.Install(profile, discovery);
  Require(second_generation > first_generation && catalog.Resolve(*handle) == nullptr,
          "install did not stale old handles");
  const auto fresh = *catalog.GetHandle(330033);
  catalog.Invalidate();
  Require(catalog.Resolve(fresh) == nullptr, "explicit invalidation retained handles");
}

void TestLifecycleAndRevalidation() {
  const auto profile = Bundle();
  const auto discovery = Discovery();
  SessionCatalog catalog;
  catalog.Install(profile, discovery);
  const auto generation = catalog.generation();
  catalog.AdvanceLifecycle(false);
  const auto invalidated = catalog.generation();
  Require(invalidated > generation, "game_ready:false did not invalidate");
  catalog.AdvanceLifecycle(false);
  Require(catalog.generation() == invalidated,
          "repeated game_ready:false was not idempotent");

  catalog.Install(profile, discovery);
  auto backend = ValidBackend();
  Require(catalog.Revalidate(backend) && backend.batch_calls == 2,
          "sentinels and relationships were not verified twice");

  auto target = *catalog.GetHandle(220022);
  backend.allocation_ok = false;
  Require(!catalog.Revalidate(backend) && catalog.Resolve(target) == nullptr,
          "allocation loss did not quarantine and stale handles");

  catalog.Install(profile, discovery);
  backend = ValidBackend();
  backend.reads[0x1008] = {0, 0};
  Require(!catalog.Revalidate(backend) && !catalog.GetHandle(220022),
          "sentinel mismatch did not quarantine table");

  catalog.Install(profile, discovery);
  backend = ValidBackend();
  backend.reads[0x200C] = {0, 44, 0, 3};
  Require(!catalog.Revalidate(backend) && !catalog.GetHandle(330033) &&
              catalog.GetHandle(220022).has_value(),
          "relationship failure did not quarantine dependent descriptor");
}

void TestBoundedBatchRevalidation() {
  auto over_64 = BoundedEvidenceFixture(65);
  SessionCatalog catalog;
  catalog.Install(over_64.profile, over_64.discovery);
  CatalogEvidenceSnapshot snapshot;
  Require(catalog.Revalidate(over_64.backend, &snapshot),
          "more than 64 accepted evidence ranges were rejected");
  Require(over_64.backend.batch_calls == 4 &&
              over_64.backend.maximum_ranges == 64 &&
              over_64.backend.maximum_bytes <= 256 * 1024,
          "revalidation did not partition both passes at backend limits");
  Require(snapshot.guards.size() == 65,
          "bounded evidence snapshot silently truncated ranges");
  for (std::size_t index = 0; index < snapshot.guards.size(); ++index) {
    Require(snapshot.guards[index].address == over_64.expected_addresses[index],
            "bounded evidence result ordering changed");
  }

  auto mixed = BoundedEvidenceFixture(129, 10);
  catalog.Install(mixed.profile, mixed.discovery);
  Require(catalog.Revalidate(mixed.backend) && mixed.backend.batch_calls == 6,
          "more than 128 mixed fingerprint/relationship ranges were rejected");
  Require(mixed.backend.maximum_ranges == 64 &&
              mixed.backend.maximum_bytes <= 256 * 1024,
          "mixed evidence exceeded a backend batch limit");

  auto exact = BoundedEvidenceFixture(64, 0, 4096);
  catalog.Install(exact.profile, exact.discovery);
  Require(catalog.Revalidate(exact.backend) && exact.backend.batch_calls == 2 &&
              exact.backend.maximum_ranges == 64 &&
              exact.backend.maximum_bytes == 256 * 1024,
          "exact range/byte limit boundary was not accepted in one chunk per pass");
}

void TestChunkFailuresAndInstability() {
  auto unstable = BoundedEvidenceFixture(129);
  SessionCatalog catalog;
  catalog.Install(unstable.profile, unstable.discovery);
  unstable.backend.mutate_on_call = 4;
  Require(!catalog.Revalidate(unstable.backend),
          "mutation between bounded verification passes was accepted");

  auto partial = BoundedEvidenceFixture(65);
  catalog.Install(partial.profile, partial.discovery);
  partial.backend.fail_on_call = 2;
  CatalogEvidenceSnapshot snapshot;
  Require(!catalog.Revalidate(partial.backend, &snapshot) && snapshot.guards.empty(),
          "partial bounded batch failure produced accepted evidence");

  auto invalid_profile = Bundle();
  invalid_profile.tables[0].rows[0].pattern.resize(256 * 1024 + 1, 1);
  invalid_profile.tables[0].rows[0].mask.resize(256 * 1024 + 1, 0xFF);
  auto invalid_backend = ValidBackend();
  catalog.Install(invalid_profile, Discovery());
  Require(!catalog.Revalidate(invalid_backend) && invalid_backend.batch_calls == 0,
          "a single oversized evidence range reached the backend");
}

void TestTransitiveDependencyQuarantine() {
  SessionCatalog catalog;
  catalog.Install(ClosureBundle(), ClosureDiscovery());
  Backend backend;
  backend.reads = {{0x3000, {9}},
                   {0x4004, {0, 0, 20, 0}},
                   {0x5004, {0, 0, 40, 0}}};
  Require(!catalog.Revalidate(backend), "target mismatch did not fail validation");
  Require(!catalog.GetHandle(100) && !catalog.GetHandle(200) &&
              !catalog.GetHandle(300),
          "dependency quarantine did not compute transitive closure");
  const auto unrelated = catalog.GetHandle(400);
  Require(unrelated && catalog.Resolve(*unrelated),
          "dependency quarantine removed unrelated descriptor");
}
}  // namespace

int main() {
  try {
    TestGenerationAndPublicSurface();
    TestLifecycleAndRevalidation();
    TestBoundedBatchRevalidation();
    TestChunkFailuresAndInstability();
    TestTransitiveDependencyQuarantine();
    std::cout << "frtk catalog smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk catalog smoke failed: " << error.what() << '\n';
    return 1;
  }
}
