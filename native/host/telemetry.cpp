#include "telemetry.h"

#include <cmath>
#include <exception>
#include <mutex>
#include <unordered_set>

namespace cfb27::telemetry {
namespace {

constexpr std::size_t kMaxTelemetryTypes = 16;
constexpr std::size_t kMaxDepth = 4;
constexpr std::size_t kMaxObjectKeys = 64;
constexpr std::size_t kMaxArrayEntries = 128;
constexpr std::size_t kMaxStringBytes = 1024;
constexpr std::size_t kMaxSerializedBytes = 16 * 1024;

std::mutex g_types_mutex;
std::unordered_set<std::string> g_registered_types;

bool IsReservedType(std::string_view type) {
  return type == "game_ready" || type == "tick" || type == "log";
}

bool IsForbiddenKey(std::string_view key) {
  return key == "address" || key == "addressHex" || key == "regionBase" ||
         key == "bytesHex" || key == "contextAddress" || key == "contextHex";
}

bool AddSerializedBytes(std::size_t bytes, std::size_t& total, std::string& error) {
  if (bytes > kMaxSerializedBytes - total) {
    error = "Serialized telemetry payload must not exceed 16 KiB";
    return false;
  }
  total += bytes;
  return true;
}

bool ValidateValue(const Json& value, std::size_t depth, std::size_t& serialized_bytes,
                   std::string& error) {
  if (value.is_null() || value.is_boolean() || value.is_number_integer() ||
      value.is_number_unsigned()) {
    return AddSerializedBytes(value.dump().size(), serialized_bytes, error);
  }
  if (value.is_number_float()) {
    if (!std::isfinite(value.get<double>())) {
      error = "Telemetry numbers must be finite";
      return false;
    }
    return AddSerializedBytes(value.dump().size(), serialized_bytes, error);
  }
  if (value.is_string()) {
    if (value.get_ref<const std::string&>().size() > kMaxStringBytes) {
      error = "Telemetry strings must not exceed 1024 bytes";
      return false;
    }
    return AddSerializedBytes(value.dump().size(), serialized_bytes, error);
  }
  if (value.is_array()) {
    if (depth > kMaxDepth) {
      error = "Telemetry payload depth must not exceed 4";
      return false;
    }
    if (value.size() > kMaxArrayEntries) {
      error = "Telemetry arrays must not exceed 128 entries";
      return false;
    }
    if (!AddSerializedBytes(2, serialized_bytes, error)) return false;
    bool first = true;
    for (const auto& item : value) {
      if (!first && !AddSerializedBytes(1, serialized_bytes, error)) return false;
      first = false;
      if (!ValidateValue(item, depth + 1, serialized_bytes, error)) return false;
    }
    return true;
  }
  if (value.is_object()) {
    if (depth > kMaxDepth) {
      error = "Telemetry payload depth must not exceed 4";
      return false;
    }
    if (value.size() > kMaxObjectKeys) {
      error = "Telemetry objects must not exceed 64 keys";
      return false;
    }
    if (!AddSerializedBytes(2, serialized_bytes, error)) return false;
    bool first = true;
    for (const auto& [key, item] : value.items()) {
      if (key.size() > kMaxStringBytes) {
        error = "Telemetry strings must not exceed 1024 bytes";
        return false;
      }
      if (IsForbiddenKey(key)) {
        error = "Telemetry payloads must not contain address or raw-byte keys";
        return false;
      }
      const std::size_t punctuation = first ? 1 : 2;
      first = false;
      if (!AddSerializedBytes(Json(key).dump().size() + punctuation,
                              serialized_bytes, error) ||
          !ValidateValue(item, depth + 1, serialized_bytes, error)) {
        return false;
      }
    }
    return true;
  }
  error = "Telemetry payload must contain only JSON-compatible values";
  return false;
}

}  // namespace

bool IsTelemetryTypeName(std::string_view type) {
  if (type.empty() || type.size() > 64 || IsReservedType(type) ||
      type.front() < 'a' || type.front() > 'z') {
    return false;
  }
  for (const char character : type.substr(1)) {
    if ((character < 'a' || character > 'z') &&
        (character < '0' || character > '9') && character != '_' &&
        character != '.' && character != '-') {
      return false;
    }
  }
  return true;
}

bool RegisterTelemetryTypes(const std::vector<std::string>& types, std::string& error) {
  if (types.empty() || types.size() > kMaxTelemetryTypes) {
    error = "Telemetry registration requires 1 to 16 types";
    return false;
  }
  std::unordered_set<std::string> requested;
  for (const auto& type : types) {
    if (!IsTelemetryTypeName(type)) {
      error = "Telemetry type name is invalid or reserved";
      return false;
    }
    if (!requested.insert(type).second) {
      error = "Telemetry registration contains duplicate types";
      return false;
    }
  }

  std::lock_guard lock(g_types_mutex);
  std::size_t new_types = 0;
  for (const auto& type : requested) {
    if (!g_registered_types.contains(type)) ++new_types;
  }
  if (new_types > kMaxTelemetryTypes - g_registered_types.size()) {
    error = "Telemetry registration exceeds the 16-type session limit";
    return false;
  }
  g_registered_types.insert(requested.begin(), requested.end());
  error.clear();
  return true;
}

bool IsTelemetryTypeRegistered(std::string_view type) {
  std::lock_guard lock(g_types_mutex);
  return g_registered_types.contains(std::string(type));
}

bool ValidateTelemetryPayload(const Json& payload, std::string& error) {
  error.clear();
  try {
    std::size_t serialized_bytes = 0;
    return ValidateValue(payload, 1, serialized_bytes, error);
  } catch (const std::exception&) {
    error = "Telemetry payload could not be serialized";
    return false;
  }
}

}  // namespace cfb27::telemetry
