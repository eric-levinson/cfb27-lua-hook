#include "../host/frtk_lua_api.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <lauxlib.h>
#include <lualib.h>
#include <lobject.h>
}

namespace {
using namespace cfb27::frtk;

struct FailOnceAllocator {
  int failures_remaining{};
  size_t target_size{};
  bool failed{};
};

void* Allocate(void* user, void* pointer, size_t, size_t size) {
  auto* allocator = static_cast<FailOnceAllocator*>(user);
  if (size == 0) {
    std::free(pointer);
    return nullptr;
  }
  if (allocator->failures_remaining > 0 && size == allocator->target_size) {
    --allocator->failures_remaining;
    allocator->failed = true;
    return nullptr;
  }
  return std::realloc(pointer, size);
}

int ArmAllocationFailure(lua_State* state) {
  auto* allocator = static_cast<FailOnceAllocator*>(
      lua_touserdata(state, lua_upvalueindex(1)));
  allocator->failures_remaining = (std::numeric_limits<int>::max)();
  return 0;
}

int DisarmAllocationFailure(lua_State* state) {
  auto* allocator = static_cast<FailOnceAllocator*>(
      lua_touserdata(state, lua_upvalueindex(1)));
  allocator->failures_remaining = 0;
  return 0;
}

void Require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

nlohmann::json Field(const char* name, const char* encoding, unsigned offset,
                     unsigned bytes, unsigned bit_offset, unsigned width,
                     std::int64_t maximum,
                     std::optional<unsigned> target = std::nullopt) {
  return {{"name", name}, {"encoding", encoding}, {"byteOffset", offset},
          {"storageBytes", bytes}, {"bitOffset", bit_offset},
          {"bitWidth", width}, {"minimum", 0}, {"maximum", maximum},
          {"referenceTableId", target ? nlohmann::json(*target) : nlohmann::json(nullptr)}};
}

ProfileBundle Bundle() {
  ProfileBundle result;
  result.profile_id = "lua-api-profile";
  result.tables = {
      {.logical_name = "Direct", .table_id = 33, .unique_id = 330033,
       .capacity = 2, .record_size = 12},
      {.logical_name = "Recruit", .table_id = 44, .unique_id = 440044,
       .capacity = 1, .record_size = 8},
      {.logical_name = "Inactive", .table_id = 55, .unique_id = 550055,
       .capacity = 1, .record_size = 8}};
  std::string error;
  const auto schema = nlohmann::json{
      {"formatVersion", 1}, {"schemaIdentity", "lua-api-schema"},
      {"buildIdentity", "lua-api-build"},
      {"tables", nlohmann::json::array({
          {{"logicalName", "Direct"}, {"tableId", 33}, {"uniqueId", 330033},
           {"capacity", 2}, {"recordSize", 12}, {"authorityStatus", "direct_verified"},
           {"fields", nlohmann::json::array({
               Field("Score", "unsigned", 0, 2, 0, 16, 65535),
               Field("Flags", "bitfield", 2, 1, 1, 3, 7),
               Field("Link", "packed-reference", 4, 4, 0, 32, 0xFFFFFFFFll, 33),
               Field("InactiveLink", "packed-reference", 8, 4, 0, 32,
                     0xFFFFFFFFll, 55)})}},
          {{"logicalName", "Recruit"}, {"tableId", 44}, {"uniqueId", 440044},
           {"capacity", 1}, {"recordSize", 8}, {"authorityStatus", "discovery_only"},
           {"fields", nlohmann::json::array({Field("Rank", "unsigned", 0, 2, 0, 16, 65535)})}},
          {{"logicalName", "Inactive"}, {"tableId", 55}, {"uniqueId", 550055},
           {"capacity", 1}, {"recordSize", 8}, {"authorityStatus", "discovery_only"},
           {"fields", nlohmann::json::array({Field("Value", "unsigned", 0, 2, 0, 16, 65535)})}}
      })}};
  Require(result.schema.LoadTrustedForTesting(schema, &error), error.c_str());
  return result;
}

DiscoveryResult Discovery() {
  return {.tables = {
      {.unique_id = 330033, .state = TableState::kResolved,
       .descriptor = TableDescriptor{.unique_id = 330033, .base = 0x1000,
          .stride = 12, .capacity = 2, .allocation_base = 0x1000,
          .allocation_size = 24}},
      {.unique_id = 440044, .state = TableState::kResolved,
       .descriptor = TableDescriptor{.unique_id = 440044, .base = 0x2000,
          .stride = 8, .capacity = 1, .allocation_base = 0x2000,
          .allocation_size = 8}}
  }};
}

class Backend final : public DiscoveryBackend, public cfb27::memory::MemoryBackend {
 public:
  std::map<std::uintptr_t, std::vector<std::uint8_t>> records;
  std::size_t reads{};
  ScanObservationResult Scan(const RowFingerprint&, std::size_t) override { return {}; }
  bool ReadBatch(std::span<const ReadRequest>,
                 std::vector<std::vector<std::uint8_t>>&) override { return true; }
  bool AllocationExists(std::uintptr_t, std::size_t) override { return true; }
  bool Validate(std::uintptr_t address, std::size_t size, bool) override {
    return std::any_of(records.begin(), records.end(), [&](const auto& item) {
      return address >= item.first && address + size >= address &&
             address + size <= item.first + item.second.size();
    });
  }
  bool Read(std::uintptr_t address, std::span<std::uint8_t> output) override {
    for (const auto& [base, bytes] : records) {
      if (address >= base && address + output.size() <= base + bytes.size()) {
        ++reads;
        std::copy_n(bytes.begin() + (address - base), output.size(), output.begin());
        return true;
      }
    }
    return false;
  }
  bool Write(std::uintptr_t address, std::span<const std::uint8_t> input) override {
    for (auto& [base, bytes] : records) {
      if (address >= base && address + input.size() <= base + bytes.size()) {
        std::copy(input.begin(), input.end(), bytes.begin() + (address - base));
        return true;
      }
    }
    return false;
  }
};

void Run(lua_State* state, const char* source) {
  if (luaL_dostring(state, source) != LUA_OK) {
    const std::string error = lua_tostring(state, -1);
    lua_pop(state, 1);
    throw std::runtime_error(error);
  }
}

void TestReadsErrorsAndInvalidation() {
  auto profile = Bundle();
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  Backend backend;
  backend.records[0x1000] = {0x34, 0x12, 0x0A, 0, 1, 0, 66, 0,
                             0, 0, 110, 0};
  backend.records[0x100C] = {7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  backend.records[0x2000] = {9, 0, 0, 0, 0, 0, 0, 0};
  lua_State* state = luaL_newstate();
  luaL_openlibs(state);
  std::mutex catalog_mutex;
  LuaDatabaseApi api(catalog, profile.schema, backend, backend,
      [&](const cfb27::memory::TransactionRequest& request) {
        return cfb27::memory::RunTransaction(request, backend);
      }, &catalog_mutex);
  api.Register(state);

  Run(state, R"lua(
    assert(type(CFB27) == "table" and type(CFB27.db) == "table")
    assert(CFB27.read_u8 == nil and CFB27.write_u8 == nil and CFB27.aob_scan == nil)
    assert(debug.getupvalue(CFB27.db.GetTableByUniqueId, 1) == nil)
    assert(debug.getupvalue(CFB27.db.Transaction, 1) == nil)
    assert(CFB27.db.GetTable == nil and CFB27.db.GetTableById == nil)
    local ok = pcall(function() CFB27.db:GetTableByUniqueId("Direct") end)
    assert(not ok)
    ok = pcall(function() CFB27.db:GetTableByUniqueId("330033") end)
    assert(not ok)
    ok = pcall(function() CFB27.db:GetTableByUniqueId(33) end)
    assert(not ok)
    direct = CFB27.db:GetTableByUniqueId(330033)
    local methods = debug.getmetatable(direct).__index
    assert(debug.getupvalue(methods.GetRecord, 1) == nil)
    for _, value in ipairs({tostring(direct), tostring(direct:GetRecord(0))}) do
      assert(not value:find("0x") and not value:find("userdata:") and
             not value:match("%x%x%x%x%x%x%x%x"))
    end
    assert(direct:GetRecord(0):GetField("Score") == 0x1234)
    assert(direct:GetRecord(0):GetField("Flags") == 5)
    local link = direct:GetRecord(0):GetField("Link")
    assert(link.uniqueId == 330033 and link.row == 1 and link.tableId == nil)
    assert(not pcall(function() direct:GetRecord(0):GetField("InactiveLink") end))
    assert(direct:GetRecord(1):GetField("Score") == 7)
    assert(direct.address == nil and direct.baseAddress == nil)
    stale_record = direct:GetRecord(0)
    local record = stale_record
    assert(record.address == nil and record.bytes == nil)
    assert(not pcall(function() direct:GetRecord(-1) end))
    assert(not pcall(function() direct:GetRecord("0") end))
    assert(not pcall(function() direct:GetRecord(2) end))
    assert(not pcall(function() record:GetField("Missing") end))
    assert(not pcall(function() record:GetField(7) end))
  )lua");
  Require(backend.reads == 5, "field reads did not use one complete record snapshot each");
  catalog.Invalidate();
  Run(state, R"lua(
    assert(not pcall(function() direct:GetRecord(0) end))
    assert(not pcall(function() stale_record:GetField("Score") end))
  )lua");
  lua_close(state);
}

void TestTransactions() {
  auto profile = Bundle();
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  Backend backend;
  backend.records[0x1000] = {1, 0, 0, 0, 1, 0, 66, 0, 0, 0, 110, 0};
  backend.records[0x100C] = std::vector<std::uint8_t>(12);
  backend.records[0x2000] = {9, 0, 0, 0, 0, 0, 0, 0};
  lua_State* state = luaL_newstate();
  luaL_openlibs(state);
  std::mutex catalog_mutex;
  LuaDatabaseApi api(catalog, profile.schema, backend, backend,
      [&](const cfb27::memory::TransactionRequest& request) {
        return cfb27::memory::RunTransaction(request, backend);
      }, &catalog_mutex);
  api.Register(state);

  Run(state, R"lua(
    local direct = CFB27.db:GetTableByUniqueId(330033)
    local record = direct:GetRecord(0)
    assert(CFB27.db:Transaction(function(tx)
      local text = tostring(tx)
      assert(not text:find("0x") and not text:find("userdata:") and
             not text:match("%x%x%x%x%x%x%x%x"))
      tx:SetField(record, "Score", 42)
      tx:SetField(record, "Flags", 3)
    end) == true)
    assert(record:GetField("Score") == 42 and record:GetField("Flags") == 3)
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx)
        tx:SetField(record, "Score", 5)
        tx:SetField(record, "Score", 6)
      end)
    end))
    assert(not pcall(function()
      CFB27.db:Transaction(function()
        CFB27.db:Transaction(function() end)
      end)
    end))
    local recruit = CFB27.db:GetTableByUniqueId(440044):GetRecord(0)
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx) tx:SetField(recruit, "Rank", 1) end)
    end))
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx) tx:SetField(record, "Score", "bad") end)
    end))
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx) tx:SetField(record, "Score", "42") end)
    end))
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx)
        tx:SetField(record, "Score", 6)
        assert(not pcall(function() tx:SetField(record, "Score", 7) end))
      end)
    end))
    assert(record:GetField("Score") == 42)
    assert(CFB27.db:Transaction(function(tx)
      tx:SetField(record, "Link", {uniqueId=330033, row=0})
    end))
    local link = record:GetField("Link")
    assert(link.uniqueId == 330033 and link.row == 0 and link.tableId == nil)
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx)
        assert(not pcall(function()
          tx:SetField(record, "Link", {tableId=33, row=0})
        end))
      end)
    end))
    assert(record:GetField("Link").row == 0)
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx)
        assert(not pcall(function()
          tx:SetField(record, "InactiveLink", {uniqueId=550055, row=0})
        end))
      end)
    end))
    local hostile_hits = 0
    local hostile = setmetatable({}, {__index=function()
      hostile_hits = hostile_hits + 1
      error("hostile __index")
    end})
    assert(not pcall(function()
      CFB27.db:Transaction(function(tx)
        assert(not pcall(function() tx:SetField(record, "Link", hostile) end))
      end)
    end))
    assert(hostile_hits == 0)
    assert(record:GetField("Score") == 42)
    local hostile_ref = setmetatable({uniqueId=330033, row=1}, {
      __index=function() hostile_hits = hostile_hits + 1; error("hostile __index") end,
      __pairs=function() hostile_hits = hostile_hits + 1; error("hostile __pairs") end,
      __len=function() hostile_hits = hostile_hits + 1; error("hostile __len") end
    })
    assert(CFB27.db:Transaction(function(tx)
      tx:SetField(record, "Link", hostile_ref)
    end))
    assert(hostile_hits == 0 and record:GetField("Link").row == 1)
    assert(CFB27.db:Transaction(function(tx) tx:SetField(record, "Score", 8) end))
    assert(record:GetField("Score") == 8)
  )lua");
  lua_close(state);
}

void TestTransactionAllocationFailureRecovery() {
  auto profile = Bundle();
  SessionCatalog catalog;
  catalog.Install(profile, Discovery());
  Backend backend;
  backend.records[0x1000] = {1, 0, 0, 0, 1, 0, 66, 0, 0, 0, 110, 0};
  backend.records[0x100C] = std::vector<std::uint8_t>(12);
  backend.records[0x2000] = {9, 0, 0, 0, 0, 0, 0, 0};
  FailOnceAllocator allocator;
  allocator.target_size = sizeudata(0, sizeof(std::uint32_t));
  lua_State* state = lua_newstate(Allocate, &allocator);
  Require(state != nullptr, "failed to create allocator-test Lua state");
  luaL_openlibs(state);
  std::mutex catalog_mutex;
  LuaDatabaseApi api(catalog, profile.schema, backend, backend,
      [&](const cfb27::memory::TransactionRequest& request) {
        return cfb27::memory::RunTransaction(request, backend);
      }, &catalog_mutex);
  api.Register(state);
  lua_pushlightuserdata(state, &allocator);
  lua_pushcclosure(state, ArmAllocationFailure, 1);
  lua_setglobal(state, "arm_transaction_allocation_failure");
  lua_pushlightuserdata(state, &allocator);
  lua_pushcclosure(state, DisarmAllocationFailure, 1);
  lua_setglobal(state, "disarm_transaction_allocation_failure");

  Run(state, R"lua(
    local record = CFB27.db:GetTableByUniqueId(330033):GetRecord(0)
    local before = record:GetField("Score")
    local ok = pcall(function()
      arm_transaction_allocation_failure()
      CFB27.db:Transaction(function(tx)
        tx:SetField(record, "Score", 9)
      end)
    end)
    disarm_transaction_allocation_failure()
    assert(not ok)
    assert(record:GetField("Score") == before)
    assert(CFB27.db:Transaction(function(tx)
      tx:SetField(record, "Score", 10)
    end))
    assert(record:GetField("Score") == 10)
  )lua");
  Require(allocator.failed,
          "transaction userdata allocation failure was not exercised");
  lua_close(state);
}
}  // namespace

int main() {
  try {
    TestReadsErrorsAndInvalidation();
    TestTransactions();
    TestTransactionAllocationFailureRecovery();
    std::cout << "frtk Lua API smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "frtk Lua API smoke failed: " << error.what() << '\n';
    return 1;
  }
}
