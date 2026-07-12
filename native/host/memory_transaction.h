#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace cfb27::memory {

constexpr std::size_t kMaxTransactionOperations = 32;
constexpr std::size_t kMaxOperationBytes = 4096;
constexpr std::size_t kMaxTransactionBytes = 64ull * 1024;

struct TransactionOperation {
  std::string address;
  std::vector<std::uint8_t> expected;
  std::vector<std::uint8_t> replacement;
};

struct TransactionRequest {
  std::string transaction_id;
  std::vector<TransactionOperation> operations;
};

enum class TransactionStatus {
  kRejected,
  kAppliedVerified,
  kRolledBackVerified,
  kRollbackUnverified,
};

struct OperationResult {
  std::size_t index{};
  bool applied{};
  bool verified{};
};

struct TransactionResult {
  TransactionStatus status{};
  std::string code;
  std::vector<OperationResult> operations;
};

class MemoryBackend {
 public:
  virtual ~MemoryBackend() = default;
  virtual bool Validate(std::uintptr_t address, std::size_t size,
                        bool writable) = 0;
  virtual bool Read(std::uintptr_t address,
                    std::span<std::uint8_t> output) = 0;
  virtual bool Write(std::uintptr_t address,
                     std::span<const std::uint8_t> input) = 0;
};

class ProcessMemoryBackend final : public MemoryBackend {
 public:
  bool Validate(std::uintptr_t address, std::size_t size,
                bool writable) override;
  bool Read(std::uintptr_t address,
            std::span<std::uint8_t> output) override;
  bool Write(std::uintptr_t address,
             std::span<const std::uint8_t> input) override;
};

TransactionResult RunTransaction(const TransactionRequest& request,
                                 MemoryBackend& backend);

}  // namespace cfb27::memory
