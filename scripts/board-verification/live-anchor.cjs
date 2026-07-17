'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require('../../packages/sdk');
const {
  TABLES,
  canonical,
  locateTable,
  findUserBoard,
} = require('./reanchor-lib.cjs');

const OUTPUT = path.resolve(__dirname, '..', '..', '.frtk', 'board-verification',
  'live-mirror-bases.json');

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
    stream.on('error', reject);
  });
}

async function main() {
  const game = await sdk.discoverGame();
  const executableSha256 = await sha256File(game.path);
  const client = sdk.createClient({ pid: game.pid, timeoutMs: 60_000 });
  const hello = await client.hello();
  if (!hello.capabilities.includes('researchWatch')) {
    throw new Error('Loaded host does not support researchWatch');
  }

  const sessionIdentity = {
    pid: game.pid,
    hostVersion: hello.hostVersion,
    protocolVersion: hello.protocolVersion,
  };
  const located = [];
  for (const table of TABLES.values()) located.push(await locateTable(client, table));
  const tables = new Map(located.map((table) => [table.id, table]));
  const board = findUserBoard(tables);
  const membership = tables.get(5847);
  const boardIndex = tables.get(4251);
  const freelist4168 = tables.get(4168).header + 24n;
  const membershipSlot = membership.base +
    BigInt(board.selected.teamRow * membership.stride + board.selected.firstFreeSlot * 4);
  const validationSummaries = Object.fromEntries(located.map((table) => [String(table.id), {
    ...table.validation,
    score: table.score,
    signatureMatches: table.signatureMatches,
  }]));

  const output = {
    capturedAt: new Date().toISOString(),
    pid: game.pid,
    supportedBuild: hello.supportedBuild,
    executableSha256,
    sessionIdentity,
    validationSummaries,
    tables: Object.fromEntries(located.map((table) => [String(table.id), {
      headerSignature: canonical(table.header),
      dataBase: canonical(table.base),
      stride: table.stride,
      capacity: table.capacity,
      freelistHeadValue: table.freelistHead,
      score: table.score,
      signatureMatches: table.signatureMatches,
    }])),
    userBoard: {
      ...board.selected,
      boardIndexAddress: canonical(boardIndex.base +
        BigInt(board.selected.boardRow * boardIndex.stride)),
      membershipRowAddress: canonical(membership.base +
        BigInt(board.selected.teamRow * membership.stride)),
      firstFreeSlotAddress: canonical(membershipSlot),
    },
    captureAddresses: {
      table4168FreelistHead: canonical(freelist4168),
      firstFreeMembershipSlot: canonical(membershipSlot),
    },
    topBoardCandidates: board.candidates,
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
