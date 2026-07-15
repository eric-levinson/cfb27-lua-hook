'use strict';

const { ERROR_CODES, Cfb27HookError } = require('./src/errors.cjs');
const { discoverGame } = require('./src/process.cjs');
const { createClient, getHostStatus, runScriptFile } = require('./src/client.cjs');
const { inspectInstallation, installHook, restoreMmcHook } = require('./src/install.cjs');
const { doctor } = require('./src/doctor.cjs');
const { followEvents } = require('./src/logs.cjs');
const {
  decodePackedReference,
  encodePackedReference,
  decodeField,
  encodeField,
} = require('./src/frtk-fields.cjs');
const { compileFrtkArtifacts } = require('./src/frtk-profile.cjs');
const {
  LIVE_RECRUITING_EVIDENCE,
  LIVE_RECRUITING_TABLES,
} = require('./src/live-recruiting-layout.cjs');
const {
  CONTACT_ACTIONS,
  createLiveRecruitingService,
} = require('./src/live-recruiting.cjs');
const {
  generateLiveClassPlan,
} = require('./src/live-class-generator.cjs');
const {
  locateLiveClassSurfaces,
} = require('./src/live-class-locator.cjs');
const {
  replaceLiveClass,
} = require('./src/live-class-replace.cjs');

module.exports = {
  ERROR_CODES,
  Cfb27HookError,
  discoverGame,
  createClient,
  getHostStatus,
  runScriptFile,
  inspectInstallation,
  installHook,
  restoreMmcHook,
  doctor,
  followEvents,
  decodePackedReference,
  encodePackedReference,
  decodeField,
  encodeField,
  compileFrtkArtifacts,
  LIVE_RECRUITING_EVIDENCE,
  LIVE_RECRUITING_TABLES,
  CONTACT_ACTIONS,
  createLiveRecruitingService,
  generateLiveClassPlan,
  locateLiveClassSurfaces,
  replaceLiveClass,
};
