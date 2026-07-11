#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>
#include <vector>

namespace cfb27::telemetry {

using Json = nlohmann::json;

bool IsTelemetryTypeName(std::string_view type);
bool RegisterTelemetryTypes(const std::vector<std::string>& types, std::string& error);
bool IsTelemetryTypeRegistered(std::string_view type);
bool ValidateTelemetryPayload(const Json& payload, std::string& error);

}  // namespace cfb27::telemetry
