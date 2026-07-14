#include "frtk_profile.h"

#include <nlohmann/json.hpp>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
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

constexpr std::size_t kMaxTables = 256;
constexpr std::size_t kMaxFingerprintsPerTable = 8;
constexpr std::size_t kMaxFingerprintsTotal = 1024;
constexpr std::size_t kMaxRelationshipsPerTable = 64;
constexpr std::size_t kMaxRelationshipsTotal = 4096;
constexpr std::size_t kMaxNameBytes = 128;

bool IsValidUtf8(std::string_view value) {
  for (std::size_t index = 0; index < value.size();) {
    const auto byte = static_cast<unsigned char>(value[index]);
    if (byte <= 0x7F) { ++index; continue; }
    const auto continuation = [&](std::size_t offset) {
      return index + offset < value.size() &&
             (static_cast<unsigned char>(value[index + offset]) & 0xC0) == 0x80;
    };
    if (byte >= 0xC2 && byte <= 0xDF && continuation(1)) { index += 2; continue; }
    if (byte >= 0xE0 && byte <= 0xEF && continuation(1) && continuation(2)) {
      const auto second = static_cast<unsigned char>(value[index + 1]);
      if ((byte != 0xE0 || second >= 0xA0) && (byte != 0xED || second <= 0x9F)) {
        index += 3; continue;
      }
    }
    if (byte >= 0xF0 && byte <= 0xF4 && continuation(1) && continuation(2) &&
        continuation(3)) {
      const auto second = static_cast<unsigned char>(value[index + 1]);
      if ((byte != 0xF0 || second >= 0x90) && (byte != 0xF4 || second <= 0x8F)) {
        index += 4; continue;
      }
    }
    return false;
  }
  return true;
}

std::string LogicalName(const json& value, const char* message) {
  if (!value.is_string()) throw std::invalid_argument(message);
  auto result = value.get<std::string>();
  if (!IsValidUtf8(result)) {
    throw std::invalid_argument("Logical names must use valid UTF-8");
  }
  if (result.empty() || result.size() > kMaxNameBytes) {
    throw std::invalid_argument("Logical names must use 1..128 UTF-8 bytes");
  }
  return result;
}

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
  if (!IsValidUtf8(result) || result.empty() || result.size() > 128) {
    throw std::invalid_argument(message);
  }
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

std::string Sha256Upper(std::string_view content) {
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
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_size),
                        sizeof(object_size), &received, 0) < 0) {
    cleanup();
    throw std::runtime_error("Unable to initialize SHA-256");
  }
  object.resize(object_size);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0,
                       0) < 0 ||
      content.size() > std::numeric_limits<ULONG>::max() ||
      BCryptHashData(
          hash,
          reinterpret_cast<PUCHAR>(const_cast<char*>(content.data())),
          static_cast<ULONG>(content.size()), 0) < 0 ||
      BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()),
                       0) < 0) {
    cleanup();
    throw std::runtime_error("Unable to compute SHA-256");
  }
  cleanup();
  constexpr char kHex[] = "0123456789ABCDEF";
  std::string result;
  result.reserve(digest.size() * 2);
  for (const auto byte : digest) {
    result.push_back(kHex[byte >> 4]);
    result.push_back(kHex[byte & 0x0F]);
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
      !relationship.at("fieldName").is_string()) {
    throw std::invalid_argument("Relationship definition is invalid");
  }
  return {
      .source_row = static_cast<std::uint32_t>(UnsignedBetween(
          relationship.at("sourceRow"), 0, capacity - 1,
          "Relationship source row exceeds capacity")),
      .field_name = LogicalName(relationship.at("fieldName"),
                                "Relationship field name is invalid"),
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
      !table.at("rows").is_array() ||
      !table.at("relationships").is_array()) {
    throw std::invalid_argument("Table profile is invalid");
  }
  TableProfile result;
  result.logical_name = LogicalName(table.at("logicalName"), "Table name is invalid");
  result.table_id = static_cast<std::uint16_t>(UnsignedBetween(
      table.at("tableId"), 0, 0x7FFF, "Invalid table ID"));
  result.unique_id = static_cast<std::uint32_t>(UnsignedBetween(
      table.at("uniqueId"), 0, 0xFFFFFFFFull, "Invalid unique ID"));
  result.capacity = static_cast<std::uint32_t>(UnsignedBetween(
      table.at("capacity"), 1, 0x1FFFF, "Invalid capacity"));
  result.record_size = static_cast<std::uint32_t>(UnsignedBetween(
      table.at("recordSize"), 1, 4096, "Invalid recordSize"));
  if (table.at("rows").size() > kMaxFingerprintsPerTable) {
    throw std::range_error("At most 8 fingerprints are allowed per table");
  }
  if (table.at("relationships").size() > kMaxRelationshipsPerTable) {
    throw std::range_error("At most 64 relationships are allowed per table");
  }

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
  if (!std::is_sorted(
          result.rows.begin(), result.rows.end(),
          [](const RowFingerprint& left, const RowFingerprint& right) {
            return left.row_index < right.row_index;
          })) {
    throw std::invalid_argument("Noncanonical row order");
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
  if (!std::is_sorted(
          result.relationships.begin(), result.relationships.end(),
          [](const RelationshipConstraint& left,
             const RelationshipConstraint& right) {
            if (left.source_row != right.source_row) {
              return left.source_row < right.source_row;
            }
            return left.field_name < right.field_name;
          })) {
    throw std::invalid_argument("Noncanonical relationship order");
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
    if (profile.at("tables").size() > kMaxTables) {
      throw std::range_error("Version-1 artifacts allow at most 256 tables");
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
    for (const auto& table : bundle.schema.tables()) {
      if (table.authority_status != AuthorityStatus::kDiscoveryOnly) {
        throw std::invalid_argument(
            "Version-1 file artifacts must use discovery_only authority");
      }
    }

    std::set<std::uint16_t> table_ids;
    std::set<std::uint32_t> unique_ids;
    std::size_t fingerprint_total = 0;
    std::size_t relationship_total = 0;
    for (const auto& table : profile.at("tables")) {
      auto parsed = ParseTable(table);
      fingerprint_total += parsed.rows.size();
      if (fingerprint_total > kMaxFingerprintsTotal) {
        throw std::range_error("At most 1024 fingerprints are allowed in total");
      }
      relationship_total += parsed.relationships.size();
      if (relationship_total > kMaxRelationshipsTotal) {
        throw std::range_error("At most 4096 relationships are allowed in total");
      }
      if (!table_ids.insert(parsed.table_id).second) {
        throw std::invalid_argument("Duplicate table ID in profile");
      }
      if (!unique_ids.insert(parsed.unique_id).second) {
        throw std::invalid_argument("Duplicate unique ID in profile");
      }
      bundle.tables.push_back(std::move(parsed));
    }
    if (!std::is_sorted(
            bundle.tables.begin(), bundle.tables.end(),
            [](const TableProfile& left, const TableProfile& right) {
              return left.table_id < right.table_id;
            })) {
      throw std::invalid_argument("Noncanonical profile table order");
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
    auto profile_without_id = profile;
    profile_without_id.erase("profileId");
    const json hash_content = {
        {"profile", std::move(profile_without_id)},
        {"layout", artifact.at("layout")},
    };
    if (Sha256Upper(hash_content.dump()) != bundle.profile_id) {
      throw std::invalid_argument("Profile ID does not match canonical content");
    }
    return {.bundle = std::move(bundle), .error = {}};
  } catch (const std::exception& exception) {
    return {.bundle = std::nullopt, .error = exception.what()};
  }
}

}  // namespace cfb27::frtk
