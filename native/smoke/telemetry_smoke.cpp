#include "../host/telemetry.h"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

using cfb27::telemetry::Json;

void Require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAILED: " << message << '\n';
    std::exit(1);
  }
}

bool Registers(const std::vector<std::string>& types) {
  std::string error;
  return cfb27::telemetry::RegisterTelemetryTypes(types, error);
}

bool ValidPayload(const Json& payload) {
  std::string error;
  return cfb27::telemetry::ValidateTelemetryPayload(payload, error);
}

}  // namespace

int main() {
  Require(cfb27::telemetry::IsTelemetryTypeName("probe.snapshot"), "valid type name");
  for (const auto* type : {"", "Probe.snapshot", "probe snapshot", ".probe",
                           "game_ready", "tick", "log"}) {
    Require(!cfb27::telemetry::IsTelemetryTypeName(type), "invalid or reserved type name");
    Require(!Registers({type}), "reject invalid or reserved registration");
  }
  Require(!Registers({"probe.duplicate", "probe.duplicate"}),
          "reject duplicate names in one request");
  std::vector<std::string> too_many;
  for (int index = 0; index < 17; ++index) {
    too_many.push_back("probe.bulk" + std::to_string(index));
  }
  Require(!Registers(too_many), "reject more than 16 names");
  Require(!cfb27::telemetry::IsTelemetryTypeRegistered("probe.bulk0"),
          "failed registration is atomic");

  Require(Registers({"probe.snapshot"}), "register telemetry type");
  Require(Registers({"probe.snapshot"}), "identical registration is idempotent");
  Require(cfb27::telemetry::IsTelemetryTypeRegistered("probe.snapshot"),
          "registered type is visible");

  const Json valid = {
      {"sequence", 1},
      {"stable", true},
      {"label", "ready"},
      {"nested", {{"items", Json::array({1, nullptr, false, "ok"})}}},
  };
  Require(ValidPayload(valid), "accept nested scalar JSON within limits");

  Json depth_five = Json::object();
  depth_five["a"]["b"]["c"]["d"]["e"] = 1;
  Require(!ValidPayload(depth_five), "reject depth 5");

  Json object_65 = Json::object();
  for (int index = 0; index < 65; ++index) object_65["key" + std::to_string(index)] = index;
  Require(!ValidPayload(object_65), "reject 65 object keys");
  Require(!ValidPayload(Json(std::vector<int>(129, 1))), "reject 129 array entries");
  Require(!ValidPayload(std::string(1025, 'x')), "reject 1025-byte strings");

  for (const auto* key : {"address", "addressHex", "regionBase", "bytesHex"}) {
    Json payload = {{"nested", {{key, "0x1"}}}};
    Require(!ValidPayload(payload), "reject address or raw-byte keys at every depth");
  }
  Require(!ValidPayload(std::numeric_limits<double>::infinity()), "reject infinity");
  Require(!ValidPayload(std::numeric_limits<double>::quiet_NaN()), "reject NaN");

  Json oversized = Json::object();
  for (int index = 0; index < 17; ++index) {
    oversized["field" + std::to_string(index)] = std::string(1024, 'x');
  }
  Require(!ValidPayload(oversized), "reject serialized payload above 16 KiB");

  std::cout << "telemetry smoke passed\n";
  return 0;
}
