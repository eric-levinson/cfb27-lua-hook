#pragma once

#include "game_builds.h"

namespace cfb27::build_policy {

bool ResearchWatchesAllowed(const game_builds::Build* build,
                            bool real_anticheat_running);
bool WritesAllowed(const game_builds::Build* build,
                   bool real_anticheat_running,
                   bool session_writes_disabled,
                   bool smoke_override);

}  // namespace cfb27::build_policy
