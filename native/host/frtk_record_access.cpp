#include "frtk_record_access.h"

#include <algorithm>
#include <charconv>
#include <iomanip>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>

namespace cfb27::frtk {
namespace {

constexpr const char* kStale = "CATALOG_STALE";
constexpr const char* kInvalid = "FIELD_INVALID";

std::string Address(std::uintptr_t address) {
  std::ostringstream stream;
  stream << "0x" << std::uppercase << std::hex << address;
  return stream.str();
}

const TableSchema* SchemaFor(const SchemaRegistry& schema,
                             const CatalogDescriptor& descriptor) {
  const auto* table = schema.FindTable(descriptor.session_table_id);
  if (!table || table->unique_id != descriptor.unique_id ||
      table->capacity != descriptor.capacity ||
      table->record_size != descriptor.stride) {
    return nullptr;
  }
  return table;
}

bool RowAddress(const CatalogDescriptor& descriptor, std::uint32_t row,
                std::uintptr_t& address) {
  if (row >= descriptor.capacity ||
      (row != 0 && descriptor.stride >
                       std::numeric_limits<std::size_t>::max() / row)) {
    return false;
  }
  const auto offset = static_cast<std::size_t>(row) * descriptor.stride;
  if (offset > std::numeric_limits<std::uintptr_t>::max() -
                   descriptor.base_address) {
    return false;
  }
  address = descriptor.base_address + offset;
  return true;
}

bool ValidReference(const SessionCatalog& catalog, std::uint64_t generation,
                    const FieldDefinition& field, const DecodedField& value) {
  if (field.encoding != "packed-reference") return true;
  const auto* reference = std::get_if<PackedReference>(&value);
  if (!reference || !field.reference_table_id ||
      reference->table_id != *field.reference_table_id) {
    return false;
  }
  return catalog.IsActiveReferenceTarget(reference->table_id,
                                         reference->row_index, generation);
}

std::optional<std::uintptr_t> InternalAddress(std::string_view text) {
  if (text.size() <= 2 || !text.starts_with("0x")) return std::nullopt;
  std::uintptr_t address{};
  const auto [end, error] =
      std::from_chars(text.data() + 2, text.data() + text.size(), address, 16);
  if (error != std::errc{} || end != text.data() + text.size())
    return std::nullopt;
  return address;
}

struct ByteConstraint {
  std::uint8_t expected{};
  std::optional<std::uint8_t> replacement;
};

struct ConstraintRange {
  std::uintptr_t begin{};
  std::uintptr_t end{};
};

bool AddOperationConstraints(
    const memory::TransactionOperation& operation,
    std::map<std::uintptr_t, ByteConstraint>& constraints,
    std::vector<ConstraintRange>& ranges) {
  const auto address = InternalAddress(operation.address);
  if (!address || operation.expected.empty() ||
      (operation.kind == memory::TransactionOperationKind::kWrite &&
       operation.expected.size() != operation.replacement.size()) ||
      (operation.kind == memory::TransactionOperationKind::kVerifyOnly &&
       !operation.replacement.empty()) ||
      *address > std::numeric_limits<std::uintptr_t>::max() -
                     operation.expected.size()) {
    return false;
  }
  ranges.push_back(
      {.begin = *address, .end = *address + operation.expected.size()});
  for (std::size_t index = 0; index < operation.expected.size(); ++index) {
    auto [found, inserted] = constraints.try_emplace(
        *address + index, ByteConstraint{.expected = operation.expected[index]});
    if (!inserted && found->second.expected != operation.expected[index])
      return false;
    if (operation.kind == memory::TransactionOperationKind::kWrite) {
      const auto replacement = operation.replacement[index];
      if (found->second.replacement &&
          *found->second.replacement != replacement) {
        return false;
      }
      found->second.replacement = replacement;
    }
  }
  return true;
}

}  // namespace

FieldReadResult RecordAccessor::ReadFields(
    TableHandle handle, std::uint32_t row,
    std::span<const std::string_view> fields) {
  if (!catalog_.Revalidate(validation_backend_)) return {.code = kStale};
  const auto* descriptor = catalog_.Resolve(handle);
  if (!descriptor) return {.code = kStale};
  const auto* table = SchemaFor(schema_, *descriptor);
  std::uintptr_t address{};
  if (!table || !RowAddress(*descriptor, row, address) || fields.empty()) {
    return {.code = kInvalid};
  }
  std::vector<const FieldDefinition*> definitions;
  definitions.reserve(fields.size());
  for (const auto name : fields) {
    const auto* field = schema_.FindField(table->table_id, name);
    if (!field) return {.code = kInvalid};
    definitions.push_back(field);
  }
  std::vector<std::uint8_t> record(table->record_size);
  if (!memory_backend_.Validate(address, record.size(), false) ||
      !memory_backend_.Read(address, record)) {
    return {.code = "READ_FAILED"};
  }
  FieldReadResult result{.ok = true};
  try {
    for (std::size_t index = 0; index < definitions.size(); ++index) {
      auto value = DecodeField(record, *definitions[index]);
      if (!ValidReference(catalog_, handle.generation, *definitions[index],
                          value)) {
        return {.code = kInvalid};
      }
      result.fields.push_back({std::string(fields[index]), std::move(value)});
    }
  } catch (...) {
    return {.code = kInvalid};
  }
  return result;
}

FieldWritePlan RecordAccessor::PlanFieldWrites(
    TableHandle handle, std::uint32_t row,
    std::span<const FieldChange> changes) {
  CatalogEvidenceSnapshot evidence;
  if (!catalog_.Revalidate(validation_backend_, &evidence))
    return {.code = kStale};
  const auto* descriptor = catalog_.Resolve(handle);
  if (!descriptor) return {.code = kStale};
  const auto* table = SchemaFor(schema_, *descriptor);
  if (!table) return {.code = kInvalid};
  if (descriptor->authority_status != AuthorityStatus::kDirectVerified) {
    return {.code = "AUTHORITY_UNPROVEN"};
  }
  std::uintptr_t address{};
  if (!RowAddress(*descriptor, row, address) || changes.empty()) {
    return {.code = kInvalid};
  }
  std::set<std::string_view> names;
  std::vector<const FieldDefinition*> definitions;
  definitions.reserve(changes.size());
  for (const auto& change : changes) {
    if (!names.insert(change.name).second) return {.code = kInvalid};
    const auto* field = schema_.FindField(table->table_id, change.name);
    if (!field || !ValidReference(catalog_, handle.generation, *field,
                                  change.value)) {
      return {.code = kInvalid};
    }
    definitions.push_back(field);
  }
  std::vector<std::uint8_t> original(table->record_size);
  if (!memory_backend_.Validate(address, original.size(), false) ||
      !memory_backend_.Read(address, original)) {
    return {.code = "READ_FAILED"};
  }
  auto replacement = original;
  try {
    for (std::size_t index = 0; index < changes.size(); ++index) {
      replacement = EncodeField(replacement, *definitions[index],
                                changes[index].value);
    }
  } catch (...) {
    return {.code = kInvalid};
  }

  FieldWritePlan result{.ok = true, .evidence = std::move(evidence)};
  std::size_t index = 0;
  while (index < original.size()) {
    while (index < original.size() && original[index] == replacement[index]) {
      ++index;
    }
    if (index == original.size()) break;
    const auto begin = index;
    while (index < original.size() && original[index] != replacement[index]) {
      ++index;
    }
    result.operations.push_back(
        {.address = Address(address + begin),
         .expected = {original.begin() + begin, original.begin() + index},
         .replacement = {replacement.begin() + begin,
                         replacement.begin() + index}});
    if (result.operations.size() > memory::kMaxTransactionOperations) {
      return {.code = kInvalid};
    }
  }
  if (result.operations.empty()) return {.code = kInvalid};
  return result;
}

GuardedFieldTransaction FinalizeFieldTransaction(
    const SessionCatalog& catalog, std::string transaction_id,
    std::span<const FieldWritePlan> plans) {
  GuardedFieldTransaction result;
  result.request.transaction_id = std::move(transaction_id);
  if (plans.empty()) {
    result.code = kInvalid;
    return result;
  }

  const auto generation = plans.front().evidence.lifecycle_generation;
  const auto& active_unique_ids = plans.front().evidence.active_unique_ids;
  std::map<std::uintptr_t, ByteConstraint> constraints;
  std::vector<ConstraintRange> ranges;
  for (const auto& plan : plans) {
    if (!plan.ok || plan.evidence.lifecycle_generation != generation ||
        plan.evidence.active_unique_ids != active_unique_ids ||
        plan.evidence.guards.empty() ||
        !catalog.EvidenceIsActive(plan.evidence)) {
      result.code = "CATALOG_EVIDENCE_STALE";
      return result;
    }
    for (const auto& guard : plan.evidence.guards) {
      if (!AddOperationConstraints(
              {.address = Address(guard.address),
               .expected = guard.expected,
               .kind = memory::TransactionOperationKind::kVerifyOnly},
              constraints, ranges)) {
        result.code = "CATALOG_EVIDENCE_AMBIGUOUS";
        return result;
      }
    }
    for (const auto& operation : plan.operations) {
      if (!AddOperationConstraints(operation, constraints, ranges)) {
        result.code = "CATALOG_EVIDENCE_AMBIGUOUS";
        return result;
      }
    }
  }

  std::sort(ranges.begin(), ranges.end(),
            [](const ConstraintRange& left, const ConstraintRange& right) {
              if (left.begin != right.begin) return left.begin < right.begin;
              return left.end < right.end;
            });
  std::vector<ConstraintRange> components;
  for (const auto& range : ranges) {
    if (components.empty() || range.begin >= components.back().end) {
      components.push_back(range);
    } else {
      components.back().end = std::max(components.back().end, range.end);
    }
  }

  for (const auto& component : components) {
    const auto size = component.end - component.begin;
    if (size == 0 || size > memory::kMaxOperationBytes) {
      result.code = "TRANSACTION_LIMIT_EXCEEDED";
      return result;
    }
    memory::TransactionOperation operation{
        .address = Address(component.begin)};
    bool has_write = false;
    for (auto address = component.begin; address < component.end; ++address) {
      const auto byte = constraints.find(address);
      if (byte == constraints.end()) {
        result.code = "CATALOG_EVIDENCE_AMBIGUOUS";
        return result;
      }
      operation.expected.push_back(byte->second.expected);
      has_write = has_write || byte->second.replacement.has_value();
    }
    if (has_write) {
      operation.replacement = operation.expected;
      auto byte = constraints.lower_bound(component.begin);
      for (std::size_t index = 0; index < operation.replacement.size();
           ++index, ++byte) {
        if (byte->second.replacement)
          operation.replacement[index] = *byte->second.replacement;
      }
    } else {
      operation.kind = memory::TransactionOperationKind::kVerifyOnly;
    }
    result.request.operations.push_back(std::move(operation));
    if (result.request.operations.size() > memory::kMaxTransactionOperations) {
      result.request.operations.clear();
      result.code = "TRANSACTION_LIMIT_EXCEEDED";
      return result;
    }
  }

  std::size_t aggregate{};
  for (const auto& operation : result.request.operations) {
    if (aggregate >
        memory::kMaxTransactionBytes - operation.expected.size()) {
      result.request.operations.clear();
      result.code = "TRANSACTION_LIMIT_EXCEEDED";
      return result;
    }
    aggregate += operation.expected.size();
  }
  result.ok = true;
  return result;
}

}  // namespace cfb27::frtk
