#include "../host/memory_transaction.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using cfb27::memory::MemoryBackend;
using cfb27::memory::RunTransaction;
using cfb27::memory::TransactionOperation;
using cfb27::memory::TransactionRequest;
using Status = cfb27::memory::TransactionStatus;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class FakeMemoryBackend final : public MemoryBackend {
 public:
  FakeMemoryBackend() {
    for (std::size_t index = 0; index < original.size(); ++index) {
      original[index] = static_cast<std::uint8_t>(index);
    }
    Reset();
  }

  void Reset() {
    bytes = original;
    write_calls = 0;
    read_calls = 0;
    fail_write_index = -1;
    fail_verification_read = false;
    fail_restore = false;
    fail_restore_read = false;
    rollback_started = false;
    write_addresses.clear();
  }

  bool Validate(std::uintptr_t address, std::size_t size, bool) override {
    return address <= bytes.size() && size <= bytes.size() - address;
  }

  bool Read(std::uintptr_t address, std::span<std::uint8_t> output) override {
    ++read_calls;
    if (fail_verification_read && write_calls > 0 && !rollback_started) {
      fail_verification_read = false;
      rollback_started = true;
      return false;
    }
    if (fail_restore_read && rollback_started) return false;
    if (!Validate(address, output.size(), false)) return false;
    std::copy_n(bytes.begin() + address, output.size(), output.begin());
    return true;
  }

  bool Write(std::uintptr_t address,
             std::span<const std::uint8_t> input) override {
    const int call_index = write_calls++;
    write_addresses.push_back(address);
    if (!rollback_started && call_index == fail_write_index) {
      rollback_started = true;
      return false;
    }
    if (rollback_started && fail_restore) return false;
    if (!Validate(address, input.size(), true)) return false;
    std::copy(input.begin(), input.end(), bytes.begin() + address);
    return true;
  }

  std::array<std::uint8_t, 256> original{};
  std::array<std::uint8_t, 256> bytes{};
  int write_calls{};
  int read_calls{};
  int fail_write_index{-1};
  bool fail_verification_read{};
  bool fail_restore{};
  bool fail_restore_read{};
  bool rollback_started{};
  std::vector<std::uintptr_t> write_addresses;
};

TransactionRequest ValidRequest(const FakeMemoryBackend& backend) {
  return {
      .transaction_id = "smoke.valid-1",
      .operations = {
          {.address = "0x10",
           .expected = {backend.original[0x10], backend.original[0x11]},
           .replacement = {0xA1, 0xA2}},
          {.address = "0x20",
           .expected = {backend.original[0x20], backend.original[0x21],
                        backend.original[0x22]},
           .replacement = {0xB1, 0xB2, 0xB3}},
      },
  };
}

void RequireRejectedWithoutWrites(const TransactionRequest& request,
                                  const char* message) {
  FakeMemoryBackend backend;
  const auto result = RunTransaction(request, backend);
  Require(result.status == Status::kRejected && backend.write_calls == 0,
          message);
}

void TestApplyAndPreflight() {
  FakeMemoryBackend backend;
  const auto valid = ValidRequest(backend);
  auto expected_after = backend.original;
  expected_after[0x10] = 0xA1;
  expected_after[0x11] = 0xA2;
  expected_after[0x20] = 0xB1;
  expected_after[0x21] = 0xB2;
  expected_after[0x22] = 0xB3;

  Require(RunTransaction(valid, backend).status == Status::kAppliedVerified,
          "happy path");
  Require(backend.bytes == expected_after, "replacement present");

  backend.Reset();
  backend.bytes[0x10] ^= 1;
  const auto mismatch = RunTransaction(valid, backend);
  Require(mismatch.status == Status::kRejected && backend.write_calls == 0,
          "preflight mismatch writes nothing");
}

void TestRollbackOutcomes() {
  FakeMemoryBackend backend;
  const auto valid = ValidRequest(backend);

  backend.Reset();
  backend.fail_write_index = 1;
  const auto rolled_back = RunTransaction(valid, backend);
  Require(rolled_back.status == Status::kRolledBackVerified,
          "failed apply rolls back");
  Require(backend.bytes == backend.original, "all originals restored");
  Require(backend.write_addresses ==
              std::vector<std::uintptr_t>({0x10, 0x20, 0x20, 0x10}),
          "attempted writes restore in reverse order");

  backend.Reset();
  backend.fail_write_index = 1;
  backend.fail_restore = true;
  Require(RunTransaction(valid, backend).status == Status::kRollbackUnverified,
          "rollback failure is explicit");

  backend.Reset();
  backend.fail_verification_read = true;
  Require(RunTransaction(valid, backend).status == Status::kRolledBackVerified,
          "verification read failure rolls back");
  Require(backend.bytes == backend.original,
          "verification read failure restores originals");

  backend.Reset();
  backend.fail_write_index = 1;
  backend.fail_restore_read = true;
  Require(RunTransaction(valid, backend).status == Status::kRollbackUnverified,
          "restore read failure is explicit");
}

void TestRequestValidation() {
  FakeMemoryBackend backend;
  const auto valid = ValidRequest(backend);

  auto request = valid;
  request.operations.clear();
  RequireRejectedWithoutWrites(request, "empty operations rejected");

  request = valid;
  request.operations.assign(33, valid.operations.front());
  RequireRejectedWithoutWrites(request, "33 operations rejected");

  request = valid;
  request.operations = {{.address = "0x0",
                         .expected = std::vector<std::uint8_t>(4097, 1),
                         .replacement = std::vector<std::uint8_t>(4097, 2)}};
  RequireRejectedWithoutWrites(request, "4097-byte operation rejected");

  request = valid;
  request.operations.clear();
  for (std::size_t index = 0; index < 17; ++index) {
    request.operations.push_back(
        {.address = "0x0",
         .expected = std::vector<std::uint8_t>(4096, 1),
         .replacement = std::vector<std::uint8_t>(4096, 2)});
  }
  RequireRejectedWithoutWrites(request, "aggregate above 64 KiB rejected");

  request = valid;
  request.operations[0].replacement.push_back(0xFF);
  RequireRejectedWithoutWrites(request, "unequal lengths rejected");

  request = valid;
  request.operations = {{
      .address = "0xFFFFFFFFFFFFFFFF",
      .expected = {1, 2},
      .replacement = {3, 4},
  }};
  RequireRejectedWithoutWrites(request, "overflowed range rejected");

  for (const auto& noncanonical_address :
       std::vector<std::string>{"0x1a", "0X10", "0x010"}) {
    request = valid;
    request.operations[0].address = noncanonical_address;
    RequireRejectedWithoutWrites(request, "noncanonical address rejected");
  }

  request = valid;
  request.operations.push_back(valid.operations.front());
  RequireRejectedWithoutWrites(request, "duplicate range rejected");

  request = valid;
  request.operations[1].address = "0x11";
  RequireRejectedWithoutWrites(request, "ascending overlap rejected");

  request = valid;
  std::swap(request.operations[0], request.operations[1]);
  request.operations[1].address = "0x21";
  RequireRejectedWithoutWrites(request, "descending overlap rejected");

  for (const auto& invalid_id :
       std::vector<std::string>{"", std::string(65, 'a'), "invalid/id"}) {
    request = valid;
    request.transaction_id = invalid_id;
    RequireRejectedWithoutWrites(request, "invalid transaction ID rejected");
  }
}

void TestNonOverlappingRequestOrderIsPreserved() {
  FakeMemoryBackend backend;
  auto request = ValidRequest(backend);
  std::swap(request.operations[0], request.operations[1]);
  const auto result = RunTransaction(request, backend);
  Require(result.status == Status::kAppliedVerified,
          "descending non-overlapping operations accepted");
  Require(backend.write_addresses ==
              std::vector<std::uintptr_t>({0x20, 0x10}),
          "caller operation order preserved");
}

}  // namespace

int main() {
  try {
    TestApplyAndPreflight();
    TestRollbackOutcomes();
    TestRequestValidation();
    TestNonOverlappingRequestOrderIsPreserved();
    std::cout << "memory transaction smoke passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "memory transaction smoke failed: " << error.what() << '\n';
    return 1;
  }
}
