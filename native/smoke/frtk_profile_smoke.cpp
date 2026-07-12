#include "../host/frtk_profile.h"

#include <nlohmann/json.hpp>

#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

using nlohmann::json;

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
  source_layout["authorityStatus"] = "commit_adapter_required";
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

  return {
      {"profile",
       {{"formatVersion", 1},
        {"profileId", "1BA61F9965B24AC83659AC04E7969A99CCCC8161610545B379F4FD219A43BB76"},
        {"schemaIdentity", "synthetic-schema-v1"},
        {"buildIdentity", "synthetic-build-v1"},
        {"tables", json::array({target, source})}}},
      {"layout",
       {{"formatVersion", 1},
        {"schemaIdentity", "synthetic-schema-v1"},
        {"buildIdentity", "synthetic-build-v1"},
        {"tables", json::array({target_layout, source_layout})}}},
  };
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
              "1BA61F9965B24AC83659AC04E7969A99CCCC8161610545B379F4FD219A43BB76",
          "profile ID lost");
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

void TestCanonicalOrdering() {
  auto tables = ValidBundle();
  auto& profile_tables = tables["profile"]["tables"];
  std::swap(profile_tables[0], profile_tables[1]);
  tables["profile"]["profileId"] =
      "20E3775956F879921C4883FEAEBE80AE9BEEFAAF70B2996FBBD966B80D2D192F";
  RequireRejectedContaining(tables, "table order",
                            "noncanonical profile table order accepted");

  auto rows = ValidBundle();
  auto& target_rows = rows["profile"]["tables"][0]["rows"];
  std::swap(target_rows[0], target_rows[1]);
  rows["profile"]["profileId"] =
      "4982F834FBEA9CF80B45F1C51CE25DE692C9E45558C0DF3A3CA619D6405CD4C7";
  RequireRejectedContaining(rows, "row order",
                            "noncanonical row order accepted");

  auto relationships = ValidBundle();
  relationships["profile"]["tables"][1]["relationships"] = json::array({
      {{"sourceRow", 19}, {"fieldName", "SchoolRef"},
       {"targetTableId", 4269}, {"targetRow", 19}},
      {{"sourceRow", 19}, {"fieldName", "RecruitRef"},
       {"targetTableId", 4269}, {"targetRow", 37}},
  });
  relationships["profile"]["profileId"] =
      "F8F2D35A6B8FC420AC88079CD0FF66A8DE6EE993766AB295605E1DFB81C4EAFF";
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
  mixed_case["profile"]["profileId"] =
      "51A687B6984D0D05BFC2DCCAFB54F42CB0B444CD6C20423E0C9D8D8B704C88F9";
  const auto canonical_result = cfb27::frtk::ParseProfile(mixed_case);
  Require(canonical_result.ok(), "bytewise mixed-case relationship order rejected");
  std::swap(mixed_case["profile"]["tables"][1]["relationships"][0],
            mixed_case["profile"]["tables"][1]["relationships"][1]);
  mixed_case["profile"]["profileId"] =
      "AFA6A3DDCFB94D52FF2341DFEBE4CED4AFC118FE5D8CF30CB7F41E4F4A21AC16";
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
    TestCanonicalOrdering();
    TestDuplicatesAndRelationships();
    std::cout << "frtk profile smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk profile smoke failed: " << error.what() << '\n';
    return 1;
  }
}
