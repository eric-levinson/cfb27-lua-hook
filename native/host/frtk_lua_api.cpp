#include "frtk_lua_api.h"

#include <algorithm>
#include <cstring>
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
constexpr std::uint32_t kTableMagic = 0x54424C31;
constexpr std::uint32_t kRecordMagic = 0x52454331;
constexpr std::uint32_t kTransactionMagic = 0x54584E31;

struct TableUserdata {
  std::uint32_t magic;
  TableHandle handle;
};

struct RecordUserdata {
  std::uint32_t magic;
  TableHandle handle;
  std::uint32_t row;
};

struct TransactionUserdata {
  std::uint32_t magic;
};

std::mutex& ApiMutex() {
  static auto* mutex = new std::mutex;
  return *mutex;
}

std::unordered_map<lua_State*, LuaDatabaseApi*>& Apis() {
  static auto* apis = new std::unordered_map<lua_State*, LuaDatabaseApi*>;
  return *apis;
}

bool Unsigned(lua_State* state, int index, std::uint32_t* output) noexcept {
  if (!lua_isinteger(state, index)) return false;
  const lua_Integer value = lua_tointeger(state, index);
  if (value < 0 || static_cast<lua_Unsigned>(value) >
                       std::numeric_limits<std::uint32_t>::max()) {
    return false;
  }
  *output = static_cast<std::uint32_t>(value);
  return true;
}

TableUserdata* TableValue(lua_State* state, int index) noexcept {
  if (lua_type(state, index) != LUA_TUSERDATA ||
      lua_rawlen(state, index) != sizeof(TableUserdata)) return nullptr;
  auto* value = static_cast<TableUserdata*>(lua_touserdata(state, index));
  return value && value->magic == kTableMagic ? value : nullptr;
}

RecordUserdata* RecordValue(lua_State* state, int index) noexcept {
  if (lua_type(state, index) != LUA_TUSERDATA ||
      lua_rawlen(state, index) != sizeof(RecordUserdata)) return nullptr;
  auto* value = static_cast<RecordUserdata*>(lua_touserdata(state, index));
  return value && value->magic == kRecordMagic ? value : nullptr;
}

bool TransactionValue(lua_State* state, int index) noexcept {
  if (lua_type(state, index) != LUA_TUSERDATA ||
      lua_rawlen(state, index) != sizeof(TransactionUserdata)) return false;
  auto* value = static_cast<TransactionUserdata*>(lua_touserdata(state, index));
  return value && value->magic == kTransactionMagic;
}

int ReferenceParts(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  if (lua_type(state, 1) != LUA_TTABLE) {
    lua_pushliteral(state, "packed-reference value must be a table");
    return lua_error(state);
  }
  std::uint32_t unique_id = 0;
  std::uint32_t row = 0;
  int seen_unique_id = 0;
  int seen_row = 0;
  int count = 0;
  lua_pushnil(state);
  while (lua_next(state, 1) != 0) {
    ++count;
    if (lua_type(state, -2) != LUA_TSTRING) {
      lua_pushliteral(state, "packed-reference must contain only uniqueId and row");
      return lua_error(state);
    }
    size_t key_size = 0;
    const char* key = lua_tolstring(state, -2, &key_size);
    std::uint32_t value = 0;
    if (!Unsigned(state, -1, &value)) {
      lua_pushliteral(state, "packed-reference values must be unsigned integers");
      return lua_error(state);
    }
    if (key_size == 8 && std::memcmp(key, "uniqueId", 8) == 0) {
      unique_id = value;
      seen_unique_id = 1;
    } else if (key_size == 3 && std::memcmp(key, "row", 3) == 0) {
      row = value;
      seen_row = 1;
    } else {
      lua_pushliteral(state, "packed-reference must contain only uniqueId and row");
      return lua_error(state);
    }
    lua_pop(state, 1);
  }
  if (count != 2 || !seen_unique_id || !seen_row) {
    lua_pushliteral(state, "packed-reference requires uniqueId and row");
    return lua_error(state);
  }
  lua_pushinteger(state, static_cast<lua_Integer>(unique_id));
  lua_pushinteger(state, static_cast<lua_Integer>(row));
  return 2;
}

int ProtectedReferenceParts(lua_State* state, int index) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushcfunction(state, ReferenceParts);
  lua_pushvalue(state, index);
  return lua_pcall(state, 1, 2, 0);
}

int TransactionCallbackThunk(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushvalue(state, 1);
  auto* value = static_cast<TransactionUserdata*>(
      lua_newuserdatauv(state, sizeof(TransactionUserdata), 0));
  value->magic = kTransactionMagic;
  luaL_setmetatable(state, kTransactionMetatable);
  lua_call(state, 1, 0);
  return 0;
}

void CreateMetatable(lua_State* state, const char* name,
                     lua_CFunction method, const char* method_name,
                     lua_CFunction to_string) {
  luaL_newmetatable(state, name);
  lua_pushcfunction(state, to_string);
  lua_setfield(state, -2, "__tostring");
  lua_newtable(state);
  lua_pushcfunction(state, method);
  lua_setfield(state, -2, method_name);
  lua_setfield(state, -2, "__index");
  lua_pop(state, 1);
}

int TableToString(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushliteral(state, "CFB27.db table");
  return 1;
}

int RecordToString(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushliteral(state, "CFB27.db record");
  return 1;
}

int TransactionToString(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushliteral(state, "CFB27.db transaction");
  return 1;
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

LuaDatabaseApi* LuaDatabaseApi::Find(lua_State* state) noexcept {
  std::lock_guard lock(ApiMutex());
  const auto found = Apis().find(state);
  return found == Apis().end() ? nullptr : found->second;
}

void LuaDatabaseApi::SetError(const char* message) noexcept {
  if (!message) message = "CFB27 database API failed";
  error_size_ = (std::min)(std::strlen(message), error_.size() - 1);
  std::memcpy(error_.data(), message, error_size_);
  error_[error_size_] = '\0';
}

int LuaDatabaseApi::Raise(lua_State* state, const LuaDatabaseApi* api) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushlstring(state, api->error_.data(), api->error_size_);
  return lua_error(state);
}

int LuaDatabaseApi::RaiseLiteral(lua_State* state, const char* message) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  lua_pushstring(state, message);
  return lua_error(state);
}

void LuaDatabaseApi::Register(lua_State* state) {
  {
    std::lock_guard lock(ApiMutex());
    state_ = state;
    Apis()[state] = this;
  }
  CreateMetatable(state, kTableMetatable, GetRecord, "GetRecord", TableToString);
  CreateMetatable(state, kRecordMetatable, GetField, "GetField", RecordToString);
  CreateMetatable(state, kTransactionMetatable, SetField, "SetField",
                  TransactionToString);
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

LuaDatabaseApi::PreparedStatus LuaDatabaseApi::PrepareGetTable(
    std::uint32_t unique_id) noexcept {
  try {
    std::unique_lock<std::mutex> lock;
    if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
    const auto handle = catalog_.GetHandle(unique_id);
    if (!handle) {
      SetError("unknown table Unique ID");
      return PreparedStatus::kError;
    }
    prepared_handle_ = *handle;
    return PreparedStatus::kReady;
  } catch (const std::exception& error) {
    SetError(error.what());
  } catch (...) {
    SetError(nullptr);
  }
  return PreparedStatus::kError;
}

int LuaDatabaseApi::GetTableByUniqueId(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  LuaDatabaseApi* api = Find(state);
  if (!api) return RaiseLiteral(state, "CFB27 database API is not registered");
  std::uint32_t unique_id = 0;
  if (!Unsigned(state, 2, &unique_id))
    return RaiseLiteral(state, "uniqueId must be an unsigned 32-bit integer");
  const PreparedStatus status = api->PrepareGetTable(unique_id);
  if (status == PreparedStatus::kError) return Raise(state, api);
  auto* value = static_cast<TableUserdata*>(
      lua_newuserdatauv(state, sizeof(TableUserdata), 0));
  value->magic = kTableMagic;
  value->handle = api->prepared_handle_;
  luaL_setmetatable(state, kTableMetatable);
  return 1;
}

LuaDatabaseApi::PreparedStatus LuaDatabaseApi::PrepareGetRecord(
    TableHandle handle, std::uint32_t row) noexcept {
  try {
    std::unique_lock<std::mutex> lock;
    if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
    const auto* descriptor = catalog_.Resolve(handle);
    if (!descriptor) {
      SetError("catalog handle is stale");
      return PreparedStatus::kError;
    }
    if (row >= descriptor->capacity) {
      SetError("row is out of range");
      return PreparedStatus::kError;
    }
    prepared_handle_ = handle;
    prepared_row_ = row;
    return PreparedStatus::kReady;
  } catch (const std::exception& error) {
    SetError(error.what());
  } catch (...) {
    SetError(nullptr);
  }
  return PreparedStatus::kError;
}

int LuaDatabaseApi::GetRecord(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  LuaDatabaseApi* api = Find(state);
  if (!api) return RaiseLiteral(state, "CFB27 database API is not registered");
  TableUserdata* table = TableValue(state, 1);
  if (!table) return RaiseLiteral(state, "table userdata expected");
  std::uint32_t row = 0;
  if (!Unsigned(state, 2, &row))
    return RaiseLiteral(state, "row must be an unsigned 32-bit integer");
  const PreparedStatus status = api->PrepareGetRecord(table->handle, row);
  if (status == PreparedStatus::kError) return Raise(state, api);
  auto* value = static_cast<RecordUserdata*>(
      lua_newuserdatauv(state, sizeof(RecordUserdata), 0));
  value->magic = kRecordMagic;
  value->handle = api->prepared_handle_;
  value->row = api->prepared_row_;
  luaL_setmetatable(state, kRecordMetatable);
  return 1;
}

LuaDatabaseApi::PreparedStatus LuaDatabaseApi::PrepareGetField(
    TableHandle handle, std::uint32_t row, const char* name,
    std::size_t name_size) noexcept {
  try {
    const std::string field(name, name_size);
    std::unique_lock<std::mutex> lock;
    if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
    if (!catalog_.Resolve(handle)) {
      SetError("catalog handle is stale");
      return PreparedStatus::kError;
    }
    const auto* schema = schema_provider_();
    if (!schema) {
      SetError("field schema is not loaded");
      return PreparedStatus::kError;
    }
    RecordAccessor accessor(catalog_, *schema, validation_backend_, memory_backend_);
    const auto result = accessor.ReadFields(handle, row, {field});
    if (!result.ok || result.fields.size() != 1) {
      const std::string error = "field read refused: " + result.code;
      SetError(error.c_str());
      return PreparedStatus::kError;
    }
    if (const auto* integer = std::get_if<std::int64_t>(&result.fields[0].value)) {
      prepared_is_reference_ = false;
      prepared_integer_ = *integer;
      return PreparedStatus::kReady;
    }
    const auto reference = std::get<PackedReference>(result.fields[0].value);
    const auto unique_id = catalog_.ActiveUniqueId(
        reference.table_id, reference.row_index, handle.generation);
    if (!unique_id) {
      SetError("packed-reference target is inactive");
      return PreparedStatus::kError;
    }
    prepared_is_reference_ = true;
    prepared_reference_unique_id_ = *unique_id;
    prepared_reference_row_ = reference.row_index;
    return PreparedStatus::kReady;
  } catch (const std::exception& error) {
    SetError(error.what());
  } catch (...) {
    SetError(nullptr);
  }
  return PreparedStatus::kError;
}

int LuaDatabaseApi::GetField(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  LuaDatabaseApi* api = Find(state);
  if (!api) return RaiseLiteral(state, "CFB27 database API is not registered");
  RecordUserdata* record = RecordValue(state, 1);
  if (!record) return RaiseLiteral(state, "record userdata expected");
  if (lua_type(state, 2) != LUA_TSTRING)
    return RaiseLiteral(state, "field name must be a string");
  size_t name_size = 0;
  const char* name = lua_tolstring(state, 2, &name_size);
  const PreparedStatus status =
      api->PrepareGetField(record->handle, record->row, name, name_size);
  if (status == PreparedStatus::kError) return Raise(state, api);
  if (!api->prepared_is_reference_) {
    lua_pushinteger(state, static_cast<lua_Integer>(api->prepared_integer_));
    return 1;
  }
  lua_createtable(state, 0, 2);
  lua_pushinteger(state,
                  static_cast<lua_Integer>(api->prepared_reference_unique_id_));
  lua_setfield(state, -2, "uniqueId");
  lua_pushinteger(state,
                  static_cast<lua_Integer>(api->prepared_reference_row_));
  lua_setfield(state, -2, "row");
  return 1;
}

LuaDatabaseApi::PreparedStatus LuaDatabaseApi::PrepareSetField(
    TableHandle handle, std::uint32_t row, const char* name,
    std::size_t name_size, bool is_reference, bool is_integer,
    std::int64_t integer,
    std::uint32_t reference_unique_id,
    std::uint32_t reference_row) noexcept {
  try {
    const bool already_failed = transaction_failed_;
    transaction_failed_ = true;
    const std::string field_name(name, name_size);
    std::unique_lock<std::mutex> lock;
    if (catalog_mutex_) lock = std::unique_lock(*catalog_mutex_);
    const auto* descriptor = catalog_.Resolve(handle);
    if (!descriptor) {
      SetError("catalog handle is stale");
      return PreparedStatus::kError;
    }
    if (descriptor->authority_status != AuthorityStatus::kDirectVerified) {
      SetError("table write authority is unproven");
      return PreparedStatus::kError;
    }
    const auto* schema = schema_provider_();
    if (!schema) {
      SetError("field schema is not loaded");
      return PreparedStatus::kError;
    }
    const auto* definition = schema->FindField(descriptor->session_table_id,
                                                field_name);
    if (!definition) {
      SetError("unknown field");
      return PreparedStatus::kError;
    }
    DecodedField decoded = integer;
    if (definition->encoding == "packed-reference") {
      if (!is_reference) {
        SetError("packed-reference value must be a table");
        return PreparedStatus::kError;
      }
      const auto table_id = catalog_.ActiveTableId(
          reference_unique_id, reference_row, handle.generation);
      if (!table_id) {
        SetError("packed-reference target is inactive");
        return PreparedStatus::kError;
      }
      decoded = PackedReference{*table_id, reference_row};
    } else if (is_reference || !is_integer) {
      SetError("field value must be an integer");
      return PreparedStatus::kError;
    }
    const auto duplicate = std::find_if(
        pending_changes_.begin(), pending_changes_.end(),
        [&](const PendingChange& item) {
          return item.handle.unique_id == handle.unique_id && item.row == row &&
                 item.change.name == field_name;
        });
    if (duplicate != pending_changes_.end()) {
      SetError("duplicate field change");
      return PreparedStatus::kError;
    }
    pending_changes_.push_back({handle, row, {field_name, decoded}});
    transaction_failed_ = already_failed;
    return PreparedStatus::kReady;
  } catch (const std::exception& error) {
    SetError(error.what());
  } catch (...) {
    SetError(nullptr);
  }
  transaction_failed_ = true;
  return PreparedStatus::kError;
}

int LuaDatabaseApi::SetField(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  LuaDatabaseApi* api = Find(state);
  if (!api) return RaiseLiteral(state, "CFB27 database API is not registered");
  if (!api->transaction_active_)
    return RaiseLiteral(state, "transaction is not active");
  if (!TransactionValue(state, 1)) {
    api->PoisonTransaction();
    return RaiseLiteral(state, "transaction userdata expected");
  }
  RecordUserdata* record = RecordValue(state, 2);
  if (!record) {
    api->PoisonTransaction();
    return RaiseLiteral(state, "record userdata expected");
  }
  if (lua_type(state, 3) != LUA_TSTRING) {
    api->PoisonTransaction();
    return RaiseLiteral(state, "field name must be a string");
  }
  size_t name_size = 0;
  const char* name = lua_tolstring(state, 3, &name_size);
  bool is_reference = lua_type(state, 4) == LUA_TTABLE;
  bool is_integer = lua_isinteger(state, 4);
  std::int64_t integer = 0;
  std::uint32_t reference_unique_id = 0;
  std::uint32_t reference_row = 0;
  if (is_reference) {
    const int status = ProtectedReferenceParts(state, 4);
    if (status != LUA_OK) {
      api->PoisonTransaction();
      return lua_error(state);
    }
    reference_unique_id = static_cast<std::uint32_t>(lua_tointeger(state, -2));
    reference_row = static_cast<std::uint32_t>(lua_tointeger(state, -1));
    lua_pop(state, 2);
  } else if (is_integer) {
    integer = static_cast<std::int64_t>(lua_tointeger(state, 4));
  }
  const PreparedStatus status = api->PrepareSetField(
      record->handle, record->row, name, name_size, is_reference, is_integer,
      integer,
      reference_unique_id, reference_row);
  if (status == PreparedStatus::kError) return Raise(state, api);
  return 0;
}

LuaDatabaseApi::PreparedStatus LuaDatabaseApi::BeginTransaction() noexcept {
  if (transaction_active_) {
    transaction_failed_ = true;
    SetError("nested transactions are forbidden");
    return PreparedStatus::kError;
  }
  transaction_active_ = true;
  transaction_failed_ = false;
  pending_changes_.clear();
  return PreparedStatus::kReady;
}

void LuaDatabaseApi::AbortTransaction() noexcept {
  transaction_active_ = false;
  transaction_failed_ = false;
  pending_changes_.clear();
}

LuaDatabaseApi::PreparedStatus LuaDatabaseApi::FinishTransaction() noexcept {
  transaction_active_ = false;
  try {
    if (transaction_failed_) {
      pending_changes_.clear();
      transaction_failed_ = false;
      SetError("transaction callback contained a refused change");
      return PreparedStatus::kError;
    }
    if (pending_changes_.empty()) {
      SetError("transaction contains no field changes");
      return PreparedStatus::kError;
    }
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
      SetError("field schema is not loaded");
      return PreparedStatus::kError;
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
        const std::string error = "field transaction refused: " + plan.code;
        SetError(error.c_str());
        return PreparedStatus::kError;
      }
      request.operations.insert(request.operations.end(), plan.operations.begin(),
                                plan.operations.end());
    }
    pending_changes_.clear();
    const auto result = submit_transaction_(request);
    if (result.status != memory::TransactionStatus::kAppliedVerified) {
      const std::string error = "field transaction failed: " + result.code;
      SetError(error.c_str());
      return PreparedStatus::kError;
    }
    return PreparedStatus::kReady;
  } catch (const std::exception& error) {
    SetError(error.what());
  } catch (...) {
    SetError(nullptr);
  }
  pending_changes_.clear();
  transaction_failed_ = false;
  return PreparedStatus::kError;
}

int LuaDatabaseApi::Transaction(lua_State* state) {
  // LUA_LONGJMP_LEAF: automatic state below is POD only.
  LuaDatabaseApi* api = Find(state);
  if (!api) return RaiseLiteral(state, "CFB27 database API is not registered");
  if (!lua_isfunction(state, 2))
    return RaiseLiteral(state, "transaction callback must be a function");
  lua_pushcfunction(state, TransactionCallbackThunk);
  lua_pushvalue(state, 2);
  const PreparedStatus begin = api->BeginTransaction();
  if (begin == PreparedStatus::kError) return Raise(state, api);
  const int callback_status = lua_pcall(state, 1, 0, 0);
  if (callback_status != LUA_OK) {
    api->AbortTransaction();
    return lua_error(state);
  }
  const PreparedStatus finish = api->FinishTransaction();
  if (finish == PreparedStatus::kError) return Raise(state, api);
  lua_pushboolean(state, 1);
  return 1;
}

}  // namespace cfb27::frtk
