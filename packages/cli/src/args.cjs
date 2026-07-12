'use strict';

function usageError(message) {
  const error = new Error(message);
  error.code = 'USAGE';
  return error;
}

const CANONICAL_ADDRESS = /^0x(?:0|[1-9A-F][0-9A-F]{0,15})$/;

function parseInteger(value, option, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw usageError(`${option} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseRange(value) {
  const separator = value.lastIndexOf(':');
  const address = value.slice(0, separator);
  const lengthText = value.slice(separator + 1);
  if (separator < 0 || !CANONICAL_ADDRESS.test(address)) {
    throw usageError('--range must use a canonical address followed by :length');
  }
  return { address, length: parseInteger(lengthText, '--range length', 1, 65536) };
}

function parseArgs(argv) {
  let command;
  let json = false;
  let help = false;
  let literal = false;
  const positionals = [];
  const options = {
    gameDir: undefined,
    mmcDir: undefined,
    artifactsDir: undefined,
    follow: false,
    after: undefined,
    pattern: undefined,
    mask: undefined,
    maxMatches: undefined,
    maxPages: undefined,
    context: undefined,
    ranges: [],
    allowUnsupportedBuild: false,
    includeAllocationMetadata: false,
    allowExternalFile: false,
  };
  const seen = new Set();
  const values = new Map([
    ['--game-dir', 'gameDir'],
    ['--mmc-dir', 'mmcDir'],
    ['--artifacts-dir', 'artifactsDir'],
    ['--after', 'after'],
    ['--pattern', 'pattern'],
    ['--mask', 'mask'],
    ['--max-matches', 'maxMatches'],
    ['--max-pages', 'maxPages'],
    ['--context', 'context'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (literal) {
      if (!command) command = token;
      else positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--json' || token === '--follow' || token === '--allow-unsupported-build' ||
        token === '--include-allocation-metadata' ||
        token === '--allow-external-file') {
      if (seen.has(token)) throw usageError(`Duplicate option: ${token}`);
      seen.add(token);
      if (token === '--json') json = true;
      else if (token === '--follow') options.follow = true;
      else if (token === '--allow-unsupported-build') options.allowUnsupportedBuild = true;
      else if (token === '--include-allocation-metadata') {
        options.includeAllocationMetadata = true;
      }
      else options.allowExternalFile = true;
      continue;
    }
    if (token === '--range') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw usageError('Missing value for --range');
      }
      options.ranges.push(parseRange(value));
      index += 1;
      continue;
    }
    if (values.has(token)) {
      if (seen.has(token)) throw usageError(`Duplicate option: ${token}`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw usageError(`Missing value for ${token}`);
      }
      seen.add(token);
      options[values.get(token)] = value;
      index += 1;
      continue;
    }
    if (token === '-') {
      if (command === 'memory' && positionals.length === 1 && positionals[0] === 'transact') {
        positionals.push(token);
        continue;
      }
      throw usageError('Unknown option: -');
    }
    if (token.startsWith('-')) throw usageError(`Unknown option: ${token}`);
    if (!command) command = token;
    else positionals.push(token);
  }

  if (options.after !== undefined) {
    options.after = parseInteger(options.after, '--after', 0, Number.MAX_SAFE_INTEGER);
  }
  if (options.maxMatches !== undefined) {
    options.maxMatches = parseInteger(options.maxMatches, '--max-matches', 1, 64);
  }
  if (options.maxPages !== undefined) {
    options.maxPages = parseInteger(options.maxPages, '--max-pages', 1, 4096);
  }
  if (options.context !== undefined) {
    options.context = parseInteger(options.context, '--context', 0, 256);
  }
  if (help) command = 'help';
  return { command, json, positionals, options };
}

module.exports = { parseArgs, usageError };
