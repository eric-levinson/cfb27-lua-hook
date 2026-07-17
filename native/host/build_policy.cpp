#include "build_policy.h"

namespace cfb27::build_policy {

bool ResearchWatchesAllowed(const game_builds::Build* build,
                            bool real_anticheat_running) {
  return game_builds::IsDiagnosticOrCertified(build) &&
         !real_anticheat_running;
}

bool WritesAllowed(const game_builds::Build* build,
                   bool real_anticheat_running,
                   bool session_writes_disabled,
                   bool smoke_override) {
  return (game_builds::IsCertified(build) || smoke_override) &&
         !real_anticheat_running && !session_writes_disabled;
}

}  // namespace cfb27::build_policy
