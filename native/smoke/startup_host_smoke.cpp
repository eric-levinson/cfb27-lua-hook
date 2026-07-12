#include <windows.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

using Json = nlohmann::json;

namespace {

bool WriteAll(HANDLE pipe, const std::uint8_t* data, std::size_t size) {
  while (size) {
    DWORD written = 0;
    if (!WriteFile(pipe, data, static_cast<DWORD>(size), &written, nullptr) ||
        written == 0) return false;
    data += written;
    size -= written;
  }
  return true;
}

bool ReadAll(HANDLE pipe, std::uint8_t* data, std::size_t size) {
  while (size) {
    DWORD read = 0;
    if (!ReadFile(pipe, data, static_cast<DWORD>(size), &read, nullptr) ||
        read == 0) return false;
    data += read;
    size -= read;
  }
  return true;
}

bool Request(const std::wstring& pipe_name, const Json& request, Json& response) {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  const ULONGLONG deadline = GetTickCount64() + 5000;
  while (GetTickCount64() < deadline) {
    pipe = CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                       nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) break;
    Sleep(10);
  }
  if (pipe == INVALID_HANDLE_VALUE) return false;

  const std::string body = request.dump();
  const auto size = static_cast<std::uint32_t>(body.size());
  std::vector<std::uint8_t> frame(4 + body.size());
  frame[0] = static_cast<std::uint8_t>(size);
  frame[1] = static_cast<std::uint8_t>(size >> 8);
  frame[2] = static_cast<std::uint8_t>(size >> 16);
  frame[3] = static_cast<std::uint8_t>(size >> 24);
  std::memcpy(frame.data() + 4, body.data(), body.size());

  std::uint8_t header[4]{};
  bool ok = WriteAll(pipe, frame.data(), frame.size()) &&
            ReadAll(pipe, header, sizeof(header));
  const std::uint32_t response_size = static_cast<std::uint32_t>(header[0]) |
      (static_cast<std::uint32_t>(header[1]) << 8) |
      (static_cast<std::uint32_t>(header[2]) << 16) |
      (static_cast<std::uint32_t>(header[3]) << 24);
  std::vector<std::uint8_t> response_body(response_size);
  ok = ok && response_size > 0 && response_size <= 1024 * 1024 &&
       ReadAll(pipe, response_body.data(), response_body.size());
  CloseHandle(pipe);
  if (!ok) return false;
  response = Json::parse(response_body.begin(), response_body.end(), nullptr, false);
  return !response.is_discarded();
}

struct LexicalBrace {
  char token{};
  std::size_t position{};
};

std::vector<LexicalBrace> LexicalBraces(const std::string& source,
                                        std::size_t begin, std::size_t end) {
  enum class LexicalState {
    kCode,
    kLineComment,
    kBlockComment,
    kString,
    kChar,
    kRawString,
  };
  LexicalState state = LexicalState::kCode;
  bool escaped = false;
  std::string raw_terminator;
  std::vector<LexicalBrace> braces;
  for (std::size_t index = begin;
       index < end && index < source.size(); ++index) {
    const char current = source[index];
    const char next = index + 1 < source.size() ? source[index + 1] : '\0';
    switch (state) {
      case LexicalState::kCode:
        if (current == '/' && next == '/') {
          state = LexicalState::kLineComment;
          ++index;
        } else if (current == '/' && next == '*') {
          state = LexicalState::kBlockComment;
          ++index;
        } else if (current == 'R' && next == '"') {
          const auto delimiter_begin = index + 2;
          const auto parenthesis = source.find('(', delimiter_begin);
          if (parenthesis != std::string::npos &&
              parenthesis - delimiter_begin <= 16 &&
              source.substr(delimiter_begin, parenthesis - delimiter_begin)
                      .find_first_of(" \\\t\v\f\r\n()") == std::string::npos) {
            raw_terminator = ")" +
                source.substr(delimiter_begin, parenthesis - delimiter_begin) +
                "\"";
            state = LexicalState::kRawString;
            index = parenthesis;
          }
        } else if (current == '"') {
          state = LexicalState::kString;
          escaped = false;
        } else if (current == '\'') {
          state = LexicalState::kChar;
          escaped = false;
        } else if (current == '{' || current == '}') {
          braces.push_back({current, index});
        }
        break;
      case LexicalState::kLineComment:
        if (current == '\n') state = LexicalState::kCode;
        break;
      case LexicalState::kBlockComment:
        if (current == '*' && next == '/') {
          state = LexicalState::kCode;
          ++index;
        }
        break;
      case LexicalState::kString:
      case LexicalState::kChar:
        if (escaped) {
          escaped = false;
        } else if (current == '\\') {
          escaped = true;
        } else if ((state == LexicalState::kString && current == '"') ||
                   (state == LexicalState::kChar && current == '\'')) {
          state = LexicalState::kCode;
        }
        break;
      case LexicalState::kRawString:
        if (source.compare(index, raw_terminator.size(), raw_terminator) == 0) {
          index += raw_terminator.size() - 1;
          state = LexicalState::kCode;
        }
        break;
    }
  }
  return braces;
}

std::optional<std::size_t> MatchingBrace(const std::string& source,
                                         std::size_t opening) {
  std::size_t depth = 0;
  for (const auto& brace : LexicalBraces(source, opening, source.size())) {
    if (brace.token == '{') {
      ++depth;
    } else if (depth > 0 && --depth == 0) {
      return brace.position;
    }
  }
  return std::nullopt;
}

std::optional<std::size_t> ContainingScopeOpen(const std::string& source,
                                               std::size_t function_open,
                                               std::size_t position) {
  std::vector<std::size_t> scopes;
  for (const auto& brace : LexicalBraces(source, function_open, position)) {
    if (brace.token == '{') {
      scopes.push_back(brace.position);
    } else if (!scopes.empty()) {
      scopes.pop_back();
    }
  }
  if (scopes.empty()) return std::nullopt;
  return scopes.back();
}

bool VerifyMatchingBraceFixtures(std::string& error) {
  const std::vector<std::string> fixtures = {
      R"({ // } closes only a comment
          int value = 1;
        })",
      R"({ /* } closes only a block comment */ int value = 1; })",
      R"({ const char brace = '}'; int value = 1; })",
      R"fixture({ const char* braces = "escaped quote: \" }"; int value = 1; })fixture",
      R"fixture({ const char* braces = R"tag("})tag"; int value = 1; })fixture",
  };
  for (const auto& fixture : fixtures) {
    const auto closing = MatchingBrace(fixture, 0);
    if (!closing || *closing != fixture.size() - 1) {
      error = "brace matcher treated a comment or literal brace as syntax";
      return false;
    }
  }
  return true;
}

bool VerifyContainingScopeFixtures(std::string& error) {
  const std::string fixture =
      R"fixture({ { const char* decoy = R"tag({)tag"; LOCK; } })fixture";
  const auto lock_at = fixture.find("LOCK");
  const auto scope_open = ContainingScopeOpen(fixture, 0, lock_at);
  if (!scope_open || *scope_open != 2) {
    error = "containing scope selected a brace from a non-code token";
    return false;
  }
  return true;
}

bool CallsOccurAfter(const std::string& source, std::string_view call,
                     std::size_t function_begin, std::size_t scope_end,
                     std::size_t function_end) {
  auto found = source.find(call, scope_end);
  if (found == std::string::npos || found >= function_end) return false;
  for (found = source.find(call, function_begin);
       found != std::string::npos && found < function_end;
       found = source.find(call, found + call.size())) {
    if (found < scope_end) return false;
  }
  return true;
}

bool VerifyLuaWriteU8Source(const std::filesystem::path& path,
                            std::string& error) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    error = "could not open Lua host source";
    return false;
  }
  const std::string source((std::istreambuf_iterator<char>(input)),
                           std::istreambuf_iterator<char>());
  constexpr std::string_view signature = "int LuaWriteU8(lua_State* state)";
  const auto signature_at = source.find(signature);
  const auto function_open = source.find('{', signature_at);
  if (signature_at == std::string::npos || function_open == std::string::npos) {
    error = "LuaWriteU8 definition was not found";
    return false;
  }
  const auto function_close = MatchingBrace(source, function_open);
  constexpr std::string_view lock =
      "std::lock_guard write_lock(g_host_write_mutex);";
  const auto lock_at = source.find(lock, function_open);
  if (!function_close || lock_at == std::string::npos || lock_at >= *function_close) {
    error = "LuaWriteU8 write lock was not found";
    return false;
  }
  const auto lock_scope_open =
      ContainingScopeOpen(source, function_open, lock_at);
  const auto lock_scope_close = lock_scope_open
      ? MatchingBrace(source, *lock_scope_open)
      : std::nullopt;
  if (!lock_scope_open || *lock_scope_open == function_open || !lock_scope_close ||
      *lock_scope_close >= *function_close) {
    error = "LuaWriteU8 write lock must have a normally exited nested scope";
    return false;
  }

  const auto critical = source.substr(lock_at, *lock_scope_close - lock_at);
  if (critical.find("lua_") != std::string::npos ||
      critical.find("luaL_") != std::string::npos) {
    error = "LuaWriteU8 write-lock scope contains a Lua API call";
    return false;
  }

  std::size_t argument_checks = 0;
  for (auto found = source.find("luaL_checkinteger", function_open);
       found != std::string::npos && found < *function_close;
       found = source.find("luaL_checkinteger", found + 1)) {
    ++argument_checks;
    if (found > lock_at) {
      error = "LuaWriteU8 parses arguments after acquiring the write lock";
      return false;
    }
  }
  if (argument_checks != 3 ||
      !CallsOccurAfter(source, "luaL_error", function_open, *lock_scope_close,
                       *function_close) ||
      !CallsOccurAfter(source, "lua_pushboolean", function_open, *lock_scope_close,
                       *function_close)) {
    error = "LuaWriteU8 Lua error/result calls must follow normal lock-scope exit";
    return false;
  }
  return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::string matcher_error;
  if (!VerifyMatchingBraceFixtures(matcher_error)) {
    std::cerr << "startup source matcher RED: " << matcher_error << '\n';
    return 8;
  }
  if (!VerifyContainingScopeFixtures(matcher_error)) {
    std::cerr << "startup scope matcher RED: " << matcher_error << '\n';
    return 9;
  }
  if (argc < 2 || argc > 3) {
    std::wcerr << L"usage: startup_host_smoke <cfb27_lua_host.dll> [lua_host.cpp]\n";
    return 2;
  }
  const std::filesystem::path source_path =
      argc == 3 ? std::filesystem::path(argv[2])
                : std::filesystem::path(L"native/host/lua_host.cpp");
  std::string source_error;
  if (!VerifyLuaWriteU8Source(source_path, source_error)) {
    std::cerr << "LuaWriteU8 source policy RED: " << source_error << '\n';
    return 7;
  }
  if (!SetEnvironmentVariableW(L"CFB27_SMOKE_ALLOW_WRITES", L"1")) return 3;
  if (!SetEnvironmentVariableW(L"CFB27_SMOKE_FORCE_ROLLBACK_UNVERIFIED", L"1") ||
      !SetEnvironmentVariableW(L"CFB27_SMOKE_HOLD_ROLLBACK", L"1") ||
      !SetEnvironmentVariableW(L"CFB27_SMOKE_FORCE_APPLY_FAILURE", L"1")) return 6;
  HMODULE host = LoadLibraryW(argv[1]);
  if (!host) {
    std::wcerr << L"LoadLibrary failed: " << GetLastError() << L'\n';
    return 1;
  }
  std::uint8_t bytes[]{0x10, 0x20};
  char address[32]{};
  sprintf_s(address, "0x%llX",
            static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(bytes)));
  const std::wstring pipe = L"\\\\.\\pipe\\CFB27LuaHost.v1." +
      std::to_wstring(GetCurrentProcessId());
  Json response;
  if (!Request(pipe, {{"protocol", 1}, {"id", "startup-write-gate"},
                      {"command", "writeTransaction"},
                      {"params", {{"transactionId", "startup.gate-1"},
                                  {"operations", Json::array({
                                      {{"address", std::string(address)},
                                       {"expectedHex", "1020"},
                                       {"replacementHex", "1121"}}})}}}},
               response)) return 4;
  if (response.value("ok", true) ||
      response["error"].value("code", "") != "UNSUPPORTED_BUILD" ||
      bytes[0] != 0x10 || bytes[1] != 0x20) return 5;
  std::cout << "startup smoke passed; smoke write gate rejected for non-protocol executable\n";
  return 0;
}
