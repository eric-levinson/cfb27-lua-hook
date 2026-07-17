#include "../host/build_policy.h"

#include <iostream>

int main() {
  using cfb27::build_policy::ResearchWatchesAllowed;
  using cfb27::build_policy::WritesAllowed;
  using cfb27::game_builds::Build;
  using cfb27::game_builds::Support;

  const Build diagnostic{"diagnostic", 1, "DIAGNOSTIC", Support::kDiagnostic};
  const Build certified{"certified", 2, "CERTIFIED", Support::kCertified};

  if (ResearchWatchesAllowed(nullptr, false) ||
      WritesAllowed(nullptr, false, false, false)) {
    std::cerr << "unknown identity gained runtime authority\n";
    return 1;
  }
  if (!ResearchWatchesAllowed(&diagnostic, false) ||
      WritesAllowed(&diagnostic, false, false, false)) {
    std::cerr << "diagnostic identity policy mismatch\n";
    return 2;
  }
  if (!ResearchWatchesAllowed(&certified, false) ||
      !WritesAllowed(&certified, false, false, false)) {
    std::cerr << "certified offline identity was denied\n";
    return 3;
  }
  if (ResearchWatchesAllowed(&certified, true) ||
      WritesAllowed(&certified, true, false, false)) {
    std::cerr << "anticheat did not close runtime authority\n";
    return 4;
  }
  if (WritesAllowed(&certified, false, true, false)) {
    std::cerr << "session write lockdown was bypassed\n";
    return 5;
  }
  if (!WritesAllowed(nullptr, false, false, true) ||
      WritesAllowed(nullptr, true, false, true)) {
    std::cerr << "smoke override policy mismatch\n";
    return 6;
  }

  std::cout << "build policy smoke passed\n";
  return 0;
}
