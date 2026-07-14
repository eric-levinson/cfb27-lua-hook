'use strict';

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const LIVE_RECRUITING_EVIDENCE = deepFreeze({
  upstreamCommit: 'b2b5a7ce4216c5838f1dbd2fb5a76dba6d67e7fe',
  layoutVersion: '1.2.0',
});

const LIVE_RECRUITING_TABLES = deepFreeze({
  userTarget: {
    logicalName: 'UserRecruitTarget',
    tableId: 4168,
    uniqueId: 3987156317,
    capacity: 1120,
    recordSize: 36,
    fields: [
      {
        name: 'CurrentNILOffer', encoding: 'bitfield', byteOffset: 30,
        storageBytes: 2, bitOffset: 6, bitWidth: 10, minimum: 0, maximum: 1023,
        referenceTableId: null,
      },
      {
        name: 'ContactFriendsAndFamily', encoding: 'bitfield', byteOffset: 34,
        storageBytes: 1, bitOffset: 4, bitWidth: 1, minimum: 0, maximum: 1,
        referenceTableId: null,
      },
      {
        name: 'ContactHighSchoolCoaches', encoding: 'bitfield', byteOffset: 34,
        storageBytes: 1, bitOffset: 5, bitWidth: 1, minimum: 0, maximum: 1,
        referenceTableId: null,
      },
      {
        name: 'SearchSocialMedia', encoding: 'bitfield', byteOffset: 34,
        storageBytes: 1, bitOffset: 6, bitWidth: 1, minimum: 0, maximum: 1,
        referenceTableId: null,
      },
    ],
  },
  visit: {
    logicalName: 'ActiveVisitInfo',
    tableId: 4176,
    uniqueId: 3093586546,
    capacity: 4830,
    recordSize: 4,
    fields: [
      {
        name: 'Activity', encoding: 'bitfield', byteOffset: 0, storageBytes: 3,
        bitOffset: 0, bitWidth: 23, minimum: 0, maximum: 15,
        referenceTableId: null,
      },
      {
        name: 'WeekType', encoding: 'bitfield', byteOffset: 2, storageBytes: 2,
        bitOffset: 7, bitWidth: 4, minimum: 0, maximum: 8,
        referenceTableId: null,
      },
      {
        name: 'WeekNumber', encoding: 'bitfield', byteOffset: 3, storageBytes: 1,
        bitOffset: 3, bitWidth: 5, minimum: 0, maximum: 31,
        referenceTableId: null,
      },
    ],
  },
  pitch: {
    logicalName: 'ActiveRecruitingPitch',
    tableId: 4190,
    uniqueId: 1559900276,
    capacity: 9380,
    recordSize: 4,
    fields: [
      {
        name: 'Intensity', encoding: 'bitfield', byteOffset: 0, storageBytes: 4,
        bitOffset: 0, bitWidth: 27, minimum: 0, maximum: 4,
        referenceTableId: null,
      },
      {
        name: 'Pitch', encoding: 'bitfield', byteOffset: 3, storageBytes: 1,
        bitOffset: 3, bitWidth: 5, minimum: 0, maximum: 22,
        referenceTableId: null,
      },
    ],
  },
  board: {
    logicalName: 'RecruitingBoard',
    tableId: 4251,
    uniqueId: 220276943,
    capacity: 138,
    recordSize: 12,
    fields: [
      {
        name: 'RecruitingHoursProcessed', encoding: 'bitfield', byteOffset: 4,
        storageBytes: 3, bitOffset: 0, bitWidth: 20, minimum: 0, maximum: 4095,
        referenceTableId: null,
      },
      {
        name: 'RecruitingHoursTotal', encoding: 'bitfield', byteOffset: 6,
        storageBytes: 2, bitOffset: 4, bitWidth: 12, minimum: 0, maximum: 4095,
        referenceTableId: null,
      },
      {
        name: 'RecruitingHoursAssigned', encoding: 'unsigned', byteOffset: 8,
        storageBytes: 4, bitOffset: 0, bitWidth: 32, minimum: 0, maximum: 4095,
        referenceTableId: null,
      },
    ],
  },
});

module.exports = { LIVE_RECRUITING_EVIDENCE, LIVE_RECRUITING_TABLES };
