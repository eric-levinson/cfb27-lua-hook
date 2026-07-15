#include "../host/research_watch.h"

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <iostream>
#include <thread>

namespace {

alignas(8) volatile std::uint64_t g_watched{};

__declspec(noinline) std::uint64_t ExecTarget(std::uint64_t value) {
  return value + 1;
}

void Require(bool condition, const char* message) {
  if (!condition) throw message;
}

template <typename Action>
std::uint32_t RunWorkerAfterArm(cfb27::research_watch::Kind kind,
                                std::uintptr_t address, std::size_t length,
                                Action action) {
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE start = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Require(ready && start && done, "event allocation failed");
  std::atomic<std::uint32_t> worker_id{};
  std::thread worker([&] {
    worker_id.store(GetCurrentThreadId(), std::memory_order_release);
    SetEvent(ready);
    WaitForSingleObject(start, INFINITE);
    action();
    SetEvent(done);
  });
  Require(WaitForSingleObject(ready, 5000) == WAIT_OBJECT_0, "worker did not start");
  const auto armed = cfb27::research_watch::Arm(kind, address, length);
  Require(armed.status == cfb27::research_watch::ArmStatus::kOk,
          "watch did not arm");
  SetEvent(start);
  Require(WaitForSingleObject(done, 5000) == WAIT_OBJECT_0, "worker did not finish");
  worker.join();
  CloseHandle(ready);
  CloseHandle(start);
  CloseHandle(done);
  return worker_id.load(std::memory_order_acquire);
}

}  // namespace

int main() {
  try {
    const auto write_thread = RunWorkerAfterArm(
        cfb27::research_watch::Kind::kWrite,
        reinterpret_cast<std::uintptr_t>(&g_watched), sizeof(g_watched),
        [] { g_watched = 0xCFB27; });
    const auto write_hits = cfb27::research_watch::Collect(false);
    Require(!write_hits.hits.empty(), "write watch captured no hits");
    Require(write_hits.hits.front().thread_id == write_thread,
            "write watch captured the wrong thread");
    Require(write_hits.hits.front().rip != 0 &&
                write_hits.hits.front().stack_count != 0,
            "write watch omitted instruction or stack state");
    cfb27::research_watch::Disarm();
    cfb27::research_watch::Collect(true);

    volatile std::uint64_t result{};
    const auto exec_thread = RunWorkerAfterArm(
        cfb27::research_watch::Kind::kExecute,
        reinterpret_cast<std::uintptr_t>(&ExecTarget), 1,
        [&] {
          auto* volatile target = &ExecTarget;
          result = target(41);
        });
    const auto exec_hits = cfb27::research_watch::Collect(false);
    Require(result == 42, "execute target did not complete");
    Require(!exec_hits.hits.empty(), "execute watch captured no hits");
    Require(exec_hits.hits.front().thread_id == exec_thread,
            "execute watch captured the wrong thread");
    Require(exec_hits.hits.front().rip ==
                reinterpret_cast<std::uintptr_t>(&ExecTarget),
            "execute watch captured the wrong instruction");
    cfb27::research_watch::Disarm();

    std::cout << "research watch smoke passed\n";
    return 0;
  } catch (const char* error) {
    cfb27::research_watch::Disarm();
    std::cerr << "research watch smoke failed: " << error << '\n';
    return 1;
  }
}
