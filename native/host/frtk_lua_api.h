#pragma once

#include "frtk_record_access.h"

#include <array>
#include <functional>
#include <mutex>

struct lua_State;

namespace cfb27::frtk {

using LuaTransactionSubmitter = std::function<memory::TransactionResult(
    const memory::TransactionRequest&)>;
using LuaSchemaProvider = std::function<const SchemaRegistry*()>;

class LuaDatabaseApi {
 public:
  LuaDatabaseApi(SessionCatalog& catalog, const SchemaRegistry& schema,
                 DiscoveryBackend& validation_backend,
                 memory::MemoryBackend& memory_backend,
                 LuaTransactionSubmitter submit_transaction,
                 std::mutex* catalog_mutex = nullptr);
  LuaDatabaseApi(SessionCatalog& catalog, LuaSchemaProvider schema_provider,
                 DiscoveryBackend& validation_backend,
                 memory::MemoryBackend& memory_backend,
                 LuaTransactionSubmitter submit_transaction,
                 std::mutex* catalog_mutex = nullptr);
  ~LuaDatabaseApi();

  void Register(lua_State* state);

 private:
  enum class PreparedStatus { kReady, kError };
  struct PendingChange {
    TableHandle handle;
    std::uint32_t row{};
    FieldChange change;
  };

  SessionCatalog& catalog_;
  LuaSchemaProvider schema_provider_;
  DiscoveryBackend& validation_backend_;
  memory::MemoryBackend& memory_backend_;
  LuaTransactionSubmitter submit_transaction_;
  std::mutex* catalog_mutex_{};
  bool transaction_active_{};
  bool transaction_failed_{};
  std::vector<PendingChange> pending_changes_;

  static LuaDatabaseApi* Find(lua_State* state) noexcept;
  static int Raise(lua_State* state, const LuaDatabaseApi* api);
  static int RaiseLiteral(lua_State* state, const char* message);
  static int GetTableByUniqueId(lua_State* state);
  static int GetRecord(lua_State* state);
  static int GetField(lua_State* state);
  static int Transaction(lua_State* state);
  static int SetField(lua_State* state);
  PreparedStatus PrepareGetTable(std::uint32_t unique_id) noexcept;
  PreparedStatus PrepareGetRecord(TableHandle handle,
                                  std::uint32_t row) noexcept;
  PreparedStatus PrepareGetField(TableHandle handle, std::uint32_t row,
                                 const char* name,
                                 std::size_t name_size) noexcept;
  PreparedStatus PrepareSetField(TableHandle handle, std::uint32_t row,
                                 const char* name, std::size_t name_size,
                                 bool is_reference, bool is_integer,
                                 std::int64_t integer,
                                 std::uint32_t reference_unique_id,
                                 std::uint32_t reference_row) noexcept;
  PreparedStatus BeginTransaction() noexcept;
  PreparedStatus FinishTransaction() noexcept;
  void AbortTransaction() noexcept;
  void PoisonTransaction() noexcept { transaction_failed_ = true; }
  void SetError(const char* message) noexcept;

  lua_State* state_{};
  std::array<char, 256> error_{};
  std::size_t error_size_{};
  TableHandle prepared_handle_{};
  std::uint32_t prepared_row_{};
  bool prepared_is_reference_{};
  std::int64_t prepared_integer_{};
  std::uint32_t prepared_reference_unique_id_{};
  std::uint32_t prepared_reference_row_{};
};

}  // namespace cfb27::frtk
