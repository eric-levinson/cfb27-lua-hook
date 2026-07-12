#include "frtk_lua_api.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>

extern "C" {
#include <lua.h>
#include <lauxlib.h>
}

namespace cfb27::frtk {
namespace {

constexpr char kTableMetatable[] = "CFB27.db.table";
constexpr char kRecordMetatable[] = "CFB27.db.record";
constexpr char kTransactionMetatable[] = "CFB27.db.transaction";

struct TableUserdata {
  TableHandle handle;
};

struct RecordUserdata {
  TableHandle handle;
  std::uint32_t row{};
};

std::mutex& ApiMutex() {
  static auto* mutex = new std::mutex;
  return *mutex;
}

std::unordered_map<lua_State*, LuaDatabaseApi*>& Apis() {
  static auto* apis =
      new std::unordered_map<lua_State*, LuaDatabaseApi*>;
  return *apis;
}

[[noreturn]] void Fail(std::string message) {
  throw std::runtime_error(std::move(message));
}

std::uint32_t CheckUnsigned(lua_State* state, int index, const char* label) {
  if (!lua_isinteger(state, index)) {
    Fail(std::string(label) + " must be an unsigned 32-bit integer");
  }
  const auto value = lua_tointeger(state, index);
  if (value < 0 ||
      static_cast<lua_Unsigned>(value) >
          std::numeric_limits<std::uint32_t>::max()) {
    Fail(std::string(label) + " must be an unsigned 32-bit integer");
  }
  return static_cast<std::uint32_t>(value);
}

void PushDecoded(lua_State* state, const DecodedField& value) {
  if (const auto* integer = std::get_if<std::int64_t>(&value)) {
    lua_pushinteger(state, static_cast<lua_Integer>(*integer));
    return;
  }
  const auto& reference = std::get<PackedReference>(value);
  lua_createtable(state, 0, 2);
  lua_pushinteger(state, reference.table_id);
  lua_setfield(state, -2, "tableId");
  lua_pushinteger(state, reference.row_index);
  lua_setfield(state, -2, "row");
}

DecodedField CheckDecoded(lua_State* state, int index,
                          const FieldDefinition& field) {
  if (field.encoding != "packed-reference") {
    if (!lua_isinteger(state, index))
      Fail("field value must be an integer");
    const auto value = lua_tointeger(state, index);
    return static_cast<std::int64_t>(value);
  }
  if (!lua_istable(state, index)) Fail("packed-reference value must be a table");
  lua_getfield(state, index, "tableId");
  const auto table_id = CheckUnsigned(state, -1, "reference tableId");
  lua_pop(state, 1);
  lua_getfield(state, index, "row");
  const auto row = CheckUnsigned(state, -1, "reference row");
  lua_pop(state, 1);
  if (table_id > std::numeric_limits<std::uint16_t>::max())
    Fail("reference tableId is out of range");
  return PackedReference{static_cast<std::uint16_t>(table_id), row};
}

void CreateMetatable(lua_State* state, const char* name,
                     lua_CFunction method, const char* method_name) {
  luaL_newmetatable(state, name);
  lua_newtable(state);
  lua_pushcfunction(state, method);
  lua_setfield(state, -2, method_name);
  lua_setfield(state, -2, "__index");
  lua_pop(state, 1);
}

}  // namespace

LuaDatabaseApi::LuaDatabaseApi(SessionCatalog& catalog,
                               const SchemaRegistry& schema,
                               DiscoveryBackend& validation_backend,
                               memory::MemoryBackend& memory_backend,
                               LuaTransactionSubmitter submit_transaction,
                               std::mutex* catalog_mutex)
    : catalog_(catalog),
      schema_provider_([&schema] { return &schema; }),
      validation_backend_(validation_backend),
      memory_backend_(memory_backend),
      submit_transaction_(std::move(submit_transaction)),
      catalog_mutex_(catalog_mutex) {}

LuaDatabaseApi::LuaDatabaseApi(SessionCatalog& catalog,
                               LuaSchemaProvider schema_provider,
                               DiscoveryBackend& validation_backend,
                               memory::MemoryBackend& memory_backend,
                               LuaTransactionSubmitter submit_transaction,
                               std::mutex* catalog_mutex)
    : catalog_(catalog),
      schema_provider_(std::move(schema_provider)),
      validation_backend_(validation_backend),
      memory_backend_(memory_backend),
      submit_transaction_(std::move(submit_transaction)),
      catalog_mutex_(catalog_mutex) {}

LuaDatabaseApi::~LuaDatabaseApi() {
  std::lock_guard lock(ApiMutex());
  const auto found = Apis().find(state_);
  if (found != Apis().end() && found->second == this) Apis().erase(found);
}

LuaDatabaseApi& LuaDatabaseApi::Self(lua_State* state) {
  std::lock_guard lock(ApiMutex());
  const auto found = Apis().find(state);
  if (found == Apis().end()) Fail("CFB27 database API is not registered");
  return *found->second;
}

int LuaDatabaseApi::Invoke(lua_State* state, Method method) {
  bool failed = false;
  try {
    return (Self(state).*method)(state);
  } catch (const std::exception& error) {
    lua_pushstring(state, error.what());
    failed = true;
  } catch (...) {
    lua_pushliteral(state, "CFB27 database API failed");
    failed = true;
  }
  if (failed) return lua_error(state);
  return 0;
}

void LuaDatabaseApi::Register(lua_State* state) {
  {
    std::lock_guard lock(ApiMutex());
    state_ = state;
    Apis()[state] = this;
  }
  CreateMetatable(state, kTableMetatable, GetRecord, "GetRecord");
  CreateMetatable(state, kRecordMetatable, GetField, "GetField");
  CreateMetatable(state, kTransactionMetatable, SetField, "SetField");

  lua_getglobal(state, "CFB27");
  if (!lua_istable(state, -1)) {
    lua_pop(state, 1);
    lua_newtable(state);
  }
  lua_newtable(state);
  lua_pushcfunction(state, GetTableByUniqueId);
  lua_setfield(state, -2, "GetTableByUniqueId");
  lua_pushcfunction(state, Transaction);
  lua_setfield(state, -2, "Transaction");
  lua_setfield(state, -2, "db");
  lua_setglobal(state, "CFB27");
}

int LuaDatabaseApi::GetTableByUniqueId(lua_State* state) {
  return Invoke(state, &LuaDatabaseApi::DoGetTableByUniqueId);
}

int LuaDatabaseApi::DoGetTableByUniqueId(lua_State* state) {
  const auto unique_id = CheckUnsigned(state, 2, "uniqueId");
  std::unique_lock<std::mutex> lock;
  if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
  const auto handle = catalog_.GetHandle(unique_id);
  if (lock.owns_lock()) lock.unlock();
  if (!handle) Fail("unknown table Unique ID");
  auto* table = static_cast<TableUserdata*>(
      lua_newuserdatauv(state, sizeof(TableUserdata), 0));
  table->handle = *handle;
  luaL_setmetatable(state, kTableMetatable);
  return 1;
}

int LuaDatabaseApi::GetRecord(lua_State* state) {
  return Invoke(state, &LuaDatabaseApi::DoGetRecord);
}

int LuaDatabaseApi::DoGetRecord(lua_State* state) {
  const auto* table = static_cast<TableUserdata*>(
      luaL_testudata(state, 1, kTableMetatable));
  if (!table) Fail("table userdata expected");
  const auto row = CheckUnsigned(state, 2, "row");
  std::unique_lock<std::mutex> lock;
  if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
  const auto* descriptor = catalog_.Resolve(table->handle);
  const auto capacity = descriptor ? descriptor->capacity : 0;
  if (lock.owns_lock()) lock.unlock();
  if (!descriptor) Fail("catalog handle is stale");
  if (row >= capacity) Fail("row is out of range");
  auto* record = static_cast<RecordUserdata*>(
      lua_newuserdatauv(state, sizeof(RecordUserdata), 0));
  record->handle = table->handle;
  record->row = row;
  luaL_setmetatable(state, kRecordMetatable);
  return 1;
}

int LuaDatabaseApi::GetField(lua_State* state) {
  return Invoke(state, &LuaDatabaseApi::DoGetField);
}

int LuaDatabaseApi::DoGetField(lua_State* state) {
  const auto* record = static_cast<RecordUserdata*>(
      luaL_testudata(state, 1, kRecordMetatable));
  if (!record) Fail("record userdata expected");
  if (lua_type(state, 2) != LUA_TSTRING) Fail("field name must be a string");
  const std::string field = lua_tostring(state, 2);
  std::unique_lock<std::mutex> lock;
  if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
  const bool resolved = catalog_.Resolve(record->handle) != nullptr;
  const auto* schema = schema_provider_();
  FieldReadResult result;
  if (resolved && schema) {
    RecordAccessor accessor(catalog_, *schema, validation_backend_,
                            memory_backend_);
    result = accessor.ReadFields(record->handle, record->row, {field});
  }
  if (lock.owns_lock()) lock.unlock();
  if (!resolved) Fail("catalog handle is stale");
  if (!schema) Fail("field schema is not loaded");
  if (!result.ok || result.fields.size() != 1)
    Fail("field read refused: " + result.code);
  PushDecoded(state, result.fields.front().value);
  return 1;
}

int LuaDatabaseApi::SetField(lua_State* state) {
  return Invoke(state, &LuaDatabaseApi::DoSetField);
}

int LuaDatabaseApi::DoSetField(lua_State* state) {
  if (!transaction_active_) Fail("transaction is not active");
  const bool already_failed = transaction_failed_;
  transaction_failed_ = true;
  if (!luaL_testudata(state, 1, kTransactionMetatable))
    Fail("transaction userdata expected");
  const auto* record = static_cast<RecordUserdata*>(
      luaL_testudata(state, 2, kRecordMetatable));
  if (!record) Fail("record userdata expected");
  if (lua_type(state, 3) != LUA_TSTRING) Fail("field name must be a string");
  const std::string name = lua_tostring(state, 3);
  std::unique_lock<std::mutex> lock;
  if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
  const auto* descriptor = catalog_.Resolve(record->handle);
  const bool direct = descriptor &&
      descriptor->authority_status == AuthorityStatus::kDirectVerified;
  const auto* schema = schema_provider_();
  const auto* table = descriptor && schema ?
      schema->FindTable(descriptor->session_table_id) : nullptr;
  const auto* found_field = table ? schema->FindField(table->table_id, name) : nullptr;
  const std::optional<FieldDefinition> field = found_field ?
      std::optional<FieldDefinition>(*found_field) : std::nullopt;
  if (lock.owns_lock()) lock.unlock();
  if (!descriptor) Fail("catalog handle is stale");
  if (!direct) Fail("table write authority is unproven");
  if (!schema) Fail("field schema is not loaded");
  if (!field) Fail("unknown field");
  const auto duplicate = std::find_if(
      pending_changes_.begin(), pending_changes_.end(),
      [&](const PendingChange& item) {
        return item.handle.unique_id == record->handle.unique_id &&
               item.row == record->row && item.change.name == name;
      });
  if (duplicate != pending_changes_.end()) Fail("duplicate field change");
  pending_changes_.push_back(
      {record->handle, record->row, {name, CheckDecoded(state, 4, *field)}});
  transaction_failed_ = already_failed;
  return 0;
}

int LuaDatabaseApi::Transaction(lua_State* state) {
  return Invoke(state, &LuaDatabaseApi::DoTransaction);
}

int LuaDatabaseApi::DoTransaction(lua_State* state) {
  if (!lua_isfunction(state, 2)) Fail("transaction callback must be a function");
  if (transaction_active_) {
    transaction_failed_ = true;
    Fail("nested transactions are forbidden");
  }
  transaction_active_ = true;
  transaction_failed_ = false;
  pending_changes_.clear();
  lua_pushvalue(state, 2);
  lua_newuserdatauv(state, 1, 0);
  luaL_setmetatable(state, kTransactionMetatable);
  const int callback_status = lua_pcall(state, 1, 0, 0);
  transaction_active_ = false;
  if (callback_status != LUA_OK) {
    pending_changes_.clear();
    return lua_error(state);
  }
  if (transaction_failed_) {
    pending_changes_.clear();
    Fail("transaction callback contained a refused change");
  }
  if (pending_changes_.empty()) Fail("transaction contains no field changes");

  std::unique_lock<std::mutex> lock;
  if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
  memory::TransactionRequest request{
      .transaction_id = "lua-db-" + std::to_string(catalog_.generation())};
  std::sort(pending_changes_.begin(), pending_changes_.end(),
            [](const PendingChange& left, const PendingChange& right) {
              if (left.handle.unique_id != right.handle.unique_id)
                return left.handle.unique_id < right.handle.unique_id;
              return left.row < right.row;
            });
  const auto* schema = schema_provider_();
  if (!schema) {
    pending_changes_.clear();
    Fail("field schema is not loaded");
  }
  std::size_t cursor = 0;
  while (cursor < pending_changes_.size()) {
    const auto handle = pending_changes_[cursor].handle;
    const auto row = pending_changes_[cursor].row;
    std::vector<FieldChange> changes;
    while (cursor < pending_changes_.size() &&
           pending_changes_[cursor].handle.unique_id == handle.unique_id &&
           pending_changes_[cursor].row == row) {
      changes.push_back(pending_changes_[cursor].change);
      ++cursor;
    }
    RecordAccessor accessor(catalog_, *schema, validation_backend_,
                            memory_backend_);
    const auto plan = accessor.PlanFieldWrites(handle, row, changes);
    if (!plan.ok) {
      pending_changes_.clear();
      Fail("field transaction refused: " + plan.code);
    }
    request.operations.insert(request.operations.end(), plan.operations.begin(),
                              plan.operations.end());
  }
  pending_changes_.clear();
  const auto result = submit_transaction_(request);
  if (lock.owns_lock()) lock.unlock();
  if (result.status != memory::TransactionStatus::kAppliedVerified)
    Fail("field transaction failed: " + result.code);
  lua_pushboolean(state, 1);
  return 1;
}

}  // namespace cfb27::frtk
