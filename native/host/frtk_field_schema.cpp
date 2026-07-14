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

constexpr std::size_t kMaxTables = 256;
constexpr std::size_t kMaxFieldsPerTable = 512;
constexpr std::size_t kMaxFieldsTotal = 32768;
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
  if (!IsValidUtf8(result) || result.empty() || result.size() > 128) {
    throw std::invalid_argument(message);
  }
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
  if (definition.storage_bytes < 1 || definition.storage_bytes > 5 ||
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
                         definition.encoding == "offset-binary" ||
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
  const bool is_offset_binary = definition.encoding == "offset-binary";
  const std::int64_t legal_minimum =
      definition.encoding == "signed"
          ? -(std::int64_t{1} << (definition.bit_width - 1))
          : is_offset_binary ? (std::numeric_limits<std::int64_t>::min)() : 0;
  const std::int64_t legal_maximum =
      definition.encoding == "signed"
          ? (std::int64_t{1} << (definition.bit_width - 1)) - 1
          : is_offset_binary
                ? (std::numeric_limits<std::int64_t>::max)()
                : static_cast<std::int64_t>(
                      (std::uint64_t{1} << definition.bit_width) - 1);
  if (definition.minimum < legal_minimum ||
      definition.maximum > legal_maximum ||
      definition.minimum > definition.maximum) {
    throw std::range_error(definition.encoding == "signed"
                               ? "Definition declares an illegal signed range"
                               : "Definition declares an illegal unsigned range");
  }
  if (is_offset_binary &&
      static_cast<std::uint64_t>(definition.maximum) -
              static_cast<std::uint64_t>(definition.minimum) >=
          (std::uint64_t{1} << definition.bit_width)) {
    throw std::range_error(
        "Definition declares an illegal offset-binary range");
  }
}

std::uint64_t ReadStorage(std::span<const std::uint8_t> record,
                          const FieldDefinition& definition) {
  std::uint64_t result = 0;
  for (std::uint32_t index = 0; index < definition.storage_bytes; ++index) {
    result = (result << 8) | record[definition.byte_offset + index];
  }
  return result;
}

FieldDefinition ParseField(const json& field, std::uint32_t record_size) {
  if (!HasExactKeys(field,
                    {"name", "encoding", "byteOffset", "storageBytes",
                     "bitOffset", "bitWidth", "minimum", "maximum",
                     "referenceTableId"}) ||
      !field.at("encoding").is_string()) {
    throw std::invalid_argument("Field definition is invalid");
  }
  FieldDefinition result;
  result.name = LogicalName(field.at("name"), "Field name is invalid");
  result.encoding = field.at("encoding").get<std::string>();
  result.byte_offset = static_cast<std::uint32_t>(IntegerBetween(
      field.at("byteOffset"), 0, std::numeric_limits<std::uint32_t>::max(),
      "Invalid byteOffset"));
  result.storage_bytes = static_cast<std::uint32_t>(
      IntegerBetween(field.at("storageBytes"), 1, 5, "Invalid storageBytes"));
  result.bit_offset = static_cast<std::uint32_t>(
      IntegerBetween(field.at("bitOffset"), 0, 39, "Invalid bitOffset"));
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
      !table.at("fields").is_array()) {
    throw std::invalid_argument("Table schema is invalid");
  }
  TableSchema result;
  result.logical_name = LogicalName(table.at("logicalName"), "Table name is invalid");
  result.table_id = static_cast<std::uint16_t>(
      IntegerBetween(table.at("tableId"), 0, 0x7FFF, "Invalid table ID"));
  result.unique_id = static_cast<std::uint32_t>(IntegerBetween(
      table.at("uniqueId"), 0, 0xFFFFFFFFll, "Invalid unique ID"));
  result.capacity = static_cast<std::uint32_t>(IntegerBetween(
      table.at("capacity"), 1, 0x1FFFF, "Invalid capacity"));
  result.record_size = static_cast<std::uint32_t>(
      IntegerBetween(table.at("recordSize"), 1, 4096, "Invalid recordSize"));
  result.authority_status = ParseAuthority(table.at("authorityStatus"));
  if (table.at("fields").size() > kMaxFieldsPerTable) {
    throw std::range_error("At most 512 fields are allowed per table");
  }
  std::set<std::string> names;
  for (const auto& field : table.at("fields")) {
    auto parsed = ParseField(field, result.record_size);
    if (!names.insert(parsed.name).second) {
      throw std::invalid_argument("Duplicate field name");
    }
    result.fields.push_back(std::move(parsed));
  }
  if (!std::is_sorted(
          result.fields.begin(), result.fields.end(),
          [](const FieldDefinition& left, const FieldDefinition& right) {
            if (left.byte_offset != right.byte_offset) {
              return left.byte_offset < right.byte_offset;
            }
            if (left.bit_offset != right.bit_offset) {
              return left.bit_offset < right.bit_offset;
            }
            return left.name < right.name;
          })) {
    throw std::invalid_argument("Noncanonical field order");
  }
  return result;
}

}  // namespace

bool SchemaRegistry::Load(const json& artifact, std::string* error) {
  return LoadImpl(artifact, false, error);
}

bool SchemaRegistry::LoadTrustedForTesting(const json& artifact,
                                           std::string* error) {
  return LoadImpl(artifact, true, error);
}

bool SchemaRegistry::LoadImpl(const json& artifact, bool allow_promoted_authority,
                              std::string* error) {
  try {
    if (!HasExactKeys(artifact, {"formatVersion", "schemaIdentity",
                                 "buildIdentity", "tables"}) ||
        IntegerBetween(artifact.at("formatVersion"), 1, 1,
                       "Unsupported layout version") != 1 ||
        !artifact.at("tables").is_array() || artifact.at("tables").empty()) {
      throw std::invalid_argument("Invalid version-1 field layout");
    }
    if (artifact.at("tables").size() > kMaxTables) {
      throw std::range_error("Version-1 artifacts allow at most 256 tables");
    }
    SchemaRegistry parsed;
    parsed.schema_identity_ =
        Identity(artifact.at("schemaIdentity"), "Invalid schema identity");
    parsed.build_identity_ =
        Identity(artifact.at("buildIdentity"), "Invalid build identity");
    std::set<std::uint16_t> table_ids;
    std::set<std::uint32_t> unique_ids;
    std::size_t field_total = 0;
    for (const auto& table : artifact.at("tables")) {
      if (table.is_object() && table.contains("fields") && table.at("fields").is_array()) {
        field_total += table.at("fields").size();
        if (field_total > kMaxFieldsTotal) {
          throw std::range_error("At most 32768 fields are allowed in total");
        }
      }
      auto parsed_table = ParseTable(table);
      if (!allow_promoted_authority &&
          parsed_table.authority_status != AuthorityStatus::kDiscoveryOnly) {
        throw std::invalid_argument(
            "Version-1 file layouts must use discovery_only authority");
      }
      if (!table_ids.insert(parsed_table.table_id).second) {
        throw std::invalid_argument("Duplicate table ID in layout");
      }
      if (!unique_ids.insert(parsed_table.unique_id).second) {
        throw std::invalid_argument("Duplicate unique ID in layout");
      }
      parsed.tables_.push_back(std::move(parsed_table));
    }
    if (!std::is_sorted(
            parsed.tables_.begin(), parsed.tables_.end(),
            [](const TableSchema& left, const TableSchema& right) {
              return left.table_id < right.table_id;
            })) {
      throw std::invalid_argument("Noncanonical layout table order");
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
  const auto shift = definition.storage_bytes * 8 - definition.bit_offset -
                     definition.bit_width;
  const std::uint64_t raw =
      (ReadStorage(record, definition) >> shift) & width_mask;
  if (definition.encoding == "packed-reference") {
    return DecodePackedReference(raw);
  }
  if (definition.encoding == "offset-binary") {
    return static_cast<std::int64_t>(raw) + definition.minimum;
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
  const std::int64_t stored_value = definition.encoding == "offset-binary"
                                        ? numeric_value - definition.minimum
                                        : numeric_value;
  const std::uint64_t raw = stored_value < 0
                                ? (std::uint64_t{1} << definition.bit_width) +
                                      stored_value
                                : static_cast<std::uint64_t>(stored_value);
  const auto shift = definition.storage_bytes * 8 - definition.bit_offset -
                     definition.bit_width;
  const std::uint64_t field_mask = width_mask << shift;
  const std::uint64_t updated_storage =
      (ReadStorage(record, definition) & ~field_mask) |
      ((raw << shift) & field_mask);
  std::vector<std::uint8_t> updated(record.begin(), record.end());
  auto remaining = updated_storage;
  for (std::uint32_t index = definition.storage_bytes; index-- > 0;) {
    updated[definition.byte_offset + index] =
        static_cast<std::uint8_t>(remaining & 0xFF);
    remaining >>= 8;
  }
  return updated;
}

}  // namespace cfb27::frtk
