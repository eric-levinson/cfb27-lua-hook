#include <windows.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using Json = nlohmann::json;

bool WriteAll(HANDLE pipe, const std::uint8_t* data, std::size_t size) {
  while (size) {
    DWORD written = 0;
    if (!WriteFile(pipe, data, static_cast<DWORD>(size), &written, nullptr) || !written) return false;
    data += written;
    size -= written;
  }
  return true;
}

bool ReadAll(HANDLE pipe, std::uint8_t* data, std::size_t size) {
  while (size) {
    DWORD read = 0;
    if (!ReadFile(pipe, data, static_cast<DWORD>(size), &read, nullptr) || !read) return false;
    data += read;
    size -= read;
  }
  return true;
}

HANDLE OpenPipe(const std::wstring& pipe_name) {
  const ULONGLONG deadline = GetTickCount64() + 5000;
  while (GetTickCount64() < deadline) {
    HANDLE pipe = CreateFileW(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_EXISTING, 0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    if (GetLastError() == ERROR_PIPE_BUSY) WaitNamedPipeW(pipe_name.c_str(), 100);
    else Sleep(10);
  }
  return INVALID_HANDLE_VALUE;
}

bool ReadResponse(HANDLE pipe, Json& response) {
  std::uint8_t header[4]{};
  bool ok = ReadAll(pipe, header, sizeof(header));
  const std::uint32_t response_size = static_cast<std::uint32_t>(header[0]) |
      (static_cast<std::uint32_t>(header[1]) << 8) |
      (static_cast<std::uint32_t>(header[2]) << 16) |
      (static_cast<std::uint32_t>(header[3]) << 24);
  if (!ok || response_size == 0 || response_size > 1024 * 1024) return false;
  std::vector<std::uint8_t> response_body(response_size);
  if (!ReadAll(pipe, response_body.data(), response_body.size())) return false;
  response = Json::parse(response_body.begin(), response_body.end(), nullptr, false);
  return !response.is_discarded();
}

bool Request(const std::wstring& pipe_name, const Json& request, Json& response, bool fragment) {
  HANDLE pipe = OpenPipe(pipe_name);
  if (pipe == INVALID_HANDLE_VALUE) return false;

  const std::string body = request.dump();
  std::vector<std::uint8_t> frame(4 + body.size());
  const auto size = static_cast<std::uint32_t>(body.size());
  frame[0] = static_cast<std::uint8_t>(size);
  frame[1] = static_cast<std::uint8_t>(size >> 8);
  frame[2] = static_cast<std::uint8_t>(size >> 16);
  frame[3] = static_cast<std::uint8_t>(size >> 24);
  std::memcpy(frame.data() + 4, body.data(), body.size());

  bool ok = fragment
      ? WriteAll(pipe, frame.data(), 2) && WriteAll(pipe, frame.data() + 2, frame.size() - 2)
      : WriteAll(pipe, frame.data(), frame.size());
  ok = ok && ReadResponse(pipe, response);
  CloseHandle(pipe);
  return ok;
}

bool RequestOversizedFrame(const std::wstring& pipe_name, Json& response) {
  HANDLE pipe = OpenPipe(pipe_name);
  if (pipe == INVALID_HANDLE_VALUE) return false;
  constexpr std::uint32_t size = 1024 * 1024 + 1;
  const std::uint8_t header[4]{
      static_cast<std::uint8_t>(size),
      static_cast<std::uint8_t>(size >> 8),
      static_cast<std::uint8_t>(size >> 16),
      static_cast<std::uint8_t>(size >> 24),
  };
  const bool ok = WriteAll(pipe, header, sizeof(header)) && ReadResponse(pipe, response);
  CloseHandle(pipe);
  return ok;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || !LoadLibraryW(argv[1])) return 2;
  const std::wstring pipe = L"\\\\.\\pipe\\CFB27LuaHost.v1." +
      std::to_wstring(GetCurrentProcessId());
  Json response;
  if (!Request(pipe, {{"protocol", 1}, {"id", "hello-1"},
                      {"command", "hello"}, {"params", Json::object()}}, response, true)) return 3;
  if (!response.value("ok", false) || response["result"].value("protocolVersion", 0) != 1) return 4;
  const auto capabilities = response["result"]["capabilities"];
  if (std::find(capabilities.begin(), capabilities.end(), "evaluate") == capabilities.end()) return 5;

  if (!Request(pipe, {{"protocol", 1}, {"id", "status-1"},
                      {"command", "status"}, {"params", Json::object()}}, response, false)) return 14;
  if (!response.value("ok", false) || !response["result"].contains("ready")) return 15;

  const Json invalid_request = Json::parse(
      R"({"protocol":18446744073709551615,"id":"bad-1","command":"hello","params":{}})");
  if (!Request(pipe, invalid_request, response, false)) return 12;
  if (response.value("ok", true) || response["error"].value("code", "") != "INVALID_REQUEST") return 13;

  if (!RequestOversizedFrame(pipe, response)) return 10;
  if (response.value("ok", true) || response["error"].value("code", "") != "INVALID_REQUEST") return 11;

  const std::string source = "local x=40\nx=x+2\ncfb.log(\"protocol-smoke=\"..tostring(x))";
  if (!Request(pipe, {{"protocol", 1}, {"id", "eval-1"},
                      {"command", "evaluate"}, {"params", {{"source", source}}}}, response, false)) return 6;
  if (!response.value("ok", false) || response["result"].value("status", "") != "ok") return 7;
  if (!Request(pipe, {{"protocol", 1}, {"id", "run-1"}, {"command", "runScript"},
                      {"params", {{"name", "smoke.lua"}, {"source", source}}}}, response, false)) return 8;
  if (!response.value("ok", false) || response["result"].value("status", "") != "ok") return 9;
  std::cout << "protocol smoke passed\n";
  return 0;
}
