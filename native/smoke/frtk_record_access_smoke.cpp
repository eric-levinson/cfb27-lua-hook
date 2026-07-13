#include "../host/frtk_record_access.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>

namespace {
using namespace cfb27::frtk;

void Require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

nlohmann::json Field(const char* name, const char* encoding, unsigned offset,
                     unsigned bytes, unsigned bit_offset, unsigned width,
                     std::int64_t maximum,
                     std::optional<unsigned> target = std::nullopt) {
  return {{"name", name}, {"encoding", encoding}, {"byteOffset", offset},
          {"storageBytes", bytes}, {"bitOffset", bit_offset},
          {"bitWidth", width}, {"minimum", 0}, {"maximum", maximum},
          {"referenceTableId", target ? nlohmann::json(*target) : nlohmann::json(nullptr)}};
}

ProfileBundle Bundle(const char* authority) {
  ProfileBundle result;
  result.profile_id = "access-profile";
  result.tables = {{.logical_name = "Target", .table_id = 22, .unique_id = 220022,
                    .capacity = 3, .record_size = 8},
                   {.logical_name = "Record", .table_id = 33, .unique_id = 330033,
                    .capacity = 2, .record_size = 8}};
  std::string error;
  const auto schema = nlohmann::json{
      {"formatVersion", 1}, {"schemaIdentity", "access-schema"},
      {"buildIdentity", "access-build"},
      {"tables", nlohmann::json::array({
        {{"logicalName", "Target"}, {"tableId", 22}, {"uniqueId", 220022},
         {"capacity", 3}, {"recordSize", 8}, {"authorityStatus", authority},
         {"fields", nlohmann::json::array()}},
        {{"logicalName", "Record"}, {"tableId", 33}, {"uniqueId", 330033},
         {"capacity", 2}, {"recordSize", 8}, {"authorityStatus", authority},
         {"fields", nlohmann::json::array({
           Field("Flags", "bitfield", 0, 1, 2, 3, 7),
           Field("Score", "unsigned", 1, 2, 0, 16, 65535),
           Field("Other", "unsigned", 3, 2, 0, 16, 65535),
           Field("TargetRef", "packed-reference", 4, 4, 0, 32, 0xFFFFFFFFll, 22)
         })}}
      })}};
  Require(result.schema.LoadTrustedForTesting(schema, &error), error.c_str());
  return result;
}

DiscoveryResult Discovery() {
  return {.tables = {
      {.unique_id = 220022, .state = TableState::kResolved,
       .descriptor = TableDescriptor{.unique_id = 220022, .base = 0x1000,
          .stride = 8, .capacity = 3, .allocation_base = 0x1000,
          .allocation_size = 24}},
      {.unique_id = 330033, .state = TableState::kResolved,
       .descriptor = TableDescriptor{.unique_id = 330033, .base = 0x2000,
          .stride = 8, .capacity = 2, .allocation_base = 0x2000,
          .allocation_size = 16}}
  }};
}

class Backend final : public DiscoveryBackend, public cfb27::memory::MemoryBackend {
 public:
  std::map<std::uintptr_t, std::vector<std::uint8_t>> records;
  std::map<std::uintptr_t, std::vector<std::uint8_t>> validation_reads;
  std::size_t record_reads{};
  ScanObservationResult Scan(const RowFingerprint&, std::size_t) override { return {}; }
  bool ReadBatch(std::span<const ReadRequest> requests,
                 std::vector<std::vector<std::uint8_t>>& out) override {
    out.clear();
    for (const auto& request : requests) {
      const auto found = validation_reads.find(request.address);
      if (found == validation_reads.end() ||
          found->second.size() != request.length) return false;
      out.push_back(found->second);
    }
    return true;
  }
  bool AllocationExists(std::uintptr_t, std::size_t) override { return true; }
  bool Validate(std::uintptr_t address, std::size_t size, bool) override {
    return records.contains(address) && records[address].size() == size;
  }
  bool Read(std::uintptr_t address, std::span<std::uint8_t> output) override {
    auto found = records.find(address);
    if (found == records.end() || found->second.size() != output.size()) return false;
    ++record_reads;
    std::copy(found->second.begin(), found->second.end(), output.begin());
    return true;
  }
  bool Write(std::uintptr_t, std::span<const std::uint8_t>) override { return false; }
};

class LinearBackend final : public DiscoveryBackend,
                            public cfb27::memory::MemoryBackend {
 public:
  void Store(std::uintptr_t address, std::initializer_list<std::uint8_t> value) {
    std::size_t index = 0;
    for (const auto byte : value) bytes[address + index++] = byte;
  }
  void Store(std::uintptr_t address, const std::vector<std::uint8_t>& value) {
    for (std::size_t index = 0; index < value.size(); ++index)
      bytes[address + index] = value[index];
  }
  ScanObservationResult Scan(const RowFingerprint&, std::size_t) override {
    return {};
  }
  bool ReadBatch(std::span<const ReadRequest> requests,
                 std::vector<std::vector<std::uint8_t>>& out) override {
    out.clear();
    for (const auto& request : requests) {
      std::vector<std::uint8_t> value(request.length);
      if (!Read(request.address, value)) return false;
      out.push_back(std::move(value));
    }
    return true;
  }
  bool AllocationExists(std::uintptr_t, std::size_t) override { return true; }
  bool Validate(std::uintptr_t address, std::size_t size, bool) override {
    for (std::size_t index = 0; index < size; ++index)
      if (!bytes.contains(address + index)) return false;
    return size != 0;
  }
  bool Read(std::uintptr_t address, std::span<std::uint8_t> output) override {
    if (!Validate(address, output.size(), false)) return false;
    for (std::size_t index = 0; index < output.size(); ++index)
      output[index] = bytes[address + index];
    return true;
  }
  bool Write(std::uintptr_t address,
             std::span<const std::uint8_t> input) override {
    ++write_calls;
    if (!Validate(address, input.size(), true)) return false;
    for (std::size_t index = 0; index < input.size(); ++index)
      bytes[address + index] = input[index];
    return true;
  }
  std::map<std::uintptr_t, std::uint8_t> bytes;
  std::size_t write_calls{};
};

ProfileBundle EvidenceBundle() {
  auto result = Bundle("direct_verified");
  result.tables[0].rows = {
      {.row_index = 0, .pattern = {0x11, 0x22}, .mask = {0xFF, 0xF0}}};
  result.tables[1].rows = {
      {.row_index = 0, .pattern = {0xA1}, .mask = {0xFF}}};
  result.tables[1].relationships = {
      {.source_row = 0, .field_name = "TargetRef", .target_table_id = 22,
       .target_row = 2}};
  return result;
}

LinearBackend EvidenceBackend() {
  LinearBackend backend;
  backend.Store(0x1000, {0x11, 0x2F, 0, 0, 0, 0, 0, 0});
  backend.Store(0x1008, {0, 0, 0, 0, 0, 0, 0, 0});
  backend.Store(0x1010, {0, 0, 0, 0, 0, 0, 0, 0});
  backend.Store(0x2000, {0xA1, 0x12, 0x34, 0x78, 0, 44, 0, 2});
  backend.Store(0x2008, {0xA1, 0x33, 0x44, 0x78, 0, 44, 0, 2});
  return backend;
}

void TestReadsAndValidation() {
  auto profile = Bundle("direct_verified");
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  Backend backend;
  backend.records[0x2000] = {0x9D, 0x12, 0x34, 0, 0, 44, 0, 2};
  RecordAccessor accessor(catalog, profile.schema, backend, backend);
  const auto handle = *catalog.GetHandle(330033);
  const auto read = accessor.ReadFields(handle, 0, {"Flags", "Score", "TargetRef"});
  Require(read.ok && read.fields.size() == 3 && backend.record_reads == 1,
          "fields were not decoded from one full-record snapshot");
  Require(std::get<std::int64_t>(read.fields[0].value) == 3 &&
              std::get<std::int64_t>(read.fields[1].value) == 0x1234,
          "typed values decoded incorrectly");
  Require(!accessor.ReadFields(handle, 2, {"Score"}).ok,
          "out-of-bounds row accepted");
  Require(!accessor.ReadFields(handle, 0, {"Missing"}).ok,
          "unknown field accepted");

  auto unsupported_profile = Bundle("direct_verified");
  auto& unsupported_tables = const_cast<std::vector<TableSchema>&>(
      unsupported_profile.schema.tables());
  unsupported_tables[1].fields[1].encoding = "float";
  SessionCatalog unsupported_catalog;
  unsupported_catalog.Install(unsupported_profile, Discovery());
  Backend unsupported_backend;
  unsupported_backend.records[0x2000] = backend.records[0x2000];
  RecordAccessor unsupported(unsupported_catalog, unsupported_profile.schema,
                             unsupported_backend, unsupported_backend);
  const auto unsupported_read = unsupported.ReadFields(
      *unsupported_catalog.GetHandle(330033), 0, {"Score"});
  Require(!unsupported_read.ok && unsupported_read.code == "FIELD_INVALID",
          "unsupported field encoding did not fail closed");

  backend.records[0x2000] = {0, 0, 0, 0, 0, 44, 0, 3};
  Require(!accessor.ReadFields(handle, 0, {"TargetRef"}).ok,
          "packed-reference target row bounds ignored");
}

void TestPlansAndAuthority() {
  auto profile = Bundle("direct_verified");
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  Backend backend;
  backend.records[0x2000] = {0xA1, 0x12, 0x34, 0x56, 0x78, 4, 0, 44};
  RecordAccessor accessor(catalog, profile.schema, backend, backend);
  const auto handle = *catalog.GetHandle(330033);
  const auto plan = accessor.PlanFieldWrites(
      handle, 0, {{"Flags", std::int64_t{5}}, {"Score", std::int64_t{0x5678}},
                  {"Other", std::int64_t{0x9ABC}}});
  Require(plan.ok && plan.operations.size() == 1,
          "adjacent changes were not collapsed into a minimal byte run");
  Require(plan.operations[0].expected == std::vector<std::uint8_t>({0xA1, 0x12, 0x34, 0x56, 0x78}) &&
              plan.operations[0].replacement == std::vector<std::uint8_t>({0xA9, 0x56, 0x78, 0x9A, 0xBC}),
          "bitfield write damaged adjacent bits or byte-run contents");
  const auto bad_reference = accessor.PlanFieldWrites(
      handle, 0, {{"TargetRef", PackedReference{22, 3}}});
  Require(!bad_reference.ok && bad_reference.code == "FIELD_INVALID",
          "out-of-range packed-reference write was planned");

  for (const char* authority : {"discovery_only", "commit_adapter_required"}) {
    auto gated_profile = Bundle(authority);
    SessionCatalog gated_catalog;
    gated_catalog.Install(gated_profile, Discovery());
    Backend gated_backend;
    gated_backend.records[0x2000] = backend.records[0x2000];
    RecordAccessor gated(gated_catalog, gated_profile.schema, gated_backend, gated_backend);
    const auto denied = gated.PlanFieldWrites(*gated_catalog.GetHandle(330033), 0,
                                               {{"Score", std::int64_t{7}}});
    Require(!denied.ok && denied.code == "AUTHORITY_UNPROVEN" &&
                gated_backend.record_reads == 0,
            "unproven authority reached transaction planning");
  }

  auto installed = Bundle("discovery_only");
  auto external = Bundle("direct_verified");
  SessionCatalog installed_catalog;
  installed_catalog.Install(installed, Discovery());
  Backend mismatched_backend;
  mismatched_backend.records[0x2000] = backend.records[0x2000];
  RecordAccessor mismatched(installed_catalog, external.schema,
                            mismatched_backend, mismatched_backend);
  const auto mismatched_plan = mismatched.PlanFieldWrites(
      *installed_catalog.GetHandle(330033), 0,
      {{"Score", std::int64_t{7}}});
  Require(!mismatched_plan.ok &&
              mismatched_plan.code == "AUTHORITY_UNPROVEN" &&
              mismatched_plan.operations.empty() &&
              mismatched_backend.record_reads == 0,
          "external schema escalated installed table authority");
}

void TestPackedReferenceRequiresActiveTarget() {
  auto profile = Bundle("direct_verified");
  profile.tables[0].rows = {
      {.row_index = 0, .pattern = {1}, .mask = {255}}};
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  Backend backend;
  backend.validation_reads[0x1000] = {9};
  backend.records[0x2000] = {0, 0, 0, 0, 0, 44, 0, 2};
  Require(!catalog.Revalidate(backend) && !catalog.GetHandle(220022) &&
              catalog.GetHandle(330033),
          "fixture did not quarantine only packed-reference target");
  RecordAccessor accessor(catalog, profile.schema, backend, backend);
  const auto result = accessor.ReadFields(*catalog.GetHandle(330033), 0,
                                          {"TargetRef"});
  Require(!result.ok && result.code == "FIELD_INVALID",
          "packed reference accepted a target absent from active catalog");
}

void TestEvidenceBoundTransactionRejectsStaleReadableCopy() {
  for (const auto [changed_address, changed_value] :
       {std::pair{std::uintptr_t{0x1000}, std::uint8_t{0x99}},
        std::pair{std::uintptr_t{0x2004}, std::uint8_t{0x03}}}) {
    auto profile = EvidenceBundle();
    SessionCatalog catalog;
    catalog.Install(profile, Discovery());
    auto backend = EvidenceBackend();
    RecordAccessor accessor(catalog, profile.schema, backend, backend);
    const auto handle = *catalog.GetHandle(330033);
    const auto plan = accessor.PlanFieldWrites(
        handle, 0, {{"Score", std::int64_t{0x5678}}});
    const auto guarded =
        FinalizeFieldTransaction(catalog, "evidence-race", {plan});
    Require(guarded.ok, "guarded transaction did not plan");

    // Deterministic old race: validation already passed; relocation leaves the
    // old allocation readable and requested field bytes unchanged, but either
    // a descriptor sentinel or relationship byte changes before preflight.
    backend.bytes[changed_address] = changed_value;
    const auto result =
        cfb27::memory::RunTransaction(guarded.request, backend);
    Require(result.status == cfb27::memory::TransactionStatus::kRejected &&
                backend.write_calls == 0 && backend.bytes[0x2001] == 0x12,
            "stale readable descriptor copy received a field write");
  }
}

void TestEvidenceMergeMultiRecordAndGeneration() {
  auto profile = EvidenceBundle();
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  auto backend = EvidenceBackend();
  RecordAccessor accessor(catalog, profile.schema, backend, backend);
  const auto handle = *catalog.GetHandle(330033);
  const auto first = accessor.PlanFieldWrites(
      handle, 0, {{"Flags", std::int64_t{5}}});
  const auto second = accessor.PlanFieldWrites(
      handle, 1, {{"Score", std::int64_t{0x5566}}});
  const auto guarded =
      FinalizeFieldTransaction(catalog, "multi-record", {first, second});
  Require(guarded.ok && guarded.request.operations.size() == 4,
          "multi-record evidence was not deduplicated and merged");
  const auto overlap = std::find_if(
      guarded.request.operations.begin(), guarded.request.operations.end(),
      [](const auto& operation) { return operation.address == "0x2000"; });
  Require(overlap != guarded.request.operations.end() &&
              overlap->expected == std::vector<std::uint8_t>({0xA1}) &&
              overlap->replacement == std::vector<std::uint8_t>({0xA9}),
          "field/sentinel overlap dropped evidence or changed unrequested bits");
  Require(cfb27::memory::RunTransaction(guarded.request, backend).status ==
              cfb27::memory::TransactionStatus::kAppliedVerified,
          "multi-record guarded transaction failed");

  auto stale_backend = EvidenceBackend();
  RecordAccessor stale_accessor(catalog, profile.schema, stale_backend,
                                stale_backend);
  const auto stale_plan = stale_accessor.PlanFieldWrites(
      *catalog.GetHandle(330033), 0, {{"Score", std::int64_t{7}}});
  catalog.Invalidate();
  Require(!FinalizeFieldTransaction(catalog, "stale-generation", {stale_plan}).ok,
          "generation invalidation did not invalidate evidence snapshot");
}

void TestEvidenceLimitsFailDuringFinalization() {
  auto profile = EvidenceBundle();
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  auto backend = EvidenceBackend();
  RecordAccessor accessor(catalog, profile.schema, backend, backend);
  auto plan = accessor.PlanFieldWrites(
      *catalog.GetHandle(330033), 0, {{"Score", std::int64_t{7}}});
  Require(plan.ok, "limit fixture did not produce a base plan");

  plan.evidence.guards.clear();
  for (std::size_t index = 0; index < 33; ++index) {
    plan.evidence.guards.push_back(
        {.address = 0x3000 + index * 2, .expected = {0}});
  }
  const auto too_many =
      FinalizeFieldTransaction(catalog, "too-many-guards", {plan});
  Require(!too_many.ok && too_many.code == "TRANSACTION_LIMIT_EXCEEDED",
          "evidence bypassed the operation limit");

  plan.evidence.guards.clear();
  for (std::size_t index = 0; index < 17; ++index) {
    plan.evidence.guards.push_back(
        {.address = 0x10000 + index * 0x2000,
         .expected = std::vector<std::uint8_t>(4096, 0)});
  }
  const auto too_large =
      FinalizeFieldTransaction(catalog, "too-many-bytes", {plan});
  Require(!too_large.ok && too_large.code == "TRANSACTION_LIMIT_EXCEEDED",
          "evidence bypassed the aggregate byte limit");

  plan.evidence.guards = {
      {.address = 0x4000,
       .expected = std::vector<std::uint8_t>(4096, 0)}};
  plan.operations = {{.address = "0x4FFF",
                      .expected = {0, 0},
                      .replacement = {1, 1}}};
  const auto unsplittable =
      FinalizeFieldTransaction(catalog, "overlap-too-wide", {plan});
  Require(!unsplittable.ok &&
              unsplittable.code == "TRANSACTION_LIMIT_EXCEEDED",
          "overlapping guard/write span was split and lost atomic evidence");
}
}  // namespace

int main() {
  try {
    TestReadsAndValidation();
    TestPackedReferenceRequiresActiveTarget();
    TestPlansAndAuthority();
    TestEvidenceBoundTransactionRejectsStaleReadableCopy();
    TestEvidenceMergeMultiRecordAndGeneration();
    TestEvidenceLimitsFailDuringFinalization();
    std::cout << "frtk record access smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk record access smoke failed: " << error.what() << '\n';
    return 1;
  }
}
