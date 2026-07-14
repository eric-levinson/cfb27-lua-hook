#include "../host/frtk_profile.h"

#include <nlohmann/json.hpp>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <bcrypt.h>

#include <array>
#include <cstdio>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

using nlohmann::json;

std::string Sha256(std::string_view content) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD received = 0;
  std::vector<std::uint8_t> object;
  std::array<std::uint8_t, 32> digest{};
  const auto cleanup = [&] {
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  };
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size),
                        &received, 0) < 0) {
    cleanup();
    throw std::runtime_error("test SHA-256 initialization failed");
  }
  object.resize(object_size);
  if (content.size() > std::numeric_limits<ULONG>::max() ||
      BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0 ||
      BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(content.data())),
                     static_cast<ULONG>(content.size()), 0) < 0 ||
      BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
    cleanup();
    throw std::runtime_error("test SHA-256 computation failed");
  }
  cleanup();
  constexpr char kHex[] = "0123456789ABCDEF";
  std::string result;
  for (const auto byte : digest) {
    result.push_back(kHex[byte >> 4]);
    result.push_back(kHex[byte & 0x0F]);
  }
  return result;
}

void RefreshProfileId(json& bundle) {
  auto profile = bundle.at("profile");
  profile.erase("profileId");
  bundle["profile"]["profileId"] =
      Sha256(json{{"profile", std::move(profile)}, {"layout", bundle.at("layout")}}.dump());
}

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

json Table(std::string name, int table_id, int unique_id, int capacity,
           int record_size) {
  return {
      {"logicalName", std::move(name)},
      {"tableId", table_id},
      {"uniqueId", unique_id},
      {"capacity", capacity},
      {"recordSize", record_size},
  };
}

std::string FieldName(std::size_t index) {
  char name[16]{};
  std::snprintf(name, sizeof(name), "Field%03zu", index);
  return name;
}

json ValidBundle() {
  auto source = Table("RecruitTarget", 4288, 428807, 100, 8);
  source["rows"] = json::array({
      {{"rowIndex", 3}, {"patternHex", "0102030405060708"},
       {"maskHex", "FFFFFFFFFFFFFFFF"}},
      {{"rowIndex", 19}, {"patternHex", "1112131415161718"},
       {"maskHex", "FFFFFFFFFFFFFFFF"}},
      {{"rowIndex", 37}, {"patternHex", "2122232425262728"},
       {"maskHex", "FFFFFFFFFFFFFFFF"}},
  });
  source["relationships"] = json::array({
      {{"sourceRow", 19}, {"fieldName", "RecruitRef"},
       {"targetTableId", 4269}, {"targetRow", 37}},
  });

  auto target = Table("Recruit", 4269, 426907, 80, 8);
  target["rows"] = json::array({
      {{"rowIndex", 3}, {"patternHex", "3132333435363738"},
       {"maskHex", "FFFFFFFFFFFFFFFF"}},
      {{"rowIndex", 19}, {"patternHex", "4142434445464748"},
       {"maskHex", "FFFFFFFFFFFFFFFF"}},
      {{"rowIndex", 37}, {"patternHex", "5152535455565758"},
       {"maskHex", "FFFFFFFFFFFFFFFF"}},
  });
  target["relationships"] = json::array();

  auto source_layout = Table("RecruitTarget", 4288, 428807, 100, 8);
  source_layout["authorityStatus"] = "discovery_only";
  source_layout["fields"] = json::array({
      {{"name", "RecruitRef"}, {"encoding", "packed-reference"},
       {"byteOffset", 0}, {"storageBytes", 4}, {"bitOffset", 0},
       {"bitWidth", 32}, {"minimum", 0}, {"maximum", 0xFFFFFFFFull},
       {"referenceTableId", 4269}},
      {{"name", "CrossByte"}, {"encoding", "bitfield"},
       {"byteOffset", 4}, {"storageBytes", 2}, {"bitOffset", 5},
       {"bitWidth", 7}, {"minimum", 0}, {"maximum", 127},
       {"referenceTableId", nullptr}},
  });
  auto target_layout = Table("Recruit", 4269, 426907, 80, 8);
  target_layout["authorityStatus"] = "discovery_only";
  target_layout["fields"] = json::array({
      {{"name", "Score"}, {"encoding", "signed"}, {"byteOffset", 4},
       {"storageBytes", 2}, {"bitOffset", 2}, {"bitWidth", 11},
       {"minimum", -1024}, {"maximum", 1023},
       {"referenceTableId", nullptr}},
  });

  json bundle = {
      {"profile",
       {{"formatVersion", 1},
        {"profileId", ""},
        {"schemaIdentity", "synthetic-schema-v1"},
        {"buildIdentity", "synthetic-build-v1"},
        {"tables", json::array({target, source})}}},
      {"layout",
       {{"formatVersion", 1},
        {"schemaIdentity", "synthetic-schema-v1"},
        {"buildIdentity", "synthetic-build-v1"},
        {"tables", json::array({target_layout, source_layout})}}},
  };
  RefreshProfileId(bundle);
  return bundle;
}

json BoundedBundle(std::size_t table_count, std::size_t fingerprints = 3,
                   std::size_t relationships = 0, std::size_t fields = 1) {
  json profile_tables = json::array();
  json layout_tables = json::array();
  for (std::size_t index = 0; index < table_count; ++index) {
    const auto table_id = static_cast<int>(index + 1);
    auto profile = Table("Table" + std::to_string(index), table_id,
                         static_cast<int>(1000 + index), 128, 8);
    profile["rows"] = json::array();
    for (std::size_t row = 0; row < fingerprints; ++row) {
      char pattern[17]{};
      std::snprintf(pattern, sizeof(pattern), "%08X%08X",
                    static_cast<unsigned>(index), static_cast<unsigned>(row + 1));
      profile["rows"].push_back({{"rowIndex", row}, {"patternHex", pattern},
                                  {"maskHex", "FFFFFFFFFFFFFFFF"}});
    }
    profile["relationships"] = json::array();
    for (std::size_t relationship = 0; relationship < relationships; ++relationship) {
      profile["relationships"].push_back({
          {"sourceRow", relationship}, {"fieldName", FieldName(relationship)},
          {"targetTableId", table_id}, {"targetRow", 0}});
    }
    profile_tables.push_back(std::move(profile));

    auto layout = Table("Table" + std::to_string(index), table_id,
                        static_cast<int>(1000 + index), 128, 8);
    layout["authorityStatus"] = "discovery_only";
    layout["fields"] = json::array();
    for (std::size_t field = 0; field < fields; ++field) {
      layout["fields"].push_back({
          {"name", FieldName(field)}, {"encoding", "unsigned"},
          {"byteOffset", 0}, {"storageBytes", 1}, {"bitOffset", 0},
          {"bitWidth", 8}, {"minimum", 0}, {"maximum", 255},
          {"referenceTableId", nullptr}});
    }
    layout_tables.push_back(std::move(layout));
  }
  json bundle = {
      {"profile", {{"formatVersion", 1}, {"profileId", ""},
                   {"schemaIdentity", "bounded-schema"},
                   {"buildIdentity", "bounded-build"},
                   {"tables", std::move(profile_tables)}}},
      {"layout", {{"formatVersion", 1}, {"schemaIdentity", "bounded-schema"},
                  {"buildIdentity", "bounded-build"},
                  {"tables", std::move(layout_tables)}}},
  };
  RefreshProfileId(bundle);
  return bundle;
}

void RequireRejected(const json& value, const char* message) {
  const auto result = cfb27::frtk::ParseProfile(value);
  Require(!result.ok() && !result.error.empty(), message);
}

void RequireRejectedContaining(const json& value, std::string_view expected,
                               const char* message) {
  const auto result = cfb27::frtk::ParseProfile(value);
  Require(!result.ok() && result.error.find(expected) != std::string::npos,
          message);
}

void TestValidProfile() {
  const auto result = cfb27::frtk::ParseProfile(ValidBundle());
  Require(result.ok(), result.error.c_str());
  Require(result.bundle->profile_id ==
              ValidBundle()["profile"]["profileId"].get<std::string>(),
          "profile ID lost");
  Require(result.bundle->profile_id ==
              "578E6F8266A8CD1CDE203D9D75AB4F9F74A893769BC54BF39871E9160823CDAE",
          "native digest differs from the JavaScript canonical digest");
  Require(result.bundle->tables.size() == 2, "table count mismatch");
  Require(result.bundle->tables[0].table_id == 4269, "table order changed");
  Require(result.bundle->tables[1].rows[1].row_index == 19, "row order changed");
  Require(result.bundle->tables[1].relationships[0].target_table_id == 4269,
          "relationship lost");
  Require(result.bundle->schema.FindTable(4288) != nullptr,
          "schema was not attached");
}

void TestExactKeysAndVersions() {
  auto extra = ValidBundle();
  extra["profile"]["generatedAt"] = "never";
  RequireRejected(extra, "profile extra key accepted");
  auto missing = ValidBundle();
  missing["profile"].erase("profileId");
  RequireRejected(missing, "profile missing key accepted");
  auto version = ValidBundle();
  version["layout"]["formatVersion"] = 2;
  RequireRejected(version, "layout version 2 accepted");
  auto profile_id = ValidBundle();
  profile_id["profile"]["profileId"] = std::string(64, 'a');
  RequireRejected(profile_id, "lowercase profile ID accepted");
}

void TestIdentityAndTableIdentity() {
  auto invalid_bytes = ValidBundle();
  invalid_bytes["profile"]["schemaIdentity"] = std::string("\xED\xA0\x80", 3);
  invalid_bytes["layout"]["schemaIdentity"] = std::string("\xED\xA0\x80", 3);
  RequireRejectedContaining(invalid_bytes, "Invalid schema identity",
                            "invalid UTF-8 profile identity accepted");
  auto identity = ValidBundle();
  identity["layout"]["buildIdentity"] = "other-build";
  RequireRejected(identity, "build identity mismatch accepted");
  auto schema = ValidBundle();
  schema["layout"]["schemaIdentity"] = "other-schema";
  RequireRejected(schema, "schema identity mismatch accepted");
  auto dimensions = ValidBundle();
  dimensions["layout"]["tables"][0]["recordSize"] = 7;
  RequireRejected(dimensions, "table dimension mismatch accepted");
  auto unique_id = ValidBundle();
  unique_id["layout"]["tables"][0]["uniqueId"] =
      unique_id["layout"]["tables"][0]["uniqueId"].get<int>() + 1;
  RequireRejected(unique_id, "per-table unique ID mismatch accepted");
  auto table_id = ValidBundle();
  table_id["layout"]["tables"][0]["tableId"] = 7000;
  RequireRejected(table_id, "per-table table ID mismatch accepted");
}

void TestRows() {
  auto too_few = ValidBundle();
  too_few["profile"]["tables"][0]["rows"].erase(2);
  RequireRejected(too_few, "fewer than three rows accepted");
  auto duplicate_index = ValidBundle();
  duplicate_index["profile"]["tables"][0]["rows"][2]["rowIndex"] = 19;
  RequireRejected(duplicate_index, "duplicate row accepted");
  auto duplicate_pattern = ValidBundle();
  duplicate_pattern["profile"]["tables"][0]["rows"][2]["patternHex"] =
      duplicate_pattern["profile"]["tables"][0]["rows"][1]["patternHex"];
  RequireRejected(duplicate_pattern, "duplicate occupied pattern accepted");
  auto lowercase = ValidBundle();
  lowercase["profile"]["tables"][0]["rows"][0]["patternHex"] =
      "01020304050607aa";
  RequireRejected(lowercase, "lowercase pattern accepted");
  auto unequal = ValidBundle();
  unequal["profile"]["tables"][0]["rows"][0]["maskHex"] = "FFFFFFFF";
  RequireRejected(unequal, "short mask accepted");
  auto unmasked = ValidBundle();
  unmasked["profile"]["tables"][0]["rows"][0]["maskHex"] =
      "00FFFFFFFFFFFFFF";
  RequireRejected(unmasked, "unmasked pattern bits accepted");
  auto bounds = ValidBundle();
  bounds["profile"]["tables"][0]["rows"][0]["rowIndex"] = 80;
  RequireRejected(bounds, "row outside capacity accepted");
  auto weak_mask = ValidBundle();
  auto& weak_rows = weak_mask["profile"]["tables"][0]["rows"];
  for (std::size_t index = 0; index < weak_rows.size(); ++index) {
    weak_rows[index]["maskHex"] = "0300000000000000";
    weak_rows[index]["patternHex"] =
        std::string("0") + std::to_string(index + 1) + "00000000000000";
  }
  RequireRejectedContaining(weak_mask, "64 selected bits",
                            "weak mask did not reach aggregate gate");
}

void TestProfileIdIntegrity() {
  auto mutation = ValidBundle();
  mutation["profile"]["tables"][0]["rows"][0]["patternHex"] =
      "3132333435363739";
  RequireRejectedContaining(mutation, "Profile ID",
                            "mutated content retained a stale profile ID");
}

void TestLayoutIntegrityAndAuthority() {
  auto layout_mutation = ValidBundle();
  layout_mutation["layout"]["tables"][0]["fields"][0]["maximum"] = 1022;
  RequireRejectedContaining(layout_mutation, "Profile ID",
                            "mutated layout retained a stale profile ID");
  for (const char* authority : {"commit_adapter_required", "direct_verified"}) {
    auto promoted = ValidBundle();
    promoted["layout"]["tables"][0]["authorityStatus"] = authority;
    RefreshProfileId(promoted);
    RequireRejectedContaining(promoted, "discovery_only",
                              "file artifact granted promoted authority");
  }
}

void TestArtifactBounds() {
  Require(cfb27::frtk::ParseProfile(BoundedBundle(256)).ok(),
          "256-table boundary rejected");
  RequireRejectedContaining(BoundedBundle(257), "256 tables",
                            "257 tables accepted");

  Require(cfb27::frtk::ParseProfile(BoundedBundle(128, 8)).ok(),
          "1024-fingerprint boundary rejected");
  RequireRejectedContaining(BoundedBundle(1, 9), "8 fingerprints",
                            "nine fingerprints in one table accepted");
  auto fingerprint_total = BoundedBundle(129, 8);
  auto& penultimate_rows = fingerprint_total["profile"]["tables"][127]["rows"];
  penultimate_rows.erase(penultimate_rows.begin() + 6, penultimate_rows.end());
  auto& final_rows = fingerprint_total["profile"]["tables"][128]["rows"];
  final_rows.erase(final_rows.begin() + 3, final_rows.end());
  RefreshProfileId(fingerprint_total);
  RequireRejectedContaining(fingerprint_total, "1024 fingerprints",
                            "aggregate fingerprint overflow accepted");

  const auto relationship_boundary =
      cfb27::frtk::ParseProfile(BoundedBundle(64, 3, 64, 64));
  Require(relationship_boundary.ok(), relationship_boundary.error.c_str());
  RequireRejectedContaining(BoundedBundle(1, 3, 65, 65), "64 relationships",
                            "65 relationships in one table accepted");
  auto relationship_total = BoundedBundle(65, 3, 64, 64);
  auto& final_relationships =
      relationship_total["profile"]["tables"][64]["relationships"];
  final_relationships.erase(final_relationships.begin() + 1,
                            final_relationships.end());
  RefreshProfileId(relationship_total);
  RequireRejectedContaining(relationship_total, "4096 relationships",
                            "aggregate relationship overflow accepted");

  const auto field_boundary = cfb27::frtk::ParseProfile(BoundedBundle(64, 3, 0, 512));
  Require(field_boundary.ok(), field_boundary.error.c_str());
  RequireRejectedContaining(BoundedBundle(1, 3, 0, 513), "512 fields",
                            "513 fields in one table accepted");
  auto field_total = BoundedBundle(65, 3, 0, 512);
  auto& final_fields = field_total["layout"]["tables"][64]["fields"];
  final_fields.erase(final_fields.begin() + 1, final_fields.end());
  RefreshProfileId(field_total);
  RequireRejectedContaining(field_total, "32768 fields",
                            "aggregate field overflow accepted");
}

void TestNameByteBounds() {
  std::string boundary;
  for (int index = 0; index < 64; ++index) boundary += "\xC3\xA9";
  auto names = BoundedBundle(1, 3, 1, 1);
  names["profile"]["tables"][0]["logicalName"] = boundary;
  names["layout"]["tables"][0]["logicalName"] = boundary;
  names["profile"]["tables"][0]["relationships"][0]["fieldName"] = boundary;
  names["layout"]["tables"][0]["fields"][0]["name"] = boundary;
  RefreshProfileId(names);
  Require(cfb27::frtk::ParseProfile(names).ok(), "128-byte names rejected");

  auto table = names;
  table["profile"]["tables"][0]["logicalName"] = boundary + "a";
  table["layout"]["tables"][0]["logicalName"] = boundary + "a";
  RefreshProfileId(table);
  RequireRejectedContaining(table, "128 UTF-8 bytes", "129-byte table name accepted");
  auto relationship = names;
  relationship["profile"]["tables"][0]["relationships"][0]["fieldName"] = boundary + "a";
  RefreshProfileId(relationship);
  RequireRejectedContaining(relationship, "128 UTF-8 bytes",
                            "129-byte relationship field name accepted");
  auto field = names;
  field["layout"]["tables"][0]["fields"][0]["name"] = boundary + "a";
  RefreshProfileId(field);
  RequireRejectedContaining(field, "128 UTF-8 bytes", "129-byte field name accepted");

  auto invalid_table = BoundedBundle(1);
  invalid_table["profile"]["tables"][0]["logicalName"] = std::string("\xC3\x28", 2);
  RequireRejectedContaining(invalid_table, "valid UTF-8",
                            "invalid UTF-8 profile table name accepted");
  auto invalid_relationship = BoundedBundle(1, 3, 1, 1);
  invalid_relationship["profile"]["tables"][0]["relationships"][0]["fieldName"] =
      std::string("\xED\xA0\x80", 3);
  RequireRejectedContaining(invalid_relationship, "valid UTF-8",
                            "UTF-8 encoded surrogate relationship name accepted");
}

void TestCanonicalOrdering() {
  auto tables = ValidBundle();
  auto& profile_tables = tables["profile"]["tables"];
  std::swap(profile_tables[0], profile_tables[1]);
  RefreshProfileId(tables);
  RequireRejectedContaining(tables, "table order",
                            "noncanonical profile table order accepted");

  auto rows = ValidBundle();
  auto& target_rows = rows["profile"]["tables"][0]["rows"];
  std::swap(target_rows[0], target_rows[1]);
  RefreshProfileId(rows);
  RequireRejectedContaining(rows, "row order",
                            "noncanonical row order accepted");

  auto relationships = ValidBundle();
  relationships["profile"]["tables"][1]["relationships"] = json::array({
      {{"sourceRow", 19}, {"fieldName", "SchoolRef"},
       {"targetTableId", 4269}, {"targetRow", 19}},
      {{"sourceRow", 19}, {"fieldName", "RecruitRef"},
       {"targetTableId", 4269}, {"targetRow", 37}},
  });
  RefreshProfileId(relationships);
  RequireRejectedContaining(relationships, "relationship order",
                            "noncanonical relationship order accepted");

  auto layout_tables = ValidBundle();
  auto& schema_tables = layout_tables["layout"]["tables"];
  std::swap(schema_tables[0], schema_tables[1]);
  RequireRejectedContaining(layout_tables, "table order",
                            "noncanonical layout table order accepted");

  auto fields = ValidBundle();
  auto& source_fields = fields["layout"]["tables"][1]["fields"];
  std::swap(source_fields[0], source_fields[1]);
  RequireRejectedContaining(fields, "field order",
                            "noncanonical field order accepted");

  auto mixed_case = ValidBundle();
  mixed_case["profile"]["tables"][1]["relationships"] = json::array({
      {{"sourceRow", 19}, {"fieldName", "Beta"},
       {"targetTableId", 4269}, {"targetRow", 19}},
      {{"sourceRow", 19}, {"fieldName", "alpha"},
       {"targetTableId", 4269}, {"targetRow", 37}},
  });
  RefreshProfileId(mixed_case);
  const auto canonical_result = cfb27::frtk::ParseProfile(mixed_case);
  Require(canonical_result.ok(), "bytewise mixed-case relationship order rejected");
  std::swap(mixed_case["profile"]["tables"][1]["relationships"][0],
            mixed_case["profile"]["tables"][1]["relationships"][1]);
  RefreshProfileId(mixed_case);
  RequireRejectedContaining(mixed_case, "relationship order",
                            "locale-style mixed-case relationship order accepted");
}

void TestDuplicatesAndRelationships() {
  auto duplicate_table = ValidBundle();
  duplicate_table["profile"]["tables"].push_back(
      duplicate_table["profile"]["tables"][0]);
  RequireRejected(duplicate_table, "duplicate table ID accepted");
  auto duplicate_unique_id = ValidBundle();
  duplicate_unique_id["profile"]["tables"][1]["uniqueId"] =
      duplicate_unique_id["profile"]["tables"][0]["uniqueId"];
  RequireRejectedContaining(duplicate_unique_id, "Duplicate unique ID in profile",
                            "duplicate profile unique ID accepted");
  auto unknown = ValidBundle();
  unknown["profile"]["tables"][1]["relationships"][0]["targetTableId"] = 9999;
  RequireRejected(unknown, "unknown relationship target accepted");
  auto target_bounds = ValidBundle();
  target_bounds["profile"]["tables"][1]["relationships"][0]["targetRow"] = 80;
  RequireRejected(target_bounds, "relationship row outside target capacity accepted");
  auto duplicate_relationship = ValidBundle();
  duplicate_relationship["profile"]["tables"][1]["relationships"].push_back(
      duplicate_relationship["profile"]["tables"][1]["relationships"][0]);
  RequireRejected(duplicate_relationship, "duplicate relationship accepted");
}

}  // namespace

int main() {
  try {
    TestValidProfile();
    TestExactKeysAndVersions();
    TestIdentityAndTableIdentity();
    TestRows();
    TestProfileIdIntegrity();
    TestLayoutIntegrityAndAuthority();
    TestArtifactBounds();
    TestNameByteBounds();
    TestCanonicalOrdering();
    TestDuplicatesAndRelationships();
    std::cout << "frtk profile smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk profile smoke failed: " << error.what() << '\n';
    return 1;
  }
}
