#include <windows.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using Json = nlohmann::json;

namespace {

constexpr char kSentinelHex[] = "CFB27A1100A1B2C3D4E5F60718293A4B";
constexpr std::array<std::uint8_t, 16> kSentinel{
    0xCF, 0xB2, 0x7A, 0x11, 0x00, 0xA1, 0xB2, 0xC3,
    0xD4, 0xE5, 0xF6, 0x07, 0x18, 0x29, 0x3A, 0x4B,
};

class Allocation {
 public:
  explicit Allocation(std::size_t size)
      : address_(VirtualAlloc(nullptr, size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE)) {}
  ~Allocation() {
    if (address_) VirtualFree(address_, 0, MEM_RELEASE);
  }
  Allocation(const Allocation&) = delete;
  Allocation& operator=(const Allocation&) = delete;
  void* get() const { return address_; }

 private:
  void* address_{};
};

class TopologyAllocation {
 public:
  TopologyAllocation() {
    SYSTEM_INFO system_info{};
    GetSystemInfo(&system_info);
    page_size_ = static_cast<std::size_t>(system_info.dwPageSize);
    address_ = static_cast<std::uint8_t*>(
        VirtualAlloc(nullptr, page_size_ * 3, MEM_RESERVE, PAGE_READWRITE));
    if (!address_) return;
    for (std::size_t page = 0; page < 3; ++page) {
      if (VirtualAlloc(address_ + page * page_size_, page_size_, MEM_COMMIT,
                       PAGE_READWRITE) != address_ + page * page_size_) return;
    }
    DWORD prior{};
    if (!VirtualProtect(address_, page_size_, PAGE_READONLY, &prior) ||
        !VirtualProtect(address_ + page_size_ * 2, page_size_, PAGE_EXECUTE_READ,
                        &prior)) return;
    valid_ = true;
  }
  ~TopologyAllocation() {
    if (address_) VirtualFree(address_, 0, MEM_RELEASE);
  }
  TopologyAllocation(const TopologyAllocation&) = delete;
  TopologyAllocation& operator=(const TopologyAllocation&) = delete;
  bool valid() const { return valid_; }
  std::uint8_t* get() const { return address_; }
  std::size_t page_size() const { return page_size_; }

 private:
  std::uint8_t* address_{};
  std::size_t page_size_{};
  bool valid_{};
};

std::string FormatAddress(std::uintptr_t address) {
  std::ostringstream out;
  out << "0x" << std::uppercase << std::hex << address;
  return out.str();
}

bool IsCanonicalAddress(const Json& value) {
  if (!value.is_string()) return false;
  const auto text = value.get<std::string>();
  if (text.size() < 3 || text[0] != '0' || text[1] != 'x' || text[2] == '0') return false;
  return std::all_of(text.begin() + 2, text.end(), [](unsigned char character) {
    return (character >= '0' && character <= '9') ||
           (character >= 'A' && character <= 'F');
  });
}

bool IsUpperHex(const Json& value) {
  if (!value.is_string()) return false;
  const auto text = value.get<std::string>();
  return text.size() % 2 == 0 &&
         std::all_of(text.begin(), text.end(), [](unsigned char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'A' && character <= 'F');
         });
}

bool IsError(const Json& response, const char* code) {
  return !response.value("ok", true) && response.contains("error") &&
         response["error"].value("code", "") == code;
}

}  // namespace

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

bool LegacyEvaluate(const std::wstring& pipe_name, std::string_view source,
                    Json& response) {
  HANDLE pipe = OpenPipe(pipe_name);
  if (pipe == INVALID_HANDLE_VALUE) return false;
  const std::string request = "EVAL " + std::string(source);
  DWORD written = 0;
  std::array<char, 4096> buffer{};
  DWORD read = 0;
  const bool ok = WriteFile(pipe, request.data(), static_cast<DWORD>(request.size()),
                            &written, nullptr) &&
      written == request.size() &&
      ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size() - 1),
               &read, nullptr);
  CloseHandle(pipe);
  if (!ok) return false;
  response = Json::parse(buffer.data(), buffer.data() + read, nullptr, false);
  return !response.is_discarded();
}

bool BoundedRequest(const std::wstring& pipe_name, Json request, Json& response,
                    DWORD timeout_ms = 5000) {
  struct State {
    Json response;
    bool ok{};
  };
  auto state = std::make_shared<State>();
  HANDLE completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!completed) return false;
  std::thread worker([pipe_name, request = std::move(request), state, completed] {
    state->ok = Request(pipe_name, request, state->response, false);
    SetEvent(completed);
  });
  if (WaitForSingleObject(completed, timeout_ms) != WAIT_OBJECT_0) {
    worker.detach();
    return false;
  }
  worker.join();
  CloseHandle(completed);
  response = std::move(state->response);
  return state->ok;
}

int wmain(int argc, wchar_t** argv) {
  wchar_t smoke_gate[8]{};
  if (GetEnvironmentVariableW(L"CFB27_SMOKE_ALLOW_WRITES", smoke_gate,
                              static_cast<DWORD>(std::size(smoke_gate))) != 1 ||
      smoke_gate[0] != L'1') return 72;
  Allocation transaction_one(4096);
  Allocation transaction_two(4096);
  if (!transaction_one.get() || !transaction_two.get()) return 73;
  auto* transaction_one_bytes = static_cast<std::uint8_t*>(transaction_one.get());
  auto* transaction_two_bytes = static_cast<std::uint8_t*>(transaction_two.get());
  transaction_one_bytes[0] = 0x10;
  transaction_one_bytes[1] = 0x20;
  transaction_two_bytes[0] = 0x30;
  transaction_two_bytes[1] = 0x40;

  if (argc != 2 || !LoadLibraryW(argv[1])) return 2;
  TopologyAllocation allocation;
  if (!allocation.valid()) return 23;
  auto* sentinel_address = allocation.get() + allocation.page_size() + 128;
  std::memcpy(sentinel_address, kSentinel.data(), kSentinel.size());
  MEMORY_BASIC_INFORMATION first_info{};
  MEMORY_BASIC_INFORMATION middle_info{};
  MEMORY_BASIC_INFORMATION final_info{};
  if (VirtualQuery(allocation.get(), &first_info, sizeof(first_info)) != sizeof(first_info) ||
      VirtualQuery(allocation.get() + allocation.page_size(), &middle_info,
                   sizeof(middle_info)) != sizeof(middle_info) ||
      VirtualQuery(allocation.get() + allocation.page_size() * 2, &final_info,
                   sizeof(final_info)) != sizeof(final_info) ||
      first_info.AllocationBase != allocation.get() ||
      middle_info.AllocationBase != allocation.get() ||
      final_info.AllocationBase != allocation.get() ||
      first_info.BaseAddress == middle_info.BaseAddress ||
      middle_info.BaseAddress == final_info.BaseAddress) return 105;
  const std::wstring pipe = L"\\\\.\\pipe\\CFB27LuaHost.v1." +
      std::to_wstring(GetCurrentProcessId());
  const std::wstring legacy_pipe = L"\\\\.\\pipe\\CFB27LuaHost." +
      std::to_wstring(GetCurrentProcessId());
  Json response;
  if (!Request(pipe, {{"protocol", 1}, {"id", "hello-1"},
                      {"command", "hello"}, {"params", Json::object()}}, response, true)) return 3;
  if (!response.value("ok", false) || response["result"].value("protocolVersion", 0) != 1) return 4;
  const auto capabilities = response["result"]["capabilities"];
  if (std::find(capabilities.begin(), capabilities.end(), "evaluate") == capabilities.end()) return 5;
  if (std::find(capabilities.begin(), capabilities.end(), "telemetry") == capabilities.end()) return 51;
  if (std::find(capabilities.begin(), capabilities.end(),
                "memoryScanAllocationMetadata") == capabilities.end()) return 106;

  if (!Request(pipe, {{"protocol", 1}, {"id", "status-1"},
                      {"command", "status"}, {"params", Json::object()}}, response, false)) return 14;
  if (!response.value("ok", false) || !response["result"].contains("ready")) return 15;

  const Json write_params{
      {"transactionId", "smoke.apply-1"},
      {"operations", Json::array({
          {{"address", FormatAddress(reinterpret_cast<std::uintptr_t>(transaction_one_bytes))},
           {"expectedHex", "1020"}, {"replacementHex", "1121"}},
          {{"address", FormatAddress(reinterpret_cast<std::uintptr_t>(transaction_two_bytes))},
           {"expectedHex", "3040"}, {"replacementHex", "3141"}},
      })},
  };

  SetEnvironmentVariableW(L"CFB27_SMOKE_ALLOW_WRITES", nullptr);
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-unsupported"},
                      {"command", "writeTransaction"}, {"params", write_params}},
               response, false) || !IsError(response, "UNSUPPORTED_BUILD")) {
    std::cerr << "writeTransaction RED response: " << response.dump() << '\n';
    return 75;
  }
  if (!SetEnvironmentVariableW(L"CFB27_SMOKE_ALLOW_WRITES", L"1")) return 76;

  if (!Request(pipe, {{"protocol", 1}, {"id", "write-apply"},
                      {"command", "writeTransaction"}, {"params", write_params}},
               response, false)) return 77;
  if (!response.value("ok", false) || response["result"].size() != 3 ||
      response["result"].value("transactionId", "") != "smoke.apply-1" ||
      response["result"].value("status", "") != "applied_verified" ||
      response["result"]["operations"].size() != 2 ||
      response["result"]["operations"][0] !=
          Json({{"index", 0}, {"applied", true}, {"verified", true}}) ||
      response["result"]["operations"][1] !=
          Json({{"index", 1}, {"applied", true}, {"verified", true}}) ||
      transaction_one_bytes[0] != 0x11 || transaction_one_bytes[1] != 0x21 ||
      transaction_two_bytes[0] != 0x31 || transaction_two_bytes[1] != 0x41) return 78;

  transaction_one_bytes[0] = 0x10;
  transaction_one_bytes[1] = 0x20;
  transaction_two_bytes[0] = 0x30;
  transaction_two_bytes[1] = 0x40;
  Json mismatch_params = write_params;
  mismatch_params["transactionId"] = "smoke.mismatch-1";
  mismatch_params["operations"][1]["expectedHex"] = "FFFF";
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-mismatch"},
                      {"command", "writeTransaction"}, {"params", mismatch_params}},
               response, false) || !IsError(response, "MEMORY_MISMATCH") ||
      transaction_one_bytes[0] != 0x10 || transaction_one_bytes[1] != 0x20 ||
      transaction_two_bytes[0] != 0x30 || transaction_two_bytes[1] != 0x40) return 79;

  Json overlap_params = write_params;
  overlap_params["transactionId"] = "smoke.overlap-1";
  overlap_params["operations"][0]["address"] =
      FormatAddress(reinterpret_cast<std::uintptr_t>(transaction_one_bytes));
  overlap_params["operations"][1]["address"] =
      FormatAddress(reinterpret_cast<std::uintptr_t>(transaction_one_bytes + 1));
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-overlap"},
                      {"command", "writeTransaction"}, {"params", overlap_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 80;

  Json malformed_hex_params = write_params;
  malformed_hex_params["transactionId"] = "smoke.malformed-1";
  malformed_hex_params["operations"][0]["replacementHex"] = "1Z";
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-malformed"},
                      {"command", "writeTransaction"}, {"params", malformed_hex_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 81;

  Json invalid_address_params = write_params;
  invalid_address_params["transactionId"] = "smoke.address-1";
  invalid_address_params["operations"][0]["address"] = "0x01";
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-address"},
                      {"command", "writeTransaction"}, {"params", invalid_address_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 82;

  Json extra_params = write_params;
  extra_params["unexpected"] = true;
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-extra"},
                      {"command", "writeTransaction"}, {"params", extra_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 83;

  Json extra_request{
      {"protocol", 1}, {"id", "write-envelope-extra"},
      {"command", "writeTransaction"}, {"params", write_params},
      {"unexpected", true},
  };
  if (!Request(pipe, extra_request, response, false) ||
      !IsError(response, "INVALID_REQUEST")) {
    std::cerr << "extra request key RED response: " << response.dump() << '\n';
    return 85;
  }

  Json extra_operation_params = write_params;
  extra_operation_params["transactionId"] = "smoke.operation-extra-1";
  extra_operation_params["operations"][0]["unexpected"] = true;
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-operation-extra"},
                      {"command", "writeTransaction"},
                      {"params", extra_operation_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 86;

  Json lowercase_hex_params = write_params;
  lowercase_hex_params["transactionId"] = "smoke.lowercase-1";
  lowercase_hex_params["operations"][0]["replacementHex"] = "aa21";
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-lowercase"},
                      {"command", "writeTransaction"},
                      {"params", lowercase_hex_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 87;

  for (const auto& invalid_transaction_id :
       std::vector<std::string>{"", std::string(65, 'A')}) {
    Json invalid_id_params = write_params;
    invalid_id_params["transactionId"] = invalid_transaction_id;
    if (!Request(pipe, {{"protocol", 1}, {"id", "write-transaction-id"},
                        {"command", "writeTransaction"},
                        {"params", invalid_id_params}},
                 response, false) || !IsError(response, "INVALID_REQUEST")) return 88;
  }

  if (std::find(capabilities.begin(), capabilities.end(), "memoryWriteTransaction") ==
      capabilities.end()) return 74;
  if (!Request(pipe, {{"protocol", 1}, {"id", "status-writes"},
                      {"command", "status"}, {"params", Json::object()}},
               response, false) || !response.value("ok", false) ||
      response["result"].value("sessionWritesDisabled", true)) return 84;

  const std::string smoke_lua_write =
      "assert(cfb.write_u8(" +
      std::to_string(reinterpret_cast<std::uintptr_t>(transaction_one_bytes)) +
      ", 16, 17)); assert(cfb.write_u8(" +
      std::to_string(reinterpret_cast<std::uintptr_t>(transaction_one_bytes)) +
      ", 17, 16))";
  if (!Request(pipe, {{"protocol", 1}, {"id", "lua-write-smoke-gate"},
                      {"command", "evaluate"},
                      {"params", {{"source", smoke_lua_write}}}},
               response, false) || !response.value("ok", false) ||
      transaction_one_bytes[0] != 0x10) {
    std::cerr << "Lua smoke write gate RED response: " << response.dump() << '\n';
    return 94;
  }

  const std::string lua_expected_mismatch =
      "cfb.write_u8(" +
      std::to_string(reinterpret_cast<std::uintptr_t>(transaction_one_bytes)) +
      ", 255, 17)";
  if (!Request(pipe, {{"protocol", 1}, {"id", "lua-write-error-unlock"},
                      {"command", "evaluate"},
                      {"params", {{"source", lua_expected_mismatch}}}},
               response, false) || !IsError(response, "SCRIPT_ERROR")) return 97;
  if (!BoundedRequest(pipe, {{"protocol", 1}, {"id", "write-after-lua-error"},
                             {"command", "writeTransaction"},
                             {"params", mismatch_params}},
                      response) || !IsError(response, "MEMORY_MISMATCH")) {
    std::cerr << "Lua write error mutex RED: subsequent transaction timed out\n";
    return 97;
  }

  Json inaccessible_params = write_params;
  inaccessible_params["transactionId"] = "smoke.access-denied-1";
  inaccessible_params["operations"].erase(inaccessible_params["operations"].begin() + 1);
  inaccessible_params["operations"][0]["address"] = "0x1";
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-access-denied"},
                      {"command", "writeTransaction"},
                      {"params", inaccessible_params}},
               response, false) || !IsError(response, "MEMORY_ACCESS_DENIED") ||
      !response["error"].value("details", Json::object()).empty()) return 98;

  Json limit_params = write_params;
  limit_params["transactionId"] = "smoke.limit-1";
  limit_params["operations"] = Json::array();
  for (std::size_t index = 0; index <= 32; ++index) {
    limit_params["operations"].push_back(write_params["operations"][0]);
  }
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-limit"},
                      {"command", "writeTransaction"}, {"params", limit_params}},
               response, false) || !IsError(response, "TRANSACTION_LIMIT_EXCEEDED") ||
      response["error"].value("message", "") !=
          "Transaction exceeds an operation or byte limit" ||
      !response["error"].value("details", Json::object()).empty()) return 99;

  if (!SetEnvironmentVariableW(L"CFB27_SMOKE_FORCE_APPLY_FAILURE", L"1")) return 100;
  Json apply_failure_params = write_params;
  apply_failure_params["transactionId"] = "smoke.apply-failure-1";
  apply_failure_params["operations"].erase(
      apply_failure_params["operations"].begin() + 1);
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-apply-failure"},
                      {"command", "writeTransaction"},
                      {"params", apply_failure_params}},
               response, false) || !IsError(response, "TRANSACTION_APPLY_FAILED") ||
      response["error"]["details"].value("transactionId", "") !=
          "smoke.apply-failure-1" ||
      response["error"]["details"].value("status", "") != "rolled_back_verified" ||
      response["error"]["details"]["operations"] !=
          Json::array({{{"index", 0}, {"applied", false}, {"verified", false}}}) ||
      transaction_one_bytes[0] != 0x10 || transaction_one_bytes[1] != 0x20) return 100;
  SetEnvironmentVariableW(L"CFB27_SMOKE_FORCE_APPLY_FAILURE", nullptr);

  const Json invalid_request = Json::parse(
      R"({"protocol":18446744073709551615,"id":"bad-1","command":"hello","params":{}})");
  if (!Request(pipe, invalid_request, response, false)) return 12;
  if (response.value("ok", true) || response["error"].value("code", "") != "INVALID_REQUEST") return 13;

  if (!RequestOversizedFrame(pipe, response)) return 10;
  if (response.value("ok", true) || response["error"].value("code", "") != "INVALID_REQUEST") return 11;

  const Json scan_params{
      {"patternHex", kSentinelHex},
      {"maskHex", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"},
      {"maxMatches", 2},
      {"contextBefore", 4},
      {"contextAfter", 4},
  };
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-gated"},
                      {"command", "scanMemory"}, {"params", scan_params}}, response, false)) return 25;
  if (!IsError(response, "UNSUPPORTED_BUILD")) return 26;
  Json false_scan_params = scan_params;
  false_scan_params["allowUnsupportedBuild"] = 1;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-exact-gate"},
                      {"command", "scanMemory"}, {"params", false_scan_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 40;

  Json allowed_scan_params = scan_params;
  allowed_scan_params["allowUnsupportedBuild"] = true;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-1"},
                      {"command", "scanMemory"}, {"params", allowed_scan_params}}, response, false)) return 27;
  if (!response.value("ok", false)) return 28;
  if (std::find(capabilities.begin(), capabilities.end(), "memoryScan") == capabilities.end() ||
      std::find(capabilities.begin(), capabilities.end(), "memoryRead") == capabilities.end()) return 24;
  Json scan = response["result"];
  std::vector<Json> found_matches;
  std::string previous_cursor;
  for (std::size_t page_number = 0; page_number < 4096; ++page_number) {
    if (scan.size() != 5 || scan.value("supportedBuild", true) ||
        !scan.contains("scannedBytes") || !scan["scannedBytes"].is_number_unsigned() ||
        scan["scannedBytes"].get<std::uint64_t>() > 32ull * 1024 * 1024 ||
        !scan.contains("matches") || !scan["matches"].is_array() ||
        !scan.contains("nextCursor")) return 29;
    for (const auto& candidate : scan["matches"]) found_matches.push_back(candidate);
    if (scan.value("complete", false)) {
      if (!scan["nextCursor"].is_null()) return 63;
      break;
    }
    if (!IsCanonicalAddress(scan["nextCursor"])) return 64;
    const auto cursor = scan["nextCursor"].get<std::string>();
    if (cursor == previous_cursor) return 65;
    previous_cursor = cursor;
    allowed_scan_params["cursor"] = cursor;
    if (!Request(pipe, {{"protocol", 1}, {"id", "scan-page"},
                        {"command", "scanMemory"}, {"params", allowed_scan_params}},
                 response, false) || !response.value("ok", false)) return 66;
    scan = response["result"];
  }
  if (!scan.value("complete", false) || found_matches.size() != 1) {
    std::cerr << "scan response: " << response.dump() << '\n';
    return 29;
  }
  const auto& match = found_matches[0];
  if (match.size() != 6 || !IsCanonicalAddress(match["address"]) ||
      !IsCanonicalAddress(match["regionBase"]) ||
      !IsCanonicalAddress(match["contextAddress"]) ||
      match.value("address", "") != FormatAddress(reinterpret_cast<std::uintptr_t>(sentinel_address)) ||
      match.value("contextAddress", "") !=
          FormatAddress(reinterpret_cast<std::uintptr_t>(sentinel_address) - 4) ||
      !match.contains("regionSize") || !match["regionSize"].is_number_unsigned() ||
      !match.contains("protection") || !match["protection"].is_number_unsigned() ||
      !IsUpperHex(match["contextHex"]) ||
      match.value("contextHex", "") != std::string("00000000") + kSentinelHex + "00000000") return 30;
  allowed_scan_params.erase("cursor");

  Json false_metadata_params = allowed_scan_params;
  false_metadata_params["cursor"] = FormatAddress(
      reinterpret_cast<std::uintptr_t>(allocation.get()));
  false_metadata_params["includeAllocationMetadata"] = false;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-allocation-false"},
                      {"command", "scanMemory"}, {"params", false_metadata_params}},
               response, false) || !response.value("ok", false) ||
      response["result"]["matches"].size() != 1 ||
      response["result"]["matches"][0].size() != 6) return 107;

  Json metadata_params = false_metadata_params;
  metadata_params["includeAllocationMetadata"] = true;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-allocation-true"},
                      {"command", "scanMemory"}, {"params", metadata_params}},
               response, false) || !response.value("ok", false) ||
      response["result"]["matches"].size() != 1) return 108;
  const auto& allocation_match = response["result"]["matches"][0];
  if (allocation_match.size() != 10 ||
      allocation_match.value("allocationBase", "") !=
          FormatAddress(reinterpret_cast<std::uintptr_t>(allocation.get())) ||
      allocation_match.value("allocationSize", 0ull) != allocation.page_size() * 3 ||
      allocation_match.value("allocationProtect", 0u) != PAGE_READWRITE ||
      allocation_match.value("offsetInAllocation", 0ull) !=
          allocation.page_size() + 128) return 109;

  Json invalid_metadata_params = allowed_scan_params;
  invalid_metadata_params["includeAllocationMetadata"] = 1;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-allocation-invalid"},
                      {"command", "scanMemory"}, {"params", invalid_metadata_params}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 110;

  const auto address = FormatAddress(reinterpret_cast<std::uintptr_t>(sentinel_address));
  const Json read_params{
      {"allowUnsupportedBuild", true},
      {"ranges", Json::array({{{"address", address}, {"length", 16}}})},
  };
  Json gated_read_params = read_params;
  gated_read_params.erase("allowUnsupportedBuild");
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-gated"},
                      {"command", "readMemory"}, {"params", gated_read_params}}, response, false) ||
      !IsError(response, "UNSUPPORTED_BUILD")) return 41;
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-1"},
                      {"command", "readMemory"}, {"params", read_params}}, response, false)) return 31;
  if (!response.value("ok", false) || response["result"].size() != 2 ||
      response["result"].value("supportedBuild", true) ||
      response["result"]["ranges"].size() != 1 ||
      response["result"]["ranges"][0].size() != 3 ||
      response["result"]["ranges"][0].value("address", "") != address ||
      response["result"]["ranges"][0].value("length", 0) != 16 ||
      response["result"]["ranges"][0].value("bytesHex", "") != kSentinelHex) return 32;

  Json invalid_params = allowed_scan_params;
  invalid_params["patternHex"] = "";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-empty-pattern"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 104;
  invalid_params = allowed_scan_params;
  invalid_params["patternHex"] = "CFB27A1Z";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-bad-hex"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 33;
  invalid_params = allowed_scan_params;
  invalid_params["patternHex"] = std::string((4096 + 1) * 2, 'F');
  invalid_params["maskHex"] = std::string((4096 + 1) * 2, 'F');
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-hostile-oversized-pattern"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 111;
  invalid_params = allowed_scan_params;
  invalid_params["patternHex"] = "cfb27a1100a1b2c3d4e5f60718293a4b";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-lower-hex"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 47;
  invalid_params = allowed_scan_params;
  invalid_params["patternHex"] = "CFB27A1100A1B2C3D4E5F60718293A4";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-odd-hex"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 48;
  invalid_params = allowed_scan_params;
  invalid_params["maskHex"] = "FFFFFFFFFFFFFFFF";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-bad-mask"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 34;
  invalid_params = allowed_scan_params;
  invalid_params["maxMatches"] = 65;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-limit"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 35;
  invalid_params = allowed_scan_params;
  invalid_params["contextBefore"] = 513;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-context-limit"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 43;
  invalid_params = allowed_scan_params;
  invalid_params["maxMatches"] = 2.5;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-integer"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 44;
  invalid_params = allowed_scan_params;
  invalid_params["cursor"] = "0xabcdef";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-lower-cursor"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 67;
  invalid_params = allowed_scan_params;
  invalid_params["cursor"] = "0x0001";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-zero-cursor"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 68;
  invalid_params = allowed_scan_params;
  invalid_params["cursor"] = 4096;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-numeric-cursor"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 69;
  invalid_params = allowed_scan_params;
  invalid_params["cursor"] = "0x10000000000000000";
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-overflow-cursor"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 70;
  SYSTEM_INFO system_info{};
  GetSystemInfo(&system_info);
  const auto above_max = reinterpret_cast<std::uintptr_t>(system_info.lpMaximumApplicationAddress) + 1;
  invalid_params = allowed_scan_params;
  invalid_params["cursor"] = FormatAddress(above_max);
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-above-max-cursor"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 71;
  invalid_params = allowed_scan_params;
  invalid_params["unexpected"] = 1;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-extra"},
                      {"command", "scanMemory"}, {"params", invalid_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 36;

  Json invalid_read_params = read_params;
  invalid_read_params["ranges"][0]["length"] = 65537;
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-limit"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 37;
  invalid_read_params = read_params;
  invalid_read_params["ranges"] = Json::array();
  for (int index = 0; index < 65; ++index) {
    invalid_read_params["ranges"].push_back({{"address", address}, {"length", 1}});
  }
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-range-count"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 49;
  invalid_read_params = read_params;
  invalid_read_params["ranges"] = Json::array();
  for (int index = 0; index < 5; ++index) {
    invalid_read_params["ranges"].push_back({{"address", address}, {"length", 65536}});
  }
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-aggregate"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 50;
  invalid_read_params = read_params;
  invalid_read_params["ranges"][0]["unexpected"] = true;
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-extra"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 38;
  invalid_read_params = read_params;
  invalid_read_params["allowUnsupportedBuild"] = 1;
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-exact-gate"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 39;
  invalid_read_params = read_params;
  invalid_read_params["ranges"][0]["address"] = "0xabcdef";
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-address"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "INVALID_REQUEST")) return 42;
  invalid_read_params = read_params;
  invalid_read_params["ranges"][0]["address"] = "0x1";
  if (!Request(pipe, {{"protocol", 1}, {"id", "read-denied"},
                      {"command", "readMemory"}, {"params", invalid_read_params}}, response, false) ||
      !IsError(response, "MEMORY_ACCESS_DENIED") ||
      !response["error"].value("details", Json::object()).empty()) return 45;

  std::memcpy(sentinel_address + 128,
              kSentinel.data(), kSentinel.size());
  Json crowded_scan_params = allowed_scan_params;
  crowded_scan_params["maxMatches"] = 1;
  if (!Request(pipe, {{"protocol", 1}, {"id", "scan-crowded"},
                      {"command", "scanMemory"}, {"params", crowded_scan_params}}, response, false) ||
      !IsError(response, "TOO_MANY_MATCHES") ||
      !response["error"].value("details", Json::object()).empty()) return 46;
  SecureZeroMemory(sentinel_address + 128, kSentinel.size());

  if (!Request(pipe, {{"protocol", 1}, {"id", "emit-unregistered"},
                      {"command", "evaluate"},
                      {"params", {{"source", "cfb.emit('probe.unregistered', {value=1})"}}}},
               response, false) || !IsError(response, "SCRIPT_ERROR")) return 52;

  if (!Request(pipe, {{"protocol", 1}, {"id", "telemetry-extra"},
                      {"command", "registerTelemetry"},
                      {"params", {{"types", Json::array({"probe.snapshot"})}, {"extra", true}}}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 53;
  if (!Request(pipe, {{"protocol", 1}, {"id", "telemetry-duplicate"},
                      {"command", "registerTelemetry"},
                      {"params", {{"types", Json::array({"probe.snapshot", "probe.snapshot"})}}}},
               response, false) || !IsError(response, "INVALID_REQUEST")) return 54;
  if (!Request(pipe, {{"protocol", 1}, {"id", "telemetry-register"},
                      {"command", "registerTelemetry"},
                      {"params", {{"types", Json::array({"probe.snapshot"})}}}},
               response, false) || !response.value("ok", false) ||
      response["result"] != Json({{"types", Json::array({"probe.snapshot"})}})) return 55;

  if (!Request(pipe, {{"protocol", 1}, {"id", "events-baseline"}, {"command", "events"},
                      {"params", {{"after", 0}, {"limit", 256}}}}, response, false) ||
      !response.value("ok", false)) return 56;
  const auto telemetry_after = response["result"].value("nextCursor", 0ull);

  const std::string telemetry_source =
      "assert(cfb.emit('probe.snapshot', {sequence=1, stable=true}))";
  if (!Request(pipe, {{"protocol", 1}, {"id", "emit-registered"}, {"command", "evaluate"},
                      {"params", {{"source", telemetry_source}}}}, response, false) ||
      !response.value("ok", false)) return 57;
  if (!Request(pipe, {{"protocol", 1}, {"id", "events-telemetry"}, {"command", "events"},
                      {"params", {{"after", telemetry_after}, {"limit", 256}}}}, response, false) ||
      !response.value("ok", false)) return 58;
  int telemetry_count = 0;
  for (const auto& event : response["result"]["events"]) {
    if (event.value("type", "") == "probe.snapshot") {
      ++telemetry_count;
      if (event.value("payload", Json::object()) != Json({{"sequence", 1}, {"stable", true}})) {
        return 59;
      }
    }
  }
  if (telemetry_count != 1) return 60;

  const std::vector<std::string> invalid_telemetry_sources{
      "local t={}; t.self=t; cfb.emit('probe.snapshot', t)",
      "cfb.emit('probe.snapshot', {value=function() end})",
      "cfb.emit('probe.snapshot', {[1]='a', name='b'})",
      "cfb.emit('probe.snapshot', {[1]='a', [3]='c'})",
      "cfb.emit('probe.snapshot', {[true]='value'})",
      "cfb.emit('probe.snapshot', {nested={address='0x1'}})",
  };
  for (std::size_t index = 0; index < invalid_telemetry_sources.size(); ++index) {
    if (!Request(pipe, {{"protocol", 1}, {"id", "emit-invalid-" + std::to_string(index)},
                        {"command", "evaluate"},
                        {"params", {{"source", invalid_telemetry_sources[index]}}}},
                 response, false) || !IsError(response, "SCRIPT_ERROR")) return 61;
  }
  const std::string budget_source =
      "local t={}; for i=1,17 do t[i]=string.rep('x',1024) end; "
      "t[18]=function() end; cfb.emit('probe.snapshot', t)";
  if (!Request(pipe, {{"protocol", 1}, {"id", "emit-budget"}, {"command", "evaluate"},
                      {"params", {{"source", budget_source}}}}, response, false) ||
      !IsError(response, "SCRIPT_ERROR") ||
      response["error"].value("message", "").find("16 KiB") == std::string::npos) return 62;

  const std::string source = "local x=40\nx=x+2\ncfb.log(\"protocol-smoke=\"..tostring(x))";
  if (!Request(pipe, {{"protocol", 1}, {"id", "eval-1"},
                      {"command", "evaluate"}, {"params", {{"source", source}}}}, response, false)) return 6;
  if (!response.value("ok", false) || response["result"].value("status", "") != "ok") return 7;
  if (!Request(pipe, {{"protocol", 1}, {"id", "run-1"}, {"command", "runScript"},
                      {"params", {{"name", "smoke.lua"}, {"source", source}}}}, response, false)) return 8;
  if (!response.value("ok", false) || response["result"].value("status", "") != "ok") return 9;

  const std::string event_source = "cfb.log(\"event-proof\")";
  if (!Request(pipe, {{"protocol", 1}, {"id", "event-seed"}, {"command", "evaluate"},
                      {"params", {{"source", event_source}}}}, response, false)) return 16;
  if (!response.value("ok", false)) return 17;
  if (!Request(pipe, {{"protocol", 1}, {"id", "logs-1"}, {"command", "logs"},
                      {"params", {{"limit", 64}}}}, response, false)) return 18;
  if (!response.value("ok", false) || !response["result"].contains("logs")) return 19;
  if (!Request(pipe, {{"protocol", 1}, {"id", "events-1"}, {"command", "events"},
                      {"params", {{"after", 0}, {"limit", 256}}}}, response, false)) return 20;
  if (!response.value("ok", false) || !response["result"].contains("events")) return 21;
  int proof_count = 0;
  for (const auto& event : response["result"]["events"]) {
    if (event.value("type", "") == "log" &&
        event.value("payload", Json::object()).value("message", "") == "event-proof") ++proof_count;
  }
  if (proof_count != 1) return 22;

  if (!SetEnvironmentVariableW(L"CFB27_SMOKE_FORCE_ROLLBACK_UNVERIFIED", L"1"))
    return 89;
  if (!SetEnvironmentVariableW(L"CFB27_SMOKE_HOLD_ROLLBACK", L"1")) return 95;
  Json rollback_params = write_params;
  rollback_params["transactionId"] = "smoke.rollback-unverified-1";
  rollback_params["operations"].erase(rollback_params["operations"].begin() + 1);
  Json rollback_response;
  bool rollback_request_ok = false;
  const auto rollback_started = std::chrono::steady_clock::now();
  std::thread rollback_thread([&] {
    rollback_request_ok = Request(
        pipe, {{"protocol", 1}, {"id", "write-rollback-unverified"},
               {"command", "writeTransaction"}, {"params", rollback_params}},
        rollback_response, false);
  });
  Sleep(100);
  const std::string concurrent_lua =
      "cfb.write_u8(" +
      std::to_string(reinterpret_cast<std::uintptr_t>(transaction_one_bytes)) +
      ", 17, 85)";
  Json concurrent_lua_response;
  const bool concurrent_lua_ok =
      LegacyEvaluate(legacy_pipe, concurrent_lua, concurrent_lua_response);
  rollback_thread.join();
  const auto rollback_elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - rollback_started);
  if (rollback_elapsed.count() < 400) {
    std::cerr << "held rollback RED elapsedMs=" << rollback_elapsed.count() << '\n';
    return 95;
  }
  if (!rollback_request_ok ||
      !IsError(rollback_response, "ROLLBACK_VERIFICATION_FAILED") ||
      rollback_response["error"]["details"].value("transactionId", "") !=
          "smoke.rollback-unverified-1" ||
      rollback_response["error"]["details"].value("status", "") !=
          "rollback_unverified" ||
      transaction_one_bytes[0] != 0x10 || transaction_one_bytes[1] != 0x20) {
    response = rollback_response;
    std::cerr << "rollback injection RED response: " << response.dump() << '\n';
    return 90;
  }
  if (!concurrent_lua_ok || concurrent_lua_response.value("ok", true) ||
      concurrent_lua_response.value("result", "").find("session writes are disabled") ==
          std::string::npos) {
    std::cerr << "atomic lockdown RED response: " << concurrent_lua_response.dump() << '\n';
    return 96;
  }
  SetEnvironmentVariableW(L"CFB27_SMOKE_FORCE_ROLLBACK_UNVERIFIED", nullptr);
  SetEnvironmentVariableW(L"CFB27_SMOKE_HOLD_ROLLBACK", nullptr);

  if (!Request(pipe, {{"protocol", 1}, {"id", "status-lockdown"},
                      {"command", "status"}, {"params", Json::object()}},
               response, false) || !response.value("ok", false) ||
      !response["result"].value("sessionWritesDisabled", false) ||
      response["result"].value("writesAllowed", true)) return 91;
  if (!Request(pipe, {{"protocol", 1}, {"id", "write-after-lockdown"},
                      {"command", "writeTransaction"}, {"params", write_params}},
               response, false) || !IsError(response, "SESSION_WRITES_DISABLED")) return 92;

  const std::string lockdown_lua =
      "cfb.write_u8(" +
      std::to_string(reinterpret_cast<std::uintptr_t>(transaction_one_bytes)) +
      ", 16, 17)";
  if (!Request(pipe, {{"protocol", 1}, {"id", "lua-write-after-lockdown"},
                      {"command", "evaluate"},
                      {"params", {{"source", lockdown_lua}}}},
               response, false) || !IsError(response, "SCRIPT_ERROR") ||
      response["error"].value("message", "").find("session writes are disabled") ==
          std::string::npos ||
      transaction_one_bytes[0] != 0x10) return 93;
  std::cout << "protocol smoke passed\n";
  return 0;
}
