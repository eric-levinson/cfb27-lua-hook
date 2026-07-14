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

std::vector<std::uint8_t> SyntheticRecord(std::size_t length,
                                          std::uint8_t seed) {
  std::vector<std::uint8_t> result(length);
  for (std::size_t index = 0; index < length; ++index) {
    result[index] = static_cast<std::uint8_t>(seed + index * 0x31);
  }
  return result;
}

std::vector<std::uint8_t> EncodeMsbFirstOracle(
    std::span<const std::uint8_t> record, const FieldDefinition& definition,
    std::int64_t numeric_value) {
  const auto width = definition.bit_width;
  const auto shift = definition.storage_bytes * 8 - definition.bit_offset - width;
  std::uint64_t storage = 0;
  for (std::uint32_t index = 0; index < definition.storage_bytes; ++index) {
    storage = (storage << 8) | record[definition.byte_offset + index];
  }
  const std::uint64_t raw = numeric_value < 0
                                ? (std::uint64_t{1} << width) + numeric_value
                                : static_cast<std::uint64_t>(numeric_value);
  const auto width_mask = (std::uint64_t{1} << width) - 1;
  const auto field_mask = width_mask << shift;
  storage = (storage & ~field_mask) | ((raw << shift) & field_mask);
  std::vector<std::uint8_t> result(record.begin(), record.end());
  for (std::uint32_t index = definition.storage_bytes; index-- > 0;) {
    result[definition.byte_offset + index] =
        static_cast<std::uint8_t>(storage & 0xFF);
    storage >>= 8;
  }
  return result;
}

std::uint64_t DecodeLittleEndianLsbFirst(
    std::span<const std::uint8_t> record, const FieldDefinition& definition) {
  std::uint64_t storage = 0;
  for (std::uint32_t index = 0; index < definition.storage_bytes; ++index) {
    storage |= static_cast<std::uint64_t>(record[definition.byte_offset + index])
               << (index * 8);
  }
  return (storage >> definition.bit_offset) &
         ((std::uint64_t{1} << definition.bit_width) - 1);
}

void TestSchemaRegistry() {
  cfb27::frtk::SchemaRegistry registry;
  std::string error;
  Require(!registry.Load(ValidLayout(), &error) &&
              error.find("discovery_only") != std::string::npos,
          "file layout granted promoted authority");
  Require(registry.LoadTrustedForTesting(ValidLayout(), &error), error.c_str());
  const auto* table = registry.FindTable(4288);
  Require(table != nullptr && table->authority_status ==
                                   cfb27::frtk::AuthorityStatus::kCommitAdapterRequired,
          "table lookup failed");
  Require(registry.FindTable(9999) == nullptr, "unknown table resolved");
  Require(registry.FindField(4288, "CrossByte") != nullptr,
          "field lookup failed");
  Require(registry.FindField(4288, "Missing") == nullptr,
          "unknown field resolved");

  auto five_byte = ValidLayout();
  five_byte["tables"][0]["fields"] = json::array({
      Field("FiveByteWindow", "unsigned", 0, 5, 4, 32, 0,
            0xFFFFFFFFull),
  });
  Require(registry.LoadTrustedForTesting(five_byte, &error),
          "five-byte storage window rejected by schema parser");

  auto extra = ValidLayout();
  extra["tables"][0]["fields"][0]["surprise"] = true;
  Require(!registry.LoadTrustedForTesting(extra, &error), "field extra key accepted");
  auto duplicate = ValidLayout();
  duplicate["tables"][1]["fields"].push_back(
      duplicate["tables"][1]["fields"][0]);
  Require(!registry.LoadTrustedForTesting(duplicate, &error), "duplicate field name accepted");
  auto duplicate_unique_id = ValidLayout();
  duplicate_unique_id["tables"][1]["uniqueId"] =
      duplicate_unique_id["tables"][0]["uniqueId"];
  Require(!registry.LoadTrustedForTesting(duplicate_unique_id, &error) &&
              error.find("Duplicate unique ID in layout") != std::string::npos,
          "duplicate layout unique ID accepted");
  Require(registry.FindTable(4288) != nullptr,
          "failed layout load replaced the previous registry");
  auto unknown_ref = ValidLayout();
  unknown_ref["tables"][1]["fields"][0]["referenceTableId"] = 9999;
  Require(!registry.LoadTrustedForTesting(unknown_ref, &error), "unknown reference table accepted");
  auto unsupported = ValidLayout();
  unsupported["tables"][1]["fields"][1]["encoding"] = "float";
  Require(!registry.LoadTrustedForTesting(unsupported, &error), "unsupported encoding accepted");
  auto offset_binary = ValidLayout();
  offset_binary["tables"][0]["fields"][0] =
      Field("Score", "offset-binary", 4, 2, 2, 11, -200, 1847);
  Require(registry.LoadTrustedForTesting(offset_binary, &error),
          "exact offset-binary encoding rejected");
  offset_binary["tables"][0]["fields"][0]["encoding"] = "offset_binary";
  Require(!registry.LoadTrustedForTesting(offset_binary, &error),
          "misspelled offset-binary encoding accepted");
  auto authority = ValidLayout();
  authority["tables"][0]["authorityStatus"] = "verified-ish";
  Require(!registry.LoadTrustedForTesting(authority, &error), "unknown authority accepted");
  auto invalid_table_name = ValidLayout();
  invalid_table_name["tables"][0]["logicalName"] = std::string("\xF0\x28\x8C\x28", 4);
  Require(!registry.LoadTrustedForTesting(invalid_table_name, &error) &&
              error.find("valid UTF-8") != std::string::npos,
          "invalid UTF-8 layout table name accepted");
  auto invalid_field_name = ValidLayout();
  invalid_field_name["tables"][0]["fields"][0]["name"] =
      std::string("\xC0\xAF", 2);
  Require(!registry.LoadTrustedForTesting(invalid_field_name, &error) &&
              error.find("valid UTF-8") != std::string::npos,
          "overlong UTF-8 field name accepted");
  auto invalid_identity = ValidLayout();
  invalid_identity["schemaIdentity"] = std::string("\xED\xA0\x80", 3);
  Require(!registry.LoadTrustedForTesting(invalid_identity, &error) &&
              error.find("Invalid schema identity") != std::string::npos,
          "invalid UTF-8 direct schema identity accepted");
  auto table_order = ValidLayout();
  std::swap(table_order["tables"][0], table_order["tables"][1]);
  Require(!registry.LoadTrustedForTesting(table_order, &error) &&
              error.find("table order") != std::string::npos,
          "noncanonical layout table order accepted");
  auto field_order = ValidLayout();
  auto& fields = field_order["tables"][1]["fields"];
  std::swap(fields[0], fields[1]);
  Require(!registry.LoadTrustedForTesting(field_order, &error) &&
              error.find("field order") != std::string::npos,
          "noncanonical field order accepted");
  auto mixed_case = ValidLayout();
  mixed_case["tables"][1]["fields"] = json::array({
      Field("Beta", "bitfield", 4, 1, 0, 2, 0, 3),
      Field("alpha", "bitfield", 4, 1, 0, 2, 0, 3),
  });
  Require(registry.LoadTrustedForTesting(mixed_case, &error),
          "bytewise mixed-case field order rejected");
  std::swap(mixed_case["tables"][1]["fields"][0],
            mixed_case["tables"][1]["fields"][1]);
  Require(!registry.LoadTrustedForTesting(mixed_case, &error) &&
              error.find("field order") != std::string::npos,
          "locale-style mixed-case field order accepted");
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
  Require((updated[0] & 0xF8) == (original[0] & 0xF8) &&
              (updated[1] & 0x0F) == (original[1] & 0x0F),
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
    Require(encoded[0] == 0xAA && (encoded[1] & 0xC0) == 0x40 &&
                (encoded[2] & 0x07) == 0x02,
            "signed codec damaged unrelated bits");
  }
  RequireThrows(
      [&] { cfb27::frtk::EncodeField(std::vector<std::uint8_t>(3), signed_field,
                                    DecodedField{std::int64_t{-1025}}); },
      "signed value below minimum accepted");

  const auto offset_binary =
      Definition("offset-binary", 1, 2, 2, 11, -200, 1847);
  const auto offset_original = SyntheticRecord(4, 0x6B);
  const auto offset_expected =
      EncodeMsbFirstOracle(offset_original, offset_binary, 226);
  const auto offset_encoded = cfb27::frtk::EncodeField(
      offset_original, offset_binary, DecodedField{std::int64_t{26}});
  Require(offset_encoded == offset_expected,
          "offset-binary JS/native golden vector mismatch");
  Require(std::get<std::int64_t>(cfb27::frtk::DecodeField(
              offset_expected, offset_binary)) == 26,
          "offset-binary raw 226 did not decode to formatted 26");
  Require((offset_encoded[1] & 0xC0) == (offset_original[1] & 0xC0) &&
              (offset_encoded[2] & 0x07) == (offset_original[2] & 0x07),
          "offset-binary codec damaged unrelated bits");
  for (const std::int64_t value : {-17, 0, 1847}) {
    const auto round_trip = cfb27::frtk::EncodeField(
        offset_original, offset_binary, DecodedField{value});
    Require(std::get<std::int64_t>(
                cfb27::frtk::DecodeField(round_trip, offset_binary)) == value,
            "offset-binary boundary round trip failed");
  }
  RequireThrows(
      [&] { cfb27::frtk::EncodeField(offset_original, offset_binary,
                                    DecodedField{std::int64_t{-201}}); },
      "offset-binary value below minimum accepted");
  auto oversized_offset_range = offset_binary;
  oversized_offset_range.maximum = 1848;
  RequireThrows(
      [&] { cfb27::frtk::DecodeField(offset_original, oversized_offset_range); },
      "offset-binary range larger than raw width accepted");

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

void TestFrTkEndianGoldenVectors() {
  auto reference = Definition("packed-reference", 0, 4, 0, 32, 0,
                              0xFFFFFFFFull);
  reference.reference_table_id = 4288;
  const PackedReference reference_value{4288, 37};
  const auto packed = cfb27::frtk::EncodePackedReference(reference_value);
  const std::vector<std::uint8_t> reference_record{
      static_cast<std::uint8_t>(packed >> 24),
      static_cast<std::uint8_t>(packed >> 16),
      static_cast<std::uint8_t>(packed >> 8),
      static_cast<std::uint8_t>(packed),
  };
  Require(std::get<PackedReference>(
              cfb27::frtk::DecodeField(reference_record, reference)) ==
              reference_value,
          "big-endian packed reference decode failed");
  Require(cfb27::frtk::EncodeField(SyntheticRecord(4, 0x17), reference,
                                   DecodedField{reference_value}) ==
              reference_record,
          "big-endian packed reference encode failed");
  Require(DecodeLittleEndianLsbFirst(reference_record, reference) != packed,
          "little-endian packed reference unexpectedly matched");

  const auto unsigned_field = Definition("bitfield", 1, 2, 3, 10, 0, 1023);
  const auto unsigned_original = SyntheticRecord(4, 0x29);
  const auto unsigned_expected =
      EncodeMsbFirstOracle(unsigned_original, unsigned_field, 0x2D3);
  const auto unsigned_encoded = cfb27::frtk::EncodeField(
      unsigned_original, unsigned_field, DecodedField{std::int64_t{0x2D3}});
  Require(unsigned_encoded == unsigned_expected,
          "10-bit JS/native golden vector mismatch");
  Require(std::get<std::int64_t>(cfb27::frtk::DecodeField(
              unsigned_expected, unsigned_field)) == 0x2D3,
          "10-bit MSB-first decode failed");
  Require((unsigned_encoded[1] & 0xE0) == (unsigned_original[1] & 0xE0) &&
              (unsigned_encoded[2] & 0x07) ==
                  (unsigned_original[2] & 0x07),
          "10-bit encode damaged prefix or suffix bits");
  Require(DecodeLittleEndianLsbFirst(unsigned_expected, unsigned_field) !=
              0x2D3,
          "little-endian 10-bit interpretation unexpectedly matched");

  const auto signed_field = Definition("signed", 1, 2, 2, 11, -1024, 1023);
  const auto signed_original = SyntheticRecord(4, 0x6B);
  const auto signed_expected =
      EncodeMsbFirstOracle(signed_original, signed_field, -317);
  const auto signed_encoded = cfb27::frtk::EncodeField(
      signed_original, signed_field, DecodedField{std::int64_t{-317}});
  Require(signed_encoded == signed_expected,
          "signed 11-bit JS/native golden vector mismatch");
  Require(std::get<std::int64_t>(cfb27::frtk::DecodeField(
              signed_expected, signed_field)) == -317,
          "signed 11-bit MSB-first decode failed");
  Require((signed_encoded[1] & 0xC0) == (signed_original[1] & 0xC0) &&
              (signed_encoded[2] & 0x07) == (signed_original[2] & 0x07),
          "signed encode damaged prefix or suffix bits");

  const auto five_byte =
      Definition("unsigned", 1, 5, 4, 32, 0, 0xFFFFFFFFull);
  const auto five_original = SyntheticRecord(8, 0x3D);
  const auto five_expected =
      EncodeMsbFirstOracle(five_original, five_byte, 0x89ABCDEFull);
  const auto five_encoded = cfb27::frtk::EncodeField(
      five_original, five_byte, DecodedField{std::int64_t{0x89ABCDEFull}});
  Require(five_encoded == five_expected,
          "five-byte JS/native golden vector mismatch");
  Require(std::get<std::int64_t>(cfb27::frtk::DecodeField(
              five_expected, five_byte)) == 0x89ABCDEFull,
          "five-byte 32-bit decode failed");
  Require((five_encoded[1] & 0xF0) == (five_original[1] & 0xF0) &&
              (five_encoded[5] & 0x0F) == (five_original[5] & 0x0F),
          "five-byte encode damaged prefix or suffix bits");
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
    TestFrTkEndianGoldenVectors();
    TestInvalidDefinitions();
    std::cout << "frtk field schema smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk field schema smoke failed: " << error.what() << '\n';
    return 1;
  }
}
