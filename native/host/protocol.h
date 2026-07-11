#pragma once

#include <windows.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace cfb27::protocol {

constexpr std::uint32_t kVersion = 1;
constexpr std::uint32_t kMaxFrameBytes = 1024 * 1024;

using Json = nlohmann::json;
using Handler = std::function<Json(const Json&)>;

bool ReadFrame(HANDLE pipe, Json& value, std::string& error);
bool WriteFrame(HANDLE pipe, const Json& value, std::string& error);
void Serve(std::wstring pipe_name, std::atomic<bool>& running, const Handler& handler);
Json ErrorResponse(std::string id, std::string code, std::string message,
                   Json details = Json::object());

}  // namespace cfb27::protocol
