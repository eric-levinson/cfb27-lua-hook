#include "protocol.h"

#include <algorithm>
#include <array>
#include <limits>
#include <string>
#include <vector>

namespace cfb27::protocol {
namespace {

bool ReadExact(HANDLE pipe, std::uint8_t* data, std::size_t size) {
  while (size > 0) {
    const DWORD requested = static_cast<DWORD>((std::min)(
        size, static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    DWORD read = 0;
    if (!ReadFile(pipe, data, requested, &read, nullptr) || read == 0) return false;
    data += read;
    size -= read;
  }
  return true;
}

bool WriteExact(HANDLE pipe, const std::uint8_t* data, std::size_t size) {
  while (size > 0) {
    const DWORD requested = static_cast<DWORD>((std::min)(
        size, static_cast<std::size_t>((std::numeric_limits<DWORD>::max)())));
    DWORD written = 0;
    if (!WriteFile(pipe, data, requested, &written, nullptr) || written == 0) return false;
    data += written;
    size -= written;
  }
  return true;
}

}  // namespace

bool ReadFrame(HANDLE pipe, Json& value, std::string& error) {
  std::array<std::uint8_t, 4> header{};
  if (!ReadExact(pipe, header.data(), header.size())) {
    error = "Could not read the frame header";
    return false;
  }

  const std::uint32_t size = static_cast<std::uint32_t>(header[0]) |
      (static_cast<std::uint32_t>(header[1]) << 8) |
      (static_cast<std::uint32_t>(header[2]) << 16) |
      (static_cast<std::uint32_t>(header[3]) << 24);
  if (size == 0 || size > kMaxFrameBytes) {
    error = "Frame size is outside the supported range";
    return false;
  }

  std::vector<std::uint8_t> body(size);
  if (!ReadExact(pipe, body.data(), body.size())) {
    error = "Could not read the complete frame body";
    return false;
  }

  value = Json::parse(body.begin(), body.end(), nullptr, false);
  if (value.is_discarded()) {
    error = "Frame body is not valid JSON";
    return false;
  }
  return true;
}

bool WriteFrame(HANDLE pipe, const Json& value, std::string& error) {
  const std::string body = value.dump();
  if (body.empty() || body.size() > kMaxFrameBytes) {
    error = "Response frame size is outside the supported range";
    return false;
  }

  const auto size = static_cast<std::uint32_t>(body.size());
  const std::array<std::uint8_t, 4> header{
      static_cast<std::uint8_t>(size),
      static_cast<std::uint8_t>(size >> 8),
      static_cast<std::uint8_t>(size >> 16),
      static_cast<std::uint8_t>(size >> 24),
  };
  if (!WriteExact(pipe, header.data(), header.size()) ||
      !WriteExact(pipe, reinterpret_cast<const std::uint8_t*>(body.data()), body.size())) {
    error = "Could not write the complete response frame";
    return false;
  }
  return true;
}

Json ErrorResponse(std::string id, std::string code, std::string message, Json details) {
  return {
      {"protocol", kVersion},
      {"id", std::move(id)},
      {"ok", false},
      {"error", {
          {"code", std::move(code)},
          {"message", std::move(message)},
          {"details", std::move(details)},
      }},
  };
}

void Serve(std::wstring pipe_name, std::atomic<bool>& running, const Handler& handler) {
  while (running.load(std::memory_order_acquire)) {
    HANDLE pipe = CreateNamedPipeW(
        pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1,
        64 * 1024, 64 * 1024, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return;

    if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) {
      Json request;
      std::string error;
      const Json response = ReadFrame(pipe, request, error)
          ? handler(request)
          : ErrorResponse("", "INVALID_REQUEST", error);
      std::string write_error;
      WriteFrame(pipe, response, write_error);
      FlushFileBuffers(pipe);
      DisconnectNamedPipe(pipe);
    }
    CloseHandle(pipe);
  }
}

}  // namespace cfb27::protocol
