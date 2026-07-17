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

const LIVE_CLASS_ERROR_MESSAGES = Object.freeze({
  GAME_NOT_RUNNING: 'College Football 27 is not running',
  HOST_NOT_READY: 'The Lua host is not ready',
  UNSUPPORTED_BUILD: 'Live recruit replacement requires the supported game build',
  SESSION_WRITES_DISABLED: 'Writes are disabled for this host session',
  PIPE_TIMEOUT: 'The live recruit class request timed out',
  LIVE_CLASS_PLAN_INVALID: 'The generated recruit class plan is invalid',
  LIVE_CLASS_SURFACE_UNVERIFIED: 'Live recruit class memory could not be uniquely verified',
  LIVE_CLASS_APPLY_FAILED: 'Live recruit class replacement failed and applied batches were rolled back',
  LIVE_CLASS_ROLLBACK_FAILED: 'Live recruit class replacement failed and rollback could not be verified',
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
  frtk profile validate <.frtk/profile.json>
                Validate and load a typed FrTk profile
  frtk catalog discover <.frtk/profile.json>
                Load a profile and discover the typed catalog
  frtk catalog inspect <.frtk/profile.json>
                Load a profile, discover, and inspect the typed catalog
  frtk records read <.frtk/profile.json> <uniqueId> --row N --field <name>...
                Load a profile and read typed fields by numeric Unique ID
  telemetry register <type...>
                Register structured telemetry type names
  live-class replace --save <path> --brooks-root <path>
                Generate with Brooks and replace the existing live recruit class

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
  --allow-external-file   Allow a FrTk profile outside .frtk or transaction JSON outside CWD
  --row <index>           Typed FrTk record row
  --field <name>          Typed FrTk field name; may be repeated
  --save <path>           Read-only dynasty autosave used as the row skeleton
  --brooks-root <path>    Brooks cfb27-dynasty-modding checkout
  --seed <value>          Optional generator seed (default: default)
  --dry-run               Generate, locate, and snapshot without writing
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
  const frtkOptions = [options.row, options.fields.length ? options.fields : undefined];
  const liveClassOptions = [options.save, options.brooksRoot, options.seed,
    options.dryRun || undefined];
  if (command !== 'live-class' && liveClassOptions.some((value) => value !== undefined)) {
    throw usageError('Live class options are only valid for live-class replace');
  }
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
  if (command !== 'frtk' && frtkOptions.some((value) => value !== undefined)) {
    throw usageError('FrTk record options are only valid for frtk records read');
  }
  if (operation === 'transact') {
    const hasUnrelatedOption = Object.entries(options).some(([key, value]) => {
      if (key === 'allowExternalFile' || key === 'row' || key === 'fields') return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'boolean') return value;
      return value !== undefined;
    });
    if (hasUnrelatedOption) {
      throw usageError('This option is not valid for memory transact');
    }
  }
  const frtkProfileFile = command === 'frtk' &&
    ((positionals[0] === 'profile' && positionals[1] === 'validate') ||
     (positionals[0] === 'catalog' &&
       (positionals[1] === 'discover' || positionals[1] === 'inspect')) ||
     (positionals[0] === 'records' && positionals[1] === 'read'));
  if (operation !== 'transact' && !frtkProfileFile && options.allowExternalFile) {
    throw usageError('--allow-external-file is only valid for memory transact or FrTk profile files');
  }
}

async function resolveFrtkProfileFile(file, { fileSystem, cwd, allowExternalFile }) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.json') {
    throw usageError('FrTk profile requires one .json file');
  }
  let resolved;
  let frtkRoot;
  try {
    resolved = await fileSystem.realpath(path.resolve(cwd, file));
    if (!allowExternalFile) frtkRoot = await fileSystem.realpath(path.resolve(cwd, '.frtk'));
  } catch {
    throw usageError('Could not resolve FrTk profile file under .frtk');
  }
  if (!allowExternalFile) {
    const relative = path.relative(frtkRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw usageError('FrTk profile file must be contained under .frtk; pass --allow-external-file to allow it');
    }
  }
  return resolved;
}

async function createLiveClient(sdk) {
  const game = await sdk.discoverGame();
  return sdk.createClient({ pid: game.pid });
}

async function discoverAndInspect(client) {
  const discovered = await client.discoverFrtkCatalog();
  return client.inspectFrtkCatalog({ generation: discovered.generation });
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
  if (command === 'frtk profile validate') {
    io.out(`FrTk profile ${result.profileId}: ${result.tableCount} tables`);
    io.out(`Schema ${result.schemaIdentity}; build ${result.buildIdentity}`);
    return;
  }
  if (command === 'frtk catalog discover' || command === 'frtk catalog inspect') {
    io.out(`FrTk catalog generation ${result.generation}: ${result.tables.length} tables`);
    for (const table of result.tables) {
      io.out(`${table.logicalName} (${table.uniqueId}): ${table.capacity} rows, ${table.authorityStatus}`);
    }
    return;
  }
  if (command === 'frtk records read') {
    io.out(`FrTk records generation ${result.generation}`);
    for (const record of result.records) {
      io.out(`Table ${record.uniqueId}, row ${record.row}`);
      for (const entry of record.values) io.out(`${entry.field}: ${JSON.stringify(entry.value)}`);
    }
    return;
  }
  if (command === 'live-class replace') {
    io.out(`Live recruit class: ${result.status}`);
    io.out(`${result.classSize} recruits; ${result.batchesApplied} batches applied`);
    if (result.optionalSkipped) {
      io.out(`${result.optionalSkipped.portraits} portraits and ${result.optionalSkipped.gear} gear rows skipped`);
    }
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

function sanitizeLiveClassError(error) {
  if (error?.code === 'USAGE') return error;
  const code = typeof error?.code === 'string' &&
    Object.hasOwn(LIVE_CLASS_ERROR_MESSAGES, error.code)
    ? error.code
    : 'LIVE_CLASS_PLAN_INVALID';
  return Object.assign(new Error(LIVE_CLASS_ERROR_MESSAGES[code]), { code });
}

function assertLiveClassStatus(status, dryRun) {
  if (!status || status.ready !== true) {
    throw Object.assign(new Error('The Lua host is not ready'), { code: 'HOST_NOT_READY' });
  }
  if (status.supportedBuild !== true) {
    throw Object.assign(new Error('The game build is unsupported'), { code: 'UNSUPPORTED_BUILD' });
  }
  if (!dryRun && (status.writesAllowed !== true || status.sessionWritesDisabled === true)) {
    throw Object.assign(new Error('Writes are disabled'), { code: 'SESSION_WRITES_DISABLED' });
  }
  if (!Number.isSafeInteger(status.ticks) || status.ticks < 0) {
    throw Object.assign(new Error('Host status is invalid'), { code: 'INVALID_RESPONSE' });
  }
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
      const artifactsDir = options.artifactsDir || env.CFB27_HOOK_ARTIFACTS;
      const doctorOptions = { gameDir, mmcDir };
      if (artifactsDir) {
        doctorOptions.proxyDll = path.resolve(artifactsDir, 'cfb27_cryptbase_proxy.dll');
        doctorOptions.hostDll = path.resolve(artifactsDir, 'cfb27_lua_host.dll');
      }
      result = await sdk.doctor(doctorOptions);
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
    } else if (command === 'frtk') {
      const [group, operation, ...extra] = positionals;
      const nonFrtkOptions = [options.gameDir, options.mmcDir, options.artifactsDir,
        options.follow || undefined, options.after, options.pattern, options.mask,
        options.maxMatches, options.maxPages, options.context,
        options.ranges.length ? options.ranges : undefined,
        options.allowUnsupportedBuild || undefined,
        options.includeAllocationMetadata || undefined];
      if (nonFrtkOptions.some((value) => value !== undefined)) {
        throw usageError('This option is not valid for FrTk commands');
      }
      if (group === 'profile' && operation === 'validate') {
        if (extra.length !== 1 || options.row !== undefined || options.fields.length) {
          throw usageError('frtk profile validate requires exactly one profile JSON file');
        }
        const file = await resolveFrtkProfileFile(extra[0], {
          fileSystem, cwd, allowExternalFile: options.allowExternalFile,
        });
        const client = await createLiveClient(sdk);
        result = await client.loadFrtkProfileFromFile(file, { fileSystem });
      } else if (group === 'catalog' && operation === 'discover') {
        if (extra.length !== 1 || options.row !== undefined || options.fields.length) {
          throw usageError('frtk catalog discover requires exactly one profile JSON file');
        }
        const file = await resolveFrtkProfileFile(extra[0], {
          fileSystem, cwd, allowExternalFile: options.allowExternalFile,
        });
        const client = await createLiveClient(sdk);
        await client.loadFrtkProfileFromFile(file, { fileSystem });
        result = await discoverAndInspect(client);
      } else if (group === 'catalog' && operation === 'inspect') {
        if (extra.length !== 1 || options.row !== undefined || options.fields.length) {
          throw usageError('frtk catalog inspect requires exactly one profile JSON file');
        }
        const file = await resolveFrtkProfileFile(extra[0], {
          fileSystem, cwd, allowExternalFile: options.allowExternalFile,
        });
        const client = await createLiveClient(sdk);
        await client.loadFrtkProfileFromFile(file, { fileSystem });
        result = await discoverAndInspect(client);
      } else if (group === 'records' && operation === 'read') {
        if (extra.length !== 2 || options.row === undefined || options.fields.length < 1 ||
            options.fields.length > 64 ||
            options.fields.some((field) => typeof field !== 'string' || field.length < 1 ||
              field.length > 128)) {
          throw usageError('frtk records read requires one profile, numeric Unique ID, --row, and 1 to 64 --field options');
        }
        const [profileFile, uniqueIdText] = extra;
        if (!/^(?:0|[1-9][0-9]{0,9})$/.test(uniqueIdText)) {
          throw usageError('FrTk records read requires a numeric Unique ID');
        }
        const uniqueId = Number(uniqueIdText);
        if (!Number.isSafeInteger(uniqueId) || uniqueId > 0xFFFFFFFF) {
          throw usageError('FrTk Unique ID must be from 0 to 4294967295');
        }
        const file = await resolveFrtkProfileFile(profileFile, {
          fileSystem, cwd, allowExternalFile: options.allowExternalFile,
        });
        const client = await createLiveClient(sdk);
        await client.loadFrtkProfileFromFile(file, { fileSystem });
        const catalog = await discoverAndInspect(client);
        if (!catalog.tables.some((table) => table.uniqueId === uniqueId)) {
          throw usageError('FrTk Unique ID is not present in the discovered catalog');
        }
        result = await client.readFrtkRecords({
          generation: catalog.generation,
          records: [{ uniqueId, row: options.row, fields: options.fields }],
        });
      } else {
        throw usageError('frtk requires profile validate, catalog discover/inspect, or records read');
      }
    } else if (command === 'live-class') {
      const [operation, ...extra] = positionals;
      if (operation !== 'replace' || extra.length) {
        throw usageError('live-class requires replace');
      }
      if (!options.save) throw usageError('--save is required for live-class replace');
      if (!options.brooksRoot) {
        throw usageError('--brooks-root is required for live-class replace');
      }
      if (options.seed !== undefined && (options.seed.length < 1 || options.seed.length > 128)) {
        throw usageError('--seed must contain 1 to 128 characters');
      }
      const unrelated = [options.gameDir, options.mmcDir, options.artifactsDir,
        options.follow || undefined, options.after, options.pattern, options.mask,
        options.maxMatches, options.maxPages, options.context,
        options.ranges.length ? options.ranges : undefined,
        options.allowUnsupportedBuild || undefined,
        options.includeAllocationMetadata || undefined,
        options.allowExternalFile || undefined,
        options.row, options.fields.length ? options.fields : undefined];
      if (unrelated.some((value) => value !== undefined)) {
        throw usageError('This option is not valid for live-class replace');
      }
      const plan = await sdk.generateLiveClassPlan({
        savePath: path.resolve(cwd, options.save),
        brooksRoot: path.resolve(cwd, options.brooksRoot),
        seed: options.seed || 'default',
      });
      const game = await sdk.discoverGame();
      const client = sdk.createClient({ pid: game.pid, timeoutMs: 10_000 });
      const status = await client.status();
      assertLiveClassStatus(status, options.dryRun);
      const surfaces = await sdk.locateLiveClassSurfaces({ client, plan });
      result = await sdk.replaceLiveClass({
        client,
        plan,
        surfaces,
        generation: status.ticks,
        dryRun: options.dryRun,
      });
    } else {
      throw usageError(`Unknown command: ${command}`);
    }

    const displayCommand = command === 'memory' || command === 'telemetry'
      ? `${command} ${positionals[0]}`
      : command === 'frtk'
        ? `${command} ${positionals[0]} ${positionals[1]}`
      : command === 'live-class'
        ? `${command} ${positionals[0]}`
      : command;
    printCommandSuccess(io, displayCommand, result, json);
    return 0;
  } catch (error) {
    const safeError = parsed.command === 'memory' && parsed.positionals?.[0] === 'transact'
      ? sanitizeTransactionError(error)
      : parsed.command === 'live-class'
        ? sanitizeLiveClassError(error)
        : error;
    printError(io, safeError, parsed.json === true, {
      includeDetails: parsed.command !== 'live-class' && (parsed.command !== 'frtk' ||
        safeError?.code === 'FRTK_DISCOVERY_TIMEOUT'),
    });
    return exitCodeFor(safeError);
  }
}

module.exports = { HELP, exitCodeFor, main };
