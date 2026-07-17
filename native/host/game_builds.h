#pragma once

#include <cstdint>
#include <optional>
#include <string_view>

namespace cfb27::game_builds {

enum class Support { kDiagnostic, kCertified };

struct BoardLayout {
  std::uintptr_t generic_record_wrapper_vtable_rva{};
  std::uintptr_t recruiting_controller_vtable_rva{};
  std::uintptr_t full_add_rva{};
  std::uintptr_t full_remove_rva{};
};

struct Build {
  std::string_view label;
  std::uintmax_t executable_size{};
  std::string_view executable_sha256;
  Support support{Support::kDiagnostic};
  std::optional<BoardLayout> board;
};

using GeneratedBuild = Build;

const Build* FindBuild(std::uintmax_t size, std::string_view uppercase_sha256);
bool IsCertified(const Build* build);
bool IsDiagnosticOrCertified(const Build* build);

}  // namespace cfb27::game_builds
