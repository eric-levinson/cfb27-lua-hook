#pragma once

#include "frtk_record_access.h"

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

  static LuaDatabaseApi& Self(lua_State* state);
  using Method = int (LuaDatabaseApi::*)(lua_State*);
  static int Invoke(lua_State* state, Method method);
  static int GetTableByUniqueId(lua_State* state);
  static int GetRecord(lua_State* state);
  static int GetField(lua_State* state);
  static int Transaction(lua_State* state);
  static int SetField(lua_State* state);
  int DoGetTableByUniqueId(lua_State* state);
  int DoGetRecord(lua_State* state);
  int DoGetField(lua_State* state);
  int DoTransaction(lua_State* state);
  int DoSetField(lua_State* state);

  lua_State* state_{};
};

}  // namespace cfb27::frtk
