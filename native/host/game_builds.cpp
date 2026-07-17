#include "game_builds.h"

#include <array>

namespace cfb27::game_builds {

#include "game_builds.generated.h"

const Build* FindBuild(std::uintmax_t size, std::string_view uppercase_sha256) {
  for (const auto& build : kGeneratedBuilds) {
    if (build.executable_size == size &&
        build.executable_sha256 == uppercase_sha256) {
      return &build;
    }
  }
  return nullptr;
}

bool IsCertified(const Build* build) {
  return build && build->support == Support::kCertified;
}

bool IsDiagnosticOrCertified(const Build* build) {
  return build && (build->support == Support::kDiagnostic ||
                   build->support == Support::kCertified);
}

}  // namespace cfb27::game_builds
