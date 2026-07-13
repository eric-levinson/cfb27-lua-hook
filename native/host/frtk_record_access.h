#pragma once

#include "frtk_catalog.h"
#include "memory_transaction.h"

#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace cfb27::frtk {

struct NamedFieldValue {
  std::string name;
  DecodedField value;
};

struct FieldReadResult {
  bool ok{};
  std::string code;
  std::vector<NamedFieldValue> fields;
};

struct FieldChange {
  std::string name;
  DecodedField value;
};

struct FieldWritePlan {
  bool ok{};
  std::string code;
  CatalogEvidenceSnapshot evidence;
  std::vector<memory::TransactionOperation> operations;
};

struct GuardedFieldTransaction {
  bool ok{};
  std::string code;
  memory::TransactionRequest request;
};

GuardedFieldTransaction FinalizeFieldTransaction(
    const SessionCatalog& catalog, std::string transaction_id,
    std::span<const FieldWritePlan> plans);
inline GuardedFieldTransaction FinalizeFieldTransaction(
    const SessionCatalog& catalog, std::string transaction_id,
    std::initializer_list<FieldWritePlan> plans) {
  return FinalizeFieldTransaction(
      catalog, std::move(transaction_id),
      std::span<const FieldWritePlan>(plans.begin(), plans.size()));
}

class RecordAccessor {
 public:
  RecordAccessor(SessionCatalog& catalog, const SchemaRegistry& schema,
                 DiscoveryBackend& validation_backend,
                 memory::MemoryBackend& memory_backend)
      : catalog_(catalog),
        schema_(schema),
        validation_backend_(validation_backend),
        memory_backend_(memory_backend) {}

  FieldReadResult ReadFields(TableHandle handle, std::uint32_t row,
                             std::span<const std::string_view> fields);
  FieldReadResult ReadFields(TableHandle handle, std::uint32_t row,
                             std::initializer_list<std::string_view> fields) {
    return ReadFields(handle, row,
                      std::span<const std::string_view>(fields.begin(),
                                                        fields.size()));
  }
  FieldWritePlan PlanFieldWrites(TableHandle handle, std::uint32_t row,
                                 std::span<const FieldChange> changes);
  FieldWritePlan PlanFieldWrites(TableHandle handle, std::uint32_t row,
                                 std::initializer_list<FieldChange> changes) {
    return PlanFieldWrites(handle, row,
                           std::span<const FieldChange>(changes.begin(),
                                                        changes.size()));
  }

 private:
  SessionCatalog& catalog_;
  const SchemaRegistry& schema_;
  DiscoveryBackend& validation_backend_;
  memory::MemoryBackend& memory_backend_;
};

}  // namespace cfb27::frtk
