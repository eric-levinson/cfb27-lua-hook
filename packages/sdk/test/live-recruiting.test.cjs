'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeField, decodeField } = require('../src/frtk-fields.cjs');
const {
  LIVE_RECRUITING_EVIDENCE,
  LIVE_RECRUITING_TABLES,
} = require('../src/live-recruiting-layout.cjs');
const {
  CONTACT_ACTIONS,
  createLiveRecruitingService,
} = require('../src/live-recruiting.cjs');

const DEFAULT_STATE = Object.freeze({
  target: Object.freeze({
    CurrentNILOffer: 180,
    ContactHighSchoolCoaches: 1,
    SearchSocialMedia: 0,
    ContactFriendsAndFamily: 1,
  }),
  board: Object.freeze({
    RecruitingHoursTotal: 550,
    RecruitingHoursProcessed: 15,
    RecruitingHoursAssigned: 85,
  }),
  pitch: Object.freeze({ Pitch: 3, Intensity: 0 }),
  visit: Object.freeze({ WeekNumber: 1, WeekType: 1, Activity: 3 }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeTypedClient(options = {}) {
  const state = clone(DEFAULT_STATE);
  for (const key of ['target', 'board', 'pitch', 'visit']) {
    Object.assign(state[key], options[key] || {});
  }
  const transactions = [];
  const reads = [];
  const identities = Object.values(LIVE_RECRUITING_TABLES);
  const byUniqueId = new Map([
    [LIVE_RECRUITING_TABLES.userTarget.uniqueId, state.target],
    [LIVE_RECRUITING_TABLES.board.uniqueId, state.board],
    [LIVE_RECRUITING_TABLES.pitch.uniqueId, state.pitch],
    [LIVE_RECRUITING_TABLES.visit.uniqueId, state.visit],
  ]);

  return {
    transactions,
    reads,
    async inspectFrtkCatalog({ generation }) {
      return {
        generation,
        tables: identities.map((table) => ({
          uniqueId: table.uniqueId,
          logicalName: table.logicalName,
          authorityStatus: options.authorityOverride || 'direct_verified',
          capacity: table.capacity,
          profileId: 'synthetic-profile',
          generation,
          evidence: [],
        })),
      };
    },
    async readFrtkRecords(request) {
      reads.push(clone(request));
      if (options.readResult) return clone(options.readResult);
      return {
        generation: request.generation,
        records: request.records.map((selector) => {
          const source = byUniqueId.get(selector.uniqueId);
          return {
            uniqueId: selector.uniqueId,
            row: selector.row,
            values: selector.fields.map((field) => ({ field, value: source[field] })),
          };
        }),
      };
    },
    async transactFrtkFields(request) {
      transactions.push(clone(request));
      for (const change of request.changes) {
        byUniqueId.get(change.uniqueId)[change.field] = change.value;
      }
      return {
        transactionId: request.transactionId,
        status: 'applied_verified',
        changedFields: request.changes.length,
      };
    },
  };
}

test('exports only sanitized verified table metadata', () => {
  assert.equal(LIVE_RECRUITING_EVIDENCE.upstreamCommit,
    'b2b5a7ce4216c5838f1dbd2fb5a76dba6d67e7fe');
  assert.equal(LIVE_RECRUITING_EVIDENCE.layoutVersion, '1.2.0');
  assert.deepEqual(Object.values(LIVE_RECRUITING_TABLES).map((table) => table.uniqueId),
    [3987156317, 3093586546, 1559900276, 220276943]);
  assert.doesNotMatch(JSON.stringify(LIVE_RECRUITING_TABLES),
    /address|patternHex|maskHex|recordHex|pid|savePath/i);
});

test('sanitized field definitions encode Brooks verified packed values', () => {
  const find = (table, field) => table.fields.find((candidate) => candidate.name === field);
  let target = Buffer.alloc(36);
  target = encodeField(target, find(LIVE_RECRUITING_TABLES.userTarget,
    'ContactFriendsAndFamily'), 1);
  target = encodeField(target, find(LIVE_RECRUITING_TABLES.userTarget,
    'ContactHighSchoolCoaches'), 1);
  target = encodeField(target, find(LIVE_RECRUITING_TABLES.userTarget,
    'SearchSocialMedia'), 1);
  assert.equal(target[34], 0x0E);

  let pitch = Buffer.alloc(4);
  pitch = encodeField(pitch, find(LIVE_RECRUITING_TABLES.pitch, 'Intensity'), 2);
  pitch = encodeField(pitch, find(LIVE_RECRUITING_TABLES.pitch, 'Pitch'), 2);
  assert.deepEqual(pitch, Buffer.from([0, 0, 0, 0x42]));

  let visit = Buffer.alloc(4);
  visit = encodeField(visit, find(LIVE_RECRUITING_TABLES.visit, 'WeekNumber'), 1);
  visit = encodeField(visit, find(LIVE_RECRUITING_TABLES.visit, 'WeekType'), 1);
  visit = encodeField(visit, find(LIVE_RECRUITING_TABLES.visit, 'Activity'), 3);
  assert.deepEqual(visit, Buffer.from([0, 0, 0x06, 0x21]));
  assert.equal(decodeField(visit, find(LIVE_RECRUITING_TABLES.visit, 'Activity')), 3);
});

test('requires all four tables to have direct_verified authority', async () => {
  const client = fakeTypedClient({ authorityOverride: 'discovery_only' });
  await assert.rejects(createLiveRecruitingService({ client, generation: 7 }),
    (error) => error.code === 'FRTK_AUTHORITY_UNPROVEN');
});

test('reads decoded target, board, pitch, and visit state', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  const state = await service.readState({
    targetRow: 12,
    boardRow: 33,
    pitchRow: 4,
    visitRow: 2,
  });
  assert.deepEqual(state.board, {
    row: 33,
    total: 550,
    processed: 15,
    assigned: 85,
    available: 465,
  });
  assert.deepEqual(state.contacts, {
    'dm-player': true,
    'browse-social-media': false,
    'friends-family': true,
  });
  assert.equal(state.currentNilOffer, 180);
  assert.deepEqual(state.pitch, { row: 4, pitch: 3, intensity: 0 });
  assert.deepEqual(state.visit,
    { row: 2, weekNumber: 1, weekType: 1, activity: 3 });
  assert.doesNotMatch(JSON.stringify(state),
    /address|bytes|changes|mask|pattern/i);
});

test('toggles a contact and assigned hours in one transaction', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  const result = await service.setContactAction({
    transactionId: 'recruiting.dm.1',
    targetRow: 12,
    boardRow: 33,
    action: 'browse-social-media',
    enabled: true,
  });
  assert.deepEqual(client.transactions[0].changes, [
    { uniqueId: 3987156317, row: 12, field: 'SearchSocialMedia', value: 1 },
    { uniqueId: 220276943, row: 33, field: 'RecruitingHoursAssigned', value: 90 },
  ]);
  assert.deepEqual(result, {
    transactionId: 'recruiting.dm.1',
    status: 'applied_verified',
    changedFields: 2,
    action: 'browse-social-media',
    enabled: true,
    assignedHours: 90,
    availableHours: 460,
  });
});

test('fails closed on insufficient hours and does not transact', async () => {
  const client = fakeTypedClient({
    target: { ContactHighSchoolCoaches: 0 },
    board: { total: 100, processed: 10, assigned: 95,
      RecruitingHoursTotal: 100, RecruitingHoursProcessed: 10,
      RecruitingHoursAssigned: 95 },
  });
  const service = await createLiveRecruitingService({ client, generation: 7 });
  await assert.rejects(service.setContactAction({
    transactionId: 'recruiting.dm.2',
    targetRow: 12,
    boardRow: 33,
    action: 'dm-player',
    enabled: true,
  }), (error) => error.code === 'RECRUITING_HOURS_INSUFFICIENT');
  assert.equal(client.transactions.length, 0);
});

test('dry runs and no-op writes never send a transaction or raw changes', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  const preview = await service.setNilOffer({
    transactionId: 'recruiting.nil.1',
    targetRow: 12,
    amount: 200,
    dryRun: true,
  });
  assert.deepEqual(preview, {
    transactionId: 'recruiting.nil.1',
    status: 'dry_run',
    changedFields: 1,
    currentNilOffer: 180,
    nextNilOffer: 200,
  });
  assert.doesNotMatch(JSON.stringify(preview), /changes|address|bytes/i);
  const noOp = await service.setContactAction({
    transactionId: 'recruiting.dm.3',
    targetRow: 12,
    boardRow: 33,
    action: 'dm-player',
    enabled: true,
  });
  assert.equal(noOp.status, 'unchanged');
  assert.equal(client.transactions.length, 0);
});

test('rewrites only an existing pitch enum and an existing visit row', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  const pitch = await service.rewritePitch({
    transactionId: 'recruiting.pitch.1',
    pitchRow: 4,
    pitch: 4,
  });
  const visit = await service.rewriteVisit({
    transactionId: 'recruiting.visit.1',
    visitRow: 2,
    weekNumber: 2,
    weekType: 1,
    activity: 6,
  });
  assert.deepEqual(client.transactions[0].changes,
    [{ uniqueId: 1559900276, row: 4, field: 'Pitch', value: 4 }]);
  assert.deepEqual(client.transactions[1].changes, [
    { uniqueId: 3093586546, row: 2, field: 'WeekNumber', value: 2 },
    { uniqueId: 3093586546, row: 2, field: 'Activity', value: 6 },
  ]);
  assert.equal(pitch.intensity, 0);
  assert.deepEqual(visit.visit,
    { row: 2, weekNumber: 2, weekType: 1, activity: 6 });
});

test('validates supported actions and decoded enum ranges', async () => {
  const client = fakeTypedClient();
  const service = await createLiveRecruitingService({ client, generation: 7 });
  assert.deepEqual(Object.keys(CONTACT_ACTIONS),
    ['dm-player', 'browse-social-media', 'friends-family']);
  await assert.rejects(service.setContactAction({
    transactionId: 'recruiting.unsupported.1', targetRow: 12, boardRow: 33,
    action: 'send-the-house', enabled: true,
  }), (error) => error.code === 'RECRUITING_ACTION_UNSUPPORTED');
  for (const [method, options] of [
    ['setNilOffer', { transactionId: 'range.nil', targetRow: 12, amount: 1024 }],
    ['rewritePitch', { transactionId: 'range.pitch', pitchRow: 4, pitch: 20 }],
    ['rewriteVisit', { transactionId: 'range.week', visitRow: 2,
      weekNumber: 32, weekType: 1, activity: 3 }],
    ['rewriteVisit', { transactionId: 'range.weektype', visitRow: 2,
      weekNumber: 1, weekType: 7, activity: 3 }],
    ['rewriteVisit', { transactionId: 'range.activity', visitRow: 2,
      weekNumber: 1, weekType: 1, activity: 14 }],
  ]) {
    await assert.rejects(service[method](options),
      (error) => error.code === 'FRTK_FIELD_INVALID');
  }
  assert.equal(client.transactions.length, 0);
});

test('rejects malformed typed read responses without leaking host data', async () => {
  const client = fakeTypedClient({
    readResult: {
      generation: 7,
      records: [{ uniqueId: 3987156317, row: 12,
        values: [{ field: 'CurrentNILOffer', value: 180 },
          { field: 'CurrentNILOffer', value: 999 }] }],
    },
  });
  const service = await createLiveRecruitingService({ client, generation: 7 });
  await assert.rejects(service.setNilOffer({
    transactionId: 'recruiting.bad-response', targetRow: 12, amount: 200,
  }), (error) => error.code === 'INVALID_RESPONSE' &&
    !JSON.stringify(error).includes('999'));
});
