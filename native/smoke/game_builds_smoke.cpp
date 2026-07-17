#include "../host/game_builds.h"

#include <iostream>

int main() {
  using cfb27::game_builds::FindBuild;
  using cfb27::game_builds::IsCertified;
  using cfb27::game_builds::IsDiagnosticOrCertified;
  using cfb27::game_builds::Support;

  const auto* july11 = FindBuild(
      247845776ULL,
      "9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8");
  if (!july11 || july11->label != "july-11-2026" ||
      july11->support != Support::kCertified || !july11->board ||
      !IsCertified(july11) || !IsDiagnosticOrCertified(july11)) return 1;

  const auto* patch1 = FindBuild(
      249801616ULL,
      "A048578530F7ED5967DF38803B63AD9B9F04FC71287F1E151C901A94AB240BFD");
  if (!patch1 || patch1->label != "patch-1-2026-07-16" ||
      patch1->support != Support::kCertified || !patch1->board ||
      patch1->board->full_add_rva != 0x810AC70ULL ||
      patch1->board->full_remove_rva != 0x8168AA0ULL ||
      patch1->board->recruit_table_id != 0x10B1 ||
      patch1->board->team_table_id != 0x18B1 ||
      !IsCertified(patch1) || !IsDiagnosticOrCertified(patch1)) return 2;

  if (FindBuild(
          247845777ULL,
          "9E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8"))
    return 3;
  if (FindBuild(
          247845776ULL,
          "8E654AD49C4702D8F9FA4E38FD1110ABE657DD38926D4124B30C70E7D29ADFE8"))
    return 4;
  if (IsCertified(nullptr) || IsDiagnosticOrCertified(nullptr)) return 5;

  std::cout << "game builds smoke passed\n";
  return 0;
}
