#include "frtk_field_schema.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <limits>
#include <set>
#include <stdexcept>
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

std::int64_t IntegerBetween(const json& value, std::int64_t minimum,
                            std::int64_t maximum, const char* message) {
  if (value.is_number_unsigned()) {
    const auto number = value.get<std::uint64_t>();
    if (minimum < 0 && number <= static_cast<std::uint64_t>(maximum)) {
      return static_cast<std::int64_t>(number);
    }
    if (minimum >= 0 && number >= static_cast<std::uint64_t>(minimum) &&
        number <= static_cast<std::uint64_t>(maximum)) {
      return static_cast<std::int64_t>(number);
    }
    throw std::range_error(message);
  }
  if (!value.is_number_integer()) throw std::range_error(message);
  const auto number = value.get<std::int64_t>();
  if (number < minimum || number > maximum) throw std::range_error(message);
  return number;
}

std::string Identity(const json& value, const char* message) {
  if (!value.is_string()) throw std::invalid_argument(message);
  auto result = value.get<std::string>();
  if (result.empty() || result.size() > 128) throw std::invalid_argument(message);
  return result;
}

AuthorityStatus ParseAuthority(const json& value) {
  if (!value.is_string()) throw std::invalid_argument("Unknown authority status");
  const auto status = value.get<std::string>();
  if (status == "discovery_only") return AuthorityStatus::kDiscoveryOnly;
  if (status == "commit_adapter_required") {
    return AuthorityStatus::kCommitAdapterRequired;
  }
  if (status == "direct_verified") return AuthorityStatus::kDirectVerified;
  throw std::invalid_argument("Unknown authority status");
}

void ValidateDefinition(std::span<const std::uint8_t> record,
                        const FieldDefinition& definition) {
  if (definition.bit_width < 1 || definition.bit_width > 32) {
    throw std::range_error("bitWidth must be from 1 through 32");
  }
  if (definition.storage_bytes < 1 || definition.storage_bytes > 4 ||
      definition.byte_offset > record.size() ||
      definition.storage_bytes > record.size() - definition.byte_offset) {
    throw std::range_error("Field storage exceeds the record bounds");
  }
  if (definition.bit_offset >= definition.storage_bytes * 8 ||
      definition.bit_width >
          definition.storage_bytes * 8 - definition.bit_offset) {
    throw std::range_error("Field bit range exceeds its storage");
  }
  const bool supported = definition.encoding == "unsigned" ||
                         definition.encoding == "signed" ||
                         definition.encoding == "bitfield" ||
                         definition.encoding == "packed-reference";
  if (!supported) {
    throw std::invalid_argument("Unsupported field encoding: " +
                                definition.encoding);
  }
  if (definition.encoding == "packed-reference" &&
      (definition.storage_bytes != 4 || definition.bit_offset != 0 ||
       definition.bit_width != 32)) {
    throw std::range_error(
        "Packed-reference fields must occupy exactly 32 bits");
  }
  const std::int64_t legal_minimum =
      definition.encoding == "signed"
          ? -(std::int64_t{1} << (definition.bit_width - 1))
          : 0;
  const std::int64_t legal_maximum =
      definition.encoding == "signed"
          ? (std::int64_t{1} << (definition.bit_width - 1)) - 1
          : static_cast<std::int64_t>(
                (std::uint64_t{1} << definition.bit_width) - 1);
  if (definition.minimum < legal_minimum ||
      definition.maximum > legal_maximum ||
      definition.minimum > definition.maximum) {
    throw std::range_error(definition.encoding == "signed"
                               ? "Definition declares an illegal signed range"
                               : "Definition declares an illegal unsigned range");
  }
}

std::uint64_t ReadStorage(std::span<const std::uint8_t> record,
                          const FieldDefinition& definition) {
  std::uint64_t result = 0;
  for (std::uint32_t index = 0; index < definition.storage_bytes; ++index) {
    result |= static_cast<std::uint64_t>(
                  record[definition.byte_offset + index])
              << (index * 8);
  }
  return result;
}

FieldDefinition ParseField(const json& field, std::uint32_t record_size) {
  if (!HasExactKeys(field,
                    {"name", "encoding", "byteOffset", "storageBytes",
                     "bitOffset", "bitWidth", "minimum", "maximum",
                     "referenceTableId"}) ||
      !field.at("name").is_string() ||
      field.at("name").get_ref<const std::string&>().empty() ||
      !field.at("encoding").is_string()) {
    throw std::invalid_argument("Field definition is invalid");
  }
  FieldDefinition result;
  result.name = field.at("name").get<std::string>();
  result.encoding = field.at("encoding").get<std::string>();
  result.byte_offset = static_cast<std::uint32_t>(IntegerBetween(
      field.at("byteOffset"), 0, std::numeric_limits<std::uint32_t>::max(),
      "Invalid byteOffset"));
  result.storage_bytes = static_cast<std::uint32_t>(
      IntegerBetween(field.at("storageBytes"), 1, 4, "Invalid storageBytes"));
  result.bit_offset = static_cast<std::uint32_t>(
      IntegerBetween(field.at("bitOffset"), 0, 31, "Invalid bitOffset"));
  result.bit_width = static_cast<std::uint32_t>(
      IntegerBetween(field.at("bitWidth"), 1, 32, "Invalid bitWidth"));
  result.minimum = IntegerBetween(field.at("minimum"),
                                  std::numeric_limits<std::int32_t>::min(),
                                  0xFFFFFFFFll, "Invalid minimum");
  result.maximum = IntegerBetween(field.at("maximum"),
                                  std::numeric_limits<std::int32_t>::min(),
                                  0xFFFFFFFFll, "Invalid maximum");
  if (!field.at("referenceTableId").is_null()) {
    result.reference_table_id = static_cast<std::uint16_t>(IntegerBetween(
        field.at("referenceTableId"), 0, 0x7FFF,
        "Invalid referenceTableId"));
  }
  ValidateDefinition(std::vector<std::uint8_t>(record_size), result);
  if (result.encoding == "packed-reference") {
    if (!result.reference_table_id) {
      throw std::range_error(
          "Packed-reference field requires referenceTableId");
    }
  } else if (result.reference_table_id) {
    throw std::invalid_argument(
        "Non-reference field referenceTableId must be null");
  }
  return result;
}

TableSchema ParseTable(const json& table) {
  if (!HasExactKeys(table,
                    {"logicalName", "tableId", "uniqueId", "capacity",
                     "recordSize", "authorityStatus", "fields"}) ||
      !table.at("logicalName").is_string() ||
      table.at("logicalName").get_ref<const std::string&>().empty() ||
      !table.at("fields").is_array()) {
    throw std::invalid_argument("Table schema is invalid");
  }
  TableSchema result;
  result.logical_name = table.at("logicalName").get<std::string>();
  result.table_id = static_cast<std::uint16_t>(
      IntegerBetween(table.at("tableId"), 0, 0x7FFF, "Invalid table ID"));
  result.unique_id = static_cast<std::uint32_t>(IntegerBetween(
      table.at("uniqueId"), 0, 0xFFFFFFFFll, "Invalid unique ID"));
  result.capacity = static_cast<std::uint32_t>(IntegerBetween(
      table.at("capacity"), 1, 0x1FFFF, "Invalid capacity"));
  result.record_size = static_cast<std::uint32_t>(
      IntegerBetween(table.at("recordSize"), 1, 4096, "Invalid recordSize"));
  result.authority_status = ParseAuthority(table.at("authorityStatus"));
  std::set<std::string> names;
  for (const auto& field : table.at("fields")) {
    auto parsed = ParseField(field, result.record_size);
    if (!names.insert(parsed.name).second) {
      throw std::invalid_argument("Duplicate field name");
    }
    result.fields.push_back(std::move(parsed));
  }
  return result;
}

}  // namespace

bool SchemaRegistry::Load(const json& artifact, std::string* error) {
  try {
    if (!HasExactKeys(artifact, {"formatVersion", "schemaIdentity",
                                 "buildIdentity", "tables"}) ||
        IntegerBetween(artifact.at("formatVersion"), 1, 1,
                       "Unsupported layout version") != 1 ||
        !artifact.at("tables").is_array() || artifact.at("tables").empty()) {
      throw std::invalid_argument("Invalid version-1 field layout");
    }
    SchemaRegistry parsed;
    parsed.schema_identity_ =
        Identity(artifact.at("schemaIdentity"), "Invalid schema identity");
    parsed.build_identity_ =
        Identity(artifact.at("buildIdentity"), "Invalid build identity");
    std::set<std::uint16_t> table_ids;
    for (const auto& table : artifact.at("tables")) {
      auto parsed_table = ParseTable(table);
      if (!table_ids.insert(parsed_table.table_id).second) {
        throw std::invalid_argument("Duplicate table ID in layout");
      }
      parsed.tables_.push_back(std::move(parsed_table));
    }
    for (const auto& table : parsed.tables_) {
      for (const auto& field : table.fields) {
        if (field.reference_table_id &&
            !parsed.FindTable(*field.reference_table_id)) {
          throw std::invalid_argument(
              "Packed-reference field targets an unknown reference table");
        }
      }
    }
    *this = std::move(parsed);
    if (error) error->clear();
    return true;
  } catch (const std::exception& exception) {
    if (error) *error = exception.what();
    return false;
  }
}

const TableSchema* SchemaRegistry::FindTable(std::uint16_t table_id) const {
  const auto found = std::find_if(
      tables_.begin(), tables_.end(),
      [table_id](const TableSchema& table) { return table.table_id == table_id; });
  return found == tables_.end() ? nullptr : &*found;
}

const FieldDefinition* SchemaRegistry::FindField(
    std::uint16_t table_id, std::string_view field_name) const {
  const auto* table = FindTable(table_id);
  if (!table) return nullptr;
  const auto found = std::find_if(
      table->fields.begin(), table->fields.end(),
      [field_name](const FieldDefinition& field) {
        return field.name == field_name;
      });
  return found == table->fields.end() ? nullptr : &*found;
}

PackedReference DecodePackedReference(std::uint64_t value) {
  if (value > 0xFFFFFFFFull) {
    throw std::range_error("Packed reference must be a 32-bit unsigned integer");
  }
  return {.table_id = static_cast<std::uint16_t>(value >> 17),
          .row_index = static_cast<std::uint32_t>(value & 0x1FFFFu)};
}

std::uint32_t EncodePackedReference(const PackedReference& reference) {
  if (reference.table_id > 0x7FFF) {
    throw std::range_error("tableId must be a 15-bit unsigned integer");
  }
  if (reference.row_index > 0x1FFFF) {
    throw std::range_error("rowIndex must be a 17-bit unsigned integer");
  }
  return (static_cast<std::uint32_t>(reference.table_id) << 17) |
         reference.row_index;
}

DecodedField DecodeField(std::span<const std::uint8_t> record,
                         const FieldDefinition& definition) {
  ValidateDefinition(record, definition);
  const std::uint64_t width_mask =
      (std::uint64_t{1} << definition.bit_width) - 1;
  const std::uint64_t raw =
      (ReadStorage(record, definition) >> definition.bit_offset) & width_mask;
  if (definition.encoding == "packed-reference") {
    return DecodePackedReference(raw);
  }
  if (definition.encoding != "signed") {
    return static_cast<std::int64_t>(raw);
  }
  const std::uint64_t sign =
      std::uint64_t{1} << (definition.bit_width - 1);
  if ((raw & sign) == 0) return static_cast<std::int64_t>(raw);
  return static_cast<std::int64_t>(raw) -
         static_cast<std::int64_t>(std::uint64_t{1}
                                   << definition.bit_width);
}

std::vector<std::uint8_t> EncodeField(
    std::span<const std::uint8_t> record, const FieldDefinition& definition,
    const DecodedField& value) {
  ValidateDefinition(record, definition);
  std::int64_t numeric_value{};
  if (definition.encoding == "packed-reference") {
    const auto* reference = std::get_if<PackedReference>(&value);
    if (!reference || !definition.reference_table_id ||
        *definition.reference_table_id != reference->table_id) {
      throw std::range_error(
          "Packed reference does not match the declared target table");
    }
    numeric_value = EncodePackedReference(*reference);
  } else {
    const auto* numeric = std::get_if<std::int64_t>(&value);
    if (!numeric) throw std::invalid_argument("Numeric field requires an integer");
    numeric_value = *numeric;
  }
  if (numeric_value < definition.minimum ||
      numeric_value > definition.maximum) {
    throw std::range_error("Field value is outside its declared bounds");
  }
  const std::uint64_t width_mask =
      (std::uint64_t{1} << definition.bit_width) - 1;
  const std::uint64_t raw = numeric_value < 0
                                ? (std::uint64_t{1} << definition.bit_width) +
                                      numeric_value
                                : static_cast<std::uint64_t>(numeric_value);
  const std::uint64_t field_mask = width_mask << definition.bit_offset;
  const std::uint64_t updated_storage =
      (ReadStorage(record, definition) & ~field_mask) |
      ((raw << definition.bit_offset) & field_mask);
  std::vector<std::uint8_t> updated(record.begin(), record.end());
  for (std::uint32_t index = 0; index < definition.storage_bytes; ++index) {
    updated[definition.byte_offset + index] =
        static_cast<std::uint8_t>((updated_storage >> (index * 8)) & 0xFF);
  }
  return updated;
}

}  // namespace cfb27::frtk
