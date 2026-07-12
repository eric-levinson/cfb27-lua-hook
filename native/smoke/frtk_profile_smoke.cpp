#include "../host/frtk_profile.h"

#include <nlohmann/json.hpp>

#include <iostream>
#include <stdexcept>
#include <string>

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
        {"profileId", std::string(64, 'A')},
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

void TestValidProfile() {
  const auto result = cfb27::frtk::ParseProfile(ValidBundle());
  Require(result.ok(), result.error.c_str());
  Require(result.bundle->profile_id == std::string(64, 'A'), "profile ID lost");
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
}

void TestDuplicatesAndRelationships() {
  auto duplicate_table = ValidBundle();
  duplicate_table["profile"]["tables"].push_back(
      duplicate_table["profile"]["tables"][0]);
  RequireRejected(duplicate_table, "duplicate table ID accepted");
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
    TestDuplicatesAndRelationships();
    std::cout << "frtk profile smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk profile smoke failed: " << error.what() << '\n';
    return 1;
  }
}
