#include "board_mutation.h"

#include "native_call.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <span>
#include <vector>

namespace cfb27::board_mutation {
namespace {

constexpr std::uint32_t kUserTargetTableRole = 4168;
constexpr std::uint32_t kActivePitchTableRole = 5790;
constexpr std::uint32_t kMembershipTableRole = 5847;
constexpr std::uint32_t kMembershipCapacity = 138;
constexpr std::uint32_t kBoardSlots = 35;
constexpr std::uint32_t kReferenceRowMask = 0x1FFFF;

struct Region {
  const std::uint8_t* begin{};
  std::size_t size{};
};

struct TableSpec {
  std::uint32_t id{};
  std::uint32_t table1_length{};
  std::uint32_t words{};
  std::uint32_t capacity{};
  std::uint32_t stride{};
  std::uint32_t data_offset{};
};

struct TableView {
  const TableSpec* spec{};
  std::uintptr_t header{};
  std::uintptr_t data{};
  std::uint32_t head{};
  std::uint32_t score{};
};

struct RuntimeCache {
  std::uintptr_t module{};
  std::uint32_t recruit_row{};
  std::uint32_t team_row{};
  std::uintptr_t controller{};
  std::uintptr_t recruit_wrapper{};
  std::uintptr_t team_wrapper{};
  TableView targets;
  TableView pitches;
  TableView membership;
};

std::optional<RuntimeCache> g_runtime_cache;

struct BoardItem {
  std::uint32_t slot{};
  std::uint32_t target_row{};
  std::uint32_t recruit_row{};
  std::uint32_t active_pitch_row{UINT32_MAX};
};

struct BoardSnapshot {
  bool valid{};
  bool compact{};
  std::uint32_t membership_row{};
  std::vector<BoardItem> items;
};

constexpr TableSpec kUserTarget{
    4168, 40444, 9, 1120, 36, 120};
constexpr TableSpec kActivePitch{
    5790, 77312, 3, 4830, 12, 19348};
constexpr TableSpec kMembership{
    5847, 19904, 35, 138, 140, 580};

bool ReadableProtection(DWORD protection) {
  if (protection & (PAGE_GUARD | PAGE_NOACCESS)) return false;
  const DWORD base = protection & 0xFF;
  return base == PAGE_READONLY || base == PAGE_READWRITE ||
         base == PAGE_WRITECOPY || base == PAGE_EXECUTE_READ ||
         base == PAGE_EXECUTE_READWRITE || base == PAGE_EXECUTE_WRITECOPY;
}

bool WritableProtection(DWORD protection) {
  if (protection & (PAGE_GUARD | PAGE_NOACCESS)) return false;
  const DWORD base = protection & 0xFF;
  return base == PAGE_READWRITE || base == PAGE_WRITECOPY ||
         base == PAGE_EXECUTE_READWRITE || base == PAGE_EXECUTE_WRITECOPY;
}

bool ReadableRange(std::uintptr_t address, std::size_t size) {
  if (!address || !size || address > std::numeric_limits<std::uintptr_t>::max() - size)
    return false;
  auto cursor = address;
  const auto end = address + size;
  while (cursor < end) {
    MEMORY_BASIC_INFORMATION info{};
    if (VirtualQuery(reinterpret_cast<const void*>(cursor), &info, sizeof(info)) !=
            sizeof(info) ||
        info.State != MEM_COMMIT || !ReadableProtection(info.Protect)) return false;
    const auto region_end = reinterpret_cast<std::uintptr_t>(info.BaseAddress) +
                            info.RegionSize;
    if (region_end <= cursor) return false;
    cursor = std::min(end, region_end);
  }
  return true;
}

template <typename T>
bool ReadValue(std::uintptr_t address, T& value) {
  if (!ReadableRange(address, sizeof(T))) return false;
#if defined(_MSC_VER)
  __try {
    std::memcpy(&value, reinterpret_cast<const void*>(address), sizeof(T));
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return false;
  }
#else
  std::memcpy(&value, reinterpret_cast<const void*>(address), sizeof(T));
#endif
  return true;
}

std::vector<Region> PrivateReadableRegions() {
  SYSTEM_INFO system{};
  GetSystemInfo(&system);
  auto cursor = reinterpret_cast<std::uintptr_t>(system.lpMinimumApplicationAddress);
  const auto maximum = reinterpret_cast<std::uintptr_t>(system.lpMaximumApplicationAddress);
  std::vector<Region> regions;
  while (cursor < maximum) {
    MEMORY_BASIC_INFORMATION info{};
    if (VirtualQuery(reinterpret_cast<const void*>(cursor), &info, sizeof(info)) !=
        sizeof(info)) break;
    const auto base = reinterpret_cast<std::uintptr_t>(info.BaseAddress);
    if (info.State == MEM_COMMIT && info.Type == MEM_PRIVATE &&
        WritableProtection(info.Protect) && info.RegionSize >= 32) {
      regions.push_back({reinterpret_cast<const std::uint8_t*>(base), info.RegionSize});
    }
    const auto next = base + info.RegionSize;
    if (next <= cursor) break;
    cursor = next;
  }
  return regions;
}

template <typename Callback>
void FindBytes(const Region& region, std::span<const std::uint8_t> needle,
               Callback callback) {
  constexpr std::size_t kChunkSize = 256 * 1024;
  const auto process = GetCurrentProcess();
  std::vector<std::uint8_t> snapshot(kChunkSize + needle.size() - 1);
  std::size_t carry = 0;
  std::uintptr_t cursor = reinterpret_cast<std::uintptr_t>(region.begin);
  const auto end = cursor + region.size;
  std::uintptr_t last_reported = 0;
  while (cursor < end) {
    const auto requested = (std::min)(kChunkSize, static_cast<std::size_t>(end - cursor));
    SIZE_T copied = 0;
    if (!ReadProcessMemory(process, reinterpret_cast<const void*>(cursor),
                           snapshot.data() + carry, requested, &copied) ||
        copied != requested) {
      carry = 0;
      cursor += requested;
      continue;
    }
    const auto available = carry + requested;
    auto search = snapshot.begin();
    const auto finish = snapshot.begin() + available;
    while (search + needle.size() <= finish) {
      const auto found = std::search(search, finish, needle.begin(), needle.end());
      if (found == finish) break;
      const auto address = cursor - carry +
          static_cast<std::uintptr_t>(found - snapshot.begin());
      if (address != last_reported) {
        callback(address);
        last_reported = address;
      }
      search = found + 1;
    }
    carry = (std::min)(needle.size() - 1, available);
    if (carry) std::memmove(snapshot.data(), snapshot.data() + available - carry, carry);
    cursor += requested;
  }
}

template <std::size_t Count, typename Callback>
void FindPatterns(
    const Region& region,
    const std::array<std::span<const std::uint8_t>, Count>& needles,
    Callback callback) {
  constexpr std::size_t kChunkSize = 256 * 1024;
  std::size_t maximum_needle = 0;
  for (const auto needle : needles) maximum_needle = (std::max)(maximum_needle, needle.size());
  if (!maximum_needle) return;

  const auto process = GetCurrentProcess();
  std::vector<std::uint8_t> snapshot(kChunkSize + maximum_needle - 1);
  std::array<std::uintptr_t, Count> last_reported{};
  std::size_t carry = 0;
  std::uintptr_t cursor = reinterpret_cast<std::uintptr_t>(region.begin);
  const auto end = cursor + region.size;
  while (cursor < end) {
    const auto requested = (std::min)(kChunkSize, static_cast<std::size_t>(end - cursor));
    SIZE_T copied = 0;
    if (!ReadProcessMemory(process, reinterpret_cast<const void*>(cursor),
                           snapshot.data() + carry, requested, &copied) ||
        copied != requested) {
      carry = 0;
      cursor += requested;
      continue;
    }
    const auto available = carry + requested;
    const auto finish = snapshot.begin() + available;
    for (std::size_t pattern = 0; pattern < Count; ++pattern) {
      const auto needle = needles[pattern];
      auto search = snapshot.begin();
      while (search + needle.size() <= finish) {
        const auto found = std::search(search, finish, needle.begin(), needle.end());
        if (found == finish) break;
        const auto address = cursor - carry +
            static_cast<std::uintptr_t>(found - snapshot.begin());
        if (address != last_reported[pattern]) {
          callback(pattern, address);
          last_reported[pattern] = address;
        }
        search = found + 1;
      }
    }
    carry = (std::min)(maximum_needle - 1, available);
    if (carry) std::memmove(snapshot.data(), snapshot.data() + available - carry, carry);
    cursor += requested;
  }
}

std::array<std::uint8_t, 8> QwordBytes(std::uint64_t value) {
  std::array<std::uint8_t, 8> bytes{};
  std::memcpy(bytes.data(), &value, sizeof(value));
  return bytes;
}

std::array<std::uint8_t, 16> TableSignature(const TableSpec& spec) {
  std::array<std::uint32_t, 4> words{
      spec.table1_length, spec.table1_length, spec.words, spec.capacity};
  std::array<std::uint8_t, 16> bytes{};
  std::memcpy(bytes.data(), words.data(), bytes.size());
  return bytes;
}

std::uint32_t ReferenceTable(std::uint32_t value) { return value >> 17; }
std::uint32_t ReferenceRow(std::uint32_t value) { return value & kReferenceRowMask; }

std::uint32_t ScoreTable(const TableSpec& spec, std::uintptr_t data,
                         const game_builds::BoardLayout& layout) {
  if (!ReadableRange(data, static_cast<std::size_t>(spec.capacity) * spec.stride))
    return 0;
  std::uint32_t free_rows = 0;
  std::uint32_t content_rows = 0;
  const auto sample = std::min<std::uint32_t>(spec.capacity, 512);
  for (std::uint32_t row = 0; row < sample; ++row) {
    const auto record = data + static_cast<std::uintptr_t>(row) * spec.stride;
    std::uint32_t first{};
    if (!ReadValue(record, first)) return 0;
    if (spec.id == kMembershipTableRole) {
      bool structural = true;
      bool saw_zero = false;
      for (std::uint32_t slot = 0; slot < spec.words; ++slot) {
        std::uint32_t reference{};
        if (!ReadValue(record + slot * 4, reference)) return 0;
        if (!reference) {
          saw_zero = true;
          continue;
        }
        const auto table = ReferenceTable(reference);
        if (saw_zero || table == 0) {
          structural = false;
          break;
        }
        ++content_rows;
      }
      if (structural) ++free_rows;
      continue;
    }
    bool rest_zero = true;
    for (std::uint32_t offset = 4; offset < spec.stride; offset += 4) {
      std::uint32_t word{};
      if (!ReadValue(record + offset, word)) return 0;
      if (word != 0) rest_zero = false;
    }
    if (first == row + 1 && rest_zero) ++free_rows;
    if (spec.id == kUserTargetTableRole) {
      std::uint32_t recruit{};
      if (!ReadValue(record + 12, recruit)) return 0;
      if (ReferenceTable(recruit) == layout.recruit_table_id) ++content_rows;
    } else if (spec.id == kActivePitchTableRole) {
      if (ReferenceTable(first) == 4190) ++content_rows;
    }
  }
  return free_rows + content_rows * 8;
}

bool LocateTable(const std::vector<Region>& regions, const TableSpec& spec,
                 const game_builds::BoardLayout& layout, TableView& selected) {
  const auto signature = TableSignature(spec);
  std::vector<TableView> candidates;
  for (const auto& region : regions) {
    FindBytes(region, signature, [&](std::uintptr_t header) {
      const auto data = header + spec.data_offset;
      const auto score = ScoreTable(spec, data, layout);
      std::uint32_t head{};
      if (score && ReadValue(header + 24, head))
        candidates.push_back({&spec, header, data, head, score});
    });
  }
  if (candidates.empty()) return false;
  std::sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
    return left.score > right.score;
  });
  if (candidates.size() > 1 && candidates[0].score == candidates[1].score) return false;
  selected = candidates[0];
  return true;
}

bool SelectTable(std::vector<TableView>& candidates, TableView& selected) {
  if (candidates.empty()) return false;
  std::sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
    return left.score > right.score;
  });
  if (candidates.size() > 1 && candidates[0].score == candidates[1].score) return false;
  selected = candidates[0];
  return true;
}

void AddTableCandidate(const TableSpec& spec,
                       const game_builds::BoardLayout& layout,
                       std::uintptr_t header,
                       std::vector<TableView>& candidates) {
  const auto data = header + spec.data_offset;
  const auto score = ScoreTable(spec, data, layout);
  std::uint32_t head{};
  if (score && ReadValue(header + 24, head))
    candidates.push_back({&spec, header, data, head, score});
}

std::uint32_t DescriptorTableId(std::uintptr_t descriptor) {
  std::uint64_t encoded{};
  if (!ReadValue(descriptor + 40, encoded)) return 0;
  return static_cast<std::uint32_t>(encoded >> 32);
}

bool ValidateController(const game_builds::BoardLayout& layout,
                        std::uintptr_t module, std::uintptr_t address) {
  std::uintptr_t vtable{};
  std::uint64_t membership_row{};
  std::uintptr_t descriptor{};
  std::uintptr_t board_store{};
  return ReadValue(address, vtable) &&
      vtable == module + layout.recruiting_controller_vtable_rva &&
      ReadValue(address + 8, membership_row) && membership_row < kMembershipCapacity &&
      ReadValue(address + 16, descriptor) &&
      DescriptorTableId(descriptor) == layout.controller_descriptor_table_id &&
      ReadValue(address + 0x138, board_store) && ReadableRange(board_store, 8);
}

bool ValidateWrapper(const game_builds::BoardLayout& layout,
                     std::uintptr_t module, std::uintptr_t address,
                     std::uint32_t table_id, std::uint32_t row) {
  std::uintptr_t vtable{};
  std::uintptr_t descriptor{};
  std::uint64_t captured_row{};
  return ReadValue(address, vtable) &&
      vtable == module + layout.generic_record_wrapper_vtable_rva &&
      ReadValue(address + 16, descriptor) && DescriptorTableId(descriptor) == table_id &&
      ReadValue(address + 24, captured_row) && captured_row == row;
}

bool RefreshTable(TableView& view) {
  if (!view.spec || !ReadableRange(view.header, 32)) return false;
  const auto expected = TableSignature(*view.spec);
  std::array<std::uint8_t, 16> actual{};
  std::uint32_t head{};
  if (!ReadValue(view.header, actual) || actual != expected ||
      !ReadValue(view.header + 24, head) ||
      !ReadableRange(view.data,
                     static_cast<std::size_t>(view.spec->capacity) * view.spec->stride)) {
    return false;
  }
  view.head = head;
  return true;
}

void FindRuntimeObjects(const game_builds::BoardLayout& layout,
                        const std::vector<Region>& regions, std::uintptr_t module,
                        std::uint32_t recruit_row, std::uint32_t team_row,
                        std::vector<std::uintptr_t>& controllers,
                        std::vector<std::uintptr_t>& recruit_wrappers,
                        std::vector<std::uintptr_t>& team_wrappers) {
  const auto wrapper_vtable = module + layout.generic_record_wrapper_vtable_rva;
  const auto controller_vtable = module + layout.recruiting_controller_vtable_rva;
  const auto wrapper_bytes = QwordBytes(wrapper_vtable);
  const auto controller_bytes = QwordBytes(controller_vtable);
  for (const auto& region : regions) {
    FindBytes(region, controller_bytes, [&](std::uintptr_t address) {
      if ((address & 7) != 0) return;
      std::uint64_t membership_row{};
      std::uintptr_t descriptor{};
      std::uintptr_t board_store{};
      if (!ReadValue(address + 8, membership_row) || membership_row >= kMembershipCapacity ||
          !ReadValue(address + 16, descriptor) ||
          DescriptorTableId(descriptor) != layout.controller_descriptor_table_id ||
          !ReadValue(address + 0x138, board_store) || !ReadableRange(board_store, 8)) return;
      controllers.push_back(address);
    });
    FindBytes(region, wrapper_bytes, [&](std::uintptr_t address) {
      if ((address & 7) != 0 || !ReadableRange(address, 32)) return;
      std::uintptr_t descriptor{};
      std::uint64_t row{};
      if (!ReadValue(address + 16, descriptor) || !ReadValue(address + 24, row)) return;
      const auto table_id = DescriptorTableId(descriptor);
      if (row == recruit_row && table_id == layout.recruit_table_id)
        recruit_wrappers.push_back(address);
      if (row == team_row && table_id == layout.team_table_id)
        team_wrappers.push_back(address);
    });
  }
}

bool DiscoverRuntime(const game_builds::BoardLayout& layout,
                     const std::vector<Region>& regions, std::uintptr_t module,
                     std::uint32_t recruit_row, std::uint32_t team_row,
                     std::vector<std::uintptr_t>& controllers,
                     std::vector<std::uintptr_t>& recruit_wrappers,
                     std::vector<std::uintptr_t>& team_wrappers,
                     TableView& targets, TableView& pitches,
                     TableView& membership) {
  const auto wrapper_vtable = module + layout.generic_record_wrapper_vtable_rva;
  const auto controller_vtable = module + layout.recruiting_controller_vtable_rva;
  const auto controller_bytes = QwordBytes(controller_vtable);
  const auto wrapper_bytes = QwordBytes(wrapper_vtable);
  const auto target_signature = TableSignature(kUserTarget);
  const auto pitch_signature = TableSignature(kActivePitch);
  const auto membership_signature = TableSignature(kMembership);
  const std::array<std::span<const std::uint8_t>, 5> patterns{
      controller_bytes, wrapper_bytes, target_signature, pitch_signature,
      membership_signature};
  std::vector<TableView> target_candidates;
  std::vector<TableView> pitch_candidates;
  std::vector<TableView> membership_candidates;

  for (const auto& region : regions) {
    FindPatterns(region, patterns, [&](std::size_t pattern, std::uintptr_t address) {
      if (pattern == 0) {
        if ((address & 7) != 0 ||
            !ValidateController(layout, module, address)) return;
        controllers.push_back(address);
        return;
      }
      if (pattern == 1) {
        if ((address & 7) != 0 || !ReadableRange(address, 32)) return;
        std::uintptr_t descriptor{};
        std::uint64_t row{};
        if (!ReadValue(address + 16, descriptor) || !ReadValue(address + 24, row)) return;
        const auto table_id = DescriptorTableId(descriptor);
        if (row == recruit_row && table_id == layout.recruit_table_id)
          recruit_wrappers.push_back(address);
        if (row == team_row && table_id == layout.team_table_id)
          team_wrappers.push_back(address);
        return;
      }
      if (pattern == 2) {
        AddTableCandidate(kUserTarget, layout, address, target_candidates);
      } else if (pattern == 3) {
        AddTableCandidate(kActivePitch, layout, address, pitch_candidates);
      } else {
        AddTableCandidate(kMembership, layout, address, membership_candidates);
      }
    });
  }
  return SelectTable(target_candidates, targets) &&
      SelectTable(pitch_candidates, pitches) &&
      SelectTable(membership_candidates, membership);
}

BoardSnapshot ReadBoard(const TableView& targets, const TableView& pitches,
                        const TableView& membership,
                        const game_builds::BoardLayout& layout,
                        std::uint32_t membership_row) {
  BoardSnapshot result{.membership_row = membership_row};
  if (membership_row >= membership.spec->capacity) return result;
  const auto row_address = membership.data +
      static_cast<std::uintptr_t>(membership_row) * membership.spec->stride;
  bool saw_zero = false;
  result.compact = true;
  for (std::uint32_t slot = 0; slot < kBoardSlots; ++slot) {
    std::uint32_t reference{};
    if (!ReadValue(row_address + slot * 4, reference)) return result;
    if (!reference) {
      saw_zero = true;
      continue;
    }
    if (saw_zero) result.compact = false;
    if (ReferenceTable(reference) != layout.user_target_table_id) return result;
    const auto target_row = ReferenceRow(reference);
    if (target_row >= targets.spec->capacity) return result;
    const auto target_address = targets.data +
        static_cast<std::uintptr_t>(target_row) * targets.spec->stride;
    std::uint32_t recruit_reference{};
    std::uint32_t pitch_reference{};
    if (!ReadValue(target_address + 12, recruit_reference) ||
        !ReadValue(target_address + 16, pitch_reference) ||
        ReferenceTable(recruit_reference) != layout.recruit_table_id) return result;
    std::uint32_t pitch_row = UINT32_MAX;
    if (pitch_reference) {
      if (ReferenceTable(pitch_reference) != layout.active_pitch_table_id ||
          ReferenceRow(pitch_reference) >= pitches.spec->capacity) return result;
      pitch_row = ReferenceRow(pitch_reference);
    }
    result.items.push_back({slot, target_row, ReferenceRow(recruit_reference), pitch_row});
  }
  result.valid = result.compact;
  return result;
}

std::vector<BoardItem> Matching(const BoardSnapshot& board, std::uint32_t recruit_row) {
  std::vector<BoardItem> matches;
  for (const auto& item : board.items)
    if (item.recruit_row == recruit_row) matches.push_back(item);
  return matches;
}

Result BaseResult(Operation operation, std::uint32_t recruit_row,
                  std::uint32_t team_row) {
  return {.operation = operation, .recruit_row = recruit_row, .team_row = team_row};
}

}  // namespace

Result Invoke(const game_builds::BoardLayout& layout, Operation operation,
              std::uint32_t recruit_row, std::uint32_t team_row) {
  auto result = BaseResult(operation, recruit_row, team_row);
  if (recruit_row > kReferenceRowMask || team_row > kReferenceRowMask) {
    result.status = Status::kInvalidArgument;
    return result;
  }
  const auto module = reinterpret_cast<std::uintptr_t>(GetModuleHandleW(nullptr));
  if (!module) {
    result.status = Status::kRecruitingNotLoaded;
    return result;
  }
  std::vector<std::uintptr_t> controllers;
  std::vector<std::uintptr_t> recruit_wrappers;
  std::vector<std::uintptr_t> team_wrappers;
  TableView targets;
  TableView pitches;
  TableView membership;
  const bool cache_valid = g_runtime_cache && g_runtime_cache->module == module &&
      g_runtime_cache->recruit_row == recruit_row &&
      g_runtime_cache->team_row == team_row &&
      ValidateController(layout, module, g_runtime_cache->controller) &&
      ValidateWrapper(layout, module, g_runtime_cache->recruit_wrapper,
                      layout.recruit_table_id, recruit_row) &&
      ValidateWrapper(layout, module, g_runtime_cache->team_wrapper,
                      layout.team_table_id, team_row) &&
      RefreshTable(g_runtime_cache->targets) &&
      RefreshTable(g_runtime_cache->pitches) &&
      RefreshTable(g_runtime_cache->membership);
  if (cache_valid) {
    controllers.push_back(g_runtime_cache->controller);
    recruit_wrappers.push_back(g_runtime_cache->recruit_wrapper);
    team_wrappers.push_back(g_runtime_cache->team_wrapper);
    targets = g_runtime_cache->targets;
    pitches = g_runtime_cache->pitches;
    membership = g_runtime_cache->membership;
  } else {
    g_runtime_cache.reset();
    const auto regions = PrivateReadableRegions();
    const bool tables_found = DiscoverRuntime(
        layout, regions, module, recruit_row, team_row, controllers,
        recruit_wrappers, team_wrappers, targets, pitches, membership);
    if (controllers.empty() || recruit_wrappers.empty() || team_wrappers.empty()) {
      result.status = Status::kRecruitingNotLoaded;
      return result;
    }
    if (controllers.size() != 1 || recruit_wrappers.size() != 1 ||
        team_wrappers.size() != 1) {
      result.status = Status::kRuntimeAmbiguous;
      return result;
    }
    if (!tables_found) {
      result.status = Status::kTableDiscoveryFailed;
      return result;
    }
    g_runtime_cache = RuntimeCache{module, recruit_row, team_row, controllers[0],
        recruit_wrappers[0], team_wrappers[0], targets, pitches, membership};
  }
  std::uint64_t membership_row64{};
  if (!ReadValue(controllers[0] + 8, membership_row64) ||
      membership_row64 >= kMembershipCapacity) {
    result.status = Status::kBoardStateInvalid;
    return result;
  }
  result.membership_row = static_cast<std::uint32_t>(membership_row64);
  const auto before = ReadBoard(targets, pitches, membership, layout, result.membership_row);
  if (!before.valid) {
    result.status = Status::kBoardStateInvalid;
    return result;
  }
  const auto before_matches = Matching(before, recruit_row);
  if (before_matches.size() > 1) {
    result.status = Status::kBoardStateInvalid;
    return result;
  }
  if (operation == Operation::kAdd && !before_matches.empty()) {
    const auto item = before_matches[0];
    result.status = Status::kUnchanged;
    result.board_slot = item.slot;
    result.target_row = item.target_row;
    result.active_pitch_row = item.active_pitch_row;
    return result;
  }
  if (operation == Operation::kRemove && before_matches.empty()) {
    result.status = Status::kUnchanged;
    return result;
  }
  if (operation == Operation::kAdd && before.items.size() >= kBoardSlots) {
    result.status = Status::kBoardFull;
    return result;
  }

  const auto old_target_head = targets.head;
  const auto old_pitch_head = pitches.head;
  std::uint32_t next_target_head{};
  std::uint32_t next_pitch_head{};
  if (operation == Operation::kAdd &&
      (old_target_head >= targets.spec->capacity || old_pitch_head >= pitches.spec->capacity ||
       !ReadValue(targets.data + static_cast<std::uintptr_t>(old_target_head) *
                     targets.spec->stride, next_target_head) ||
       !ReadValue(pitches.data + static_cast<std::uintptr_t>(old_pitch_head) *
                     pitches.spec->stride, next_pitch_head))) {
    result.status = Status::kBoardStateInvalid;
    return result;
  }
  const auto removed = operation == Operation::kRemove ? before_matches[0] : BoardItem{};

  std::uint64_t team_cell = team_wrappers[0];
  std::uint64_t recruit_cell = recruit_wrappers[0];
  const std::array<std::uint64_t, 3> arguments{
      controllers[0], reinterpret_cast<std::uint64_t>(&team_cell),
      reinterpret_cast<std::uint64_t>(&recruit_cell)};
  const auto target = module +
      (operation == Operation::kAdd ? layout.full_add_rva : layout.full_remove_rva);
  const auto call = native_call::Invoke(target, arguments);
  result.call_value = call.value;
  result.fault_code = call.fault_code;
  if (call.status != native_call::Status::kOk) {
    result.status = Status::kNativeCallFailed;
    return result;
  }

  std::uint32_t new_target_head{};
  std::uint32_t new_pitch_head{};
  if (!ReadValue(targets.header + 24, new_target_head) ||
      !ReadValue(pitches.header + 24, new_pitch_head)) {
    result.status = Status::kPostconditionFailed;
    return result;
  }
  const auto after = ReadBoard(targets, pitches, membership, layout, result.membership_row);
  const auto after_matches = Matching(after, recruit_row);
  if (!after.valid) {
    result.status = Status::kPostconditionFailed;
    return result;
  }

  if (operation == Operation::kAdd) {
    if (after.items.size() != before.items.size() + 1 || after_matches.size() != 1 ||
        after_matches[0].slot != before.items.size() ||
        after_matches[0].target_row != old_target_head ||
        after_matches[0].active_pitch_row != old_pitch_head ||
        new_target_head != next_target_head || new_pitch_head != next_pitch_head) {
      result.status = Status::kPostconditionFailed;
      return result;
    }
    result.board_slot = after_matches[0].slot;
    result.target_row = after_matches[0].target_row;
    result.active_pitch_row = after_matches[0].active_pitch_row;
  } else {
    std::uint32_t cleared_recruit{};
    std::uint32_t cleared_pitch{};
    const auto freed_target = targets.data +
        static_cast<std::uintptr_t>(removed.target_row) * targets.spec->stride;
    if (after.items.size() + 1 != before.items.size() || !after_matches.empty() ||
        new_target_head != removed.target_row ||
        removed.active_pitch_row == UINT32_MAX || new_pitch_head != removed.active_pitch_row ||
        !ReadValue(freed_target + 12, cleared_recruit) || cleared_recruit != 0 ||
        !ReadValue(freed_target + 16, cleared_pitch) || cleared_pitch != 0) {
      result.status = Status::kPostconditionFailed;
      return result;
    }
    result.board_slot = removed.slot;
    result.target_row = removed.target_row;
    result.active_pitch_row = removed.active_pitch_row;
  }
  result.status = Status::kApplied;
  return result;
}

const char* StatusCode(Status status) {
  switch (status) {
    case Status::kApplied: return "APPLIED";
    case Status::kUnchanged: return "UNCHANGED";
    case Status::kInvalidArgument: return "INVALID_ARGUMENT";
    case Status::kRecruitingNotLoaded: return "RECRUITING_NOT_LOADED";
    case Status::kRuntimeAmbiguous: return "RUNTIME_DISCOVERY_AMBIGUOUS";
    case Status::kTableDiscoveryFailed: return "BOARD_TABLE_DISCOVERY_FAILED";
    case Status::kBoardStateInvalid: return "BOARD_STATE_INVALID";
    case Status::kBoardFull: return "BOARD_FULL";
    case Status::kNativeCallFailed: return "BOARD_NATIVE_CALL_FAILED";
    case Status::kPostconditionFailed: return "BOARD_POSTCONDITION_FAILED";
  }
  return "BOARD_STATE_INVALID";
}

}  // namespace cfb27::board_mutation
