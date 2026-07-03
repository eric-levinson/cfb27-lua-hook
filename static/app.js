const state = {
  activeView: "generator",
  files: [],
  selectedFile: "",
  profiles: [],
  fieldCapabilities: [],
  selectedProfileId: "",
  saveFingerprint: "",
  recordCount: 0,
  lockMap: {},
  defaultConfigs: [],
  currentConfig: null,
  configWarnings: [],
  configErrors: [],
  currentPreview: null,
  previewContext: null,
  lastApplyResult: null,
  lastPatchExport: null,
  recruitEditor: { columns: [], rows: [], selectedId: "", dirty: {}, offset: 0, pageSize: 250, total: 0 },
  tableBrowser: { summaries: [], selected: null, rowOffset: 0, rowPageSize: 50, rowCount: 0 },
  artifactBrowser: { artifacts: [], selected: null, detail: null, loaded: false },
  roster: { players: [], selectedId: "", dirty: {}, file: "", offset: 0, pageSize: 500 },
};

const CONFIG_STORAGE_KEY = "cfb27.generator.config.current";
const VIEW_STORAGE_KEY = "cfb27.generator.activeView";

const LOCK_FIELD_OPTIONS = [
  ["identity", "Identity"],
  ["footballProfile", "Football Profile"],
  ["gameFields.ratings", "Ratings"],
  ["gameFields.developmentTrait", "Development"],
  ["gameFields.size", "Size"],
  ["gameFields.appearanceToken", "Appearance"],
  ["gameFields.abilities", "Abilities"],
];

const POSITION_WEIGHT_ORDER = [
  "QB",
  "HB",
  "FB",
  "WR",
  "TE",
  "LT",
  "LG",
  "C",
  "RG",
  "RT",
  "LE",
  "RE",
  "DT",
  "LOLB",
  "MLB",
  "ROLB",
  "CB",
  "FS",
  "SS",
  "K",
  "P",
];

const DEVELOPMENT_TRAIT_ORDER = ["Normal", "College_Impact", "College_Star", "College_Elite"];
const QUALITY_MODIFIER_ORDER = ["Gem", "Bust"];
const PROFILE_SCORE_KEYS = [
  ["readiness", "Ready"],
  ["physical", "Physical"],
  ["technical", "Technical"],
  ["mental", "Mental"],
  ["ceiling", "Ceiling"],
];

const els = {
  status: document.querySelector("#status"),
  fileSelect: document.querySelector("#fileSelect"),
  refreshBtn: document.querySelector("#refreshBtn"),
  backupBtn: document.querySelector("#backupBtn"),
  artifactsBtn: document.querySelector("#artifactsBtn"),
  cleanupArtifactsBtn: document.querySelector("#cleanupArtifactsBtn"),
  metrics: document.querySelector("#metrics"),
  profileSearch: document.querySelector("#profileSearch"),
  seedInput: document.querySelector("#seedInput"),
  generatePreviewBtn: document.querySelector("#generatePreviewBtn"),
  applyPreviewBtn: document.querySelector("#applyPreviewBtn"),
  exportPatchBtn: document.querySelector("#exportPatchBtn"),
  reloadProfilesBtn: document.querySelector("#reloadProfilesBtn"),
  previewSummary: document.querySelector("#previewSummary"),
  previewBrowser: document.querySelector("#previewBrowser"),
  configName: document.querySelector("#configName"),
  configMeta: document.querySelector("#configMeta"),
  configEditor: document.querySelector("#configEditor"),
  configWarnings: document.querySelector("#configWarnings"),
  validateConfigBtn: document.querySelector("#validateConfigBtn"),
  importConfigBtn: document.querySelector("#importConfigBtn"),
  exportConfigBtn: document.querySelector("#exportConfigBtn"),
  duplicateConfigBtn: document.querySelector("#duplicateConfigBtn"),
  resetConfigBtn: document.querySelector("#resetConfigBtn"),
  configFileInput: document.querySelector("#configFileInput"),
  configQuickForm: document.querySelector("#configQuickForm"),
  configDisplayName: document.querySelector("#configDisplayName"),
  configIdInput: document.querySelector("#configIdInput"),
  fiveStarCountInput: document.querySelector("#fiveStarCountInput"),
  fourStarCountInput: document.querySelector("#fourStarCountInput"),
  classStrengthMinInput: document.querySelector("#classStrengthMinInput"),
  classStrengthMaxInput: document.querySelector("#classStrengthMaxInput"),
  overallToleranceInput: document.querySelector("#overallToleranceInput"),
  maxRareOverallInput: document.querySelector("#maxRareOverallInput"),
  starRatingWriteSelect: document.querySelector("#starRatingWriteSelect"),
  archetypeWriteSelect: document.querySelector("#archetypeWriteSelect"),
  qualityWriteSelect: document.querySelector("#qualityWriteSelect"),
  configStructured: document.querySelector("#configStructured"),
  profilesBody: document.querySelector("#profilesBody"),
  profileInspector: document.querySelector("#profileInspector"),
  viewTabs: Array.from(document.querySelectorAll("[data-view-tab]")),
  viewSections: Array.from(document.querySelectorAll("[data-view]")),
  loadRecruitEditorBtn: document.querySelector("#loadRecruitEditorBtn"),
  saveRecruitEditorBtn: document.querySelector("#saveRecruitEditorBtn"),
  recruitEditorSearch: document.querySelector("#recruitEditorSearch"),
  recruitEditorPrevBtn: document.querySelector("#recruitEditorPrevBtn"),
  recruitEditorPageInfo: document.querySelector("#recruitEditorPageInfo"),
  recruitEditorNextBtn: document.querySelector("#recruitEditorNextBtn"),
  recruitEditorHead: document.querySelector("#recruitEditorHead"),
  recruitEditorBody: document.querySelector("#recruitEditorBody"),
  recruitEditorForm: document.querySelector("#recruitEditorForm"),
  refreshSaveToolsBtn: document.querySelector("#refreshSaveToolsBtn"),
  backupSelectedSaveBtn: document.querySelector("#backupSelectedSaveBtn"),
  artifactKindFilter: document.querySelector("#artifactKindFilter"),
  artifactSearch: document.querySelector("#artifactSearch"),
  listArtifactsBtn: document.querySelector("#listArtifactsBtn"),
  saveToolsBody: document.querySelector("#saveToolsBody"),
  artifactList: document.querySelector("#artifactList"),
  schemaQuery: document.querySelector("#schemaQuery"),
  schemaDomain: document.querySelector("#schemaDomain"),
  schemaSearchBtn: document.querySelector("#schemaSearchBtn"),
  schemaOccurrencesBtn: document.querySelector("#schemaOccurrencesBtn"),
  schemaHead: document.querySelector("#schemaHead"),
  schemaBody: document.querySelector("#schemaBody"),
  deepTablesCheck: document.querySelector("#deepTablesCheck"),
  discoverTablesBtn: document.querySelector("#discoverTablesBtn"),
  tableSummaryBody: document.querySelector("#tableSummaryBody"),
  tableRowsPanel: document.querySelector("#tableRowsPanel"),
  loadRosterBtn: document.querySelector("#loadRosterBtn"),
  saveRosterPlayerBtn: document.querySelector("#saveRosterPlayerBtn"),
  rosterSearch: document.querySelector("#rosterSearch"),
  rosterPrevBtn: document.querySelector("#rosterPrevBtn"),
  rosterPageInfo: document.querySelector("#rosterPageInfo"),
  rosterNextBtn: document.querySelector("#rosterNextBtn"),
  rosterBody: document.querySelector("#rosterBody"),
  rosterForm: document.querySelector("#rosterForm"),
};

function setStatus(message, isWarning = false) {
  els.status.textContent = message;
  els.status.classList.toggle("warning", isWarning);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function numberFmt(value) {
  if (value === undefined || value === null || value === "") return "-";
  return new Intl.NumberFormat().format(value);
}

function dateFmt(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString();
}

function currentViewFromStorage() {
  return "generator";
}

function sectionMatchesView(section, view) {
  return String(section.dataset.view || "").split(/\s+/).includes(view);
}

function setActiveView(view, persist = true) {
  state.activeView = els.viewTabs.some((tab) => tab.dataset.viewTab === view) ? view : "generator";
  if (persist) localStorage.setItem(VIEW_STORAGE_KEY, state.activeView);
  for (const tab of els.viewTabs) {
    const active = tab.dataset.viewTab === state.activeView;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
  }
  for (const section of els.viewSections) {
    section.hidden = !sectionMatchesView(section, state.activeView);
  }
  if (state.activeView === "save-tools") renderSaveTools();
  if (state.activeView === "recruit-editor" && !state.recruitEditor.rows.length) {
    loadRecruitEditor().catch((error) => setStatus(error.message, true));
  }
  if (state.activeView === "schema" && !els.schemaBody.children.length) {
    searchSchema(false).catch((error) => setStatus(error.message, true));
  }
  if (state.activeView === "tables" && !state.tableBrowser.summaries.length) {
    discoverTables().catch((error) => setStatus(error.message, true));
  }
}

function configLabel() {
  if (!state.currentConfig) return "-";
  return state.currentConfig.name || state.currentConfig.id || "-";
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadStoredConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredConfig(config = state.currentConfig) {
  if (!config) {
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    return;
  }
  localStorage.setItem(CONFIG_STORAGE_KEY, prettyJson(config));
}

function scoreNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(1, number)) * 100);
}

function intFromInput(input, fallback = 0) {
  const number = Number(input.value);
  return Number.isInteger(number) ? number : fallback;
}

function numberFromInput(input, fallback = 0) {
  const number = Number(input.value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumberFromInput(input, fallback = null) {
  if (String(input.value || "").trim() === "") return fallback;
  const number = Number(input.value);
  return Number.isFinite(number) ? number : fallback;
}

function writeFieldValueFromSelect(select) {
  if (select.value === "true") return true;
  if (select.value === "false") return false;
  return "after-research";
}

function selectValueForWriteField(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "after-research";
}

function populateWriteFieldSelect(select) {
  select.innerHTML = [
    ["after-research", "After Research"],
    ["false", "Disabled"],
    ["true", "Request Write"],
  ]
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
}

function scoreCell(value) {
  const score = scoreNumber(value);
  return `
    <div class="score-cell" title="${score}">
      <span style="width:${score}%"></span>
      <strong>${score}</strong>
    </div>
  `;
}

function selectedFileInfo() {
  return state.files.find((file) => file.name === state.selectedFile) || null;
}

function profileName(profile) {
  const identity = profile.identity || {};
  return `${identity.firstName || ""} ${identity.lastName || ""}`.trim();
}

function generatedWriteCount(profile) {
  return Object.keys((profile.gameFields && profile.gameFields.generatedWrites) || {}).length;
}

function lockStorageKey() {
  return `cfb27.generator.locks.${state.saveFingerprint || state.selectedFile || "unselected"}`;
}

function profileLockKey(profile) {
  const source = profile.source || {};
  return `${source.saveFingerprint || state.saveFingerprint}:R${source.recruitRow}:P${source.playerRow}`;
}

function defaultLocks() {
  return { rowLocked: false, fields: [] };
}

function loadLockMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(lockStorageKey()) || "{}");
    state.lockMap = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    state.lockMap = {};
  }
}

function saveLockMap() {
  localStorage.setItem(lockStorageKey(), JSON.stringify(state.lockMap));
}

function locksForProfile(profile) {
  const stored = state.lockMap[profileLockKey(profile)] || {};
  return {
    rowLocked: Boolean(stored.rowLocked),
    fields: Array.isArray(stored.fields) ? stored.fields.slice().sort() : [],
  };
}

function applyStoredLocks() {
  state.profiles = state.profiles.map((profile) => ({
    ...profile,
    locks: locksForProfile(profile),
  }));
}

function selectedProfile() {
  return state.profiles.find((item) => item.recruitId === state.selectedProfileId) || null;
}

function updateProfileLocks(profile, locks) {
  const key = profileLockKey(profile);
  const normalized = {
    rowLocked: Boolean(locks.rowLocked),
    fields: Array.from(new Set(locks.fields || [])).sort(),
  };
  if (!normalized.rowLocked && !normalized.fields.length) {
    delete state.lockMap[key];
  } else {
    state.lockMap[key] = normalized;
  }
  saveLockMap();
  profile.locks = normalized;
}

function preservedFieldCount(profile) {
  const original = profile.originalFields || {};
  return Object.values(original).reduce((total, group) => {
    if (!group || typeof group !== "object") return total;
    return total + Object.keys(group).length;
  }, 0);
}

function capabilityCounts() {
  const counts = {};
  for (const field of state.fieldCapabilities) {
    const key = field.generatorState || field.status || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function renderFiles() {
  els.fileSelect.innerHTML = state.files
    .map((file) => `<option value="${escapeHtml(file.name)}">${escapeHtml(file.name)}</option>`)
    .join("");
  els.fileSelect.value = state.selectedFile;
  renderSaveTools();
}

function renderMetrics(file = selectedFileInfo()) {
  const counts = capabilityCounts();
  const items = [
    ["Class", numberFmt(state.recordCount)],
    ["Loaded", numberFmt(state.profiles.length)],
    ["Preview Diffs", numberFmt(state.currentPreview?.summary?.diffCount || 0)],
    ["Writable", numberFmt(counts.writable || 0)],
    ["Skipped", numberFmt(counts["skipped because unverified"] || 0)],
    ["Config", configLabel()],
    ["Size", file ? `${numberFmt(file.size)} bytes` : "-"],
    ["Modified", file ? dateFmt(file.modified) : "-"],
  ];
  els.metrics.innerHTML = items
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function summaryChips(items) {
  return Object.entries(items || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => `<span>${escapeHtml(label)} <strong>${numberFmt(value)}</strong></span>`)
    .join("");
}

function budgetChips(items) {
  return Object.entries(items || {})
    .map(([label, budget]) => {
      const actual = budget?.actual ?? 0;
      const target = budget?.target ?? 0;
      const range = `${numberFmt(budget?.min ?? 0)}-${numberFmt(budget?.max ?? 0)}`;
      return `<span title="Configured ${range}">${escapeHtml(label)} <strong>${numberFmt(actual)}/${numberFmt(target)}</strong></span>`;
    })
    .join("");
}

function previewStaleReason(preview = state.currentPreview) {
  if (!preview) return "";
  const context = state.previewContext || {};
  if (context.file && context.file !== state.selectedFile) {
    return "selected save changed after preview";
  }
  const previewFingerprint = context.saveFingerprint || preview.saveFingerprint || "";
  if (previewFingerprint && state.saveFingerprint && previewFingerprint !== state.saveFingerprint) {
    return "save fingerprint changed after preview";
  }
  const fileInfo = selectedFileInfo();
  if (fileInfo && context.fileModified && fileInfo.modified !== context.fileModified) {
    return "save modified time changed after preview";
  }
  if (fileInfo && context.fileSize && fileInfo.size !== context.fileSize) {
    return "save size changed after preview";
  }
  return "";
}

function renderPreviewSummary() {
  const preview = state.currentPreview;
  if (!preview) {
    els.previewSummary.innerHTML = "";
    els.previewSummary.classList.remove("active");
    els.applyPreviewBtn.disabled = true;
    els.exportPatchBtn.disabled = true;
    return;
  }
  const summary = preview.summary || {};
  const validationCounts = preview.validationReport?.counts || {};
  const apply = state.lastApplyResult;
  const staleReason = previewStaleReason(preview);
  els.applyPreviewBtn.disabled = !preview.valid || Boolean(apply) || Boolean(staleReason);
  els.exportPatchBtn.disabled = !preview.valid || Boolean(staleReason);
  els.previewSummary.classList.add("active");
  els.previewSummary.innerHTML = `
    <div class="preview-head">
      <div>
        <strong>${preview.valid ? "Preview Ready" : "Preview Has Errors"}</strong>
        <span title="${escapeHtml(preview.previewId || "")}">${escapeHtml((preview.previewId || "").slice(0, 16))}</span>
      </div>
      <div>
        <span>Seed ${escapeHtml(preview.seed || "")}</span>
        <span>${numberFmt(summary.diffCount || 0)} diffs</span>
        <span>${numberFmt(summary.skippedFieldCount || 0)} skipped</span>
        <span>${numberFmt(summary.validationErrorCount || 0)} validation errors</span>
        <span>${numberFmt(summary.validationWarningCount || 0)} validation warnings</span>
        ${staleReason ? `<span class="stale-preview">Stale: ${escapeHtml(staleReason)}</span>` : ""}
      </div>
    </div>
    <div class="preview-groups">
      <div><b>Stars</b>${summaryChips(summary.stars)}</div>
      <div><b>Rank Bands</b>${summaryChips(summary.rankBands)}</div>
      <div><b>Development</b>${summaryChips(summary.development)}</div>
      <div><b>Quality</b>${summaryChips(summary.qualityModifier)}</div>
      <div><b>Budgets</b>${budgetChips(summary.budgets)}</div>
      <div><b>Validation</b>${summaryChips(validationCounts)}</div>
    </div>
    ${apply ? `
      <div class="apply-result">
        <span>${apply.applied ? "Applied" : "Applied With Mismatches"}</span>
        <span>${numberFmt(apply.appliedRecruitCount || 0)} recruits</span>
        <span>${numberFmt(apply.changedFieldCount || 0)} fields</span>
        <span title="${escapeHtml(apply.targetPath || "")}">${escapeHtml(apply.writeMode === "copy" ? "New Copy" : "Overwrite")}</span>
        <span title="${escapeHtml(apply.backup?.backup || "")}">Backup</span>
        <span title="${escapeHtml(apply.sidecar?.path || "")}">Sidecar</span>
        <span title="${escapeHtml(apply.report?.path || "")}">Report</span>
      </div>
    ` : ""}
  `;
}

function renderApplyDetails() {
  const apply = state.lastApplyResult;
  const patchExport = state.lastPatchExport;
  if (!apply && !patchExport) return "";
  const mismatches = apply?.readBackMismatches || [];
  const errors = state.currentPreview?.validationReport?.errors || [];
  const warnings = state.currentPreview?.validationReport?.warnings || [];
  const artifactMessage = apply && apply.artifactWriteSucceeded
    ? "Artifacts written"
    : `Artifact error: ${apply?.artifactError || "unknown error"}`;
  return `
    <section class="apply-detail-panel">
      ${patchExport ? `
        <h3>Dry Run Patch</h3>
        <dl class="apply-detail-grid">
          <div><dt>Status</dt><dd>Exported</dd></div>
          <div><dt>Recruits</dt><dd>${numberFmt(patchExport.appliedRecruitCount || 0)}</dd></div>
          <div><dt>Fields</dt><dd>${numberFmt(patchExport.changedFieldCount || 0)}</dd></div>
          <div><dt>Preview</dt><dd title="${escapeHtml(patchExport.previewId || "")}">${escapeHtml((patchExport.previewId || "").slice(0, 16))}</dd></div>
        </dl>
      ` : ""}
      ${apply ? `
        <h3>Apply Result</h3>
        <dl class="apply-detail-grid">
          <div><dt>Save Write</dt><dd>${apply.writeSucceeded ? (apply.writeMode === "copy" ? "New copy written" : "Overwritten") : "Failed"}</dd></div>
          <div><dt>Target</dt><dd title="${escapeHtml(apply.targetPath || "")}">${escapeHtml(apply.targetFile || "-")}</dd></div>
          <div><dt>Read Back</dt><dd>${mismatches.length ? `${numberFmt(mismatches.length)} mismatch(es)` : "Matched"}</dd></div>
          <div><dt>Artifacts</dt><dd title="${escapeHtml(apply.artifactError || "")}">${escapeHtml(artifactMessage)}</dd></div>
          <div><dt>Backup</dt><dd title="${escapeHtml(apply.backup?.backup || "")}">${escapeHtml(apply.backup?.backup || "-")}</dd></div>
          <div><dt>Sidecar</dt><dd title="${escapeHtml(apply.sidecar?.path || "")}">${escapeHtml(apply.sidecar?.path || "-")}</dd></div>
          <div><dt>Report</dt><dd title="${escapeHtml(apply.report?.path || "")}">${escapeHtml(apply.report?.path || "-")}</dd></div>
        </dl>
        <table class="compact-table">
          <thead><tr><th>Type</th><th>Detail</th><th>Expected</th><th>Actual</th></tr></thead>
          <tbody>
            ${mismatches.slice(0, 12).map((item) => `
              <tr>
                <td>${escapeHtml(item.field || "read-back")}</td>
                <td title="${escapeHtml(item.recruitId || "")}">${escapeHtml(item.recruitId || item.recruitRow || "")}</td>
                <td>${escapeHtml(item.expected ?? "")}</td>
                <td>${escapeHtml(item.actual ?? "")}</td>
              </tr>
            `).join("")}
            ${errors.slice(0, 6).map((item) => `
              <tr><td>Error</td><td colspan="3">${escapeHtml(item)}</td></tr>
            `).join("")}
            ${warnings.slice(0, 6).map((item) => `
              <tr><td>Warning</td><td colspan="3">${escapeHtml(item)}</td></tr>
            `).join("")}
            ${(!mismatches.length && !errors.length && !warnings.length) ? '<tr><td colspan="4">No read-back mismatches or validation messages</td></tr>' : ""}
          </tbody>
        </table>
      ` : ""}
    </section>
  `;
}

function renderPreviewBrowser() {
  const preview = state.currentPreview;
  if (!preview) {
    els.previewBrowser.innerHTML = "";
    els.previewBrowser.classList.remove("active");
    return;
  }
  const summary = preview.summary || {};
  const diffFields = summary.diffFields || [];
  const budgetConsumers = summary.budgetConsumers || {};
  const consumerRows = Object.entries(budgetConsumers)
    .flatMap(([budget, recruits]) => (recruits || []).slice(0, 8).map((recruit) => ({ budget, ...recruit })))
    .sort((left, right) => (left.rank || 999999) - (right.rank || 999999))
    .slice(0, 24);
  els.previewBrowser.classList.add("active");
  els.previewBrowser.innerHTML = `
    <section>
      <h3>Diff Fields</h3>
      <table class="compact-table">
        <thead>
          <tr><th>Field</th><th>Count</th><th>Sample</th></tr>
        </thead>
        <tbody>
          ${diffFields.slice(0, 16).map((item) => `
            <tr>
              <td title="${escapeHtml(item.field || "")}">${escapeHtml(item.patchKey || item.field || "")}</td>
              <td>${numberFmt(item.count || 0)}</td>
              <td title="${escapeHtml(item.sampleFrom ?? "")} -> ${escapeHtml(item.sampleTo ?? "")}">
                ${escapeHtml(item.sampleFrom ?? "")} -> ${escapeHtml(item.sampleTo ?? "")}
              </td>
            </tr>
          `).join("") || '<tr><td colspan="3">No writable diffs</td></tr>'}
        </tbody>
      </table>
    </section>
    <section>
      <h3>Budget Recruits</h3>
      <table class="compact-table">
        <thead>
          <tr><th>Budget</th><th>Recruit</th><th>OVR</th></tr>
        </thead>
        <tbody>
          ${consumerRows.map((item) => `
            <tr data-profile-id="${escapeHtml(item.recruitId || "")}">
              <td>${escapeHtml(item.budget || "")}</td>
              <td title="${escapeHtml(item.name || "")}">#${numberFmt(item.rank)} ${escapeHtml(item.position || "")} ${escapeHtml(item.name || "")}</td>
              <td>${numberFmt(item.overall)}</td>
            </tr>
          `).join("") || '<tr><td colspan="3">No budget recruits</td></tr>'}
        </tbody>
      </table>
    </section>
    ${renderApplyDetails()}
  `;
}

function renderConfigWarnings() {
  const errors = state.configErrors || [];
  const warnings = state.configWarnings || [];
  if (!errors.length && !warnings.length) {
    els.configWarnings.innerHTML = "No config warnings";
    return;
  }
  const chunks = [];
  if (errors.length) {
    chunks.push(`<strong>Errors</strong><ul>${errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
  }
  if (warnings.length) {
    chunks.push(`<strong>Warnings</strong><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
  }
  els.configWarnings.innerHTML = chunks.join("");
}

function renderConfigStructured(config) {
  if (!config || !els.configStructured) {
    if (els.configStructured) els.configStructured.innerHTML = "";
    return;
  }
  const weights = config.classBudget?.positionWeights || {};
  const rankBands = config.rankBands || [];
  const writeStates = config.writeFieldStates || {};
  const classBudget = config.classBudget || {};
  const development = config.development || {};
  const qualityModifier = config.qualityModifier || {};
  const profileTypes = config.profileTypes || {};
  const bodyRules = config.bodyRules || {};
  const positionRows = POSITION_WEIGHT_ORDER.map((position) => `
    <label>
      <span>${escapeHtml(position)}</span>
      <input data-position-weight="${escapeHtml(position)}" type="number" min="0" max="1" step="0.000001" value="${escapeHtml(weights[position] ?? 0)}">
    </label>
  `).join("");
  const budgetRows = [
    ["generationalFreshmanCount", "Generational"],
    ["eliteDevelopmentCount", "Elite Dev"],
    ["platinumPhysicalAbilityCount", "Platinum Phys"],
  ].map(([key, label]) => {
    const value = classBudget[key] || {};
    return `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td><input data-class-budget-range="${escapeHtml(key)}" data-range-bound="min" type="number" min="0" value="${escapeHtml(value.min ?? 0)}"></td>
        <td><input data-class-budget-range="${escapeHtml(key)}" data-range-bound="max" type="number" min="0" value="${escapeHtml(value.max ?? 0)}"></td>
      </tr>
    `;
  }).join("");
  const rankRows = rankBands.map((band, index) => `
    <tr>
      <td title="${escapeHtml(band.id || "")}">${escapeHtml(band.id || "")}</td>
      <td><input data-rank-band-index="${index}" data-rank-band-field="minRank" type="number" min="1" value="${escapeHtml(band.minRank ?? "")}"></td>
      <td><input data-rank-band-index="${index}" data-rank-band-field="maxRank" type="number" min="1" value="${escapeHtml(band.maxRank ?? "")}"></td>
      <td><input data-rank-band-index="${index}" data-rank-band-field="expectedOverall.min" type="number" min="0" max="100" value="${escapeHtml(band.expectedOverall?.min ?? "")}"></td>
      <td><input data-rank-band-index="${index}" data-rank-band-field="expectedOverall.max" type="number" min="0" max="100" value="${escapeHtml(band.expectedOverall?.max ?? "")}"></td>
      <td><input data-rank-band-index="${index}" data-rank-band-field="rareMaxOverall" type="number" min="0" max="100" value="${escapeHtml(band.rareMaxOverall ?? "")}"></td>
    </tr>
  `).join("");
  const developmentTraitRows = DEVELOPMENT_TRAIT_ORDER.map((trait) => `
    <tr>
      <td>${escapeHtml(trait)}</td>
      <td><input data-development-trait-weight="${escapeHtml(trait)}" type="number" min="0" max="1" step="0.000001" value="${escapeHtml(development.traitWeights?.[trait] ?? 0)}"></td>
    </tr>
  `).join("");
  const developmentBandRows = rankBands.map((band) => `
    <tr>
      <td title="${escapeHtml(band.id || "")}">${escapeHtml(band.id || "")}</td>
      <td><input data-development-rank-band="${escapeHtml(band.id || "")}" type="number" min="0" step="0.05" value="${escapeHtml(development.rankBandMultipliers?.[band.id] ?? 1)}"></td>
    </tr>
  `).join("");
  const qualityRows = QUALITY_MODIFIER_ORDER.map((quality) => {
    const budget = qualityModifier.budgets?.[quality] || {};
    return `
      <tr>
        <td>${escapeHtml(quality)}</td>
        <td><input data-quality-budget="${escapeHtml(quality)}" data-range-bound="min" type="number" min="0" value="${escapeHtml(budget.min ?? 0)}"></td>
        <td><input data-quality-budget="${escapeHtml(quality)}" data-range-bound="max" type="number" min="0" value="${escapeHtml(budget.max ?? 0)}"></td>
      </tr>
    `;
  }).join("");
  const profileRankHead = rankBands.map((band) => `<th title="${escapeHtml(band.id || "")}">${escapeHtml(band.id || "")}</th>`).join("");
  const profileRankRows = Object.entries(profileTypes).map(([profileId, profile]) => `
    <tr>
      <td title="${escapeHtml(profileId)}">${escapeHtml(profileId)}</td>
      ${rankBands.map((band) => `
        <td><input data-profile-type="${escapeHtml(profileId)}" data-profile-type-rank-band="${escapeHtml(band.id || "")}" type="number" min="0" max="1" step="0.000001" value="${escapeHtml(profile.rankBandWeights?.[band.id] ?? 0)}"></td>
      `).join("")}
    </tr>
  `).join("");
  const profileRangeHead = PROFILE_SCORE_KEYS.map(([, label]) => `<th colspan="2">${escapeHtml(label)}</th>`).join("");
  const profileRangeSubhead = PROFILE_SCORE_KEYS.map(() => "<th>Min</th><th>Max</th>").join("");
  const profileRangeRows = Object.entries(profileTypes).map(([profileId, profile]) => `
    <tr>
      <td title="${escapeHtml(profileId)}">${escapeHtml(profileId)}</td>
      ${PROFILE_SCORE_KEYS.map(([key]) => `
        <td><input data-profile-type="${escapeHtml(profileId)}" data-profile-type-range="${escapeHtml(key)}" data-range-bound="min" type="number" min="0" max="1" step="0.01" value="${escapeHtml(profile[key]?.min ?? 0)}"></td>
        <td><input data-profile-type="${escapeHtml(profileId)}" data-profile-type-range="${escapeHtml(key)}" data-range-bound="max" type="number" min="0" max="1" step="0.01" value="${escapeHtml(profile[key]?.max ?? 0)}"></td>
      `).join("")}
    </tr>
  `).join("");
  const bodyRuleRows = Object.entries(bodyRules).map(([ruleId, rule]) => `
    <tr>
      <td title="${escapeHtml(ruleId)}">${escapeHtml(ruleId)}</td>
      <td><input data-body-rule="${escapeHtml(ruleId)}" data-body-rule-field="heightInches" data-range-bound="min" type="number" min="48" max="96" value="${escapeHtml(rule.heightInches?.min ?? "")}"></td>
      <td><input data-body-rule="${escapeHtml(ruleId)}" data-body-rule-field="heightInches" data-range-bound="max" type="number" min="48" max="96" value="${escapeHtml(rule.heightInches?.max ?? "")}"></td>
      <td><input data-body-rule="${escapeHtml(ruleId)}" data-body-rule-field="weightLbs" data-range-bound="min" type="number" min="160" max="415" value="${escapeHtml(rule.weightLbs?.min ?? "")}"></td>
      <td><input data-body-rule="${escapeHtml(ruleId)}" data-body-rule-field="weightLbs" data-range-bound="max" type="number" min="160" max="415" value="${escapeHtml(rule.weightLbs?.max ?? "")}"></td>
    </tr>
  `).join("");
  const writeRows = Object.entries(writeStates)
    .map(([group, detail]) => `
      <tr>
        <td>${escapeHtml(group)}</td>
        <td>${escapeHtml(detail?.state || "")}</td>
        <td>${numberFmt((detail?.fields || []).length)}</td>
        <td>${numberFmt((detail?.blockedFields || []).length)}</td>
      </tr>
    `)
    .join("");
  els.configStructured.innerHTML = `
    <section>
      <h3>Position Weights</h3>
      <div class="position-weight-grid">${positionRows}</div>
    </section>
    <section>
      <h3>Class Budgets</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table config-number-table">
          <thead><tr><th>Budget</th><th>Min</th><th>Max</th></tr></thead>
          <tbody>${budgetRows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h3>Rank Bands</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table config-number-table">
          <thead><tr><th>Band</th><th>Min Rank</th><th>Max Rank</th><th>OVR Min</th><th>OVR Max</th><th>Rare Max</th></tr></thead>
          <tbody>${rankRows || '<tr><td colspan="6" class="empty-row">No rank bands configured</td></tr>'}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h3>Development</h3>
      <div class="split-config-tables">
        <div class="support-table-wrap inset">
          <table class="compact-table config-number-table">
            <thead><tr><th>Trait</th><th>Weight</th></tr></thead>
            <tbody>${developmentTraitRows}</tbody>
          </table>
        </div>
        <div class="support-table-wrap inset">
          <table class="compact-table config-number-table">
            <thead><tr><th>Rank Band</th><th>Multiplier</th></tr></thead>
            <tbody>${developmentBandRows || '<tr><td colspan="2" class="empty-row">No rank bands configured</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </section>
    <section>
      <h3>Quality Budgets</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table config-number-table">
          <thead><tr><th>Modifier</th><th>Min</th><th>Max</th></tr></thead>
          <tbody>${qualityRows}</tbody>
        </table>
      </div>
    </section>
    <section class="wide-config-section">
      <h3>Profile Type Weights</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table config-number-table">
          <thead><tr><th>Profile</th>${profileRankHead}</tr></thead>
          <tbody>${profileRankRows || `<tr><td colspan="${rankBands.length + 1}" class="empty-row">No profile types configured</td></tr>`}</tbody>
        </table>
      </div>
    </section>
    <section class="wide-config-section">
      <h3>Profile Score Ranges</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table config-number-table">
          <thead><tr><th rowspan="2">Profile</th>${profileRangeHead}</tr><tr>${profileRangeSubhead}</tr></thead>
          <tbody>${profileRangeRows || '<tr><td colspan="11" class="empty-row">No profile types configured</td></tr>'}</tbody>
        </table>
      </div>
    </section>
    <section class="wide-config-section">
      <h3>Body Rules</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table config-number-table">
          <thead><tr><th>Rule</th><th>Height Min</th><th>Height Max</th><th>Weight Min</th><th>Weight Max</th></tr></thead>
          <tbody>${bodyRuleRows || '<tr><td colspan="5" class="empty-row">No body rules configured</td></tr>'}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h3>Write States</h3>
      <div class="support-table-wrap inset">
        <table class="compact-table">
          <thead><tr><th>Group</th><th>State</th><th>Fields</th><th>Blocked</th></tr></thead>
          <tbody>${writeRows || '<tr><td colspan="4" class="empty-row">No write states</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderConfigControls() {
  const config = state.currentConfig;
  if (!config) {
    els.configQuickForm.reset();
    renderConfigStructured(null);
    return;
  }
  const budget = config.classBudget || {};
  const strength = budget.classStrengthModifier || {};
  const validation = config.validation || {};
  const writeFields = config.writeFields || {};
  els.configDisplayName.value = config.name || "";
  els.configIdInput.value = config.id || "";
  els.fiveStarCountInput.value = budget.fiveStarCount ?? "";
  els.fourStarCountInput.value = budget.fourStarCount ?? "";
  els.classStrengthMinInput.value = strength.min ?? "";
  els.classStrengthMaxInput.value = strength.max ?? "";
  els.overallToleranceInput.value = validation.overallTolerance ?? "";
  els.maxRareOverallInput.value = validation.maxRareOverallCount ?? "";
  els.starRatingWriteSelect.value = selectValueForWriteField(writeFields.starRating);
  els.archetypeWriteSelect.value = selectValueForWriteField(writeFields.archetype);
  els.qualityWriteSelect.value = selectValueForWriteField(writeFields.qualityModifier);
  renderConfigStructured(config);
}

function renderConfig() {
  const config = state.currentConfig;
  if (!config) {
    els.configName.textContent = "Config";
    els.configMeta.textContent = "Version -";
    els.configEditor.value = "";
    renderConfigWarnings();
    renderConfigControls();
    renderMetrics();
    return;
  }
  els.configName.textContent = config.name || config.id || "Config";
  els.configMeta.textContent = `Version ${config.configVersion || "-"} | ${config.generator?.writePolicy || "-"}`;
  els.configEditor.value = prettyJson(config);
  renderConfigWarnings();
  renderConfigControls();
  renderMetrics();
}

async function validateConfigObject(config, updateEditor = true) {
  const requestBody = { config };
  if (state.recordCount > 0) {
    requestBody.recruitCount = state.recordCount;
  }
  const payload = await api("/api/generator/config/validate", {
    method: "POST",
    body: JSON.stringify(requestBody),
  });
  state.configErrors = payload.errors || [];
  state.configWarnings = [
    ...(payload.migrationWarnings || []),
    ...(payload.warnings || []),
  ];
  if (!payload.valid) {
    renderConfigWarnings();
    throw new Error(state.configErrors[0] || "Config is invalid");
  }
  state.currentConfig = payload.normalizedConfig;
  saveStoredConfig();
  if (updateEditor) renderConfig();
  return payload.normalizedConfig;
}

async function validateConfigFromEditor() {
  let parsed;
  try {
    parsed = JSON.parse(els.configEditor.value);
  } catch (error) {
    state.configErrors = [error.message];
    state.configWarnings = [];
    renderConfigWarnings();
    setStatus("Config JSON is invalid", true);
    return;
  }
  try {
    await validateConfigObject(parsed);
    const warningCount = state.configWarnings.length;
    setStatus(warningCount ? `Config normalized with ${numberFmt(warningCount)} warning(s)` : "Config validated");
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadGeneratorConfigs() {
  const payload = await api("/api/generator/default-configs");
  state.defaultConfigs = payload.configs || [];
  const storedConfig = loadStoredConfig();
  if (storedConfig) {
    try {
      await validateConfigObject(storedConfig, false);
    } catch {
      state.currentConfig = state.defaultConfigs[0] || null;
      state.configWarnings = ["Saved config was invalid and the built-in default was restored"];
      state.configErrors = [];
      saveStoredConfig();
    }
  } else {
    state.currentConfig = state.defaultConfigs[0] || null;
    state.configWarnings = [];
    state.configErrors = [];
    saveStoredConfig();
  }
  renderConfig();
}

function resetConfig() {
  state.currentConfig = state.defaultConfigs[0] ? deepClone(state.defaultConfigs[0]) : null;
  state.configWarnings = [];
  state.configErrors = [];
  saveStoredConfig();
  renderConfig();
  setStatus("Reset generator config");
}

function duplicateConfig() {
  if (!state.currentConfig) return;
  const clone = deepClone(state.currentConfig);
  const suffix = Date.now().toString(36);
  clone.id = `${String(clone.id || "config").replace(/-copy-[a-z0-9]+$/, "")}-copy-${suffix}`;
  clone.name = `${clone.name || "Config"} Copy`;
  state.currentConfig = clone;
  state.configWarnings = [];
  state.configErrors = [];
  saveStoredConfig();
  renderConfig();
  setStatus("Duplicated generator config");
}

async function applyConfigControls(event) {
  event.preventDefault();
  if (!state.currentConfig) return;
  const nextConfig = deepClone(state.currentConfig);
  nextConfig.id = els.configIdInput.value.trim();
  nextConfig.name = els.configDisplayName.value.trim();
  nextConfig.classBudget = nextConfig.classBudget || {};
  nextConfig.classBudget.fiveStarCount = intFromInput(els.fiveStarCountInput, nextConfig.classBudget.fiveStarCount || 0);
  nextConfig.classBudget.fourStarCount = intFromInput(els.fourStarCountInput, nextConfig.classBudget.fourStarCount || 0);
  nextConfig.classBudget.classStrengthModifier = {
    min: numberFromInput(els.classStrengthMinInput, nextConfig.classBudget.classStrengthModifier?.min || 0),
    max: numberFromInput(els.classStrengthMaxInput, nextConfig.classBudget.classStrengthModifier?.max || 0),
  };
  nextConfig.validation = nextConfig.validation || {};
  nextConfig.validation.overallTolerance = intFromInput(
    els.overallToleranceInput,
    nextConfig.validation.overallTolerance || 0,
  );
  nextConfig.validation.maxRareOverallCount = intFromInput(
    els.maxRareOverallInput,
    nextConfig.validation.maxRareOverallCount || 0,
  );
  nextConfig.writeFields = nextConfig.writeFields || {};
  nextConfig.writeFields.starRating = writeFieldValueFromSelect(els.starRatingWriteSelect);
  nextConfig.writeFields.archetype = writeFieldValueFromSelect(els.archetypeWriteSelect);
  nextConfig.writeFields.qualityModifier = writeFieldValueFromSelect(els.qualityWriteSelect);

  nextConfig.classBudget.positionWeights = {};
  els.configStructured.querySelectorAll("[data-position-weight]").forEach((input) => {
    const value = Number(input.value);
    nextConfig.classBudget.positionWeights[input.dataset.positionWeight] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
  els.configStructured.querySelectorAll("[data-class-budget-range][data-range-bound]").forEach((input) => {
    const key = input.dataset.classBudgetRange;
    const bound = input.dataset.rangeBound;
    nextConfig.classBudget[key] = nextConfig.classBudget[key] || {};
    nextConfig.classBudget[key][bound] = intFromInput(input, nextConfig.classBudget[key][bound] || 0);
  });
  nextConfig.rankBands = (nextConfig.rankBands || []).map((band) => deepClone(band));
  els.configStructured.querySelectorAll("[data-rank-band-index][data-rank-band-field]").forEach((input) => {
    const index = Number(input.dataset.rankBandIndex);
    const field = input.dataset.rankBandField;
    const value = field === "maxRank" ? optionalNumberFromInput(input, null) : Number(input.value);
    if (!Number.isInteger(index) || !nextConfig.rankBands[index]) return;
    if (field === "maxRank" && value === null) {
      nextConfig.rankBands[index][field] = null;
      return;
    }
    if (!Number.isFinite(value)) return;
    if (field === "expectedOverall.min") {
      nextConfig.rankBands[index].expectedOverall = nextConfig.rankBands[index].expectedOverall || {};
      nextConfig.rankBands[index].expectedOverall.min = value;
    } else if (field === "expectedOverall.max") {
      nextConfig.rankBands[index].expectedOverall = nextConfig.rankBands[index].expectedOverall || {};
      nextConfig.rankBands[index].expectedOverall.max = value;
    } else {
      nextConfig.rankBands[index][field] = value;
    }
  });
  nextConfig.development = nextConfig.development || {};
  nextConfig.development.traitWeights = {};
  els.configStructured.querySelectorAll("[data-development-trait-weight]").forEach((input) => {
    const value = Number(input.value);
    nextConfig.development.traitWeights[input.dataset.developmentTraitWeight] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
  nextConfig.development.rankBandMultipliers = {};
  els.configStructured.querySelectorAll("[data-development-rank-band]").forEach((input) => {
    const value = Number(input.value);
    nextConfig.development.rankBandMultipliers[input.dataset.developmentRankBand] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
  nextConfig.qualityModifier = nextConfig.qualityModifier || {};
  nextConfig.qualityModifier.budgets = nextConfig.qualityModifier.budgets || {};
  els.configStructured.querySelectorAll("[data-quality-budget][data-range-bound]").forEach((input) => {
    const quality = input.dataset.qualityBudget;
    const bound = input.dataset.rangeBound;
    nextConfig.qualityModifier.budgets[quality] = nextConfig.qualityModifier.budgets[quality] || {};
    nextConfig.qualityModifier.budgets[quality][bound] = intFromInput(input, nextConfig.qualityModifier.budgets[quality][bound] || 0);
  });
  nextConfig.profileTypes = nextConfig.profileTypes || {};
  els.configStructured.querySelectorAll("[data-profile-type][data-profile-type-rank-band]").forEach((input) => {
    const profileType = input.dataset.profileType;
    const band = input.dataset.profileTypeRankBand;
    const value = Number(input.value);
    nextConfig.profileTypes[profileType] = nextConfig.profileTypes[profileType] || {};
    nextConfig.profileTypes[profileType].rankBandWeights = nextConfig.profileTypes[profileType].rankBandWeights || {};
    nextConfig.profileTypes[profileType].rankBandWeights[band] = Number.isFinite(value) && value >= 0 ? value : 0;
  });
  els.configStructured.querySelectorAll("[data-profile-type][data-profile-type-range][data-range-bound]").forEach((input) => {
    const profileType = input.dataset.profileType;
    const range = input.dataset.profileTypeRange;
    const bound = input.dataset.rangeBound;
    nextConfig.profileTypes[profileType] = nextConfig.profileTypes[profileType] || {};
    nextConfig.profileTypes[profileType][range] = nextConfig.profileTypes[profileType][range] || {};
    nextConfig.profileTypes[profileType][range][bound] = numberFromInput(input, nextConfig.profileTypes[profileType][range][bound] || 0);
  });
  nextConfig.bodyRules = nextConfig.bodyRules || {};
  els.configStructured.querySelectorAll("[data-body-rule][data-body-rule-field][data-range-bound]").forEach((input) => {
    const rule = input.dataset.bodyRule;
    const field = input.dataset.bodyRuleField;
    const bound = input.dataset.rangeBound;
    nextConfig.bodyRules[rule] = nextConfig.bodyRules[rule] || {};
    nextConfig.bodyRules[rule][field] = nextConfig.bodyRules[rule][field] || {};
    nextConfig.bodyRules[rule][field][bound] = intFromInput(input, nextConfig.bodyRules[rule][field][bound] || 0);
  });

  try {
    await validateConfigObject(nextConfig);
    const warningCount = state.configWarnings.length;
    setStatus(warningCount ? `Config controls applied with ${numberFmt(warningCount)} warning(s)` : "Config controls applied");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function exportConfig() {
  if (!state.currentConfig) return;
  const blob = new Blob([`${prettyJson(state.currentConfig)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.currentConfig.id || "cfb27-generator"}.cfb27-generator.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Exported normalized config");
}

function importConfigFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    els.configEditor.value = String(reader.result || "");
    validateConfigFromEditor();
  };
  reader.onerror = () => setStatus("Could not read config file", true);
  reader.readAsText(file);
}

function profileMatches(profile, query) {
  if (!query) return true;
  const football = profile.footballProfile || {};
  const game = profile.gameFields || {};
  const text = [
    profile.recruitId,
    profile.playerId,
    profileName(profile),
    football.nationalRank,
    football.position,
    football.archetype,
    football.archetypeDisplay,
    football.profileType,
    football.bodyComposition,
    game.developmentTrait,
    game.qualityModifier,
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(query);
}

function renderProfiles() {
  const query = els.profileSearch.value.trim().toLowerCase();
  const visible = state.profiles.filter((profile) => profileMatches(profile, query)).slice(0, 700);
  if (!visible.length) {
    els.profilesBody.innerHTML = '<tr class="empty-row"><td colspan="11">No profiles</td></tr>';
    return;
  }

  els.profilesBody.innerHTML = visible
    .map((profile) => {
      const football = profile.footballProfile || {};
      const game = profile.gameFields || {};
      const source = profile.source || {};
      const selected = profile.recruitId === state.selectedProfileId ? " selected" : "";
      const ratings = game.ratings || {};
      const locks = profile.locks || defaultLocks();
      return `
        <tr class="${selected}" data-profile-id="${escapeHtml(profile.recruitId)}">
          <td>${numberFmt(football.nationalRank || 0)}</td>
          <td title="${escapeHtml(profileName(profile))}">${escapeHtml(profileName(profile))}</td>
          <td>${escapeHtml(football.position || "")}</td>
          <td title="${escapeHtml(football.archetype || "")}">${escapeHtml(football.archetypeDisplay || football.archetype || "")}</td>
          <td>${escapeHtml(football.profileType || "")}</td>
          <td>${numberFmt(ratings.overall)}</td>
          <td>${scoreCell(football.readinessScore)}</td>
          <td>${scoreCell(football.physicalScore)}</td>
          <td>${scoreCell(football.technicalScore)}</td>
          <td>${locks.rowLocked ? "Row" : numberFmt((locks.fields || []).length)}</td>
          <td title="${escapeHtml(profile.playerId || "")}">${numberFmt(source.recruitRow)} / ${numberFmt(source.playerRow)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCapabilityChips() {
  const counts = capabilityCounts();
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => `<span>${escapeHtml(label)} <strong>${numberFmt(count)}</strong></span>`)
    .join("");
}

function renderScoreGrid(football) {
  return `
    <div class="score-grid">
      <label>Ready ${scoreCell(football.readinessScore)}</label>
      <label>Physical ${scoreCell(football.physicalScore)}</label>
      <label>Technical ${scoreCell(football.technicalScore)}</label>
      <label>Mental ${scoreCell(football.mentalScore)}</label>
      <label>Ceiling ${scoreCell(football.ceilingScore)}</label>
    </div>
  `;
}

function renderGeneratedDiffTable(diffs) {
  if (!Array.isArray(diffs) || !diffs.length) {
    return '<div class="empty-state compact">No writable diffs for this recruit</div>';
  }
  return `
    <div class="diff-table-wrap">
      <table class="diff-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          ${diffs.slice(0, 40).map((diff) => `
            <tr>
              <td title="${escapeHtml(diff.field || "")}">${escapeHtml(diff.patchKey || diff.field || "")}</td>
              <td title="${escapeHtml(diff.from ?? "")}">${escapeHtml(diff.from ?? "")}</td>
              <td title="${escapeHtml(diff.to ?? "")}">${escapeHtml(diff.to ?? "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${diffs.length > 40 ? `<p class="table-note">${numberFmt(diffs.length - 40)} more writable diff(s) hidden</p>` : ""}
    </div>
  `;
}

function renderValidationDetails() {
  const report = state.currentPreview?.validationReport || null;
  if (!report) return "";
  const counts = report.counts || {};
  const rankBands = report.details?.rankBands || {};
  const positions = report.details?.positions || {};
  const samples = [
    ...((report.samples && report.samples.errors) || []),
    ...((report.samples && report.samples.warnings) || []),
  ];
  const rankBandItems = Object.entries(rankBands)
    .slice(0, 8)
    .map(([band, detail]) => `
      <span title="OVR ${numberFmt(detail.minOverall)}-${numberFmt(detail.maxOverall)}, avg ${numberFmt(detail.averageOverall)}">
        ${escapeHtml(band)} <strong>${numberFmt(detail.count)}</strong>
      </span>
    `)
    .join("");
  const positionItems = Object.entries(positions)
    .sort(([, left], [, right]) => (right.count || 0) - (left.count || 0))
    .slice(0, 10)
    .map(([position, detail]) => `<span>${escapeHtml(position)} <strong>${numberFmt(detail.count)}</strong></span>`)
    .join("");
  return `
    <section class="inspector-section">
      <h3>Validation Report</h3>
      <dl class="detail-grid">
        <div><dt>Status</dt><dd>${report.valid ? "Valid" : "Invalid"}</dd></div>
        <div><dt>Typical OVR Warnings</dt><dd>${numberFmt(counts.typicalOverallWarnings || 0)}</dd></div>
        <div><dt>Rating Bound Errors</dt><dd>${numberFmt(counts.ratingBoundErrors || 0)}</dd></div>
        <div><dt>Body Rule Errors</dt><dd>${numberFmt(counts.bodyRuleErrors || 0)}</dd></div>
        <div><dt>Weight Encoding Errors</dt><dd>${numberFmt(counts.encodedWeightErrors || 0)}</dd></div>
        <div><dt>Star Mismatches</dt><dd>${numberFmt(counts.starMismatches || 0)}</dd></div>
      </dl>
      <div class="state-chips">${rankBandItems}</div>
      <div class="state-chips">${positionItems}</div>
      ${samples.length ? `
        <div class="sample-list">
          ${samples.slice(0, 6).map((sample) => `
            <div>
              <span>#${numberFmt(sample.rank)} ${escapeHtml(sample.position || "")}</span>
              <strong>${numberFmt(sample.overall)} OVR</strong>
              <em>${escapeHtml(sample.issue || "")}</em>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderInspector(profile) {
  if (!profile) {
    els.profileInspector.innerHTML = '<div class="empty-state">Select a recruit profile</div>';
    return;
  }

  const identity = profile.identity || {};
  const football = profile.footballProfile || {};
  const game = profile.gameFields || {};
  const ratings = game.ratings || {};
  const source = profile.source || {};
  const appearance = game.appearanceToken || {};
  const locks = profile.locks || {};
  const intent = profile.generationIntent || {};
  const fingerprint = source.saveFingerprint || state.saveFingerprint || "";

  els.profileInspector.innerHTML = `
    <section class="inspector-section profile-head">
      <div>
        <h2>${escapeHtml(profileName(profile) || profile.recruitId)}</h2>
        <p>${escapeHtml(football.position || "")} | ${escapeHtml(football.archetypeDisplay || football.archetype || "")}</p>
      </div>
      <strong>#${numberFmt(football.nationalRank || 0)}</strong>
    </section>

    <section class="inspector-section">
      <h3>Football Identity</h3>
      <dl class="detail-grid">
        <div><dt>Profile</dt><dd>${escapeHtml(football.profileType || "")}</dd></div>
        <div><dt>Body</dt><dd>${escapeHtml(football.bodyComposition || "")}</dd></div>
        <div><dt>Generational</dt><dd>${intent.generationalFreshman ? "Yes" : "No"}</dd></div>
        <div><dt>Position Rank</dt><dd>${numberFmt(football.positionRank || 0)}</dd></div>
        <div><dt>State Rank</dt><dd>${numberFmt(football.stateRank || 0)}</dd></div>
        <div><dt>Home State</dt><dd>${escapeHtml(identity.homeState || "")}</dd></div>
        <div><dt>Hometown</dt><dd>${escapeHtml(identity.hometown || "")}</dd></div>
      </dl>
      ${renderScoreGrid(football)}
    </section>

    <section class="inspector-section">
      <h3>Ratings Core</h3>
      <dl class="rating-grid">
        <div><dt>OVR</dt><dd>${numberFmt(ratings.overall)}</dd></div>
        <div><dt>SPD</dt><dd>${numberFmt(ratings.speed)}</dd></div>
        <div><dt>ACC</dt><dd>${numberFmt(ratings.acceleration)}</dd></div>
        <div><dt>STR</dt><dd>${numberFmt(ratings.strength)}</dd></div>
        <div><dt>AWR</dt><dd>${numberFmt(ratings.awareness)}</dd></div>
        <div><dt>AGI</dt><dd>${numberFmt(ratings.agility)}</dd></div>
      </dl>
    </section>

    <section class="inspector-section">
      <h3>Game Fields</h3>
      <dl class="detail-grid">
        <div><dt>Development</dt><dd>${escapeHtml(game.developmentTrait || "")}</dd></div>
        <div><dt>Quality</dt><dd>${escapeHtml(game.qualityModifier || "")}</dd></div>
        <div><dt>Star Raw</dt><dd title="${escapeHtml(game.starRating || "")}">${escapeHtml(game.starRating || "")}</dd></div>
        <div><dt>Body Type</dt><dd>${escapeHtml(game.bodyType || "")}</dd></div>
        <div><dt>Size</dt><dd>${numberFmt(game.heightInches)} in / ${numberFmt(game.weightLbs)} lb</dd></div>
        <div><dt>Jersey</dt><dd>${numberFmt(game.jerseyNumber)}</dd></div>
        <div><dt>Head</dt><dd title="${escapeHtml(appearance.genericHeadAssetName || "")}">${escapeHtml(appearance.genericHeadAssetName || "")}</dd></div>
        <div><dt>Portrait</dt><dd>${numberFmt(appearance.portrait)}</dd></div>
      </dl>
    </section>

    <section class="inspector-section">
      <h3>Preview State</h3>
      <div class="lock-controls">
        <label class="lock-row">
          <input type="checkbox" data-lock-row ${locks.rowLocked ? "checked" : ""}>
          <span>Lock entire recruit</span>
        </label>
        <div class="lock-grid">
          ${LOCK_FIELD_OPTIONS.map(([value, label]) => `
            <label>
              <input type="checkbox" data-lock-field="${escapeHtml(value)}" ${(locks.fields || []).includes(value) ? "checked" : ""}>
              <span>${escapeHtml(label)}</span>
            </label>
          `).join("")}
        </div>
      </div>
      <dl class="detail-grid">
        <div><dt>Generated Writes</dt><dd>${numberFmt(generatedWriteCount(profile))}</dd></div>
        <div><dt>Preserved Fields</dt><dd>${numberFmt(preservedFieldCount(profile))}</dd></div>
        <div><dt>Row Lock</dt><dd>${locks.rowLocked ? "Locked" : "Open"}</dd></div>
        <div><dt>Field Locks</dt><dd>${numberFmt((locks.fields || []).length)}</dd></div>
        <div><dt>Recruit Row</dt><dd>${numberFmt(source.recruitRow)}</dd></div>
        <div><dt>Player Row</dt><dd>${numberFmt(source.playerRow)}</dd></div>
        <div><dt>Fingerprint</dt><dd title="${escapeHtml(fingerprint)}">${escapeHtml(fingerprint.slice(0, 16))}</dd></div>
      </dl>
      <div class="state-chips">${renderCapabilityChips()}</div>
      ${renderGeneratedDiffTable(game.generatedDiffs || [])}
      <pre>${escapeHtml(JSON.stringify(game.generatedWrites || {}, null, 2))}</pre>
    </section>

    ${renderValidationDetails()}

    <section class="inspector-section">
      <h3>Sidecar Intent</h3>
      <pre>${escapeHtml(JSON.stringify(intent, null, 2))}</pre>
    </section>
  `;
}

function selectProfile(profileId) {
  state.selectedProfileId = profileId;
  const profile = state.profiles.find((item) => item.recruitId === profileId) || null;
  renderProfiles();
  renderInspector(profile);
}

function renderSaveTools() {
  if (!els.saveToolsBody) return;
  els.saveToolsBody.innerHTML = state.files
    .map((file) => `
      <tr class="${file.name === state.selectedFile ? "selected" : ""}">
        <td title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</td>
        <td>${numberFmt(file.size)}</td>
        <td>${dateFmt(file.modified)}</td>
        <td title="${escapeHtml(file.error || "")}">${escapeHtml(file.error ? "Error" : "OK")}</td>
      </tr>
    `)
    .join("") || '<tr><td colspan="4" class="empty-row">No editable save files found</td></tr>';
  renderArtifactBrowser();
}

function artifactMatchesFilter(artifact) {
  const kind = els.artifactKindFilter?.value || "all";
  const query = (els.artifactSearch?.value || "").trim().toLowerCase();
  if (kind !== "all" && artifact.kind !== kind) return false;
  if (!query) return true;
  return [
    artifact.kind,
    artifact.name,
    artifact.path,
    artifact.sha256,
  ].join(" ").toLowerCase().includes(query);
}

function artifactSummaryRows(detail) {
  const summary = detail?.summary || {};
  const rows = [
    ["Save", summary.saveName],
    ["Preview", summary.previewId],
    ["Seed", summary.seed],
    ["Records", summary.recordCount],
    ["Applied", summary.appliedRecruitCount],
    ["Changed Fields", summary.changedFieldCount],
    ["Validation", summary.validationValid === undefined ? "" : (summary.validationValid ? "Valid" : "Invalid")],
    ["Errors", summary.validationErrorCount],
    ["Warnings", summary.validationWarningCount],
    ["Mismatches", summary.readBackMismatchCount],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  return rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`)
    .join("");
}

function renderArtifactBrowser() {
  if (!els.artifactList) return;
  if (!state.artifactBrowser.loaded) {
    els.artifactList.innerHTML = '<div class="empty-state compact">Artifact list has not been loaded.</div>';
    return;
  }
  const visible = state.artifactBrowser.artifacts.filter(artifactMatchesFilter);
  const selected = state.artifactBrowser.selected || {};
  const detail = state.artifactBrowser.detail;
  const listRows = visible
    .map((artifact) => {
      const isSelected = artifact.kind === selected.kind && artifact.name === selected.name;
      return `
        <button class="artifact-row ${isSelected ? "selected" : ""}" type="button" data-artifact-kind="${escapeHtml(artifact.kind)}" data-artifact-name="${escapeHtml(artifact.name)}">
          <strong>${escapeHtml(artifact.kind || "")}</strong>
          <span title="${escapeHtml(artifact.path || "")}">${escapeHtml(artifact.name || "")}</span>
          <em>${numberFmt(artifact.size || 0)} bytes</em>
        </button>
      `;
    })
    .join("");
  const detailPanel = detail ? `
    <section class="artifact-detail">
      <h3>${escapeHtml(detail.artifact?.kind || "")}: ${escapeHtml(detail.artifact?.name || "")}</h3>
      <dl class="detail-grid">${artifactSummaryRows(detail)}</dl>
      <div class="state-chips">
        <span>Size <strong>${numberFmt(detail.artifact?.size || 0)}</strong></span>
        <span>Modified <strong>${dateFmt(detail.artifact?.modified)}</strong></span>
        <span title="${escapeHtml(detail.artifact?.sha256 || "")}">SHA <strong>${escapeHtml((detail.artifact?.sha256 || "").slice(0, 12))}</strong></span>
      </div>
      <pre>${escapeHtml(JSON.stringify(detail.data || {}, null, 2))}</pre>
    </section>
  ` : '<div class="empty-state compact">Select an artifact to inspect its summary and JSON.</div>';
  els.artifactList.innerHTML = `
    <h3>Generator Artifacts</h3>
    <p class="support-note">${numberFmt(visible.length)} shown of ${numberFmt(state.artifactBrowser.artifacts.length)} loaded</p>
    <div class="artifact-browser">
      <div class="artifact-list">
        ${listRows || '<div class="empty-state compact">No artifacts match the current filters</div>'}
      </div>
      ${detailPanel}
    </div>
  `;
}

function recruitEditorDisplayColumns() {
  const preferred = ["national_rank", "first_name", "last_name", "position", "archetype", "overall", "speed", "dev_trait"];
  return preferred
    .map((key) => state.recruitEditor.columns.find((column) => column.key === key))
    .filter(Boolean);
}

function selectedRecruitEditorRow() {
  return state.recruitEditor.rows.find((row) => String(row.id) === String(state.recruitEditor.selectedId)) || null;
}

function recruitEditorMatches(row, query) {
  if (!query) return true;
  return [
    row.id,
    row.national_rank,
    row.first_name,
    row.last_name,
    row.position,
    row.archetype,
    row.dev_trait,
  ].join(" ").toLowerCase().includes(query);
}

function renderRecruitEditorPager(filteredCount) {
  const total = state.recruitEditor.total || state.recruitEditor.rows.length;
  const start = total ? state.recruitEditor.offset + 1 : 0;
  const stop = Math.min(state.recruitEditor.offset + state.recruitEditor.rows.length, total);
  const suffix = filteredCount !== state.recruitEditor.rows.length ? `, ${numberFmt(filteredCount)} matched on page` : "";
  els.recruitEditorPageInfo.textContent = `Rows ${numberFmt(start)}-${numberFmt(stop)} of ${numberFmt(total)}${suffix}`;
  els.recruitEditorPrevBtn.disabled = state.recruitEditor.offset <= 0;
  els.recruitEditorNextBtn.disabled = stop >= total;
}

function renderRecruitEditor() {
  const displayColumns = recruitEditorDisplayColumns();
  els.recruitEditorHead.innerHTML = `<tr>${displayColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr>`;
  const query = els.recruitEditorSearch.value.trim().toLowerCase();
  const rows = state.recruitEditor.rows.filter((row) => recruitEditorMatches(row, query));
  els.recruitEditorBody.innerHTML = rows
    .map((row) => `
      <tr data-recruit-editor-id="${escapeHtml(row.id)}" class="${String(row.id) === String(state.recruitEditor.selectedId) ? "selected" : ""}">
        ${displayColumns.map((column) => `<td title="${escapeHtml(row[column.key] ?? "")}">${escapeHtml(row[column.key] ?? "")}</td>`).join("")}
      </tr>
    `)
    .join("") || `<tr><td colspan="${Math.max(1, displayColumns.length)}" class="empty-row">No recruits loaded</td></tr>`;
  renderRecruitEditorPager(rows.length);
  renderRecruitEditorForm();
}

function inputForColumn(column, value, prefix) {
  const key = escapeHtml(column.key);
  const label = escapeHtml(column.label || column.key);
  if (column.type === "select" && Array.isArray(column.options)) {
    return `
      <label>
        <span>${label}</span>
        <select data-${prefix}-field="${key}">
          ${column.options.map((option) => {
            const optionValue = typeof option === "object" ? option.value : option;
            const optionLabel = typeof option === "object" ? option.label : option;
            return `<option value="${escapeHtml(optionValue)}" ${String(optionValue) === String(value) ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`;
          }).join("")}
        </select>
      </label>
    `;
  }
  if (column.type === "number") {
    return `
      <label>
        <span>${label}</span>
        <input data-${prefix}-field="${key}" type="number" value="${escapeHtml(value ?? "")}" min="${escapeHtml(column.min ?? "")}" max="${escapeHtml(column.max ?? "")}">
      </label>
    `;
  }
  return `
    <label>
      <span>${label}</span>
      <input data-${prefix}-field="${key}" type="text" value="${escapeHtml(value ?? "")}" maxlength="${escapeHtml(column.maxLength || 64)}">
    </label>
  `;
}

function renderRecruitEditorForm() {
  const row = selectedRecruitEditorRow();
  if (!row) {
    els.recruitEditorForm.innerHTML = '<div class="empty-state compact">Select a recruit row.</div>';
    els.saveRecruitEditorBtn.disabled = true;
    return;
  }
  const writableColumns = state.recruitEditor.columns.filter((column) => column.writable).slice(0, 80);
  const dirtyKeys = Object.keys(state.recruitEditor.dirty);
  els.saveRecruitEditorBtn.disabled = dirtyKeys.length === 0;
  els.recruitEditorForm.innerHTML = `
    <h3>${escapeHtml(row.first_name || "")} ${escapeHtml(row.last_name || "")}</h3>
    <p class="support-note">Recruit row ${escapeHtml(row.recruit_index ?? row.id)} | Player row ${escapeHtml(row.player_index ?? "-")}</p>
    <div class="edit-form-grid">
      ${writableColumns.map((column) => inputForColumn(column, state.recruitEditor.dirty[column.key] ?? row[column.key], "manual")).join("")}
    </div>
  `;
}

async function loadRecruitEditor() {
  if (!state.selectedFile) return;
  setStatus("Loading manual recruit editor...");
  const payload = await api(
    `/api/recruits/${encodeURIComponent(state.selectedFile)}?limit=${state.recruitEditor.pageSize}&offset=${state.recruitEditor.offset}`,
  );
  state.recruitEditor.columns = payload.columns || [];
  state.recruitEditor.rows = payload.players || [];
  state.recruitEditor.total = payload.recordCount || state.recruitEditor.rows.length;
  state.recruitEditor.offset = payload.offset || state.recruitEditor.offset;
  state.recruitEditor.selectedId = state.recruitEditor.rows[0]?.id || "";
  state.recruitEditor.dirty = {};
  renderRecruitEditor();
  if (state.activeView === "recruit-editor") {
    setStatus(`Loaded ${numberFmt(payload.recordCount || state.recruitEditor.rows.length)} manual recruit rows`);
  }
}

async function saveRecruitEditorRow() {
  const row = selectedRecruitEditorRow();
  const changes = state.recruitEditor.dirty;
  if (!row || !Object.keys(changes).length) return;
  setStatus("Saving manual recruit row...");
  await api(`/api/recruits/${encodeURIComponent(state.selectedFile)}/players/${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ changes }),
  });
  state.recruitEditor.dirty = {};
  await loadRecruitEditor();
  await loadProfiles();
  setStatus("Manual recruit row saved and generator profiles refreshed");
}

function renderSchemaEntries(payload, mode) {
  const entries = payload.entries || [];
  if (mode === "occurrences") {
    els.schemaHead.innerHTML = "<tr><th>Name</th><th>Table</th><th>Field</th><th>Count</th></tr>";
    els.schemaBody.innerHTML = entries
      .map((entry) => `
        <tr>
          <td title="${escapeHtml(entry.name || "")}">${escapeHtml(entry.name || "")}</td>
          <td>${escapeHtml(entry.table || entry.tableName || "")}</td>
          <td>${escapeHtml(entry.field || entry.fieldName || "")}</td>
          <td>${numberFmt(entry.count || entry.occurrenceCount || 0)}</td>
        </tr>
      `)
      .join("") || '<tr><td colspan="4" class="empty-row">No occurrences found</td></tr>';
    return;
  }
  els.schemaHead.innerHTML = "<tr><th>Name</th><th>Table</th><th>Type</th><th>Field</th></tr>";
  els.schemaBody.innerHTML = entries
    .map((entry) => `
      <tr>
        <td title="${escapeHtml(entry.name || "")}">${escapeHtml(entry.name || "")}</td>
        <td>${escapeHtml(entry.table || entry.tableName || "")}</td>
        <td>${escapeHtml(entry.type || entry.category || "")}</td>
        <td>${escapeHtml(entry.field || entry.fieldName || entry.key || "")}</td>
      </tr>
    `)
    .join("") || '<tr><td colspan="4" class="empty-row">No schema entries found</td></tr>';
}

async function searchSchema(occurrences = false) {
  const query = els.schemaQuery.value.trim();
  const domain = els.schemaDomain.value;
  setStatus(occurrences ? "Searching schema occurrences..." : "Searching schema...");
  const path = occurrences
    ? `/api/schema/occurrences?file=${encodeURIComponent(state.selectedFile)}&query=${encodeURIComponent(query)}&domain=${encodeURIComponent(domain)}&limit=300`
    : `/api/schema?query=${encodeURIComponent(query)}&domain=${encodeURIComponent(domain)}&limit=300`;
  const payload = await api(path);
  renderSchemaEntries(payload, occurrences ? "occurrences" : "entries");
  if (state.activeView === "schema") {
    setStatus(`${numberFmt(payload.count ?? (payload.entries || []).length)} schema result(s)`);
  }
}

async function discoverTables() {
  setStatus("Discovering inferred tables...");
  const payload = await api(`/api/tables${els.deepTablesCheck.checked ? "?deep=1" : ""}`);
  state.tableBrowser.selected = null;
  state.tableBrowser.rowOffset = 0;
  state.tableBrowser.rowCount = 0;
  state.tableBrowser.summaries = (payload.files || []).flatMap((fileResult) =>
    (fileResult.tables || []).map((table) => ({ ...table, file: table.file || fileResult.file?.name || "" })),
  );
  els.tableSummaryBody.innerHTML = state.tableBrowser.summaries
    .map((table) => `
      <tr data-table-file="${escapeHtml(table.file)}" data-table-id="${escapeHtml(table.id)}">
        <td title="${escapeHtml(table.file || "")}">${escapeHtml(table.file || "")}</td>
        <td title="${escapeHtml(table.notes || "")}">${escapeHtml(table.name || table.id || "")}</td>
        <td>${numberFmt(table.recordCount || 0)}</td>
        <td>${escapeHtml(table.confidence || "")}</td>
      </tr>
    `)
    .join("") || '<tr><td colspan="4" class="empty-row">No inferred tables found</td></tr>';
  if (state.activeView === "tables") {
    setStatus(`Discovered ${numberFmt(state.tableBrowser.summaries.length)} inferred table(s)`);
  }
}

function renderTableRowsPanel(payload, fileName, tableId) {
  const selected = state.tableBrowser.selected || {};
  const rowOffset = state.tableBrowser.rowOffset || 0;
  const rowPageSize = state.tableBrowser.rowPageSize || 50;
  const recordCount = payload.recordCount || 0;
  const rows = payload.rows || [];
  const start = recordCount ? rowOffset + 1 : 0;
  const stop = Math.min(rowOffset + rows.length, recordCount);
  const columns = (payload.columns || []).slice(0, 12);
  els.tableRowsPanel.innerHTML = `
    <h3>${escapeHtml(payload.name || selected.name || tableId)}</h3>
    <p class="support-note">${escapeHtml(fileName)} | Rows ${numberFmt(start)}-${numberFmt(stop)} of ${numberFmt(recordCount)}</p>
    <div class="pager">
      <button type="button" data-table-row-page="prev" ${rowOffset <= 0 ? "disabled" : ""}>Prev</button>
      <span>${numberFmt(rowPageSize)} per page</span>
      <button type="button" data-table-row-page="next" ${stop >= recordCount ? "disabled" : ""}>Next</button>
    </div>
    <div class="support-table-wrap inset">
      <table class="compact-table">
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label || column.key)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>${columns.map((column) => `<td title="${escapeHtml(row[column.key] ?? "")}">${escapeHtml(row[column.key] ?? "")}</td>`).join("")}</tr>
          `).join("") || `<tr><td colspan="${Math.max(1, columns.length)}" class="empty-row">No rows</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function loadTableRows(fileName, tableId, offset = 0) {
  setStatus("Loading table rows...");
  const pageSize = state.tableBrowser.rowPageSize;
  const payload = await api(
    `/api/table/${encodeURIComponent(fileName)}/${encodeURIComponent(tableId)}?limit=${pageSize}&offset=${Math.max(0, offset)}`,
  );
  state.tableBrowser.selected = {
    fileName,
    tableId,
    name: payload.name || tableId,
  };
  state.tableBrowser.rowOffset = payload.offset || Math.max(0, offset);
  state.tableBrowser.rowCount = payload.recordCount || 0;
  renderTableRowsPanel(payload, fileName, tableId);
  setStatus(`Loaded table rows ${numberFmt(state.tableBrowser.rowOffset + 1)}-${numberFmt(state.tableBrowser.rowOffset + (payload.rows || []).length)}`);
}

function rosterFileName() {
  const roster = state.files.find((file) => file.name.startsWith("ROSTER-"));
  return roster?.name || state.selectedFile;
}

function selectedRosterPlayer() {
  return state.roster.players.find((player) => String(player.id) === String(state.roster.selectedId)) || null;
}

function filteredRosterPlayers() {
  const query = els.rosterSearch.value.trim().toLowerCase();
  return state.roster.players.filter((player) => [
    player.id,
    player.first_name,
    player.last_name,
    player.hometown,
    player.internal_id,
  ].join(" ").toLowerCase().includes(query));
}

function renderRosterPager(filteredCount) {
  const start = filteredCount ? state.roster.offset + 1 : 0;
  const stop = Math.min(state.roster.offset + state.roster.pageSize, filteredCount);
  els.rosterPageInfo.textContent = `Rows ${numberFmt(start)}-${numberFmt(stop)} of ${numberFmt(filteredCount)}`;
  els.rosterPrevBtn.disabled = state.roster.offset <= 0;
  els.rosterNextBtn.disabled = stop >= filteredCount;
}

function renderRoster() {
  const filtered = filteredRosterPlayers();
  const rows = filtered.slice(state.roster.offset, state.roster.offset + state.roster.pageSize);
  els.rosterBody.innerHTML = rows
    .map((player) => `
      <tr data-roster-id="${escapeHtml(player.id)}" class="${String(player.id) === String(state.roster.selectedId) ? "selected" : ""}">
        <td>${escapeHtml(player.first_name || "")}</td>
        <td>${escapeHtml(player.last_name || "")}</td>
        <td>${escapeHtml(player.hometown || "")}</td>
        <td>${escapeHtml(player.id || "")}</td>
      </tr>
    `)
    .join("") || '<tr><td colspan="4" class="empty-row">No roster players loaded</td></tr>';
  renderRosterPager(filtered.length);
  renderRosterForm();
}

function renderRosterForm() {
  const player = selectedRosterPlayer();
  if (!player) {
    els.rosterForm.innerHTML = '<div class="empty-state compact">Select a roster player.</div>';
    els.saveRosterPlayerBtn.disabled = true;
    return;
  }
  const columns = [
    { key: "first_name", label: "First", maxLength: 16 },
    { key: "last_name", label: "Last", maxLength: 20 },
    { key: "hometown", label: "Hometown", maxLength: 25 },
    { key: "internal_id", label: "Internal ID", maxLength: 32 },
  ];
  els.saveRosterPlayerBtn.disabled = !Object.keys(state.roster.dirty).length;
  els.rosterForm.innerHTML = `
    <h3>${escapeHtml(player.first_name || "")} ${escapeHtml(player.last_name || "")}</h3>
    <p class="support-note">Roster row ${escapeHtml(player.id || "")}</p>
    <div class="edit-form-grid">
      ${columns.map((column) => inputForColumn(column, state.roster.dirty[column.key] ?? player[column.key], "roster")).join("")}
    </div>
  `;
}

async function loadRoster() {
  const fileName = rosterFileName();
  if (!fileName) return;
  setStatus("Loading roster...");
  const payload = await api(`/api/roster/${encodeURIComponent(fileName)}`);
  state.roster.file = fileName;
  state.roster.players = payload.players || [];
  state.roster.offset = 0;
  state.roster.selectedId = state.roster.players[0]?.id || "";
  state.roster.dirty = {};
  renderRoster();
  if (state.activeView === "roster") {
    setStatus(`Loaded ${numberFmt(state.roster.players.length)} roster player(s) from ${fileName}`);
  }
}

async function saveRosterPlayer() {
  const player = selectedRosterPlayer();
  if (!player || !Object.keys(state.roster.dirty).length) return;
  setStatus("Saving roster player...");
  await api(`/api/roster/${encodeURIComponent(state.roster.file)}/players/${encodeURIComponent(player.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ changes: state.roster.dirty }),
  });
  state.roster.dirty = {};
  await loadRoster();
  setStatus("Roster player saved");
}

async function loadProfiles() {
  if (!state.selectedFile) return;
  setStatus(`Loading ${state.selectedFile}...`);
  try {
    const payload = await api(`/api/generator/recruits/${encodeURIComponent(state.selectedFile)}?limit=5000`);
    state.profiles = payload.recruits || [];
    state.currentPreview = null;
    state.previewContext = null;
    state.fieldCapabilities = (payload.fieldCapabilities && payload.fieldCapabilities.fields) || [];
    state.saveFingerprint = payload.saveFingerprint || "";
    state.recordCount = payload.count || state.profiles.length;
    loadLockMap();
    applyStoredLocks();
    state.selectedProfileId = state.profiles[0] ? state.profiles[0].recruitId : "";
    renderMetrics(payload.file);
    renderPreviewSummary();
    renderPreviewBrowser();
    renderProfiles();
    renderInspector(state.profiles[0] || null);
    if (state.currentConfig) {
      try {
        await validateConfigObject(state.currentConfig);
      } catch (error) {
        renderConfig();
        setStatus(`Loaded ${numberFmt(state.recordCount)} joined recruit profiles; config invalid for this class`, true);
        return;
      }
    }
    setStatus(`Loaded ${numberFmt(state.recordCount)} joined recruit profiles`);
  } catch (error) {
    state.profiles = [];
    state.currentPreview = null;
    state.previewContext = null;
    state.fieldCapabilities = [];
    state.recordCount = 0;
    state.selectedProfileId = "";
    renderMetrics();
    renderPreviewSummary();
    renderPreviewBrowser();
    renderProfiles();
    renderInspector(null);
    setStatus(error.message, true);
  }
}

async function generatePreview() {
  if (!state.selectedFile || !state.currentConfig) return;
  setStatus("Generating preview...");
  try {
    const normalizedConfig = await validateConfigObject(state.currentConfig);
    const payload = await api("/api/generator/preview", {
      method: "POST",
      body: JSON.stringify({
        file: state.selectedFile,
        config: normalizedConfig,
        seed: els.seedInput.value.trim() || "default",
        locks: state.lockMap,
      }),
    });
    state.currentPreview = payload;
    state.previewContext = {
      file: state.selectedFile,
      saveFingerprint: payload.saveFingerprint || state.saveFingerprint || "",
      previewId: payload.previewId || "",
      fileModified: payload.file?.modified || selectedFileInfo()?.modified || 0,
      fileSize: payload.file?.size || selectedFileInfo()?.size || 0,
    };
    state.lastApplyResult = null;
    state.lastPatchExport = null;
    state.profiles = payload.recruits || [];
    state.fieldCapabilities = (payload.fieldCapabilities && payload.fieldCapabilities.fields) || state.fieldCapabilities;
    state.saveFingerprint = payload.saveFingerprint || state.saveFingerprint;
    state.recordCount = payload.summary?.count || state.profiles.length;
    applyStoredLocks();
    state.selectedProfileId = state.profiles[0] ? state.profiles[0].recruitId : "";
    renderMetrics(payload.file);
    renderPreviewSummary();
    renderPreviewBrowser();
    renderProfiles();
    renderInspector(state.profiles[0] || null);
    const warningCount = (payload.warnings || []).length;
    setStatus(
      payload.valid
        ? `Generated preview with ${numberFmt(payload.summary?.diffCount || 0)} writable diff(s)`
        : (payload.errors || ["Preview failed"])[0],
      !payload.valid || warningCount > 0,
    );
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function applyPreview() {
  const preview = state.currentPreview;
  if (!state.selectedFile || !state.currentConfig || !preview || !preview.valid) return;
  const staleReason = previewStaleReason(preview);
  if (staleReason) {
    setStatus(`Regenerate preview before apply: ${staleReason}`, true);
    renderPreviewSummary();
    return;
  }
  const diffCount = preview.summary?.diffCount || 0;
  const confirmed = window.confirm(
    `Write ${numberFmt(diffCount)} generated field changes to a new modded save copy based on ${state.selectedFile}? The selected save stays unchanged and a backup will be created first.`,
  );
  if (!confirmed) return;
  els.applyPreviewBtn.disabled = true;
  setStatus("Applying generated preview...");
  try {
    const normalizedConfig = await validateConfigObject(state.currentConfig);
    const payload = await api("/api/generator/apply", {
      method: "POST",
      body: JSON.stringify({
        file: state.selectedFile,
        previewId: preview.previewId,
        configHash: preview.configHash,
        config: normalizedConfig,
        seed: preview.seed || els.seedInput.value.trim() || "default",
        confirm: true,
        writeMode: "copy",
        locks: state.lockMap,
      }),
    });
    state.lastApplyResult = payload;
    setStatus(
      payload.applied && payload.artifactWriteSucceeded
        ? `Wrote ${numberFmt(payload.changedFieldCount || 0)} field change(s) to ${payload.targetFile || "new modded save copy"}`
        : payload.applied
          ? `Apply wrote ${payload.targetFile || "the target save"}, but artifact writing failed: ${payload.artifactError || "unknown error"}`
        : `Apply wrote ${payload.targetFile || "the target save"} but reported ${numberFmt((payload.readBackMismatches || []).length)} read-back mismatch(es)`,
      !payload.applied || !payload.artifactWriteSucceeded,
    );
    renderPreviewSummary();
    renderPreviewBrowser();
  } catch (error) {
    els.applyPreviewBtn.disabled = !state.currentPreview?.valid;
    setStatus(error.message, true);
  }
}

function downloadJson(payload, filename) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportDryRunPatch() {
  const preview = state.currentPreview;
  if (!state.selectedFile || !state.currentConfig || !preview || !preview.valid) return;
  const staleReason = previewStaleReason(preview);
  if (staleReason) {
    setStatus(`Regenerate preview before dry-run export: ${staleReason}`, true);
    renderPreviewSummary();
    return;
  }
  els.exportPatchBtn.disabled = true;
  setStatus("Exporting dry-run patch...");
  try {
    const normalizedConfig = await validateConfigObject(state.currentConfig);
    const payload = await api("/api/generator/patch-export", {
      method: "POST",
      body: JSON.stringify({
        file: state.selectedFile,
        previewId: preview.previewId,
        configHash: preview.configHash,
        config: normalizedConfig,
        seed: preview.seed || els.seedInput.value.trim() || "default",
        locks: state.lockMap,
      }),
    });
    state.lastPatchExport = payload;
    downloadJson(payload, `${state.selectedFile}.${payload.previewId || "preview"}.patch.json`);
    setStatus(`Exported dry-run patch with ${numberFmt(payload.changedFieldCount || 0)} field change(s)`);
    renderPreviewBrowser();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    els.exportPatchBtn.disabled = !state.currentPreview?.valid;
  }
}

async function showArtifacts() {
  try {
    setActiveView("save-tools");
    await loadGeneratorArtifacts();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function cleanupArtifacts() {
  const confirmed = window.confirm("Keep the newest 25 sidecars and 25 reports, and delete older generator artifacts?");
  if (!confirmed) return;
  setStatus("Cleaning generator artifacts...");
  try {
    const payload = await api("/api/generator/artifacts/cleanup", {
      method: "POST",
      body: JSON.stringify({ keepLatestPerKind: 25 }),
    });
    setStatus(`Deleted ${numberFmt(payload.deletedCount || 0)} older generator artifact(s)`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadArtifactDetail(kind, name) {
  if (!kind || !name) return;
  state.artifactBrowser.selected = { kind, name };
  state.artifactBrowser.detail = null;
  renderArtifactBrowser();
  const payload = await api(
    `/api/generator/artifact?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`,
  );
  state.artifactBrowser.detail = payload;
  renderArtifactBrowser();
  setStatus(`Loaded ${kind} artifact ${name}`);
}

async function loadGeneratorArtifacts(selectFirst = true) {
  setStatus("Loading generator artifacts...");
  const payload = await api("/api/generator/artifacts?limit=250");
  state.artifactBrowser.artifacts = payload.artifacts || [];
  state.artifactBrowser.loaded = true;
  const current = state.artifactBrowser.selected;
  const stillPresent = current && state.artifactBrowser.artifacts.some(
    (artifact) => artifact.kind === current.kind && artifact.name === current.name,
  );
  if (!stillPresent) {
    state.artifactBrowser.selected = null;
    state.artifactBrowser.detail = null;
  }
  renderArtifactBrowser();
  const visible = state.artifactBrowser.artifacts.filter(artifactMatchesFilter);
  if (selectFirst && !state.artifactBrowser.detail && visible.length) {
    await loadArtifactDetail(visible[0].kind, visible[0].name);
    return;
  }
  setStatus(`Loaded ${numberFmt(payload.count || 0)} generator artifact(s)`);
}

async function loadFiles() {
  setStatus("Loading save files...");
  const payload = await api("/api/files");
  state.files = payload.files || [];
  const dynastyFiles = state.files.filter((file) => file.name.startsWith("DYNASTY-"));
  if (!state.files.length) {
    state.selectedFile = "";
    renderFiles();
    renderMetrics(null);
    setStatus("No editable saves found", true);
    return;
  }
  if (!state.selectedFile || !state.files.some((file) => file.name === state.selectedFile)) {
    state.selectedFile = (dynastyFiles[0] || state.files[0]).name;
  }
  renderFiles();
  await loadProfiles();
}

async function backupCurrent() {
  if (!state.selectedFile) return;
  setStatus("Creating backup...");
  try {
    const payload = await api(`/api/backup/${encodeURIComponent(state.selectedFile)}`, { method: "POST" });
    setStatus(`Backup created: ${payload.backup}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

els.refreshBtn.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message, true)));
els.backupBtn.addEventListener("click", () => backupCurrent());
els.artifactsBtn.addEventListener("click", () => showArtifacts());
els.cleanupArtifactsBtn.addEventListener("click", () => cleanupArtifacts());
els.reloadProfilesBtn.addEventListener("click", () => loadProfiles());
els.generatePreviewBtn.addEventListener("click", () => generatePreview());
els.applyPreviewBtn.addEventListener("click", () => applyPreview());
els.exportPatchBtn.addEventListener("click", () => exportDryRunPatch());
els.validateConfigBtn.addEventListener("click", () => validateConfigFromEditor());
els.importConfigBtn.addEventListener("click", () => els.configFileInput.click());
els.exportConfigBtn.addEventListener("click", () => exportConfig());
els.duplicateConfigBtn.addEventListener("click", () => duplicateConfig());
els.resetConfigBtn.addEventListener("click", () => resetConfig());
els.configQuickForm.addEventListener("submit", applyConfigControls);
els.configFileInput.addEventListener("change", () => {
  const file = els.configFileInput.files && els.configFileInput.files[0];
  importConfigFile(file);
  els.configFileInput.value = "";
});
els.fileSelect.addEventListener("change", () => {
  state.selectedFile = els.fileSelect.value;
  state.recruitEditor = { ...state.recruitEditor, rows: [], selectedId: "", dirty: {}, offset: 0, total: 0 };
  state.tableBrowser = { ...state.tableBrowser, summaries: [], selected: null, rowOffset: 0, rowCount: 0 };
  state.roster = { ...state.roster, players: [], selectedId: "", dirty: {}, file: "", offset: 0 };
  loadProfiles();
});
els.profileSearch.addEventListener("input", renderProfiles);
els.profilesBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-profile-id]");
  if (row) selectProfile(row.dataset.profileId);
});
els.previewBrowser.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-profile-id]");
  if (row && row.dataset.profileId) selectProfile(row.dataset.profileId);
});
for (const tab of els.viewTabs) {
  tab.addEventListener("click", () => setActiveView(tab.dataset.viewTab));
}
els.loadRecruitEditorBtn.addEventListener("click", () => loadRecruitEditor().catch((error) => setStatus(error.message, true)));
els.saveRecruitEditorBtn.addEventListener("click", () => saveRecruitEditorRow().catch((error) => setStatus(error.message, true)));
els.recruitEditorSearch.addEventListener("input", renderRecruitEditor);
els.recruitEditorPrevBtn.addEventListener("click", () => {
  state.recruitEditor.offset = Math.max(0, state.recruitEditor.offset - state.recruitEditor.pageSize);
  loadRecruitEditor().catch((error) => setStatus(error.message, true));
});
els.recruitEditorNextBtn.addEventListener("click", () => {
  state.recruitEditor.offset += state.recruitEditor.pageSize;
  loadRecruitEditor().catch((error) => setStatus(error.message, true));
});
els.recruitEditorBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-recruit-editor-id]");
  if (!row) return;
  state.recruitEditor.selectedId = row.dataset.recruitEditorId;
  state.recruitEditor.dirty = {};
  renderRecruitEditor();
});
els.recruitEditorForm.addEventListener("input", (event) => {
  const input = event.target.closest("[data-manual-field]");
  if (!input) return;
  const key = input.dataset.manualField;
  const column = state.recruitEditor.columns.find((item) => item.key === key) || {};
  state.recruitEditor.dirty[key] = column.type === "number" ? Number(input.value) : input.value;
  els.saveRecruitEditorBtn.disabled = false;
});
els.refreshSaveToolsBtn.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message, true)));
els.backupSelectedSaveBtn.addEventListener("click", () => backupCurrent());
els.listArtifactsBtn.addEventListener("click", () => loadGeneratorArtifacts().catch((error) => setStatus(error.message, true)));
els.artifactKindFilter.addEventListener("change", () => {
  state.artifactBrowser.detail = null;
  renderArtifactBrowser();
});
els.artifactSearch.addEventListener("input", () => {
  state.artifactBrowser.detail = null;
  renderArtifactBrowser();
});
els.artifactList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-artifact-kind][data-artifact-name]");
  if (!row) return;
  loadArtifactDetail(row.dataset.artifactKind, row.dataset.artifactName).catch((error) => setStatus(error.message, true));
});
els.schemaSearchBtn.addEventListener("click", () => searchSchema(false).catch((error) => setStatus(error.message, true)));
els.schemaOccurrencesBtn.addEventListener("click", () => searchSchema(true).catch((error) => setStatus(error.message, true)));
els.schemaQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchSchema(false).catch((error) => setStatus(error.message, true));
});
els.discoverTablesBtn.addEventListener("click", () => discoverTables().catch((error) => setStatus(error.message, true)));
els.tableSummaryBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-table-id]");
  if (!row) return;
  loadTableRows(row.dataset.tableFile, row.dataset.tableId, 0).catch((error) => setStatus(error.message, true));
});
els.tableRowsPanel.addEventListener("click", (event) => {
  const button = event.target.closest("[data-table-row-page]");
  if (!button || button.disabled) return;
  const selected = state.tableBrowser.selected;
  if (!selected) return;
  const direction = button.dataset.tableRowPage;
  const nextOffset = direction === "next"
    ? state.tableBrowser.rowOffset + state.tableBrowser.rowPageSize
    : Math.max(0, state.tableBrowser.rowOffset - state.tableBrowser.rowPageSize);
  loadTableRows(selected.fileName, selected.tableId, nextOffset).catch((error) => setStatus(error.message, true));
});
els.loadRosterBtn.addEventListener("click", () => loadRoster().catch((error) => setStatus(error.message, true)));
els.saveRosterPlayerBtn.addEventListener("click", () => saveRosterPlayer().catch((error) => setStatus(error.message, true)));
els.rosterSearch.addEventListener("input", () => {
  state.roster.offset = 0;
  renderRoster();
});
els.rosterPrevBtn.addEventListener("click", () => {
  state.roster.offset = Math.max(0, state.roster.offset - state.roster.pageSize);
  renderRoster();
});
els.rosterNextBtn.addEventListener("click", () => {
  const filteredCount = filteredRosterPlayers().length;
  state.roster.offset = Math.min(
    Math.max(0, filteredCount - (filteredCount % state.roster.pageSize || state.roster.pageSize)),
    state.roster.offset + state.roster.pageSize,
  );
  renderRoster();
});
els.rosterBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-roster-id]");
  if (!row) return;
  state.roster.selectedId = row.dataset.rosterId;
  state.roster.dirty = {};
  renderRoster();
});
els.rosterForm.addEventListener("input", (event) => {
  const input = event.target.closest("[data-roster-field]");
  if (!input) return;
  state.roster.dirty[input.dataset.rosterField] = input.value;
  els.saveRosterPlayerBtn.disabled = false;
});
els.profileInspector.addEventListener("change", (event) => {
  const profile = selectedProfile();
  if (!profile) return;
  const rowLock = event.target.closest("[data-lock-row]");
  const fieldLock = event.target.closest("[data-lock-field]");
  if (!rowLock && !fieldLock) return;
  const current = profile.locks || defaultLocks();
  if (rowLock) {
    updateProfileLocks(profile, {
      ...current,
      rowLocked: Boolean(rowLock.checked),
    });
  }
  if (fieldLock) {
    const field = fieldLock.dataset.lockField;
    const fields = new Set(current.fields || []);
    if (fieldLock.checked) {
      fields.add(field);
    } else {
      fields.delete(field);
    }
    updateProfileLocks(profile, {
      ...current,
      fields: Array.from(fields),
    });
  }
  renderProfiles();
  renderInspector(profile);
  setStatus(`Updated locks for ${profileName(profile) || profile.recruitId}`);
});

populateWriteFieldSelect(els.starRatingWriteSelect);
populateWriteFieldSelect(els.archetypeWriteSelect);
populateWriteFieldSelect(els.qualityWriteSelect);
state.activeView = currentViewFromStorage();
setActiveView(state.activeView, false);
renderMetrics(null);
renderInspector(null);
renderConfig();
renderPreviewSummary();
renderPreviewBrowser();
loadGeneratorConfigs()
  .then(loadFiles)
  .catch((error) => setStatus(error.message, true));
