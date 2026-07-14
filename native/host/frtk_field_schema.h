#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <nlohmann/json_fwd.hpp>

namespace cfb27::frtk {

enum class AuthorityStatus {
  kDiscoveryOnly,
  kCommitAdapterRequired,
  kDirectVerified,
};

struct PackedReference {
  std::uint16_t table_id{};
  std::uint32_t row_index{};

  bool operator==(const PackedReference&) const = default;
};

struct FieldDefinition {
  std::string name;
  std::string encoding;
  std::uint32_t byte_offset{};
  std::uint32_t storage_bytes{};
  std::uint32_t bit_offset{};
  std::uint32_t bit_width{};
  std::int64_t minimum{};
  std::int64_t maximum{};
  std::optional<std::uint16_t> reference_table_id;
};

struct TableSchema {
  std::string logical_name;
  std::uint16_t table_id{};
  std::uint32_t unique_id{};
  std::uint32_t capacity{};
  std::uint32_t record_size{};
  AuthorityStatus authority_status{};
  std::vector<FieldDefinition> fields;
};

class SchemaRegistry {
 public:
  bool Load(const nlohmann::json& artifact, std::string* error = nullptr);
  bool LoadTrustedForTesting(const nlohmann::json& artifact,
                             std::string* error = nullptr);

  [[nodiscard]] const TableSchema* FindTable(std::uint16_t table_id) const;
  [[nodiscard]] const FieldDefinition* FindField(
      std::uint16_t table_id, std::string_view field_name) const;
  [[nodiscard]] const std::string& schema_identity() const {
    return schema_identity_;
  }
  [[nodiscard]] const std::string& build_identity() const {
    return build_identity_;
  }
  [[nodiscard]] const std::vector<TableSchema>& tables() const {
    return tables_;
  }

 private:
  bool LoadImpl(const nlohmann::json& artifact, bool allow_promoted_authority,
                std::string* error);
  std::string schema_identity_;
  std::string build_identity_;
  std::vector<TableSchema> tables_;
};

using DecodedField = std::variant<std::int64_t, PackedReference>;

PackedReference DecodePackedReference(std::uint64_t value);
std::uint32_t EncodePackedReference(const PackedReference& reference);
DecodedField DecodeField(std::span<const std::uint8_t> record,
                         const FieldDefinition& definition);
std::vector<std::uint8_t> EncodeField(
    std::span<const std::uint8_t> record, const FieldDefinition& definition,
    const DecodedField& value);

}  // namespace cfb27::frtk
