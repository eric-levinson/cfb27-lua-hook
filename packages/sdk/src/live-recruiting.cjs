'use strict';

const { Cfb27HookError } = require('./errors.cjs');
const { hasOnlyKeys, isSafeIntegerBetween } = require('./validation.cjs');
const { LIVE_RECRUITING_TABLES } = require('./live-recruiting-layout.cjs');

const TRANSACTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ROW = 0xFFFFFFFF;

const CONTACT_ACTIONS = Object.freeze({
  'dm-player': Object.freeze({ field: 'ContactHighSchoolCoaches', hours: 10 }),
  'browse-social-media': Object.freeze({ field: 'SearchSocialMedia', hours: 5 }),
  'friends-family': Object.freeze({ field: 'ContactFriendsAndFamily', hours: 25 }),
});

const TARGET_FIELDS = Object.freeze([
  'CurrentNILOffer',
  'ContactHighSchoolCoaches',
  'SearchSocialMedia',
  'ContactFriendsAndFamily',
]);
const BOARD_FIELDS = Object.freeze([
  'RecruitingHoursProcessed',
  'RecruitingHoursTotal',
  'RecruitingHoursAssigned',
]);
const PITCH_FIELDS = Object.freeze(['Pitch', 'Intensity']);
const VISIT_FIELDS = Object.freeze(['WeekNumber', 'WeekType', 'Activity']);

function fail(code, message) {
  return new Cfb27HookError(code, message);
}

function invalidRequest() {
  return fail('INVALID_REQUEST', 'Live recruiting request is invalid');
}

function invalidField() {
  return fail('FRTK_FIELD_INVALID', 'Live recruiting field or value is invalid');
}

function invalidResponse() {
  return fail('INVALID_RESPONSE', 'Live recruiting state is invalid');
}

function requireRow(value) {
  if (!isSafeIntegerBetween(value, 0, MAX_ROW)) throw invalidRequest();
  return value;
}

function requireRange(value, minimum, maximum) {
  if (!isSafeIntegerBetween(value, minimum, maximum)) throw invalidField();
  return value;
}

function requireMutation(options, keys) {
  const allowed = [...keys, 'dryRun'];
  if (!hasOnlyKeys(options, allowed) || keys.some((key) => !Object.hasOwn(options, key)) ||
      (Object.hasOwn(options, 'dryRun') && typeof options.dryRun !== 'boolean') ||
      typeof options.transactionId !== 'string' || !TRANSACTION_ID.test(options.transactionId)) {
    throw invalidRequest();
  }
  return Boolean(options.dryRun);
}

function selector(table, row, fields) {
  return { uniqueId: table.uniqueId, row, fields: [...fields] };
}

function decodeRecord(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).sort().join(',') !== 'row,uniqueId,values' ||
      record.uniqueId !== expected.uniqueId || record.row !== expected.row ||
      !Array.isArray(record.values) || record.values.length !== expected.fields.length) {
    throw invalidResponse();
  }
  const values = {};
  for (let index = 0; index < expected.fields.length; index += 1) {
    const item = record.values[index];
    const field = expected.fields[index];
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'field,value' ||
        item.field !== field || Object.hasOwn(values, field) ||
        !Number.isSafeInteger(item.value)) {
      throw invalidResponse();
    }
    values[field] = item.value;
  }
  return values;
}

function requireDecodedRange(values, field, minimum, maximum) {
  if (!isSafeIntegerBetween(values[field], minimum, maximum)) throw invalidResponse();
}

function validateTarget(values) {
  requireDecodedRange(values, 'CurrentNILOffer', 0, 1023);
  for (const field of TARGET_FIELDS.slice(1)) requireDecodedRange(values, field, 0, 1);
}

function validateBoard(values) {
  for (const field of BOARD_FIELDS) requireDecodedRange(values, field, 0, 4095);
  if (values.RecruitingHoursAssigned > values.RecruitingHoursTotal) {
    throw invalidResponse();
  }
}

function validatePitch(values) {
  requireDecodedRange(values, 'Pitch', 0, 19);
  requireDecodedRange(values, 'Intensity', 0, 2);
}

function validateVisit(values) {
  requireDecodedRange(values, 'WeekNumber', 0, 31);
  requireDecodedRange(values, 'WeekType', 0, 6);
  requireDecodedRange(values, 'Activity', 0, 13);
}

async function createLiveRecruitingService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).sort().join(',') !== 'client,generation' ||
      !options.client || typeof options.client.inspectFrtkCatalog !== 'function' ||
      typeof options.client.readFrtkRecords !== 'function' ||
      typeof options.client.transactFrtkFields !== 'function' ||
      !isSafeIntegerBetween(options.generation, 1, Number.MAX_SAFE_INTEGER)) {
    throw invalidRequest();
  }
  const { client, generation } = options;
  const catalog = await client.inspectFrtkCatalog({ generation });
  if (!catalog || catalog.generation !== generation || !Array.isArray(catalog.tables)) {
    throw invalidResponse();
  }
  for (const table of Object.values(LIVE_RECRUITING_TABLES)) {
    const found = catalog.tables.find((candidate) => candidate?.uniqueId === table.uniqueId);
    if (!found || found.authorityStatus !== 'direct_verified') {
      throw fail('FRTK_AUTHORITY_UNPROVEN', 'Live recruiting table authority is unproven');
    }
  }

  async function readSelectors(selectors) {
    const result = await client.readFrtkRecords({ generation, records: selectors });
    if (!result || result.generation !== generation || !Array.isArray(result.records) ||
        result.records.length !== selectors.length) {
      throw invalidResponse();
    }
    return result.records.map((record, index) => decodeRecord(record, selectors[index]));
  }

  async function applyChanges(transactionId, changes, summary, dryRun) {
    if (changes.length === 0) {
      return { transactionId, status: 'unchanged', changedFields: 0, ...summary };
    }
    if (dryRun) {
      return { transactionId, status: 'dry_run', changedFields: changes.length, ...summary };
    }
    const result = await client.transactFrtkFields({ transactionId, generation, changes });
    if (!result || result.transactionId !== transactionId ||
        result.status !== 'applied_verified' || result.changedFields !== changes.length) {
      throw invalidResponse();
    }
    return {
      transactionId: result.transactionId,
      status: result.status,
      changedFields: result.changedFields,
      ...summary,
    };
  }

  async function readState(readOptions = {}) {
    if (!hasOnlyKeys(readOptions, ['targetRow', 'boardRow', 'pitchRow', 'visitRow']) ||
        !Object.hasOwn(readOptions, 'targetRow') || !Object.hasOwn(readOptions, 'boardRow')) {
      throw invalidRequest();
    }
    const targetRow = requireRow(readOptions.targetRow);
    const boardRow = requireRow(readOptions.boardRow);
    const selectors = [
      selector(LIVE_RECRUITING_TABLES.userTarget, targetRow, TARGET_FIELDS),
      selector(LIVE_RECRUITING_TABLES.board, boardRow, BOARD_FIELDS),
    ];
    if (Object.hasOwn(readOptions, 'pitchRow')) {
      selectors.push(selector(LIVE_RECRUITING_TABLES.pitch,
        requireRow(readOptions.pitchRow), PITCH_FIELDS));
    }
    if (Object.hasOwn(readOptions, 'visitRow')) {
      selectors.push(selector(LIVE_RECRUITING_TABLES.visit,
        requireRow(readOptions.visitRow), VISIT_FIELDS));
    }
    const records = await readSelectors(selectors);
    const target = records[0];
    const board = records[1];
    validateTarget(target);
    validateBoard(board);
    let cursor = 2;
    let pitch = null;
    let visit = null;
    if (Object.hasOwn(readOptions, 'pitchRow')) {
      const values = records[cursor++];
      validatePitch(values);
      pitch = { row: readOptions.pitchRow, pitch: values.Pitch, intensity: values.Intensity };
    }
    if (Object.hasOwn(readOptions, 'visitRow')) {
      const values = records[cursor];
      validateVisit(values);
      visit = {
        row: readOptions.visitRow,
        weekNumber: values.WeekNumber,
        weekType: values.WeekType,
        activity: values.Activity,
      };
    }
    return {
      generation,
      targetRow,
      currentNilOffer: target.CurrentNILOffer,
      contacts: {
        'dm-player': Boolean(target.ContactHighSchoolCoaches),
        'browse-social-media': Boolean(target.SearchSocialMedia),
        'friends-family': Boolean(target.ContactFriendsAndFamily),
      },
      board: {
        row: boardRow,
        total: board.RecruitingHoursTotal,
        processed: board.RecruitingHoursProcessed,
        assigned: board.RecruitingHoursAssigned,
        available: board.RecruitingHoursTotal - board.RecruitingHoursAssigned,
      },
      pitch,
      visit,
    };
  }

  async function setContactAction(mutation = {}) {
    const dryRun = requireMutation(mutation,
      ['transactionId', 'targetRow', 'boardRow', 'action', 'enabled']);
    const targetRow = requireRow(mutation.targetRow);
    const boardRow = requireRow(mutation.boardRow);
    if (typeof mutation.enabled !== 'boolean') throw invalidRequest();
    const action = CONTACT_ACTIONS[mutation.action];
    if (!action) {
      throw fail('RECRUITING_ACTION_UNSUPPORTED', 'Recruiting action is unsupported');
    }
    const state = await readState({ targetRow, boardRow });
    const enabled = mutation.enabled;
    if (state.contacts[mutation.action] === enabled) {
      return {
        transactionId: mutation.transactionId,
        status: 'unchanged',
        changedFields: 0,
        action: mutation.action,
        enabled,
        assignedHours: state.board.assigned,
        availableHours: state.board.available,
      };
    }
    const nextAssigned = state.board.assigned + (enabled ? action.hours : -action.hours);
    if (enabled && nextAssigned > state.board.total) {
      throw fail('RECRUITING_HOURS_INSUFFICIENT', 'Recruiting hours are insufficient');
    }
    if (nextAssigned < 0) throw invalidResponse();
    return applyChanges(mutation.transactionId, [
      { uniqueId: LIVE_RECRUITING_TABLES.userTarget.uniqueId, row: targetRow,
        field: action.field, value: enabled ? 1 : 0 },
      { uniqueId: LIVE_RECRUITING_TABLES.board.uniqueId, row: boardRow,
        field: 'RecruitingHoursAssigned', value: nextAssigned },
    ], {
      action: mutation.action,
      enabled,
      assignedHours: nextAssigned,
      availableHours: state.board.total - nextAssigned,
    }, dryRun);
  }

  async function setNilOffer(mutation = {}) {
    const dryRun = requireMutation(mutation,
      ['transactionId', 'targetRow', 'amount']);
    const targetRow = requireRow(mutation.targetRow);
    const amount = requireRange(mutation.amount, 0, 1023);
    const [target] = await readSelectors([
      selector(LIVE_RECRUITING_TABLES.userTarget, targetRow, ['CurrentNILOffer']),
    ]);
    requireDecodedRange(target, 'CurrentNILOffer', 0, 1023);
    const changes = target.CurrentNILOffer === amount ? [] : [{
      uniqueId: LIVE_RECRUITING_TABLES.userTarget.uniqueId,
      row: targetRow,
      field: 'CurrentNILOffer',
      value: amount,
    }];
    return applyChanges(mutation.transactionId, changes, {
      currentNilOffer: target.CurrentNILOffer,
      nextNilOffer: amount,
    }, dryRun);
  }

  async function rewritePitch(mutation = {}) {
    const dryRun = requireMutation(mutation,
      ['transactionId', 'pitchRow', 'pitch']);
    const pitchRow = requireRow(mutation.pitchRow);
    const pitch = requireRange(mutation.pitch, 0, 19);
    const [values] = await readSelectors([
      selector(LIVE_RECRUITING_TABLES.pitch, pitchRow, PITCH_FIELDS),
    ]);
    validatePitch(values);
    const changes = values.Pitch === pitch ? [] : [{
      uniqueId: LIVE_RECRUITING_TABLES.pitch.uniqueId,
      row: pitchRow,
      field: 'Pitch',
      value: pitch,
    }];
    return applyChanges(mutation.transactionId, changes, {
      pitchRow,
      pitch,
      intensity: values.Intensity,
    }, dryRun);
  }

  async function rewriteVisit(mutation = {}) {
    const dryRun = requireMutation(mutation,
      ['transactionId', 'visitRow', 'weekNumber', 'weekType', 'activity']);
    const visitRow = requireRow(mutation.visitRow);
    const requested = {
      WeekNumber: requireRange(mutation.weekNumber, 0, 31),
      WeekType: requireRange(mutation.weekType, 0, 6),
      Activity: requireRange(mutation.activity, 0, 13),
    };
    const [values] = await readSelectors([
      selector(LIVE_RECRUITING_TABLES.visit, visitRow, VISIT_FIELDS),
    ]);
    validateVisit(values);
    const changes = VISIT_FIELDS.filter((field) => values[field] !== requested[field])
      .map((field) => ({
        uniqueId: LIVE_RECRUITING_TABLES.visit.uniqueId,
        row: visitRow,
        field,
        value: requested[field],
      }));
    return applyChanges(mutation.transactionId, changes, {
      visit: {
        row: visitRow,
        weekNumber: requested.WeekNumber,
        weekType: requested.WeekType,
        activity: requested.Activity,
      },
    }, dryRun);
  }

  return Object.freeze({
    readState,
    setContactAction,
    setNilOffer,
    rewritePitch,
    rewriteVisit,
  });
}

module.exports = { CONTACT_ACTIONS, createLiveRecruitingService };
