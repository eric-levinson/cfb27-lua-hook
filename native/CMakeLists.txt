cmake_minimum_required(VERSION 3.24)
project(cfb27_live_hook LANGUAGES C CXX)

option(CFB27_DIRECT_ONLY "Build a direct-record test DLL without the request detour" OFF)
option(CFB27_DIRECT_FAST "Use a distinct direct-record test module/pipe" OFF)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "CFB27 Live Hook requires a 64-bit Windows toolchain")
endif()

include(FetchContent)

FetchContent_Declare(
  minhook
  GIT_REPOSITORY https://github.com/TsudaKageyu/minhook.git
  GIT_TAG v1.3.4
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(minhook)

FetchContent_Declare(
  lua_source
  URL https://www.lua.org/ftp/lua-5.4.8.tar.gz
  URL_HASH SHA256=4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae
)
FetchContent_GetProperties(lua_source)
if(NOT lua_source_POPULATED)
  FetchContent_Populate(lua_source)
endif()

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

add_library(cfb27_live_hook SHARED hook.cpp)
target_compile_features(cfb27_live_hook PRIVATE cxx_std_20)
target_compile_definitions(cfb27_live_hook PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_live_hook PRIVATE minhook lua54)
set_target_properties(cfb27_live_hook PROPERTIES OUTPUT_NAME "cfb27_live_hook")
if(CFB27_DIRECT_ONLY)
  target_compile_definitions(cfb27_live_hook PRIVATE CFB27_DIRECT_ONLY)
  set_target_properties(cfb27_live_hook PROPERTIES OUTPUT_NAME "cfb27_live_direct")
endif()
if(CFB27_DIRECT_FAST)
  target_compile_definitions(cfb27_live_hook PRIVATE CFB27_DIRECT_FAST)
  set_target_properties(cfb27_live_hook PROPERTIES OUTPUT_NAME "cfb27_live_direct_fast")
endif()

add_executable(cfb27_hook_injector injector.cpp)
target_compile_features(cfb27_hook_injector PRIVATE cxx_std_20)
target_compile_definitions(cfb27_hook_injector PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)

add_library(cfb27_submit_probe SHARED submit_probe.cpp)
target_compile_features(cfb27_submit_probe PRIVATE cxx_std_20)
target_compile_definitions(cfb27_submit_probe PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
set_target_properties(cfb27_submit_probe PROPERTIES OUTPUT_NAME "cfb27_submit_probe")

# A uniquely named copy is useful when an earlier diagnostic DLL is already
# mapped into the running game and Windows has locked its on-disk image.
add_library(cfb27_live_hook_diag SHARED hook.cpp)
target_compile_features(cfb27_live_hook_diag PRIVATE cxx_std_20)
target_compile_definitions(cfb27_live_hook_diag PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_live_hook_diag PRIVATE minhook lua54)
set_target_properties(cfb27_live_hook_diag PROPERTIES OUTPUT_NAME "cfb27_live_hook_diag")

add_library(cfb27_live_hook_fallback SHARED hook.cpp)
target_compile_features(cfb27_live_hook_fallback PRIVATE cxx_std_20)
target_compile_definitions(cfb27_live_hook_fallback PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX CFB27_FALLBACK_PIPE)
target_link_libraries(cfb27_live_hook_fallback PRIVATE minhook lua54)
set_target_properties(cfb27_live_hook_fallback PROPERTIES OUTPUT_NAME "cfb27_live_hook_fallback")

add_library(cfb27_request_trace SHARED request_trace.cpp)
target_compile_features(cfb27_request_trace PRIVATE cxx_std_20)
target_compile_definitions(cfb27_request_trace PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
set_target_properties(cfb27_request_trace PROPERTIES OUTPUT_NAME "cfb27_request_trace")

add_library(cfb27_request_trace2 SHARED request_trace.cpp)
target_compile_features(cfb27_request_trace2 PRIVATE cxx_std_20)
target_compile_definitions(cfb27_request_trace2 PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX CFB27_REQUEST_TRACE_SECONDARY)
set_target_properties(cfb27_request_trace2 PROPERTIES OUTPUT_NAME "cfb27_request_trace2")

add_library(cfb27_response_guard SHARED response_guard.cpp)
target_compile_features(cfb27_response_guard PRIVATE cxx_std_20)
target_compile_definitions(cfb27_response_guard PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(cfb27_response_guard PRIVATE lua54)
set_target_properties(cfb27_response_guard PROPERTIES OUTPUT_NAME "cfb27_response_guard")
