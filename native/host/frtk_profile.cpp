#include "frtk_profile.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <bit>
#include <cctype>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace cfb27::frtk {
namespace {

using nlohmann::json;

bool HasExactKeys(const json& value,
                  std::initializer_list<std::string_view> expected) {
  if (!value.is_object() || value.size() != expected.size()) return false;
  for (const auto key : expected) {
    if (!value.contains(std::string(key))) return false;
  }
  return true;
}

std::uint64_t UnsignedBetween(const json& value, std::uint64_t minimum,
                              std::uint64_t maximum, const char* message) {
  if (value.is_number_unsigned()) {
    const auto number = value.get<std::uint64_t>();
    if (number >= minimum && number <= maximum) return number;
  } else if (value.is_number_integer()) {
    const auto number = value.get<std::int64_t>();
    if (number >= 0 && static_cast<std::uint64_t>(number) >= minimum &&
        static_cast<std::uint64_t>(number) <= maximum) {
      return static_cast<std::uint64_t>(number);
    }
  }
  throw std::range_error(message);
}

std::string Identity(const json& value, const char* message) {
  if (!value.is_string()) throw std::invalid_argument(message);
  auto result = value.get<std::string>();
  if (result.empty() || result.size() > 128) throw std::invalid_argument(message);
  return result;
}

bool IsUpperHex(const std::string& value) {
  if (value.empty() || value.size() % 2 != 0) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return std::isdigit(character) ||
           (character >= static_cast<unsigned char>('A') &&
            character <= static_cast<unsigned char>('F'));
  });
}

std::vector<std::uint8_t> DecodeHex(const std::string& value) {
  if (!IsUpperHex(value)) throw std::range_error("Expected uppercase hex bytes");
  std::vector<std::uint8_t> result;
  result.reserve(value.size() / 2);
  const auto nibble = [](char character) -> std::uint8_t {
    return character <= '9' ? static_cast<std::uint8_t>(character - '0')
                            : static_cast<std::uint8_t>(character - 'A' + 10);
  };
  for (std::size_t index = 0; index < value.size(); index += 2) {
    result.push_back(
        static_cast<std::uint8_t>((nibble(value[index]) << 4) |
                                  nibble(value[index + 1])));
  }
  return result;
}

RowFingerprint ParseRow(const json& row, std::uint32_t capacity,
                        std::uint32_t record_size) {
  if (!HasExactKeys(row, {"rowIndex", "patternHex", "maskHex"}) ||
      !row.at("patternHex").is_string() || !row.at("maskHex").is_string()) {
    throw std::invalid_argument("Row fingerprint is invalid");
  }
  RowFingerprint result;
  result.row_index = static_cast<std::uint32_t>(UnsignedBetween(
      row.at("rowIndex"), 0, capacity - 1, "Row index exceeds capacity"));
  result.pattern = DecodeHex(row.at("patternHex").get<std::string>());
  result.mask = DecodeHex(row.at("maskHex").get<std::string>());
  if (result.pattern.size() != record_size || result.mask.size() != record_size) {
    throw std::range_error("Pattern and mask lengths must match recordSize");
  }
  for (std::size_t index = 0; index < result.pattern.size(); ++index) {
    if ((result.pattern[index] & ~result.mask[index]) != 0) {
      throw std::range_error("Pattern contains unselected bits");
    }
  }
  return result;
}

RelationshipConstraint ParseRelationship(const json& relationship,
                                         std::uint32_t capacity) {
  if (!HasExactKeys(relationship,
                    {"sourceRow", "fieldName", "targetTableId", "targetRow"}) ||
      !relationship.at("fieldName").is_string() ||
      relationship.at("fieldName").get_ref<const std::string&>().empty()) {
    throw std::invalid_argument("Relationship definition is invalid");
  }
  return {
      .source_row = static_cast<std::uint32_t>(UnsignedBetween(
          relationship.at("sourceRow"), 0, capacity - 1,
          "Relationship source row exceeds capacity")),
      .field_name = relationship.at("fieldName").get<std::string>(),
      .target_table_id = static_cast<std::uint16_t>(UnsignedBetween(
          relationship.at("targetTableId"), 0, 0x7FFF,
          "Invalid relationship target table")),
      .target_row = static_cast<std::uint32_t>(UnsignedBetween(
          relationship.at("targetRow"), 0, 0x1FFFF,
          "Invalid relationship target row")),
  };
}

TableProfile ParseTable(const json& table) {
  if (!HasExactKeys(table,
                    {"logicalName", "tableId", "uniqueId", "capacity",
                     "recordSize", "rows", "relationships"}) ||
      !table.at("logicalName").is_string() ||
      table.at("logicalName").get_ref<const std::string&>().empty() ||
      !table.at("rows").is_array() ||
      !table.at("relationships").is_array()) {
    throw std::invalid_argument("Table profile is invalid");
  }
  TableProfile result;
  result.logical_name = table.at("logicalName").get<std::string>();
  result.table_id = static_cast<std::uint16_t>(UnsignedBetween(
      table.at("tableId"), 0, 0x7FFF, "Invalid table ID"));
  result.unique_id = static_cast<std::uint32_t>(UnsignedBetween(
      table.at("uniqueId"), 0, 0xFFFFFFFFull, "Invalid unique ID"));
  result.capacity = static_cast<std::uint32_t>(UnsignedBetween(
      table.at("capacity"), 1, 0x1FFFF, "Invalid capacity"));
  result.record_size = static_cast<std::uint32_t>(UnsignedBetween(
      table.at("recordSize"), 1, 4096, "Invalid recordSize"));

  std::set<std::uint32_t> row_indexes;
  std::set<std::vector<std::uint8_t>> patterns;
  std::size_t selected_bits = 0;
  for (const auto& row : table.at("rows")) {
    auto parsed = ParseRow(row, result.capacity, result.record_size);
    if (!row_indexes.insert(parsed.row_index).second) {
      throw std::invalid_argument("Duplicate row index");
    }
    patterns.insert(parsed.pattern);
    for (const auto byte : parsed.mask) selected_bits += std::popcount(byte);
    result.rows.push_back(std::move(parsed));
  }
  if (selected_bits < 64) {
    throw std::invalid_argument("Table masks require at least 64 selected bits");
  }
  if (result.rows.size() < 3 || patterns.size() < 3) {
    throw std::invalid_argument(
        "Each table requires at least three distinct occupied rows");
  }

  std::set<std::pair<std::uint32_t, std::string>> relationship_ids;
  for (const auto& relationship : table.at("relationships")) {
    auto parsed = ParseRelationship(relationship, result.capacity);
    if (!relationship_ids.insert({parsed.source_row, parsed.field_name}).second) {
      throw std::invalid_argument(
          "Duplicate relationship source field identity");
    }
    result.relationships.push_back(std::move(parsed));
  }
  return result;
}

void ValidateTableIdentity(const TableProfile& profile,
                           const TableSchema& schema) {
  if (profile.logical_name != schema.logical_name ||
      profile.table_id != schema.table_id ||
      profile.unique_id != schema.unique_id ||
      profile.capacity != schema.capacity ||
      profile.record_size != schema.record_size) {
    throw std::invalid_argument("Profile/layout table identity mismatch");
  }
}

}  // namespace

ProfileValidationResult ParseProfile(const json& artifact) {
  try {
    if (!HasExactKeys(artifact, {"profile", "layout"}) ||
        !artifact.at("profile").is_object() ||
        !artifact.at("layout").is_object()) {
      throw std::invalid_argument("Invalid profile bundle");
    }
    const auto& profile = artifact.at("profile");
    if (!HasExactKeys(profile, {"formatVersion", "profileId",
                                "schemaIdentity", "buildIdentity", "tables"}) ||
        UnsignedBetween(profile.at("formatVersion"), 1, 1,
                        "Unsupported profile version") != 1 ||
        !profile.at("profileId").is_string() ||
        !profile.at("tables").is_array() || profile.at("tables").empty()) {
      throw std::invalid_argument("Invalid version-1 profile");
    }

    ProfileBundle bundle;
    bundle.profile_id = profile.at("profileId").get<std::string>();
    if (bundle.profile_id.size() != 64 || !IsUpperHex(bundle.profile_id)) {
      throw std::invalid_argument("Invalid profile ID");
    }
    bundle.schema_identity =
        Identity(profile.at("schemaIdentity"), "Invalid schema identity");
    bundle.build_identity =
        Identity(profile.at("buildIdentity"), "Invalid build identity");
    std::string schema_error;
    if (!bundle.schema.Load(artifact.at("layout"), &schema_error)) {
      throw std::invalid_argument(schema_error);
    }
    if (bundle.schema_identity != bundle.schema.schema_identity() ||
        bundle.build_identity != bundle.schema.build_identity()) {
      throw std::invalid_argument("Profile/layout identity mismatch");
    }

    std::set<std::uint16_t> table_ids;
    for (const auto& table : profile.at("tables")) {
      auto parsed = ParseTable(table);
      if (!table_ids.insert(parsed.table_id).second) {
        throw std::invalid_argument("Duplicate table ID in profile");
      }
      bundle.tables.push_back(std::move(parsed));
    }
    if (bundle.tables.size() != bundle.schema.tables().size()) {
      throw std::invalid_argument("Profile/layout table identity mismatch");
    }
    for (const auto& table : bundle.tables) {
      const auto* schema = bundle.schema.FindTable(table.table_id);
      if (!schema) {
        throw std::invalid_argument("Profile/layout table identity mismatch");
      }
      ValidateTableIdentity(table, *schema);
      for (const auto& relationship : table.relationships) {
        const auto found = std::find_if(
            bundle.tables.begin(), bundle.tables.end(),
            [&relationship](const TableProfile& candidate) {
              return candidate.table_id == relationship.target_table_id;
            });
        if (found == bundle.tables.end()) {
          throw std::invalid_argument("Unknown relationship target table");
        }
        if (relationship.target_row >= found->capacity) {
          throw std::range_error(
              "Relationship target row exceeds target table capacity");
        }
      }
    }
    return {.bundle = std::move(bundle), .error = {}};
  } catch (const std::exception& exception) {
    return {.bundle = std::nullopt, .error = exception.what()};
  }
}

}  // namespace cfb27::frtk
