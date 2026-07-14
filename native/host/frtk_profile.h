#pragma once

#include "frtk_field_schema.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

namespace cfb27::frtk {

struct RelationshipConstraint {
  std::uint32_t source_row{};
  std::string field_name;
  std::uint16_t target_table_id{};
  std::uint32_t target_row{};
};

struct RowFingerprint {
  std::uint32_t row_index{};
  std::vector<std::uint8_t> pattern;
  std::vector<std::uint8_t> mask;
};

struct TableProfile {
  std::string logical_name;
  std::uint16_t table_id{};
  std::uint32_t unique_id{};
  std::uint32_t capacity{};
  std::uint32_t record_size{};
  std::vector<RowFingerprint> rows;
  std::vector<RelationshipConstraint> relationships;
};

struct ProfileBundle {
  std::string profile_id;
  std::string schema_identity;
  std::string build_identity;
  std::vector<TableProfile> tables;
  SchemaRegistry schema;
};

struct ProfileValidationResult {
  std::optional<ProfileBundle> bundle;
  std::string error;

  [[nodiscard]] bool ok() const { return bundle.has_value(); }
};

ProfileValidationResult ParseProfile(const nlohmann::json& artifact);

}  // namespace cfb27::frtk
