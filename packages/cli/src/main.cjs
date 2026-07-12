'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs, usageError } = require('./args.cjs');
const { printSuccess, printError } = require('./output.cjs');

const TRANSACTION_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Transaction request was rejected',
  UNSUPPORTED_BUILD: 'Memory writes require the supported game build',
  MEMORY_ACCESS_DENIED: 'Transaction memory is not available for writing',
  MEMORY_MISMATCH: 'Live memory does not match the transaction preflight',
  TRANSACTION_LIMIT_EXCEEDED: 'Transaction exceeds an operation or byte limit',
  TRANSACTION_APPLY_FAILED: 'Transaction failed and was rolled back',
  ROLLBACK_VERIFICATION_FAILED: 'Transaction rollback could not be verified',
  SESSION_WRITES_DISABLED: 'Writes are disabled for this host session',
  HOST_NOT_READY: 'Could not connect to the Lua host',
  PIPE_TIMEOUT: 'Lua host transaction request timed out',
  PROTOCOL_MISMATCH: 'Host protocol version does not match',
  INVALID_RESPONSE: 'Host returned an invalid writeTransaction response',
});

const HELP = `cfb27lua <command> [options]

Commands:
  install      Install the proxy and Lua host after closing the game
  uninstall    Restore both preserved MMC proxies
  status       Read live host status
  run <file>   Run a Lua script file
  eval <lua>   Evaluate Lua source
  doctor       Run read-only diagnostics
  logs          Read recent host logs
  events        Read host events after a cursor
  memory scan   Scan bounded private readable memory (diagnostic)
  memory read   Read bounded canonical address ranges (diagnostic)
  memory transact <file.json>
                Apply one guarded transaction from a JSON request file
  telemetry register <type...>
                Register structured telemetry type names

Options:
  --game-dir <path>       College Football 27 directory
  --mmc-dir <path>        Madden Modding Community manager directory
  --artifacts-dir <path>  Built hook DLL directory
  --json                  Emit one JSON object
  --follow                Follow new log events as JSONL with --json
  --after <cursor>        Start event reads after this cursor
  --pattern <hex>         Uppercase scan pattern bytes
  --mask <hex>            Uppercase scan mask bytes
  --max-matches <count>   Maximum scan matches (1-64)
  --max-pages <count>     Maximum scan pages (1-4096; default 4096)
  --context <bytes>       Context bytes on each side (0-256)
  --range <address:length> Canonical read range; may be repeated
  --allow-unsupported-build
                          Explicitly allow unsupported-build diagnostics
  --include-allocation-metadata
                          Include session-only allocation topology in scan matches
  --allow-external-file   Allow a transaction JSON file outside the current directory
  -h, --help              Show this help`;

const defaultIo = {
  env: process.env,
  out: (value) => process.stdout.write(`${value}\n`),
  err: (value) => process.stderr.write(`${value}\n`),
};

function exitCodeFor(error) {
  if (error?.code === 'USAGE' || error?.code === 'INVALID_REQUEST') return 2;
  if (['GAME_NOT_RUNNING', 'GAME_PATH_MISMATCH', 'HOST_NOT_INSTALLED', 'HOST_NOT_READY',
    'UNSUPPORTED_BUILD', 'ANTICHEAT_RUNNING', 'PIPE_TIMEOUT'].includes(error?.code)) return 20;
  if (['PROTOCOL_MISMATCH', 'INVALID_RESPONSE', 'SCRIPT_ERROR'].includes(error?.code)) return 30;
  if (['INSTALLATION_CONFLICT', 'BACKUP_VERIFICATION_FAILED'].includes(error?.code)) return 40;
  return 70;
}

function requireDirectory(value, label) {
  if (!value) throw usageError(`${label} is required`);
  return value;
}

function requireMemoryScanOptions(options) {
  if (!options.pattern) throw usageError('--pattern is required for memory scan');
  if (!options.mask) throw usageError('--mask is required for memory scan');
  if (options.maxMatches === undefined) throw usageError('--max-matches is required for memory scan');
  if (options.context === undefined) throw usageError('--context is required for memory scan');
  return {
    patternHex: options.pattern,
    maskHex: options.mask,
    maxMatches: options.maxMatches,
    contextBefore: options.context,
    contextAfter: options.context,
    maxPages: options.maxPages || 4096,
    ...(options.allowUnsupportedBuild ? { allowUnsupportedBuild: true } : {}),
    ...(options.includeAllocationMetadata ? { includeAllocationMetadata: true } : {}),
  };
}

function rejectMisplacedDeveloperOptions(command, positionals, options) {
  const operation = command === 'memory' ? positionals[0] : undefined;
  const scanOptions = [
    options.pattern, options.mask, options.maxMatches, options.maxPages, options.context,
    options.includeAllocationMetadata || undefined,
  ];
  if (command !== 'memory' && (scanOptions.some((value) => value !== undefined) ||
      options.ranges.length || options.allowUnsupportedBuild)) {
    throw usageError('Memory diagnostic options are only valid for memory diagnostics; they are not valid for this command');
  }
  if (operation === 'scan' && options.ranges.length) {
    throw usageError('--range is not valid for memory scan');
  }
  if (operation === 'read' && scanOptions.some((value) => value !== undefined)) {
    throw usageError('Scan options are not valid for memory read');
  }
  if (operation === 'transact') {
    const hasUnrelatedOption = Object.entries(options).some(([key, value]) => {
      if (key === 'allowExternalFile') return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'boolean') return value;
      return value !== undefined;
    });
    if (hasUnrelatedOption) {
      throw usageError('This option is not valid for memory transact');
    }
  }
  if (operation !== 'transact' && options.allowExternalFile) {
    throw usageError('--allow-external-file is only valid for memory transact');
  }
}

async function readTransactionRequest(file, { fileSystem, cwd, allowExternalFile }) {
  if (file === '-') throw usageError('memory transact requires a JSON file and refuses stdin');
  if (path.extname(file).toLowerCase() !== '.json') {
    throw usageError('memory transact requires a .json file');
  }
  let resolvedCwd;
  try {
    resolvedCwd = await fileSystem.realpath(path.resolve(cwd));
  } catch (error) {
    throw usageError(`Could not resolve current working directory: ${error.message}`);
  }
  let resolved;
  try {
    resolved = await fileSystem.realpath(path.resolve(cwd, file));
  } catch (error) {
    throw usageError(`Could not resolve transaction JSON file: ${error.message}`);
  }
  const relative = path.relative(resolvedCwd, resolved);
  if (!allowExternalFile && (relative === '..' || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative))) {
    throw usageError('Transaction file is outside the current working directory; pass --allow-external-file to allow it');
  }
  let source;
  try {
    source = await fileSystem.readFile(resolved, 'utf8');
  } catch (error) {
    throw usageError(`Could not read transaction JSON file: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw usageError('Transaction file must contain valid JSON');
  }
}

function memoryHumanLines(command, result) {
  if (command === 'memory scan') {
    const count = result.matches.length;
    return [
      `${count} ${count === 1 ? 'match' : 'matches'}, ${result.scannedBytes} bytes scanned`,
      ...result.matches.map((match) => `${match.address} (region ${match.regionBase})`),
    ];
  }
  const bytes = result.ranges.reduce((total, range) => total + range.length, 0);
  return [
    `${result.ranges.length} ${result.ranges.length === 1 ? 'range' : 'ranges'}, ${bytes} bytes`,
    ...result.ranges.map((range) => `${range.address}: ${range.length} bytes`),
  ];
}

function printCommandSuccess(io, command, result, json) {
  if (json) {
    if (command === 'memory transact') {
      io.out(JSON.stringify(result));
      return;
    }
    printSuccess(io, command, result, true);
    return;
  }
  if (command.startsWith('memory ')) {
    if (command === 'memory transact') {
      const applied = result.operations.filter((operation) => operation.applied).length;
      const verified = result.operations.filter((operation) => operation.verified).length;
      io.out(`Transaction ${result.transactionId}: ${result.status}`);
      io.out(`${result.operations.length} ${result.operations.length === 1 ? 'operation' : 'operations'}, ${applied} applied, ${verified} verified`);
      return;
    }
    for (const line of memoryHumanLines(command, result)) io.out(line);
    return;
  }
  if (command === 'telemetry register') {
    const count = result.types.length;
    io.out(`${count} telemetry ${count === 1 ? 'type' : 'types'} registered`);
    for (const type of result.types) io.out(type);
    return;
  }
  printSuccess(io, command, result, false);
}

function sanitizeTransactionError(error) {
  if (error?.code === 'USAGE') return error;
  const code = typeof error?.code === 'string' &&
    Object.hasOwn(TRANSACTION_ERROR_MESSAGES, error.code)
    ? error.code
    : 'INVALID_RESPONSE';
  return Object.assign(new Error(TRANSACTION_ERROR_MESSAGES[code]), { code });
}

async function main(argv, {
  sdk = require('@cfb27/lua-hook'),
  io = defaultIo,
  fileSystem = fs,
  cwd = process.cwd(),
} = {}) {
  let parsed = { json: false };
  try {
    parsed = parseArgs(argv);
    const { command, json, positionals, options } = parsed;
    const env = io.env || process.env;
    if (!command || command === 'help') {
      io.out(HELP);
      return 0;
    }
    rejectMisplacedDeveloperOptions(command, positionals, options);

    let result;
    if (command === 'install') {
      if (positionals.length) throw usageError('install does not accept positional arguments');
      const gameDir = requireDirectory(options.gameDir || env.CFB27_GAME_DIR, '--game-dir');
      const mmcDir = requireDirectory(options.mmcDir || env.CFB27_MMC_DIR, '--mmc-dir');
      const artifactsDir = requireDirectory(
        options.artifactsDir || env.CFB27_HOOK_ARTIFACTS,
        '--artifacts-dir',
      );
      result = await sdk.installHook({
        gameDir,
        mmcDir,
        proxyDll: path.resolve(artifactsDir, 'cfb27_cryptbase_proxy.dll'),
        hostDll: path.resolve(artifactsDir, 'cfb27_lua_host.dll'),
      });
    } else if (command === 'uninstall') {
      if (positionals.length) throw usageError('uninstall does not accept positional arguments');
      const gameDir = requireDirectory(options.gameDir || env.CFB27_GAME_DIR, '--game-dir');
      const mmcDir = requireDirectory(options.mmcDir || env.CFB27_MMC_DIR, '--mmc-dir');
      result = await sdk.restoreMmcHook({ gameDir, mmcDir });
    } else if (command === 'status') {
      if (positionals.length) throw usageError('status does not accept positional arguments');
      const game = await sdk.discoverGame();
      result = await sdk.createClient({ pid: game.pid }).status();
    } else if (command === 'run') {
      if (positionals.length !== 1) throw usageError('run requires exactly one Lua file');
      result = await sdk.runScriptFile(positionals[0]);
    } else if (command === 'eval') {
      if (!positionals.length) throw usageError('eval requires Lua source');
      const game = await sdk.discoverGame();
      result = await sdk.createClient({ pid: game.pid }).evaluateLua(positionals.join(' '));
    } else if (command === 'doctor') {
      if (positionals.length) throw usageError('doctor does not accept positional arguments');
      const gameDir = requireDirectory(options.gameDir || env.CFB27_GAME_DIR, '--game-dir');
      const mmcDir = requireDirectory(options.mmcDir || env.CFB27_MMC_DIR, '--mmc-dir');
      result = await sdk.doctor({ gameDir, mmcDir });
    } else if (command === 'logs') {
      if (positionals.length) throw usageError('logs does not accept positional arguments');
      const game = await sdk.discoverGame();
      const client = sdk.createClient({ pid: game.pid });
      if (options.follow) {
        for await (const event of sdk.followEvents(client, {
          after: options.after || 0,
          signal: io.signal,
        })) {
          if (event.type !== 'log') continue;
          if (json) io.out(JSON.stringify({ ok: true, command: 'logs', event }));
          else io.out(event.payload?.message || '');
        }
        return 0;
      }
      result = await client.getLogs({ limit: 100 });
    } else if (command === 'events') {
      if (positionals.length) throw usageError('events does not accept positional arguments');
      if (options.follow) throw usageError('--follow is only supported by logs');
      const game = await sdk.discoverGame();
      result = await sdk.createClient({ pid: game.pid }).getEvents({
        after: options.after || 0,
        limit: 256,
      });
    } else if (command === 'memory') {
      const [operation, ...extra] = positionals;
      if (operation === 'scan') {
        if (extra.length) throw usageError('memory scan does not accept positional arguments');
        const scanOptions = requireMemoryScanOptions(options);
        const game = await sdk.discoverGame();
        result = await sdk.createClient({ pid: game.pid, timeoutMs: 10_000 }).scanMemory(scanOptions);
      } else if (operation === 'read') {
        if (extra.length) throw usageError('memory read does not accept positional arguments');
        if (!options.ranges.length) throw usageError('memory read requires at least one --range');
        const readOptions = { ranges: options.ranges };
        if (options.allowUnsupportedBuild) readOptions.allowUnsupportedBuild = true;
        const game = await sdk.discoverGame();
        result = await sdk.createClient({ pid: game.pid }).readMemory(readOptions);
      } else if (operation === 'transact') {
        if (extra.length !== 1) {
          throw usageError('memory transact requires exactly one JSON file');
        }
        const transaction = await readTransactionRequest(extra[0], {
          fileSystem,
          cwd,
          allowExternalFile: options.allowExternalFile,
        });
        const game = await sdk.discoverGame();
        result = await sdk.createClient({ pid: game.pid }).writeTransaction(transaction);
      } else {
        throw usageError('memory requires scan, read, or transact');
      }
    } else if (command === 'telemetry') {
      const [operation, ...types] = positionals;
      if (operation !== 'register') throw usageError('telemetry requires register');
      if (!types.length) throw usageError('telemetry register requires at least one type name');
      const game = await sdk.discoverGame();
      result = await sdk.createClient({ pid: game.pid }).registerTelemetryTypes(types);
    } else {
      throw usageError(`Unknown command: ${command}`);
    }

    const displayCommand = command === 'memory' || command === 'telemetry'
      ? `${command} ${positionals[0]}`
      : command;
    printCommandSuccess(io, displayCommand, result, json);
    return 0;
  } catch (error) {
    const safeError = parsed.command === 'memory' && parsed.positionals?.[0] === 'transact'
      ? sanitizeTransactionError(error)
      : error;
    printError(io, safeError, parsed.json === true);
    return exitCodeFor(safeError);
  }
}

module.exports = { HELP, exitCodeFor, main };
