'use strict';

function printSuccess(io, command, result, json) {
  if (json) {
    io.out(JSON.stringify({ ok: true, command, result }));
    return;
  }
  io.out(`${command}: ${JSON.stringify(result, null, 2)}`);
}

function printError(io, error, json, { includeDetails = true } = {}) {
  const normalized = {
    code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: typeof error?.message === 'string' ? error.message : 'Unknown error',
  };
  if (includeDetails && error?.details !== undefined) normalized.details = error.details;
  if (json) {
    io.out(JSON.stringify({ ok: false, error: normalized }));
    return;
  }
  io.err(`${normalized.code}: ${normalized.message}`);
}

module.exports = { printSuccess, printError };
