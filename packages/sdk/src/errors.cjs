'use strict';

const ERROR_CODES = Object.freeze([
  'GAME_NOT_RUNNING',
  'GAME_PATH_MISMATCH',
  'HOST_NOT_INSTALLED',
  'HOST_NOT_READY',
  'UNSUPPORTED_BUILD',
  'ANTICHEAT_RUNNING',
  'PROTOCOL_MISMATCH',
  'PIPE_TIMEOUT',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'SCRIPT_ERROR',
  'MEMORY_ACCESS_DENIED',
  'MEMORY_MISMATCH',
  'TRANSACTION_LIMIT_EXCEEDED',
  'TRANSACTION_APPLY_FAILED',
  'ROLLBACK_VERIFICATION_FAILED',
  'SESSION_WRITES_DISABLED',
  'SCAN_LIMIT_EXCEEDED',
  'TOO_MANY_MATCHES',
  'INSTALLATION_CONFLICT',
  'BACKUP_VERIFICATION_FAILED',
]);

class Cfb27HookError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'Cfb27HookError';
    this.code = code;
    this.details = details;
  }
}

module.exports = { ERROR_CODES, Cfb27HookError };
