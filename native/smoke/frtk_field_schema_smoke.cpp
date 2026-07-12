#include "../host/frtk_field_schema.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace {

using nlohmann::json;
using cfb27::frtk::DecodedField;
using cfb27::frtk::FieldDefinition;
using cfb27::frtk::PackedReference;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Function>
void RequireThrows(Function&& function, const char* message) {
  try {
    function();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(message);
}

json Field(std::string name, std::string encoding, int byte_offset,
           int storage_bytes, int bit_offset, int bit_width,
           std::int64_t minimum, std::uint64_t maximum,
           json reference_table_id = nullptr) {
  return {{"name", std::move(name)}, {"encoding", std::move(encoding)},
          {"byteOffset", byte_offset}, {"storageBytes", storage_bytes},
          {"bitOffset", bit_offset}, {"bitWidth", bit_width},
          {"minimum", minimum}, {"maximum", maximum},
          {"referenceTableId", std::move(reference_table_id)}};
}

json ValidLayout() {
  return {
      {"formatVersion", 1},
      {"schemaIdentity", "synthetic-schema-v1"},
      {"buildIdentity", "synthetic-build-v1"},
      {"tables", json::array({
          {{"logicalName", "Recruit"}, {"tableId", 4269},
           {"uniqueId", 426907}, {"capacity", 80}, {"recordSize", 8},
           {"authorityStatus", "direct_verified"},
           {"fields", json::array({Field("Score", "signed", 4, 2, 2, 11,
                                                -1024, 1023)})}},
          {{"logicalName", "RecruitTarget"}, {"tableId", 4288},
           {"uniqueId", 428807}, {"capacity", 100}, {"recordSize", 8},
           {"authorityStatus", "commit_adapter_required"},
           {"fields", json::array({
               Field("RecruitRef", "packed-reference", 0, 4, 0, 32, 0,
                     0xFFFFFFFFull, 4269),
               Field("CrossByte", "bitfield", 4, 2, 5, 7, 0, 127),
               Field("Count", "unsigned", 6, 2, 0, 16, 10, 500),
           })}},
      })},
  };
}

FieldDefinition Definition(std::string encoding, std::uint32_t byte_offset,
                           std::uint32_t storage_bytes, std::uint32_t bit_offset,
                           std::uint32_t bit_width, std::int64_t minimum,
                           std::uint64_t maximum) {
  FieldDefinition result;
  result.name = "Synthetic";
  result.encoding = std::move(encoding);
  result.byte_offset = byte_offset;
  result.storage_bytes = storage_bytes;
  result.bit_offset = bit_offset;
  result.bit_width = bit_width;
  result.minimum = minimum;
  result.maximum = maximum;
  return result;
}

void TestSchemaRegistry() {
  cfb27::frtk::SchemaRegistry registry;
  std::string error;
  Require(registry.Load(ValidLayout(), &error), error.c_str());
  const auto* table = registry.FindTable(4288);
  Require(table != nullptr && table->authority_status ==
                                   cfb27::frtk::AuthorityStatus::kCommitAdapterRequired,
          "table lookup failed");
  Require(registry.FindTable(9999) == nullptr, "unknown table resolved");
  Require(registry.FindField(4288, "CrossByte") != nullptr,
          "field lookup failed");
  Require(registry.FindField(4288, "Missing") == nullptr,
          "unknown field resolved");

  auto extra = ValidLayout();
  extra["tables"][0]["fields"][0]["surprise"] = true;
  Require(!registry.Load(extra, &error), "field extra key accepted");
  auto duplicate = ValidLayout();
  duplicate["tables"][1]["fields"].push_back(
      duplicate["tables"][1]["fields"][0]);
  Require(!registry.Load(duplicate, &error), "duplicate field name accepted");
  auto unknown_ref = ValidLayout();
  unknown_ref["tables"][1]["fields"][0]["referenceTableId"] = 9999;
  Require(!registry.Load(unknown_ref, &error), "unknown reference table accepted");
  auto unsupported = ValidLayout();
  unsupported["tables"][1]["fields"][1]["encoding"] = "float";
  Require(!registry.Load(unsupported, &error), "unsupported encoding accepted");
  auto authority = ValidLayout();
  authority["tables"][0]["authorityStatus"] = "verified-ish";
  Require(!registry.Load(authority, &error), "unknown authority accepted");
}

void TestPackedReferences() {
  const PackedReference reference{.table_id = 4288, .row_index = 37};
  const auto packed = cfb27::frtk::EncodePackedReference(reference);
  Require(packed == ((4288u << 17) | 37u), "packed value mismatch");
  Require(cfb27::frtk::DecodePackedReference(packed) == reference,
          "packed reference round trip failed");
  RequireThrows([] { cfb27::frtk::EncodePackedReference({0x8000, 0}); },
                "oversized table ID accepted");
  RequireThrows([] { cfb27::frtk::EncodePackedReference({1, 0x20000}); },
                "oversized row index accepted");
}

void TestFieldCodecs() {
  const auto bitfield = Definition("bitfield", 0, 2, 5, 7, 0, 127);
  const std::vector<std::uint8_t> original{0xA5, 0x5A};
  const auto updated = cfb27::frtk::EncodeField(original, bitfield,
                                                DecodedField{std::int64_t{73}});
  Require(std::get<std::int64_t>(cfb27::frtk::DecodeField(updated, bitfield)) == 73,
          "bitfield round trip failed");
  Require((updated[0] & 0x1F) == 0x05 && (updated[1] & 0xF0) == 0x50,
          "bitfield damaged unrelated bits");
  Require(original == std::vector<std::uint8_t>({0xA5, 0x5A}),
          "input record was mutated");

  const auto signed_field = Definition("signed", 1, 2, 2, 11, -1024, 1023);
  for (const std::int64_t value : {-1024, -17, 0, 1023}) {
    const auto encoded = cfb27::frtk::EncodeField(
        std::vector<std::uint8_t>{0xAA, 0x55, 0xAA}, signed_field,
        DecodedField{value});
    Require(std::get<std::int64_t>(
                cfb27::frtk::DecodeField(encoded, signed_field)) == value,
            "signed round trip failed");
    Require(encoded[0] == 0xAA && (encoded[2] & 0xE0) == 0xA0,
            "signed codec damaged unrelated bits");
  }
  RequireThrows(
      [&] { cfb27::frtk::EncodeField(std::vector<std::uint8_t>(3), signed_field,
                                    DecodedField{std::int64_t{-1025}}); },
      "signed value below minimum accepted");

  const auto unsigned_field = Definition("unsigned", 0, 2, 0, 16, 10, 500);
  const auto encoded = cfb27::frtk::EncodeField(
      std::vector<std::uint8_t>(2), unsigned_field, DecodedField{std::int64_t{300}});
  Require(std::get<std::int64_t>(
              cfb27::frtk::DecodeField(encoded, unsigned_field)) == 300,
          "unsigned round trip failed");
  RequireThrows([&] { cfb27::frtk::DecodeField(std::vector<std::uint8_t>(1),
                                               unsigned_field); },
                "record bounds ignored");

  auto reference = Definition("packed-reference", 0, 4, 0, 32, 0, 0xFFFFFFFFull);
  reference.reference_table_id = 4288;
  const PackedReference value{4288, 91};
  const auto encoded_reference = cfb27::frtk::EncodeField(
      std::vector<std::uint8_t>(4), reference, DecodedField{value});
  Require(std::get<PackedReference>(
              cfb27::frtk::DecodeField(encoded_reference, reference)) == value,
          "reference round trip failed");
  RequireThrows(
      [&] { cfb27::frtk::EncodeField(std::vector<std::uint8_t>(4), reference,
                                    DecodedField{PackedReference{5840, 91}}); },
      "wrong packed target accepted");
}

void TestInvalidDefinitions() {
  auto invalid_signed = Definition("signed", 0, 2, 0, 11, -1025, 1023);
  RequireThrows([&] { cfb27::frtk::DecodeField(std::vector<std::uint8_t>(2),
                                               invalid_signed); },
                "illegal signed range accepted");
  auto invalid_width = Definition("unsigned", 0, 1, 0, 0, 0, 0);
  RequireThrows([&] { cfb27::frtk::DecodeField(std::vector<std::uint8_t>(1),
                                               invalid_width); },
                "zero bit width accepted");
  auto unsupported = Definition("float", 0, 4, 0, 32, 0, 100);
  RequireThrows([&] { cfb27::frtk::DecodeField(std::vector<std::uint8_t>(4),
                                               unsupported); },
                "unsupported encoding accepted by codec");
}

}  // namespace

int main() {
  try {
    TestSchemaRegistry();
    TestPackedReferences();
    TestFieldCodecs();
    TestInvalidDefinitions();
    std::cout << "frtk field schema smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk field schema smoke failed: " << error.what() << '\n';
    return 1;
  }
}
