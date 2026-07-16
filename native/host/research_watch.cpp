#include "research_watch.h"

#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <mutex>

namespace cfb27::research_watch {
namespace {

struct SlotState {
  std::atomic<std::uintptr_t> address{};
  std::atomic<Kind> kind{Kind::kWrite};
  std::atomic<std::size_t> length{1};
};

struct BufferedHit {
  Hit hit;
  std::atomic<bool> ready{};
};

struct SavedThread {
  DWORD thread_id{};
  DWORD64 dr0{};
  DWORD64 dr1{};
  DWORD64 dr2{};
  DWORD64 dr3{};
  DWORD64 dr6{};
  DWORD64 dr7{};
};

std::array<SlotState, kMaxSlots> g_slots;
std::array<BufferedHit, kMaxHits> g_hits;
std::atomic<std::uint64_t> g_hit_count{};
std::atomic<std::uint64_t> g_dropped{};
std::mutex g_mutex;
std::vector<SavedThread> g_saved_threads;
PVOID g_handler{};

bool IsExecutable(std::uintptr_t address) {
  MEMORY_BASIC_INFORMATION info{};
  if (!address || VirtualQuery(reinterpret_cast<const void*>(address), &info,
                               sizeof(info)) != sizeof(info) ||
      info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) {
    return false;
  }
  constexpr DWORD executable = PAGE_EXECUTE | PAGE_EXECUTE_READ |
                               PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  return (info.Protect & executable) != 0;
}

bool IsWritable(std::uintptr_t address, std::size_t length) {
  if (!address || !length || address > UINTPTR_MAX - length) return false;
  MEMORY_BASIC_INFORMATION info{};
  if (VirtualQuery(reinterpret_cast<const void*>(address), &info, sizeof(info)) !=
          sizeof(info) ||
      info.State != MEM_COMMIT || (info.Protect & (PAGE_GUARD | PAGE_NOACCESS))) {
    return false;
  }
  constexpr DWORD writable = PAGE_READWRITE | PAGE_WRITECOPY |
                             PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
  const auto region_end = reinterpret_cast<std::uintptr_t>(info.BaseAddress) +
                          static_cast<std::uintptr_t>(info.RegionSize);
  return address + length <= region_end && (info.Protect & writable) != 0;
}

DWORD64 LengthEncoding(std::size_t length) {
  switch (length) {
    case 1: return 0;
    case 2: return 1;
    case 4: return 3;
    case 8: return 2;
    default: return 0;
  }
}

void SetDebugAddress(CONTEXT& context, std::size_t slot, DWORD64 address) {
  switch (slot) {
    case 0: context.Dr0 = address; break;
    case 1: context.Dr1 = address; break;
    case 2: context.Dr2 = address; break;
    case 3: context.Dr3 = address; break;
    default: break;
  }
}

void ApplySlots(CONTEXT& context, const SavedThread& original) {
  context.Dr0 = original.dr0;
  context.Dr1 = original.dr1;
  context.Dr2 = original.dr2;
  context.Dr3 = original.dr3;
  context.Dr6 = 0;
  context.Dr7 = original.dr7;
  for (std::size_t slot = 0; slot < kMaxSlots; ++slot) {
    const auto enable_shift = slot * 2;
    const auto control_shift = 16 + slot * 4;
    context.Dr7 &= ~(static_cast<DWORD64>(3) << enable_shift);
    context.Dr7 &= ~(static_cast<DWORD64>(0xF) << control_shift);
    const auto address = g_slots[slot].address.load(std::memory_order_acquire);
    if (!address) continue;
    SetDebugAddress(context, slot, static_cast<DWORD64>(address));
    context.Dr7 |= static_cast<DWORD64>(1) << enable_shift;
    if (g_slots[slot].kind.load(std::memory_order_relaxed) == Kind::kWrite) {
      const auto control = static_cast<DWORD64>(1) |
          (LengthEncoding(g_slots[slot].length.load(std::memory_order_relaxed)) << 2);
      context.Dr7 |= control << control_shift;
    }
  }
}

SavedThread* FindSavedThread(DWORD thread_id) {
  const auto found = std::find_if(
      g_saved_threads.begin(), g_saved_threads.end(),
      [thread_id](const SavedThread& saved) { return saved.thread_id == thread_id; });
  return found == g_saved_threads.end() ? nullptr : &*found;
}

bool ConfigureThread(DWORD thread_id) {
  if (thread_id == GetCurrentThreadId()) return false;
  HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                 THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION,
                             FALSE, thread_id);
  if (!thread) return false;
  if (SuspendThread(thread) == static_cast<DWORD>(-1)) {
    CloseHandle(thread);
    return false;
  }

  CONTEXT context{};
  context.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  bool configured = false;
  if (GetThreadContext(thread, &context)) {
    auto* saved = FindSavedThread(thread_id);
    if (!saved && (context.Dr7 & 0xFF) == 0) {
      g_saved_threads.push_back({thread_id, context.Dr0, context.Dr1, context.Dr2,
                                 context.Dr3, context.Dr6, context.Dr7});
      saved = &g_saved_threads.back();
    }
    if (saved) {
      ApplySlots(context, *saved);
      configured = SetThreadContext(thread, &context) != FALSE;
    }
  }
  ResumeThread(thread);
  CloseHandle(thread);
  return configured;
}

std::size_t ConfigureAllThreads() {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  THREADENTRY32 entry{sizeof(entry)};
  std::size_t configured = 0;
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == GetCurrentProcessId() &&
          ConfigureThread(entry.th32ThreadID)) {
        ++configured;
      }
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return configured;
}

bool RestoreThread(const SavedThread& saved) {
  if (saved.thread_id == GetCurrentThreadId()) return false;
  HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                 THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION,
                             FALSE, saved.thread_id);
  if (!thread) return false;
  if (SuspendThread(thread) == static_cast<DWORD>(-1)) {
    CloseHandle(thread);
    return false;
  }
  CONTEXT context{};
  context.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  bool restored = false;
  if (GetThreadContext(thread, &context)) {
    context.Dr0 = saved.dr0;
    context.Dr1 = saved.dr1;
    context.Dr2 = saved.dr2;
    context.Dr3 = saved.dr3;
    context.Dr6 = saved.dr6;
    context.Dr7 = saved.dr7;
    restored = SetThreadContext(thread, &context) != FALSE;
  }
  ResumeThread(thread);
  CloseHandle(thread);
  return restored;
}

void ClearHits() {
  g_hit_count.store(0, std::memory_order_release);
  g_dropped.store(0, std::memory_order_release);
  for (auto& buffered : g_hits) buffered.ready.store(false, std::memory_order_release);
}

void CapturePointer(std::uint64_t address, PointerSnapshot& snapshot) {
  if (!address) return;
  for (std::size_t index = 0; index < kPointerWords; ++index) {
#if defined(_MSC_VER)
    __try {
      snapshot.words[index] =
          *(reinterpret_cast<const std::uint64_t*>(address) + index);
      snapshot.count = index + 1;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
      break;
    }
#else
    snapshot.words[index] =
        *(reinterpret_cast<const std::uint64_t*>(address) + index);
    snapshot.count = index + 1;
#endif
  }
}

LONG CALLBACK HandleException(EXCEPTION_POINTERS* pointers) {
  if (!pointers || !pointers->ExceptionRecord || !pointers->ContextRecord ||
      pointers->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP) {
    return EXCEPTION_CONTINUE_SEARCH;
  }
  auto& context = *pointers->ContextRecord;
  const DWORD64 fired = context.Dr6 & 0xF;
  bool ours = false;
  for (std::size_t slot = 0; slot < kMaxSlots; ++slot) {
    if ((fired & (static_cast<DWORD64>(1) << slot)) == 0 ||
        g_slots[slot].address.load(std::memory_order_acquire) == 0) {
      continue;
    }
    ours = true;
    const auto ordinal = g_hit_count.fetch_add(1, std::memory_order_acq_rel);
    if (ordinal >= kMaxHits) {
      g_dropped.fetch_add(1, std::memory_order_relaxed);
      continue;
    }
    auto& buffered = g_hits[static_cast<std::size_t>(ordinal)];
    auto& hit = buffered.hit;
    hit = {};
    hit.slot = slot;
    hit.thread_id = GetCurrentThreadId();
    hit.rip = static_cast<std::uintptr_t>(context.Rip);
    hit.rsp = static_cast<std::uintptr_t>(context.Rsp);
    hit.rax = context.Rax;
    hit.rbx = context.Rbx;
    hit.rbp = context.Rbp;
    hit.rsi = context.Rsi;
    hit.rdi = context.Rdi;
    hit.rcx = context.Rcx;
    hit.rdx = context.Rdx;
    hit.r8 = context.R8;
    hit.r9 = context.R9;
    hit.r10 = context.R10;
    hit.r11 = context.R11;
    CapturePointer(hit.rbx, hit.rbx_memory);
    CapturePointer(hit.rsi, hit.rsi_memory);
    CapturePointer(hit.rdi, hit.rdi_memory);
    CapturePointer(hit.rcx, hit.rcx_memory);
    CapturePointer(hit.rdx, hit.rdx_memory);
    CapturePointer(hit.r8, hit.r8_memory);
    CapturePointer(hit.r9, hit.r9_memory);
    for (std::size_t index = 0; index < kStackWords; ++index) {
#if defined(_MSC_VER)
      __try {
        hit.stack[index] = *(reinterpret_cast<const std::uint64_t*>(context.Rsp) + index);
        hit.stack_count = index + 1;
      } __except (EXCEPTION_EXECUTE_HANDLER) {
        break;
      }
#else
      hit.stack[index] = *(reinterpret_cast<const std::uint64_t*>(context.Rsp) + index);
      hit.stack_count = index + 1;
#endif
    }
    buffered.ready.store(true, std::memory_order_release);
  }
  if (!ours) return EXCEPTION_CONTINUE_SEARCH;
  context.Dr6 = 0;
  context.EFlags |= 1u << 16;
  return EXCEPTION_CONTINUE_EXECUTION;
}

bool AnySlotActive() {
  return std::any_of(g_slots.begin(), g_slots.end(), [](const SlotState& slot) {
    return slot.address.load(std::memory_order_acquire) != 0;
  });
}

}  // namespace

ArmResult Arm(Kind kind, std::uintptr_t address, std::size_t length) {
  if ((kind == Kind::kExecute && !IsExecutable(address)) ||
      (kind == Kind::kWrite &&
       ((length != 1 && length != 2 && length != 4 && length != 8) ||
        address % length != 0 || !IsWritable(address, length)))) {
    return {.status = ArmStatus::kInvalidAddress};
  }

  std::lock_guard lock(g_mutex);
  std::size_t slot = kMaxSlots;
  for (std::size_t index = 0; index < kMaxSlots; ++index) {
    if (g_slots[index].address.load(std::memory_order_acquire) == 0) {
      slot = index;
      break;
    }
  }
  if (slot == kMaxSlots) return {.status = ArmStatus::kNoSlot};

  if (!g_handler) {
    g_handler = AddVectoredExceptionHandler(1, HandleException);
    if (!g_handler) return {.status = ArmStatus::kHandlerFailed};
    ClearHits();
  }
  g_slots[slot].kind.store(kind, std::memory_order_relaxed);
  g_slots[slot].length.store(kind == Kind::kExecute ? 1 : length,
                             std::memory_order_relaxed);
  g_slots[slot].address.store(address, std::memory_order_release);

  const auto thread_count = ConfigureAllThreads();
  if (!thread_count) {
    g_slots[slot].address.store(0, std::memory_order_release);
    if (!AnySlotActive()) {
      RemoveVectoredExceptionHandler(g_handler);
      g_handler = nullptr;
      g_saved_threads.clear();
    }
    return {.status = ArmStatus::kNoThreads};
  }
  return {.status = ArmStatus::kOk, .slot = slot, .thread_count = thread_count};
}

Snapshot Collect(bool clear) {
  Snapshot snapshot;
  const auto count = (std::min)(g_hit_count.load(std::memory_order_acquire),
                                static_cast<std::uint64_t>(kMaxHits));
  snapshot.hits.reserve(static_cast<std::size_t>(count));
  for (std::size_t index = 0; index < static_cast<std::size_t>(count); ++index) {
    if (g_hits[index].ready.load(std::memory_order_acquire)) {
      snapshot.hits.push_back(g_hits[index].hit);
    }
  }
  snapshot.dropped = g_dropped.load(std::memory_order_acquire);
  if (clear) ClearHits();
  return snapshot;
}

std::size_t Disarm() {
  std::lock_guard lock(g_mutex);
  if (!g_handler && !AnySlotActive()) return 0;
  std::size_t restored = 0;
  for (const auto& saved : g_saved_threads) {
    if (RestoreThread(saved)) ++restored;
  }
  for (auto& slot : g_slots) slot.address.store(0, std::memory_order_release);
  if (g_handler) {
    RemoveVectoredExceptionHandler(g_handler);
    g_handler = nullptr;
  }
  g_saved_threads.clear();
  return restored;
}

const char* ArmStatusCode(ArmStatus status) {
  switch (status) {
    case ArmStatus::kOk: return "ok";
    case ArmStatus::kInvalidAddress: return "invalid_address";
    case ArmStatus::kNoSlot: return "no_slot";
    case ArmStatus::kNoThreads: return "no_threads";
    case ArmStatus::kHandlerFailed: return "handler_failed";
  }
  return "unknown";
}

}  // namespace cfb27::research_watch
