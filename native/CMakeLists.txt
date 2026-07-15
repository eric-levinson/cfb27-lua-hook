cmake_minimum_required(VERSION 3.24)
project(cfb27_lua_hook LANGUAGES C CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "CFB27 Lua Hook requires 64-bit Windows")
endif()

include(FetchContent)

FetchContent_Declare(
  lua_source
  URL https://www.lua.org/ftp/lua-5.4.8.tar.gz
  URL_HASH SHA256=4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae
)
FetchContent_GetProperties(lua_source)
if(NOT lua_source_POPULATED)
  FetchContent_Populate(lua_source)
endif()

FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
)
FetchContent_MakeAvailable(nlohmann_json)

set(LUA_DIR "${lua_source_SOURCE_DIR}/src")
set(LUA_SOURCES
  ${LUA_DIR}/lapi.c ${LUA_DIR}/lauxlib.c ${LUA_DIR}/lbaselib.c
  ${LUA_DIR}/lcode.c ${LUA_DIR}/lcorolib.c ${LUA_DIR}/lctype.c
  ${LUA_DIR}/ldblib.c ${LUA_DIR}/ldebug.c ${LUA_DIR}/ldo.c
  ${LUA_DIR}/ldump.c ${LUA_DIR}/lfunc.c ${LUA_DIR}/lgc.c
  ${LUA_DIR}/linit.c ${LUA_DIR}/liolib.c ${LUA_DIR}/llex.c
  ${LUA_DIR}/lmathlib.c ${LUA_DIR}/lmem.c ${LUA_DIR}/loadlib.c
  ${LUA_DIR}/lobject.c ${LUA_DIR}/lopcodes.c ${LUA_DIR}/loslib.c
  ${LUA_DIR}/lparser.c ${LUA_DIR}/lstate.c ${LUA_DIR}/lstring.c
  ${LUA_DIR}/lstrlib.c ${LUA_DIR}/ltable.c ${LUA_DIR}/ltablib.c
  ${LUA_DIR}/ltm.c ${LUA_DIR}/lundump.c ${LUA_DIR}/lutf8lib.c
  ${LUA_DIR}/lvm.c ${LUA_DIR}/lzio.c
)

add_library(lua54 STATIC ${LUA_SOURCES})
target_include_directories(lua54 PUBLIC ${LUA_DIR})
set_target_properties(lua54 PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(cfb27_lua_host SHARED
  host/frtk_catalog.cpp
  host/frtk_discovery.cpp
  host/frtk_field_schema.cpp
  host/frtk_lua_api.cpp
  host/frtk_profile.cpp
  host/frtk_record_access.cpp
  host/lua_host.cpp
  host/memory_reader.cpp
  host/memory_transaction.cpp
  host/native_call.cpp
  host/protocol.cpp
  host/research_watch.cpp
  host/telemetry.cpp
)
target_compile_features(cfb27_lua_host PRIVATE cxx_std_20)
target_compile_definitions(cfb27_lua_host PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_lua_host PRIVATE lua54 bcrypt nlohmann_json::nlohmann_json)

add_library(cfb27_cryptbase_proxy SHARED
  proxy/cryptbase_proxy.cpp
  proxy/cryptbase_proxy.def
)
target_compile_features(cfb27_cryptbase_proxy PRIVATE cxx_std_20)
target_compile_definitions(cfb27_cryptbase_proxy PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)

add_executable(cfb27_startup_smoke smoke/startup_host_smoke.cpp)
target_compile_features(cfb27_startup_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_startup_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_startup_smoke PRIVATE nlohmann_json::nlohmann_json)
target_link_options(cfb27_startup_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_protocol_smoke smoke/protocol_smoke.cpp)
target_compile_features(cfb27_protocol_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_protocol_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_protocol_smoke PRIVATE bcrypt nlohmann_json::nlohmann_json)
target_link_options(cfb27_protocol_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_memory_reader_smoke
  smoke/memory_reader_smoke.cpp
  host/memory_reader.cpp
)
target_compile_features(cfb27_memory_reader_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_memory_reader_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_options(cfb27_memory_reader_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_memory_transaction_smoke
  smoke/memory_transaction_smoke.cpp
  host/memory_transaction.cpp
)
target_compile_features(cfb27_memory_transaction_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_memory_transaction_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_options(cfb27_memory_transaction_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_native_call_smoke
  smoke/native_call_smoke.cpp
  host/native_call.cpp
)
target_compile_features(cfb27_native_call_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_native_call_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_options(cfb27_native_call_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_research_watch_smoke
  smoke/research_watch_smoke.cpp
  host/research_watch.cpp
)
target_compile_features(cfb27_research_watch_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_research_watch_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_options(cfb27_research_watch_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_telemetry_smoke
  smoke/telemetry_smoke.cpp
  host/telemetry.cpp
)
target_compile_features(cfb27_telemetry_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_telemetry_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_telemetry_smoke PRIVATE nlohmann_json::nlohmann_json)
target_link_options(cfb27_telemetry_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_frtk_profile_smoke
  smoke/frtk_profile_smoke.cpp
  host/frtk_profile.cpp
  host/frtk_field_schema.cpp
)
target_compile_features(cfb27_frtk_profile_smoke PRIVATE cxx_std_20)
target_link_libraries(cfb27_frtk_profile_smoke PRIVATE bcrypt nlohmann_json::nlohmann_json)
target_link_options(cfb27_frtk_profile_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_frtk_field_schema_smoke
  smoke/frtk_field_schema_smoke.cpp
  host/frtk_field_schema.cpp
)
target_compile_features(cfb27_frtk_field_schema_smoke PRIVATE cxx_std_20)
target_link_libraries(cfb27_frtk_field_schema_smoke PRIVATE nlohmann_json::nlohmann_json)
target_link_options(cfb27_frtk_field_schema_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_frtk_discovery_smoke
  smoke/frtk_discovery_smoke.cpp
  host/frtk_discovery.cpp
  host/frtk_field_schema.cpp
)
target_compile_features(cfb27_frtk_discovery_smoke PRIVATE cxx_std_20)
target_link_libraries(cfb27_frtk_discovery_smoke PRIVATE nlohmann_json::nlohmann_json)
target_link_options(cfb27_frtk_discovery_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_frtk_catalog_smoke
  smoke/frtk_catalog_smoke.cpp
  host/frtk_catalog.cpp
  host/frtk_field_schema.cpp
)
target_compile_features(cfb27_frtk_catalog_smoke PRIVATE cxx_std_20)
target_link_libraries(cfb27_frtk_catalog_smoke PRIVATE nlohmann_json::nlohmann_json)
target_link_options(cfb27_frtk_catalog_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_frtk_record_access_smoke
  smoke/frtk_record_access_smoke.cpp
  host/frtk_catalog.cpp
  host/frtk_record_access.cpp
  host/frtk_field_schema.cpp
  host/memory_transaction.cpp
)
target_compile_features(cfb27_frtk_record_access_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_frtk_record_access_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_frtk_record_access_smoke PRIVATE nlohmann_json::nlohmann_json)
target_link_options(cfb27_frtk_record_access_smoke PRIVATE /STACK:1048576)

add_executable(cfb27_frtk_lua_api_smoke
  smoke/frtk_lua_api_smoke.cpp
  host/frtk_lua_api.cpp
  host/frtk_catalog.cpp
  host/frtk_record_access.cpp
  host/frtk_field_schema.cpp
  host/memory_transaction.cpp
)
target_compile_features(cfb27_frtk_lua_api_smoke PRIVATE cxx_std_20)
target_compile_definitions(cfb27_frtk_lua_api_smoke PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_frtk_lua_api_smoke PRIVATE lua54 nlohmann_json::nlohmann_json)
target_link_options(cfb27_frtk_lua_api_smoke PRIVATE /STACK:1048576)
