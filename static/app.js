const state = {
  activeView: "recruiting",
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
  live: { status: null, luaHost: null, loading: false, playerResult: null },
  recruitEditor: { columns: [], rows: [], selectedId: "", dirty: {}, offset: 0, pageSize: 250, total: 0 },
  tableBrowser: { summaries: [], selected: null, rowOffset: 0, rowPageSize: 50, rowCount: 0 },
  artifactBrowser: { artifacts: [], selected: null, detail: null, loaded: false },
  roster: { players: [], selectedId: "", dirty: {}, file: "", offset: 0, pageSize: 500 },
  recruiting: {
    board: null,
    selectedId: "",
    filter: "",
    sort: "rank",
    preview: null,
    activeTab: "board",
    prospectScrollTop: 0,
    prospectRenderPending: false,
    prospectSort: { key: "rank", direction: "asc" },
    prospectFilters: { position: "all", stars: "all", board: "all" },
    selectedProspectIds: [],
    stagedAdds: [],
    stagedActions: [],
  },
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

const RECRUITING_THEME_STORAGE_KEY = "cfb27.recruiting.theme";
const RECRUITING_TAB_STORAGE_KEY = "cfb27.recruiting.activeTab";
const RECRUITING_TAB_IDS = new Set(["board", "prospects", "portal", "school", "classes"]);
const RECRUITING_DEFAULT_THEME = {
  key: "neutral",
  name: "College Football",
  mark: "CFB",
  primary: "#202628",
  secondary: "#d6b552",
  backdrop: "#202628",
  hero: "#9b1238",
  side: "#9b1238",
  secondaryWash: "rgba(214, 181, 82, 0.22)",
};
const RECRUITING_TEAM_THEMES = {
  alabama: {
    key: "alabama",
    name: "Alabama",
    mark: "A",
    primary: "#9b1238",
    secondary: "#ffffff",
    backdrop: "#3c1a24",
    hero: "#9b1238",
    side: "#9b1238",
    secondaryWash: "rgba(255, 255, 255, 0.18)",
  },
  georgia: {
    key: "georgia",
    name: "Georgia",
    mark: "G",
    primary: "#ba0c2f",
    secondary: "#ffffff",
    backdrop: "#2a1a1d",
    hero: "#ba0c2f",
    side: "#ba0c2f",
    secondaryWash: "rgba(255, 255, 255, 0.18)",
  },
  ohiostate: {
    key: "ohiostate",
    name: "Ohio State",
    mark: "OSU",
    primary: "#bb0000",
    secondary: "#a7b1b7",
    backdrop: "#2a2023",
    hero: "#bb0000",
    side: "#bb0000",
    secondaryWash: "rgba(167, 177, 183, 0.22)",
  },
  oregon: {
    key: "oregon",
    name: "Oregon",
    mark: "O",
    primary: "#006f3d",
    secondary: "#ffe100",
    backdrop: "#006f3d",
    hero: "#0f7d45",
    side: "#0f7d45",
    secondaryWash: "rgba(255, 225, 0, 0.24)",
  },
};

const RECRUITING_WEEKLY_ACTIONS = [
  { field: "SearchSocialMedia", label: "Search Social Media", shortLabel: "Social", hours: 5 },
  { field: "ContactHighSchoolCoaches", label: "DM the Player", shortLabel: "DM", hours: 10 },
  { field: "ContactFriendsAndFamily", label: "Friends & Family", shortLabel: "Family", hours: 25 },
  { field: "SendTheHouse", label: "Send the House", shortLabel: "House", hours: 50 },
];

const els = {
  status: document.querySelector("#status"),
  fileSelect: document.querySelector("#fileSelect"),
  saveDirectoryLabel: document.querySelector("#saveDirectoryLabel"),
  chooseSaveFolderBtn: document.querySelector("#chooseSaveFolderBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  backupBtn: document.querySelector("#backupBtn"),
  artifactsBtn: document.querySelector("#artifactsBtn"),
  cleanupArtifactsBtn: document.querySelector("#cleanupArtifactsBtn"),
  metrics: document.querySelector("#metrics"),
  profileSearch: document.querySelector("#profileSearch"),
  seedInput: document.querySelector("#seedInput"),
  generatorEngineSelect: document.querySelector("#generatorEngineSelect"),
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
  desktopOpenSaveBtn: document.querySelector("#desktopOpenSaveBtn"),
  refreshLiveBtn: document.querySelector("#refreshLiveBtn"),
  livePlayerQuery: document.querySelector("#livePlayerQuery"),
  unlockDynastyBtn: document.querySelector("#unlockDynastyBtn"),
  discoverLivePlayerBtn: document.querySelector("#discoverLivePlayerBtn"),
  liveSessionPanel: document.querySelector("#liveSessionPanel"),
  liveSafetyPanel: document.querySelector("#liveSafetyPanel"),
  liveModulesBody: document.querySelector("#liveModulesBody"),
  livePlayerPanel: document.querySelector("#livePlayerPanel"),
  luaHostState: document.querySelector("#luaHostState"),
  luaScriptInput: document.querySelector("#luaScriptInput"),
  runLuaBtn: document.querySelector("#runLuaBtn"),
  loadRecruitingBtn: document.querySelector("#loadRecruitingBtn"),
  previewRecruitingPlanBtn: document.querySelector("#previewRecruitingPlanBtn"),
  recruitingStatus: document.querySelector("#recruitingStatus"),
  recruitingCounters: document.querySelector("#recruitingCounters"),
  recruitingSearch: document.querySelector("#recruitingSearch"),
  recruitingSort: document.querySelector("#recruitingSort"),
  recruitingTabs: Array.from(document.querySelectorAll("[data-recruiting-tab]")),
  recruitingTargetsBody: document.querySelector("#recruitingTargetsBody"),
  recruitingDetail: document.querySelector("#recruitingDetail"),
  recruitingSide: document.querySelector("#recruitingSide"),
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

function normalizeThemeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function recruitingTheme(board) {
  const payloadTheme = board?.theme && typeof board.theme === "object" ? board.theme : {};
  const candidates = [
    payloadTheme.key,
    payloadTheme.name,
    board?.team?.name,
    board?.schoolName,
    board?.programName,
    localStorage.getItem(RECRUITING_THEME_STORAGE_KEY),
  ];
  const base = candidates
    .map(normalizeThemeKey)
    .map((key) => RECRUITING_TEAM_THEMES[key])
    .find(Boolean) || RECRUITING_DEFAULT_THEME;
  return { ...base, ...payloadTheme };
}

function programMarkClass(theme) {
  return String(theme.mark || "").trim().length > 1 ? "wordmark" : "";
}

function applyRecruitingTheme(board) {
  const theme = recruitingTheme(board);
  const markClass = programMarkClass(theme);
  const root = document.body;
  root.style.setProperty("--team-primary", theme.primary || RECRUITING_DEFAULT_THEME.primary);
  root.style.setProperty("--team-secondary", theme.secondary || RECRUITING_DEFAULT_THEME.secondary);
  root.style.setProperty("--team-backdrop", theme.backdrop || theme.primary || RECRUITING_DEFAULT_THEME.backdrop);
  root.style.setProperty("--team-hero", theme.hero || theme.primary || RECRUITING_DEFAULT_THEME.hero);
  root.style.setProperty("--team-side", theme.side || theme.hero || theme.primary || RECRUITING_DEFAULT_THEME.side);
  root.style.setProperty("--team-secondary-wash", theme.secondaryWash || RECRUITING_DEFAULT_THEME.secondaryWash);
  for (const mark of document.querySelectorAll("[data-cfb-program-mark]")) {
    mark.textContent = theme.mark || RECRUITING_DEFAULT_THEME.mark;
    mark.setAttribute("title", theme.name || RECRUITING_DEFAULT_THEME.name);
    mark.classList.toggle("wordmark", markClass === "wordmark");
  }
  return theme;
}

function dateFmt(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString();
}

function currentViewFromStorage() {
  if (window.location.pathname === "/recruiting") return "recruiting";
  const storedView = localStorage.getItem(VIEW_STORAGE_KEY);
  if (storedView) return storedView;
  return "recruiting";
}

function normalizeRecruitingTab(value) {
  const tab = String(value || "").trim().toLowerCase();
  return RECRUITING_TAB_IDS.has(tab) ? tab : "board";
}

function currentRecruitingTabFromLocation() {
  const params = new URLSearchParams(window.location.search || "");
  const tab = params.get("tab");
  if (RECRUITING_TAB_IDS.has(String(tab || "").toLowerCase())) return normalizeRecruitingTab(tab);
  return "board";
}

function recruitingTabPath(tab) {
  const normalized = normalizeRecruitingTab(tab);
  const params = new URLSearchParams(window.location.search || "");
  if (normalized === "board") params.delete("tab");
  else params.set("tab", normalized);
  const query = params.toString();
  return `/recruiting${query ? `?${query}` : ""}`;
}

function setRecruitingTab(tab, persist = true) {
  state.recruiting.activeTab = normalizeRecruitingTab(tab);
  localStorage.setItem(RECRUITING_TAB_STORAGE_KEY, state.recruiting.activeTab);
  if (persist && window.history && state.activeView === "recruiting") {
    const nextPath = recruitingTabPath(state.recruiting.activeTab);
    if (`${window.location.pathname}${window.location.search}` !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
  }
  renderRecruitingWorkbench();
}

function sectionMatchesView(section, view) {
  return String(section.dataset.view || "").split(/\s+/).includes(view);
}

function setActiveView(view, persist = true) {
  state.activeView = els.viewTabs.some((tab) => tab.dataset.viewTab === view) ? view : "generator";
  if (persist) localStorage.setItem(VIEW_STORAGE_KEY, state.activeView);
  if (persist && window.history && window.location.pathname !== "/recruiting" && state.activeView === "recruiting") {
    window.history.pushState({}, "", recruitingTabPath(state.recruiting.activeTab));
  } else if (persist && window.history && window.location.pathname === "/recruiting" && state.activeView !== "recruiting") {
    window.history.pushState({}, "", "/");
  }
  document.body.classList.toggle("recruiting-active", state.activeView === "recruiting");
  if (state.activeView === "recruiting") applyRecruitingTheme(state.recruiting.board);
  for (const tab of els.viewTabs) {
    const active = tab.dataset.viewTab === state.activeView;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
  }
  for (const section of els.viewSections) {
    section.hidden = !sectionMatchesView(section, state.activeView);
  }
  if (state.activeView === "save-tools") renderSaveTools();
  if (state.activeView === "live" && !state.live.status && !state.live.loading) {
    loadLiveStatus().catch((error) => setStatus(error.message, true));
  }
  if (state.activeView === "recruit-editor" && !state.recruitEditor.rows.length) {
    loadRecruitEditor().catch((error) => setStatus(error.message, true));
  }
  if (state.activeView === "schema" && !els.schemaBody.children.length) {
    searchSchema(false).catch((error) => setStatus(error.message, true));
  }
  if (state.activeView === "tables" && !state.tableBrowser.summaries.length) {
    discoverTables().catch((error) => setStatus(error.message, true));
  }
  if (state.activeView === "recruiting" && state.selectedFile && !state.recruiting.board) {
    loadRecruitingBoard().catch((error) => setStatus(error.message, true));
  }
}

function renderLiveStatus() {
  const status = state.live.status;
  const luaHost = state.live.luaHost;
  if (!status) {
    els.liveSessionPanel.innerHTML = '<div class="empty-state compact">Checking for your running game…</div>';
    els.liveSafetyPanel.innerHTML = '<div class="empty-state compact">Editing status will appear here.</div>';
    els.liveModulesBody.innerHTML = "";
    els.luaHostState.textContent = "Game not found";
    els.runLuaBtn.disabled = true;
    return;
  }
  const build = (status.builds || []).find((item) => String(item.path || "").toLowerCase().endsWith("collegefb27.exe"));
  const process = (status.gameProcesses || [])[0];
  const attach = process?.readOnlyAttach || {};
  els.liveSessionPanel.innerHTML = `
    <h3>Game Connection</h3>
    <dl class="detail-list">
      <dt>Status</dt><dd><strong>${attach.attached ? "Connected" : "Game not found"}</strong></dd>
      <dt>Game</dt><dd>${process ? "College Football 27" : "Launch CFB27 in offline mode"}</dd>
      <dt>Version</dt><dd>${build?.recognized ? "Supported" : "Not yet supported"}</dd>
      <dt>Lua scripts</dt><dd>${luaHost?.ready ? "Ready" : "Not loaded"}</dd>
    </dl>
    <details class="inline-technical"><summary>Connection info</summary><code>${escapeHtml(build?.sha256 || "-")}</code></details>`;
  const blockers = status.writeBlockers || [];
  els.liveSafetyPanel.innerHTML = `
    <h3>Editing Status</h3>
    <p class="editing-state"><strong>${status.writeEligible ? "Ready to edit" : "Preview only"}</strong></p>
    <p>${status.writeEligible ? "Player changes are available." : "Player search works, but changes are temporarily disabled while this build is being verified."}</p>
    <details class="inline-technical"><summary>Why?</summary><ul>${blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>No issues found.</li>"}</ul></details>`;
  const modules = process?.modules || [];
  els.luaHostState.textContent = luaHost?.ready ? "Ready" : "Not loaded";
  els.runLuaBtn.disabled = !luaHost?.ready;
  els.liveModulesBody.innerHTML = modules.map((module) => `
    <tr>
      <td>${escapeHtml(module.name)}</td>
      <td><code>0x${Number(module.base || 0).toString(16).toUpperCase()}</code></td>
      <td>${numberFmt(module.size)}</td>
      <td>${escapeHtml(module.path)}</td>
    </tr>`).join("");
}

function liveRatingSummary(objects, field, fallback) {
  const counts = new Map();
  for (const object of objects || []) {
    const value = Number(object?.ratings?.[field]);
    if (!Number.isInteger(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const values = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  return {
    value: values.length ? values[0][0] : Number(fallback),
    matchingCount: values.length ? values[0][1] : 0,
    values,
    conflicted: values.length > 1,
  };
}

function renderLivePlayer() {
  const result = state.live.playerResult;
  if (!result) {
    els.livePlayerPanel.innerHTML = '<div class="empty-state compact">Search for a player above to view their ratings.</div>';
    return;
  }
  const player = result.player || {};
  const discovery = result.discovery || {};
  const objects = discovery.objects || [];
  const ratingFields = Object.keys(player.ratings || objects[0]?.ratings || {});
  const conflicts = ratingFields.filter((field) => liveRatingSummary(objects, field, player.ratings?.[field]).conflicted);
  els.livePlayerPanel.innerHTML = `
    <h3>${escapeHtml(`${player.firstName || ""} ${player.lastName || ""}`.trim())}</h3>
    <p class="player-subtitle">${escapeHtml(player.position || "-")} · Player ID ${numberFmt(player.playerId)}</p>
    <p class="support-note">Apply holds the Dynasty record at the new value and arms the verified player-response guard. Reopen the player page once to refresh the game UI.</p>
    <div class="support-table-wrap">
      <table class="compact-table">
        <thead><tr><th>Rating</th><th>Detected runtime</th><th>Saved value</th><th>Action</th></tr></thead>
        <tbody>${ratingFields.map((field) => {
          const summary = liveRatingSummary(objects, field, player.ratings?.[field]);
          const distribution = summary.values.map(([value, count]) => `${value} × ${count}`).join(", ");
          return `
          <tr>
            <td>${escapeHtml(field)}</td>
            <td><input type="number" min="0" max="${field === "overall" ? 100 : 99}" value="${numberFmt(summary.value)}" data-live-rating-value="${escapeHtml(field)}" data-live-rating-before="${numberFmt(summary.value)}" aria-label="${escapeHtml(field)} runtime value" title="${escapeHtml(distribution || "No runtime copy detected")}"></td>
            <td>${numberFmt(player.ratings?.[field])}</td>
            <td>
              <button type="button" data-live-write-rating="${escapeHtml(field)}">Apply</button>
              <button class="secondary-action" type="button" data-live-restore-rating="${escapeHtml(field)}">Reset</button>
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
    <details class="technical-details inline-player-details"><summary>Technical details</summary><p>${numberFmt(discovery.count)} matching object(s) · ${numberFmt(conflicts.length)} field conflict(s) · layout ${escapeHtml(discovery.ratingLayoutVersion || "-")}</p></details>`;
}

async function writeLiveRating(field, value) {
  const result = state.live.playerResult;
  const discovery = result?.discovery;
  const player = result?.player;
  const objects = discovery?.objects || [];
  if (!player) throw new Error("Find a player before writing.");
  const summary = liveRatingSummary(objects, field, player.ratings?.[field]);
  const before = summary.value;
  const next = Number(value);
  const maximum = field === "overall" ? 100 : 99;
  if (!Number.isInteger(next) || next < 0 || next > maximum) {
    throw new Error(`${field} must be an integer from 0 to ${maximum}.`);
  }
  if (next === before) {
    setStatus(`${field} is already ${next}.`);
    return;
  }
  const confirmed = window.confirm(`Change ${player.firstName} ${player.lastName} ${field} from ${before} to ${next} in the active offline Dynasty?`);
  if (!confirmed) return;
  const response = await api("/api/live/hook/apply-rating", {
    method: "POST",
    body: JSON.stringify({
      file: state.selectedFile,
      row: player.row,
      field,
      expected: Number(player.ratings?.[field]),
      value: next,
    }),
  });
  if (!response.directWrite?.verified) {
    throw new Error("The live write did not pass readback verification.");
  }
  state.live.playerResult = {
    ...result,
    player: response.player || {
      ...player,
      ratings: { ...player.ratings, [field]: next },
    },
    discovery: response.discovery || discovery,
  };
  renderLivePlayer();
  const refreshMessage = response.refresh === "instant"
    ? "Updated in the roster now."
    : response.refresh === "edit-player-fallback"
      ? "Updated and saved, but this screen still needs the Edit Player fallback."
      : "Updated live. If the roster still shows the old value, move the roster cursor away and back once.";
  setStatus(`${player.firstName} ${player.lastName} ${field} ${before} → ${next}. ${refreshMessage}`);
}

async function discoverLivePlayer() {
  const query = els.livePlayerQuery.value.trim();
  if (!state.selectedFile) throw new Error("Select a Dynasty save first.");
  if (!query) throw new Error("Enter a player name.");
  els.discoverLivePlayerBtn.disabled = true;
  setStatus(`Discovering live player ${query}...`);
  try {
    state.live.playerResult = await api("/api/live/discover-player", {
      method: "POST",
      body: JSON.stringify({ file: state.selectedFile, query }),
    });
    renderLivePlayer();
    const count = state.live.playerResult.discovery?.count || 0;
    setStatus(`Found ${count} verified live object(s) for ${query}.`, count === 0);
  } finally {
    els.discoverLivePlayerBtn.disabled = false;
  }
}

async function loadLiveStatus() {
  state.live.loading = true;
  els.refreshLiveBtn.disabled = true;
  try {
    [state.live.status, state.live.luaHost] = await Promise.all([
      api("/api/live/status"),
      api("/api/live/lua/status"),
    ]);
    renderLiveStatus();
    const process = state.live.status.gameProcesses?.[0];
    setStatus(process ? "Connected to College Football 27." : "College Football 27 is not running.", !process);
  } finally {
    state.live.loading = false;
    els.refreshLiveBtn.disabled = false;
  }
}

async function runLuaSnippet() {
  const script = els.luaScriptInput.value.trim();
  if (!script) throw new Error("Enter a Lua script first.");
  if (!state.live.luaHost?.ready) throw new Error("The Lua host is not loaded in the running game.");
  els.runLuaBtn.disabled = true;
  setStatus("Running Lua in College Football 27...");
  try {
    await api("/api/live/lua/eval", {
      method: "POST",
      body: JSON.stringify({ script }),
    });
    setStatus("Lua script ran in the current game session.");
  } finally {
    els.runLuaBtn.disabled = !state.live.luaHost?.ready;
  }
}

async function unlockDynastyEditing() {
  if (!state.selectedFile) throw new Error("Select the active Dynasty autosave first.");
  els.unlockDynastyBtn.disabled = true;
  setStatus("Unlocking Dynasty editing controls...");
  try {
    await api("/api/live/hook/attach", { method: "POST" });
    const result = await api("/api/live/hook/unlock-editing", {
      method: "POST",
      body: JSON.stringify({ file: state.selectedFile }),
    });
    setStatus(
      result.monitor?.running
        ? "Dynasty editing is unlocked and will stay unlocked while the game is open. Back out and reopen the player screen."
        : "Dynasty editing is unlocked. Back out and reopen the player screen.",
    );
  } finally {
    els.unlockDynastyBtn.disabled = false;
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
  const directory = state.saveDirectory || "No save folder selected";
  els.saveDirectoryLabel.textContent = `Save folder: ${directory}`;
  els.saveDirectoryLabel.title = directory;
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

function starString(count) {
  const stars = starCountFromValue(count);
  if (!stars) return "------";
  return `${"★".repeat(Math.max(0, Math.min(5, stars)))}${"☆".repeat(Math.max(0, 5 - stars))}`;
}

function starCountFromValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value || "").trim().toLowerCase().replace(/[_\s-]/g, "");
  if (!normalized) return 0;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (normalized.includes("five") || normalized === "5star") return 5;
  if (normalized.includes("four") || normalized === "4star") return 4;
  if (normalized.includes("three") || normalized === "3star") return 3;
  if (normalized.includes("two") || normalized === "2star") return 2;
  if (normalized.includes("one") || normalized === "1star") return 1;
  return 0;
}

function compactName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return String(name || "-");
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function lastNameFirstInitial(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return String(name || "-").toUpperCase();
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`.toUpperCase();
}

function offerShort(target) {
  return target.offerState === "Offered" ? "Y" : "N";
}

function interestLabel(target) {
  if (target.interestRank) return `${target.interestRank}${target.interestRank === 1 ? "st" : "th"}`;
  if (target.prospectInfluenceTotal > 0) return "Top 3";
  return target.offerState === "Offered" ? "10th" : "--";
}

function stageLabel(target) {
  if (target.offerState === "Offered" && target.currentNilOffer > 0) return "Top 3";
  if (target.offerState === "Offered") return "Committed";
  return "Open";
}

function archetypeLabel(value) {
  return String(value || "Unknown")
    .replace(/^[A-Z]{1,3}_/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function recruitingTargets() {
  const board = state.recruiting.board || {};
  const query = (state.recruiting.filter || "").trim().toLowerCase();
  const targets = (board.targets || []).filter((target) => {
    if (!query) return true;
    return [
      target.name,
      target.position,
      target.nationalRank,
      target.offerState,
      target.stage,
      (target.selectedActions || []).join(" "),
    ].join(" ").toLowerCase().includes(query);
  });
  const sort = state.recruiting.sort || "rank";
  targets.sort((left, right) => {
    if (sort === "hours") return Number(right.activeHours || 0) - Number(left.activeHours || 0);
    if (sort === "position") return String(left.position || "").localeCompare(String(right.position || ""));
    if (sort === "name") return String(left.name || "").localeCompare(String(right.name || ""));
    return Number(left.nationalRank || Number.MAX_SAFE_INTEGER) - Number(right.nationalRank || Number.MAX_SAFE_INTEGER);
  });
  return targets;
}

function selectedRecruitingTarget() {
  const targets = state.recruiting.board?.targets || [];
  return targets.find((target) => target.id === state.recruiting.selectedId) || null;
}

function stagedActionKey(targetId, field) {
  return `${targetId || ""}:${field || ""}`;
}

function stagedActionForTarget(targetId, field) {
  const key = stagedActionKey(targetId, field);
  return (state.recruiting.stagedActions || []).find((item) => stagedActionKey(item.targetId, item.actionField) === key) || null;
}

function projectedActionEnabled(target, action) {
  const staged = stagedActionForTarget(target?.id, action.field);
  if (staged) return Boolean(staged.enabled);
  return Boolean((target?.actionBooleans || {})[action.field]);
}

function stagedActionHourDelta(action, beforeEnabled, afterEnabled) {
  if (beforeEnabled === afterEnabled) return 0;
  return afterEnabled ? action.hours : -action.hours;
}

function targetStagedActionPlans(targetId = "") {
  const actions = state.recruiting.stagedActions || [];
  return targetId ? actions.filter((item) => item.targetId === targetId) : actions;
}

function totalStagedActionHourDelta() {
  return (state.recruiting.stagedActions || []).reduce((total, item) => total + Number(item.hoursDelta || 0), 0);
}

function stageRecruitingWeeklyAction(target, action) {
  if (!target || !action) return;
  const beforeEnabled = Boolean((target.actionBooleans || {})[action.field]);
  const afterEnabled = !projectedActionEnabled(target, action);
  const hoursDelta = stagedActionHourDelta(action, beforeEnabled, afterEnabled);
  const key = stagedActionKey(target.id, action.field);
  const next = (state.recruiting.stagedActions || []).filter((item) => stagedActionKey(item.targetId, item.actionField) !== key);
  if (hoursDelta !== 0) {
    next.push({
      type: "set-weekly-action",
      targetId: target.id,
      userRecruitTargetRow: target.provenance?.userRecruitTargetRow,
      boardRow: target.provenance?.boardRow,
      recruitRow: target.provenance?.recruitRow,
      playerRow: target.provenance?.playerRow,
      name: target.name,
      actionField: action.field,
      actionLabel: action.label,
      enabled: afterEnabled,
      hoursDelta,
    });
  }
  state.recruiting.stagedActions = next;
  state.recruiting.preview = null;
  renderRecruitingWorkbench();
  setStatus(
    hoursDelta
      ? `Staged ${action.label} ${afterEnabled ? "on" : "off"} for ${target.name || target.id}`
      : `Cleared staged ${action.label} change`
  );
}

function renderStagedRecruitingActions(target = null) {
  const staged = targetStagedActionPlans(target?.id || "");
  if (!staged.length) return '<div class="cfb-staged-actions empty">No weekly action changes staged.</div>';
  return `
    <div class="cfb-staged-actions">
      <strong>Staged Weekly Actions</strong>
      <ul>
        ${staged.map((item) => `
          <li>
            <span>${escapeHtml(item.actionLabel || item.actionField)} ${item.enabled ? "on" : "off"}</span>
            <em>${item.hoursDelta > 0 ? "+" : ""}${numberFmt(item.hoursDelta)}h</em>
            <button type="button" data-recruiting-clear-action="${escapeHtml(stagedActionKey(item.targetId, item.actionField))}">Clear</button>
          </li>
        `).join("")}
      </ul>
    </div>
  `;
}

function renderRecruitingCounters() {
  if (!els.recruitingCounters) return;
  const board = state.recruiting.board;
  if (!board) {
    els.recruitingCounters.innerHTML = "";
    return;
  }
  const counters = board.counters || {};
  const stagedDelta = totalStagedActionHourDelta();
  const projectedHours = (Number(counters.hoursUsed || 0) + stagedDelta);
  const items = [
    ["Remaining", counters.remainingPoints, "◆"],
    ["Targets", `${numberFmt(counters.targetsUsed)}/${numberFmt(counters.targetsMax)}`, "⌖"],
    ["Hours", `${numberFmt(projectedHours)}/${numberFmt(counters.hoursMax)}${stagedDelta ? ` (${stagedDelta > 0 ? "+" : ""}${numberFmt(stagedDelta)})` : ""}`, "◴"],
    ["Scholarships", `${numberFmt(counters.scholarshipsUsed)}/${numberFmt(counters.scholarshipsMax)}`, "▣"],
  ];
  els.recruitingCounters.innerHTML = items
    .map(([label, value, icon]) => `
      <div class="cfb-scorebug-item">
        <em>${escapeHtml(icon)}</em>
        <span>${escapeHtml(label)}</span>
        <strong title="${escapeHtml(value)}">${escapeHtml(value ?? "-")}</strong>
      </div>
    `)
    .join("");
}

function gateChips(gates) {
  return Object.entries(gates || {})
    .map(([label, value]) => `<span title="${escapeHtml(value)}">${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`)
    .join("");
}

function renderRecruitingTargets() {
  if (!els.recruitingTargetsBody) return;
  const targets = recruitingTargets();
  if (!targets.length) {
    els.recruitingTargetsBody.innerHTML = '<tr class="empty-row"><td colspan="6">No board targets</td></tr>';
    return;
  }
  els.recruitingTargetsBody.innerHTML = targets
    .map((target, index) => `
      <tr class="${target.id === state.recruiting.selectedId ? "selected" : ""}" data-recruiting-target-id="${escapeHtml(target.id)}">
        <td>${numberFmt(index + 1)}</td>
        <td title="${escapeHtml(target.name || "")}">
          <strong>${escapeHtml(lastNameFirstInitial(target.name))}</strong>
          <span>${escapeHtml(starString(target.stars))}</span>
        </td>
        <td>${escapeHtml(target.position || "-")}</td>
        <td>◆ ${numberFmt(target.currentNilOffer || target.nilExpectation || 0)}</td>
        <td>${escapeHtml(interestLabel(target))}</td>
        <td>${numberFmt(target.activeHours)}/${numberFmt(target.maxHours)}</td>
      </tr>
    `)
    .join("");
}

function targetSummaryCards(targets) {
  const offered = targets.filter((target) => target.offerState === "Offered").length;
  const fiveStars = targets.filter((target) => Number(target.stars || 0) >= 5).length;
  const hours = targets.reduce((total, target) => total + Number(target.activeHours || 0), 0);
  return [
    ["Board Targets", targets.length],
    ["Scholarships", offered],
    ["5 Star Targets", fiveStars],
    ["Assigned Hours", hours],
  ];
}

function renderRecruitingDataTable(targets) {
  if (!targets.length) return '<div class="empty-state compact">No targets match the current filter.</div>';
  return `
    <div class="cfb-data-table-wrap">
      <table class="cfb-data-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
            <th>Pos</th>
            <th>Rating</th>
            <th>Archetype</th>
            <th>NIL</th>
            <th>Interest</th>
            <th>Hours</th>
            <th>Offer</th>
            <th>Visit</th>
          </tr>
        </thead>
        <tbody>
          ${targets.map((target) => `
            <tr data-recruiting-target-id="${escapeHtml(target.id)}">
              <td>${numberFmt(target.nationalRank)}</td>
              <td><strong>${escapeHtml(target.name || "-")}</strong></td>
              <td>${escapeHtml(target.position || "-")}</td>
              <td>${escapeHtml(starString(target.stars))}</td>
              <td>${escapeHtml(archetypeLabel(target.archetype))}</td>
              <td>◆ ${numberFmt(target.currentNilOffer || target.nilExpectation || 0)}</td>
              <td>${escapeHtml(interestLabel(target))}</td>
              <td>${numberFmt(target.activeHours)}/${numberFmt(target.maxHours)}</td>
              <td>${escapeHtml(offerShort(target))}</td>
              <td>${target.visit?.scheduledVisit ? `Week ${escapeHtml(target.visit.scheduledVisit.weekNumber ?? "-")}` : "-"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function prospectPoolProfiles() {
  const query = (state.recruiting.filter || "").trim().toLowerCase();
  const filters = state.recruiting.prospectFilters || {};
  const boardRows = boardRecruitRows();
  const stagedIds = stagedAddIdSet();
  const profiles = state.profiles.filter((profile) => {
    if (!profileMatches(profile, query)) return false;
    const football = profile.footballProfile || {};
    if (filters.position && filters.position !== "all" && String(football.position || "") !== filters.position) return false;
    if (filters.stars && filters.stars !== "all" && starCountForProfile(profile) !== Number(filters.stars)) return false;
    if (filters.board && filters.board !== "all") {
      const onBoard = boardRows.has(Number((profile.source || {}).recruitRow));
      const staged = stagedIds.has(profile.recruitId);
      if (filters.board === "board" && !onBoard) return false;
      if (filters.board === "available" && (onBoard || staged)) return false;
      if (filters.board === "staged" && !staged) return false;
    }
    return true;
  });
  const sort = state.recruiting.prospectSort || { key: state.recruiting.sort || "rank", direction: "asc" };
  const direction = sort.direction === "desc" ? -1 : 1;
  profiles.sort((left, right) => {
    const leftFootball = left.footballProfile || {};
    const rightFootball = right.footballProfile || {};
    const leftGame = left.gameFields || {};
    const rightGame = right.gameFields || {};
    const leftName = profileName(left);
    const rightName = profileName(right);
    let result = 0;
    if (sort.key === "position") result = String(leftFootball.position || "").localeCompare(String(rightFootball.position || "")) || leftName.localeCompare(rightName);
    else if (sort.key === "name") result = leftName.localeCompare(rightName);
    else if (sort.key === "stars") result = starCountForProfile(left) - starCountForProfile(right);
    else if (sort.key === "overall") result = Number((leftGame.ratings || {}).overall || 0) - Number((rightGame.ratings || {}).overall || 0);
    else if (sort.key === "dev") result = String(leftGame.developmentTrait || "").localeCompare(String(rightGame.developmentTrait || ""));
    else result = Number(leftFootball.nationalRank || Number.MAX_SAFE_INTEGER) - Number(rightFootball.nationalRank || Number.MAX_SAFE_INTEGER);
    return result * direction;
  });
  return profiles;
}

function boardRecruitRows() {
  return new Set((state.recruiting.board?.targets || [])
    .map((target) => Number(target.provenance?.recruitRow))
    .filter((row) => Number.isFinite(row)));
}

function stagedAddIdSet() {
  return new Set((state.recruiting.stagedAdds || []).map((item) => item.recruitId));
}

function selectedProspectIdSet() {
  return new Set(state.recruiting.selectedProspectIds || []);
}

function starCountForProfile(profile) {
  const football = profile.footballProfile || {};
  const game = profile.gameFields || {};
  return starCountFromValue(football.starRating || game.starRating || 0);
}

function profileStarString(profile) {
  return starString(starCountForProfile(profile));
}

function prospectFilterOptions(profiles) {
  const positions = [...new Set(profiles.map((profile) => profile.footballProfile?.position).filter(Boolean))].sort();
  return { positions };
}

const PROSPECT_VIRTUAL_ROW_HEIGHT = 48;
const PROSPECT_VIRTUAL_VIEWPORT_HEIGHT = 620;
const PROSPECT_VIRTUAL_BUFFER_ROWS = 6;

function prospectVirtualWindow(profiles, scrollTop) {
  const rowHeight = PROSPECT_VIRTUAL_ROW_HEIGHT;
  const viewportHeight = PROSPECT_VIRTUAL_VIEWPORT_HEIGHT;
  const total = profiles.length;
  const maxScrollTop = Math.max(0, total * rowHeight - viewportHeight);
  const clampedScrollTop = Math.min(Math.max(0, Number(scrollTop || 0)), maxScrollTop);
  const start = Math.max(0, Math.floor(clampedScrollTop / rowHeight) - PROSPECT_VIRTUAL_BUFFER_ROWS);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + (PROSPECT_VIRTUAL_BUFFER_ROWS * 2) + 2;
  const end = Math.min(total, start + visibleCount);
  return { rowHeight, viewportHeight, total, start, end, visible: profiles.slice(start, end) };
}

function prospectVirtualRowsHtml(profiles) {
  const boardRows = boardRecruitRows();
  const selectedIds = selectedProspectIdSet();
  const stagedIds = stagedAddIdSet();
  return profiles.map((profile) => {
    const football = profile.footballProfile || {};
    const game = profile.gameFields || {};
    const identity = profile.identity || {};
    const source = profile.source || {};
    const ratings = game.ratings || {};
    const onBoard = boardRows.has(Number(source.recruitRow));
    const staged = stagedIds.has(profile.recruitId);
    const selected = selectedIds.has(profile.recruitId);
    const canAdd = !onBoard && !staged;
    return `
      <div class="cfb-virtual-row ${selected ? "selected" : ""}" data-profile-id="${escapeHtml(profile.recruitId || "")}" style="height:${PROSPECT_VIRTUAL_ROW_HEIGHT}px">
        <span><input type="checkbox" data-prospect-select="${escapeHtml(profile.recruitId || "")}" ${selected ? "checked" : ""} ${canAdd ? "" : "disabled"}></span>
        <span>${numberFmt(football.nationalRank || 0)}</span>
        <span title="${escapeHtml(profileName(profile))}"><strong>${escapeHtml(profileName(profile) || "-")}</strong></span>
        <span>${escapeHtml(football.position || "-")}</span>
        <span>${escapeHtml(profileStarString(profile))}</span>
        <span title="${escapeHtml(football.archetypeDisplay || football.archetype || "")}">${escapeHtml(football.archetypeDisplay || football.archetype || "-")}</span>
        <span>${numberFmt(ratings.overall)}</span>
        <span>${escapeHtml(game.developmentTrait || "-")}</span>
        <span title="${escapeHtml([identity.hometown, identity.homeState].filter(Boolean).join(", "))}">${escapeHtml(identity.homeState || identity.hometown || "-")}</span>
        <span>${onBoard ? "On board" : (staged ? "Staged" : "Available")}</span>
        <span><button type="button" data-prospect-add="${escapeHtml(profile.recruitId || "")}" ${canAdd ? "" : "disabled"}>${staged ? "Staged" : (onBoard ? "On Board" : "Add")}</button></span>
      </div>
    `;
  }).join("");
}

function sortHeader(key, label) {
  const sort = state.recruiting.prospectSort || {};
  const active = sort.key === key;
  const indicator = active ? ` ${sort.direction === "desc" ? "desc" : "asc"}` : "";
  return `<button type="button" data-prospect-sort="${escapeHtml(key)}" class="${active ? "active" : ""}">${escapeHtml(label)}${indicator}</button>`;
}

function updateProspectVirtualWindow() {
  if (state.recruiting.activeTab !== "prospects") return;
  const body = els.recruitingDetail?.querySelector("[data-prospect-virtual-body]");
  const windowEl = els.recruitingDetail?.querySelector("[data-prospect-virtual-window]");
  const spacer = els.recruitingDetail?.querySelector("[data-prospect-virtual-spacer]");
  const meta = els.recruitingDetail?.querySelector("[data-prospect-virtual-meta]");
  if (!body || !windowEl || !spacer || !meta) return;
  const profiles = prospectPoolProfiles();
  const view = prospectVirtualWindow(profiles, body.scrollTop);
  state.recruiting.prospectScrollTop = body.scrollTop;
  spacer.style.height = `${view.total * view.rowHeight}px`;
  windowEl.style.transform = `translateY(${view.start * view.rowHeight}px)`;
  windowEl.innerHTML = prospectVirtualRowsHtml(view.visible);
  meta.innerHTML = `
    <span>Showing ${numberFmt(view.total)} decoded recruit profiles</span>
    <span>Rows ${numberFmt(view.start + 1)}-${numberFmt(view.end)} rendered</span>
  `;
}

function renderProspectVirtualTable(profiles) {
  const rowHeight = 48;
  const viewportHeight = 620;
  const view = prospectVirtualWindow(profiles, state.recruiting.prospectScrollTop);
  if (!view.total) return '<div class="empty-state compact">No prospects match the current filter.</div>';
  return `
    <div class="cfb-virtual-meta" data-prospect-virtual-meta>
      <span>Showing ${numberFmt(view.total)} decoded recruit profiles</span>
      <span>Rows ${numberFmt(view.start + 1)}-${numberFmt(view.end)} rendered</span>
    </div>
      <div class="cfb-virtual-table">
      <div class="cfb-virtual-row header">
        <span></span>
        <span>${sortHeader("rank", "Rank")}</span>
        <span>${sortHeader("name", "Name")}</span>
        <span>${sortHeader("position", "Pos")}</span>
        <span>${sortHeader("stars", "Stars")}</span>
        <span>Archetype</span>
        <span>${sortHeader("overall", "OVR")}</span>
        <span>${sortHeader("dev", "Dev")}</span>
        <span>Home</span>
        <span>Status</span>
        <span>Board</span>
      </div>
      <div class="cfb-virtual-body" data-prospect-virtual-body style="height:${viewportHeight}px">
        <div class="cfb-virtual-spacer" data-prospect-virtual-spacer style="height:${view.total * rowHeight}px">
          <div class="cfb-virtual-window" data-prospect-virtual-window style="transform:translateY(${view.start * rowHeight}px)">
            ${prospectVirtualRowsHtml(view.visible)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderProspectControls(allProfiles, filteredProfiles) {
  const options = prospectFilterOptions(allProfiles);
  const filters = state.recruiting.prospectFilters || {};
  const selectedCount = (state.recruiting.selectedProspectIds || []).length;
  const stagedCount = (state.recruiting.stagedAdds || []).length;
  const boardCount = (state.recruiting.board?.targets || []).length;
  const boardMax = Number(state.recruiting.board?.counters?.targetsMax || 35);
  return `
    <div class="cfb-prospect-toolbar">
      <label>
        <span>Position</span>
        <select data-prospect-filter="position">
          <option value="all">All</option>
          ${options.positions.map((position) => `<option value="${escapeHtml(position)}" ${filters.position === position ? "selected" : ""}>${escapeHtml(position)}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>Stars</span>
        <select data-prospect-filter="stars">
          <option value="all">All</option>
          ${[5, 4, 3, 2, 1].map((stars) => `<option value="${stars}" ${String(filters.stars) === String(stars) ? "selected" : ""}>${stars} Star</option>`).join("")}
        </select>
      </label>
      <label>
        <span>Board</span>
        <select data-prospect-filter="board">
          ${[
            ["all", "All"],
            ["available", "Available"],
            ["board", "On Board"],
            ["staged", "Staged"],
          ].map(([value, label]) => `<option value="${value}" ${filters.board === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <div class="cfb-prospect-actions">
        <button type="button" data-prospect-select-visible>Select Visible</button>
        <button type="button" data-prospect-clear-selection ${selectedCount ? "" : "disabled"}>Clear Selection</button>
        <button type="button" data-prospect-stage-selected ${selectedCount ? "" : "disabled"}>Add Selected to Board</button>
        <button type="button" data-prospect-clear-staged ${stagedCount ? "" : "disabled"}>Clear Staged</button>
      </div>
      <div class="cfb-prospect-counts">
        <span>${numberFmt(filteredProfiles.length)} shown</span>
        <span>${numberFmt(selectedCount)} selected</span>
        <span>${numberFmt(stagedCount)} staged</span>
        <span>${numberFmt(boardCount)}/${numberFmt(boardMax)} board</span>
      </div>
    </div>
  `;
}

function renderStagedBoardAdds() {
  const staged = state.recruiting.stagedAdds || [];
  const preview = state.recruiting.preview;
  if (!staged.length) {
    return '<div class="cfb-staged-adds empty">No prospects staged for board add.</div>';
  }
  return `
    <div class="cfb-staged-adds">
      <div>
        <strong>Staged Board Adds</strong>
        <span>${numberFmt(staged.length)} prospect(s). Preview-only until board allocation writes are proven.</span>
      </div>
      <button type="button" data-prospect-preview-staged>Preview Add Plan</button>
      <ul>
        ${staged.slice(0, 12).map((item) => `
          <li>
            <span>${escapeHtml(item.name)}</span>
            <em>${escapeHtml(item.position || "-")} | #${numberFmt(item.nationalRank)}</em>
            <button type="button" data-prospect-unstage="${escapeHtml(item.recruitId)}">Remove</button>
          </li>
        `).join("")}
        ${staged.length > 12 ? `<li><span>+${numberFmt(staged.length - 12)} more</span></li>` : ""}
      </ul>
      ${preview ? `
        <div class="cfb-staged-preview">
          <strong>${preview.valid ? "Preview valid" : "Preview has errors"}</strong>
          <span>${preview.writeEnabled ? "Write enabled" : "Write gated"} | Planned hour delta ${numberFmt(preview.hourSummary?.plannedDelta || 0)}</span>
          ${(preview.warnings || []).map((warning) => `<em>${escapeHtml(warning.message || warning.code || warning)}</em>`).join("")}
          ${(preview.errors || []).map((error) => `<em class="error">${escapeHtml(error.message || error.code || error)}</em>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function profileByRecruitId(recruitId) {
  return state.profiles.find((profile) => profile.recruitId === recruitId) || null;
}

function stagedAddFromProfile(profile) {
  const football = profile.footballProfile || {};
  const source = profile.source || {};
  return {
    recruitId: profile.recruitId,
    playerId: profile.playerId,
    recruitRow: source.recruitRow,
    playerRow: source.playerRow,
    name: profileName(profile),
    position: football.position || "",
    nationalRank: football.nationalRank || 0,
  };
}

function canStageProfile(profile) {
  if (!profile) return false;
  const boardCount = (state.recruiting.board?.targets || []).length;
  const boardMax = Number(state.recruiting.board?.counters?.targetsMax || 35);
  if (boardCount + (state.recruiting.stagedAdds || []).length >= boardMax) return false;
  const source = profile.source || {};
  if (boardRecruitRows().has(Number(source.recruitRow))) return false;
  if (stagedAddIdSet().has(profile.recruitId)) return false;
  return true;
}

function stageProspectsForBoard(recruitIds) {
  const next = state.recruiting.stagedAdds.slice();
  const seen = new Set(next.map((item) => item.recruitId));
  for (const recruitId of recruitIds) {
    const profile = profileByRecruitId(recruitId);
    if (!canStageProfile(profile) || seen.has(recruitId)) continue;
    next.push(stagedAddFromProfile(profile));
    seen.add(recruitId);
  }
  state.recruiting.stagedAdds = next;
  state.recruiting.selectedProspectIds = [];
  state.recruiting.preview = null;
  renderRecruitingWorkbench();
  setStatus(next.length ? `Staged ${numberFmt(next.length)} prospect(s) for board add preview` : "No eligible prospects selected", !next.length);
}

function updateProspectSelection(recruitId, selected) {
  const ids = new Set(state.recruiting.selectedProspectIds || []);
  const profile = profileByRecruitId(recruitId);
  if (selected && canStageProfile(profile)) ids.add(recruitId);
  else ids.delete(recruitId);
  state.recruiting.selectedProspectIds = [...ids];
}

function visibleProspectIds() {
  const profiles = prospectPoolProfiles();
  const view = prospectVirtualWindow(profiles, state.recruiting.prospectScrollTop);
  return view.visible.map((profile) => profile.recruitId).filter(Boolean);
}

function renderRecruitingSchoolView(board, targets) {
  const counters = board.counters || {};
  return `
    <section class="cfb-view-panel">
      <div class="cfb-view-head">
        <h3>My School</h3>
        <p>Save-level recruiting state decoded from the current board row.</p>
      </div>
      <div class="cfb-summary-grid">
        ${[
          ["Remaining Points", counters.remainingPoints],
          ["Targets", `${numberFmt(counters.targetsUsed)}/${numberFmt(counters.targetsMax)}`],
          ["Hours", `${numberFmt(counters.hoursUsed)}/${numberFmt(counters.hoursMax)}`],
          ["Scholarships", `${numberFmt(counters.scholarshipsUsed)}/${numberFmt(counters.scholarshipsMax)}`],
          ["Board Row", board.boardRow],
          ["Visible Hours Used", counters.boardVisibleHoursUsed],
        ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "-")}</strong></div>`).join("")}
      </div>
      <div class="cfb-split-panels">
        <section>
          <h4>Position Load</h4>
          <div class="cfb-position-grid">
            ${Object.entries(targets.reduce((acc, target) => {
              const key = target.position || "-";
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, {})).sort((a, b) => a[0].localeCompare(b[0])).map(([position, count]) => `
              <span>${escapeHtml(position)} <strong>${numberFmt(count)}</strong></span>
            `).join("") || "<em>No targets</em>"}
          </div>
        </section>
        <section>
          <h4>Write Gates</h4>
          <div class="state-chips">${gateChips(board.writeGates)}</div>
        </section>
      </div>
    </section>
  `;
}

function renderRecruitingClassesView(board, targets) {
  const cards = targetSummaryCards(targets);
  return `
    <section class="cfb-view-panel">
      <div class="cfb-view-head">
        <h3>Top Classes</h3>
        <p>Class rankings are not decoded yet; this view shows the current save's board summary until school-class tables are proven.</p>
      </div>
      <div class="cfb-summary-grid">
        ${cards.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${numberFmt(value)}</strong></div>`).join("")}
      </div>
      ${renderRecruitingDataTable(targets.slice(0, 12))}
    </section>
  `;
}

function renderRecruitingPortalView() {
  return `
    <section class="cfb-view-panel">
      <div class="cfb-view-head">
        <h3>Transfer Portal</h3>
        <p>Transfer portal tables are not decoded in the current 017 scope. This tab is wired so it can become a real decoded view once the data path exists.</p>
      </div>
      <div class="empty-state compact">No transfer portal data is available from the recruiting board payload.</div>
    </section>
  `;
}

function renderRecruitingTabContent() {
  const board = state.recruiting.board;
  const targets = recruitingTargets();
  if (!els.recruitingDetail || !els.recruitingSide) return false;
  if (!board) return false;
  if (state.recruiting.activeTab === "board") return false;
  els.recruitingSide.innerHTML = "";
  if (state.recruiting.activeTab === "prospects") {
    const allProfiles = state.profiles.slice();
    const profiles = prospectPoolProfiles();
    els.recruitingDetail.innerHTML = `
      <section class="cfb-view-panel">
        <div class="cfb-view-head">
          <h3>Prospect List</h3>
          <p>Full decoded recruit pool from the selected save. The table only renders the visible rows.</p>
        </div>
        ${renderProspectControls(allProfiles, profiles)}
        ${renderStagedBoardAdds()}
        ${renderProspectVirtualTable(profiles)}
      </section>
    `;
    requestAnimationFrame(() => {
      const body = els.recruitingDetail.querySelector("[data-prospect-virtual-body]");
      if (body && Math.abs(body.scrollTop - (state.recruiting.prospectScrollTop || 0)) > 1) {
        body.scrollTo(0, state.recruiting.prospectScrollTop || 0);
      }
    });
    return true;
  }
  if (state.recruiting.activeTab === "portal") {
    els.recruitingDetail.innerHTML = renderRecruitingPortalView();
    return true;
  }
  if (state.recruiting.activeTab === "school") {
    els.recruitingDetail.innerHTML = renderRecruitingSchoolView(board, targets);
    return true;
  }
  if (state.recruiting.activeTab === "classes") {
    els.recruitingDetail.innerHTML = renderRecruitingClassesView(board, targets);
    return true;
  }
  return false;
}

function renderRecruitingDetail() {
  if (!els.recruitingDetail || !els.recruitingSide) return;
  const board = state.recruiting.board;
  const target = selectedRecruitingTarget();
  if (!board) {
    els.recruitingDetail.innerHTML = '<div class="empty-state compact">Load a board and select a target.</div>';
    els.recruitingSide.innerHTML = '<div class="empty-state compact">Write gates and provenance will appear here.</div>';
    return;
  }
  if (renderRecruitingTabContent()) return;
  if (!target) {
    els.recruitingDetail.innerHTML = '<div class="empty-state compact">Select a target from the board.</div>';
    els.recruitingSide.innerHTML = `<section class="inspector-section"><h3>Write Gates</h3><div class="state-chips">${gateChips(board.writeGates)}</div></section>`;
    return;
  }
  const profile = target.recruitingProfile || {};
  const visit = target.visit || {};
  const actions = target.selectedActions || [];
  const stagedActions = targetStagedActionPlans(target.id);
  const nilValue = target.currentNilOffer || target.nilExpectation || 0;
  const heightWeight = `${target.heightDisplay || "-"} | ${target.weightLbs ? `${numberFmt(target.weightLbs)} lbs` : "-"}`;
  const theme = recruitingTheme(board);
  const markClass = programMarkClass(theme);
  els.recruitingDetail.innerHTML = `
    <section class="cfb-recruit-hero">
      <div class="cfb-program-script ${markClass}" data-cfb-program-mark>${escapeHtml(theme.mark)}</div>
      <div class="cfb-player-silhouette"></div>
      <div class="cfb-hero-name">
        <span>${escapeHtml(String(target.name || "").split(/\s+/)[0] || "")}</span>
        <strong>${escapeHtml(String(target.name || target.id).split(/\s+/).slice(1).join(" ") || target.name || target.id)}</strong>
        <em>${escapeHtml(starString(target.stars))} | NAT: ${numberFmt(target.nationalRank)} | STA: ${numberFmt(target.stateRank)} | POS: ${numberFmt(target.positionRank)}</em>
      </div>
      <dl class="cfb-hero-facts">
        <div><dt>Position</dt><dd>${escapeHtml(target.position || "-")}</dd></div>
        <div><dt>Class</dt><dd>High School</dd></div>
        <div><dt>Height & Weight</dt><dd>${escapeHtml(heightWeight)}</dd></div>
        <div><dt>Archetype</dt><dd>${escapeHtml(archetypeLabel(target.archetype))}</dd></div>
        <div><dt>Expected NIL</dt><dd>◆ ${numberFmt(nilValue)}</dd></div>
        <div><dt>Hometown</dt><dd>${escapeHtml([target.hometown, target.homeState].filter(Boolean).join(", ") || "-")}</dd></div>
      </dl>
    </section>

    <section class="cfb-detail-panel">
      <div class="cfb-panel-tabs">
        <strong>Overview</strong>
        <span>Recruiting</span>
        <span>Scouting</span>
        <em>◆ ${numberFmt(target.currentNilOffer || 0)}</em>
        <em>◴ ${numberFmt(target.activeHours)}/${numberFmt(target.maxHours)}</em>
      </div>
      <div class="cfb-overview-grid">
        <section>
          <h3>Top Schools</h3>
          <div class="cfb-school-row">
            <span>#</span>
            <span>School</span>
            <span>Influence</span>
            <span>Offer</span>
            <strong>1</strong>
            <b class="cfb-mini-logo ${markClass}" data-cfb-program-mark>${escapeHtml(theme.mark)}</b>
            <div class="cfb-influence"><i style="width:${Math.max(12, Math.min(100, Number(target.prospectInfluenceTotal || 65)))}%"></i></div>
            <b>${offerShort(target)}</b>
          </div>
        </section>
        <section class="cfb-commit-box">
          <div class="cfb-big-logo ${markClass}" data-cfb-program-mark>${escapeHtml(theme.mark)}</div>
          <strong>${escapeHtml(stageLabel(target))}</strong>
          <span>${escapeHtml(target.name || "This prospect")} ${stageLabel(target) === "Committed" ? "has committed." : "is still available."}</span>
        </section>
      </div>
    </section>

    <section class="cfb-action-panel">
      <h3>Planning</h3>
      <div class="planner-grid cfb-planner-grid">
        ${RECRUITING_WEEKLY_ACTIONS.map((action) => {
          const current = Boolean((target.actionBooleans || {})[action.field]);
          const projected = projectedActionEnabled(target, action);
          const staged = stagedActionForTarget(target.id, action.field);
          return `
          <button type="button" class="${projected ? "active" : ""} ${staged ? "staged" : ""}" data-recruiting-action="${escapeHtml(action.field)}" title="${escapeHtml(action.label)} (${numberFmt(action.hours)}h)">
            <span>${escapeHtml(action.shortLabel)}</span>
            <strong>${numberFmt(action.hours)}h</strong>
            <em>${projected ? "On" : "Off"}${staged ? ` | ${current ? "was on" : "was off"}` : ""}</em>
          </button>
        `;
        }).join("")}
        ${[
          ["Scholarship", "Offer writes still need coupled ProspectInteraction/feedback validation"],
          ["Visit", "Visit allocation and ProspectInteraction bit windows remain read-only"],
          ["Sell/Sway", "Use existing active-pitch rows only; allocation remains blocked"],
        ].map(([label, title]) => `
          <button type="button" disabled title="${escapeHtml(title)}"><span>${escapeHtml(label)}</span><strong>Gated</strong><em>Needs recipe</em></button>
        `).join("")}
      </div>
      ${renderStagedRecruitingActions(target)}
      <p class="support-note">Weekly action toggles are mapping-validated and previewable. Apply remains copy-write gated until the board write path is enabled.</p>
    </section>
  `;
  const pitches = (target.activePitches || [])
    .map((pitch) => `<li>${escapeHtml(pitch.field)} <strong>Row ${numberFmt(pitch.row)}</strong> <span>Pitch ${escapeHtml(pitch.pitch ?? "-")} / ${escapeHtml(pitch.intensity ?? "-")}</span></li>`)
    .join("");
  els.recruitingSide.innerHTML = `
    <section class="cfb-side-profile">
      <div class="cfb-side-header">
        <span class="cfb-online-dot"></span>
      </div>
      <h3>${escapeHtml(String(target.name || "").split(/\s+/)[0] || "")}</h3>
      <h2>${escapeHtml(String(target.name || target.id).split(/\s+/).slice(1).join(" ") || target.name || target.id)}</h2>
      <p>${escapeHtml(starString(target.stars))} | NAT: ${numberFmt(target.nationalRank)} | STA: ${numberFmt(target.stateRank)} | POS: ${numberFmt(target.positionRank)}</p>
      <dl>
        <div><dt>Position</dt><dd>${escapeHtml(target.position || "-")}</dd></div>
        <div><dt>Archetype</dt><dd>${escapeHtml(archetypeLabel(target.archetype))}</dd></div>
        <div><dt>Class & NIL</dt><dd>HS | ◆ ${numberFmt(nilValue)}</dd></div>
        <div><dt>Height & Weight</dt><dd>${escapeHtml(heightWeight)}</dd></div>
        <div><dt>Hometown</dt><dd>${escapeHtml([target.hometown, target.homeState].filter(Boolean).join(", ") || "-")}</dd></div>
      </dl>
    </section>

    <section class="cfb-side-block">
      <h3>Visit</h3>
      <div class="cfb-side-stats">
        <span>Scheduled <strong>${visit.scheduledVisit ? "Yes" : "No"}</strong></span>
        <span>Week <strong>${escapeHtml(visit.scheduledVisit?.weekNumber ?? visit.prospectVisitState?.visitWeekNumber ?? "-")}</strong></span>
        <span>Offer <strong>${visit.prospectVisitState?.hasOfferedScholarship ? "Yes" : offerShort(target)}</strong></span>
      </div>
    </section>

    <section class="cfb-side-block">
      <h3>Active Pitches</h3>
      <ul class="cfb-pitch-list">${pitches || "<li>No active pitch rows</li>"}</ul>
      <p class="support-note">Existing rows are valid patch targets; missing row allocation stays blocked.</p>
    </section>

    <section class="cfb-dealbreaker">
      <span>Dealbreaker</span>
      <strong>${escapeHtml(profile.dealbreakerRaw ? "Coach Prestige" : "Unknown")}</strong>
      <em>Have A+ | Need B</em>
    </section>

    <section class="cfb-side-block debug">
      <h3>Rows</h3>
      <div class="cfb-side-stats">
        <span>Recruit <strong>${numberFmt(target.provenance?.recruitRow)}</strong></span>
        <span>Player <strong>${numberFmt(target.provenance?.playerRow)}</strong></span>
        <span>Target <strong>${numberFmt(target.provenance?.userRecruitTargetRow)}</strong></span>
        <span>Board <strong>${numberFmt(target.provenance?.boardRow)}</strong></span>
      </div>
    </section>

    <section class="cfb-side-block">
      <h3>Write Gates</h3>
      <div class="state-chips">${gateChips(board.writeGates)}</div>
    </section>
  `;
}

function renderRecruitingWorkbench() {
  const board = state.recruiting.board;
  applyRecruitingTheme(board);
  for (const tab of els.recruitingTabs) {
    const active = tab.dataset.recruitingTab === state.recruiting.activeTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  }
  if (els.recruitingStatus) {
    const warnings = board?.warnings || [];
    els.recruitingStatus.innerHTML = board
      ? `
        <span>${board.readOnly ? "Read-only board" : "Writable board"}</span>
        <span>${escapeHtml(board.saveName || state.selectedFile || "-")}</span>
        <span>Board Row ${numberFmt(board.boardRow)}</span>
        <span>${escapeHtml((board.saveFingerprint || "").slice(0, 12))}</span>
        ${warnings.map((warning) => `<span class="warning">${escapeHtml(warning)}</span>`).join("")}
      `
      : '<span>Loading recruiting board...</span>';
  }
  if (els.previewRecruitingPlanBtn) {
    els.previewRecruitingPlanBtn.disabled = !board || !((state.recruiting.stagedAdds || []).length || (state.recruiting.stagedActions || []).length);
  }
  renderRecruitingCounters();
  renderRecruitingTargets();
  renderRecruitingDetail();
}

async function loadRecruitingBoard() {
  if (!state.selectedFile) return;
  setStatus("Loading recruiting board...");
  const payload = await api(`/api/recruiting/${encodeURIComponent(state.selectedFile)}`);
  state.recruiting.board = payload;
  state.recruiting.preview = null;
  state.recruiting.stagedActions = [];
  state.recruiting.selectedId = payload.targets?.[0]?.id || "";
  renderRecruitingWorkbench();
  setStatus(`Loaded recruiting board with ${numberFmt((payload.targets || []).length)} target(s)`);
}

async function previewRecruitingPlan() {
  const board = state.recruiting.board;
  if (!board || !state.selectedFile) return;
  setStatus("Previewing recruiting plan...");
  const plans = (state.recruiting.stagedAdds || []).map((item) => ({
    type: "add-prospect-to-board",
    recruitId: item.recruitId,
    playerId: item.playerId,
    recruitRow: item.recruitRow,
    playerRow: item.playerRow,
    name: item.name,
    position: item.position,
    hoursDelta: 0,
  })).concat((state.recruiting.stagedActions || []).map((item) => ({
    type: "set-weekly-action",
    targetId: item.targetId,
    userRecruitTargetRow: item.userRecruitTargetRow,
    boardRow: item.boardRow,
    recruitRow: item.recruitRow,
    playerRow: item.playerRow,
    name: item.name,
    actionField: item.actionField,
    actionLabel: item.actionLabel,
    enabled: item.enabled,
    hoursDelta: item.hoursDelta,
  })));
  const payload = await api("/api/recruiting/preview", {
    method: "POST",
    body: JSON.stringify({
      file: state.selectedFile,
      saveFingerprint: board.saveFingerprint,
      plans,
    }),
  });
  state.recruiting.preview = payload;
  renderRecruitingWorkbench();
  setStatus(payload.valid ? "Recruiting plan preview is read-only and write-gated" : "Recruiting plan preview has errors", !payload.valid);
}

async function setSaveDirectory(directory, persist = false) {
  const payload = await api("/api/settings/save-directory", {
    method: "POST",
    body: JSON.stringify({ directory }),
  });
  if (persist && window.cfb27Desktop?.persistSaveDirectory) {
    await window.cfb27Desktop.persistSaveDirectory(payload.directory);
  }
  state.saveDirectory = payload.directory;
  state.selectedFile = "";
  await loadFiles();
  setStatus(`Using saves from ${payload.directory}`);
}

async function chooseSaveDirectory() {
  let directory = "";
  let persist = false;
  if (window.cfb27Desktop?.selectSaveDirectory) {
    const result = await window.cfb27Desktop.selectSaveDirectory();
    if (!result || result.canceled) return;
    directory = result.path;
    persist = true;
  } else {
    directory = window.prompt("Enter the full path to your CFB27 save folder:", state.saveDirectory || "") || "";
    if (!directory) return;
  }
  await setSaveDirectory(directory, persist);
}

async function syncDesktopSaveDirectory() {
  if (!window.cfb27Desktop?.getSaveDirectory) return false;
  const directory = await window.cfb27Desktop.getSaveDirectory();
  if (!directory) return false;
  await setSaveDirectory(directory, false);
  return true;
}

async function initializeFiles() {
  try {
    if (await syncDesktopSaveDirectory()) return;
  } catch (error) {
    setStatus(`Saved folder could not be opened: ${error.message}`, true);
  }
  await loadFiles();
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
  const externalPreviewOnly = preview.applyMode === "external-preview-only";
  els.applyPreviewBtn.disabled = !preview.valid || Boolean(apply) || Boolean(staleReason);
  els.exportPatchBtn.disabled = !preview.valid || Boolean(staleReason) || externalPreviewOnly;
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
        ${preview.engine ? `<span>${escapeHtml(preview.engine)}</span>` : ""}
        ${externalPreviewOnly ? '<span>Apply uses Home Dogs writer</span>' : ""}
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
  const profileLimit = state.currentPreview?.engine === "home-dogs" ? state.profiles.length : 700;
  const visible = state.profiles.filter((profile) => profileMatches(profile, query)).slice(0, profileLimit);
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
  state.profiles = [];
  state.currentPreview = null;
  state.previewContext = null;
  state.lastApplyResult = null;
  state.lastPatchExport = null;
  state.selectedProfileId = "";
  renderPreviewSummary();
  renderPreviewBrowser();
  renderProfiles();
  renderInspector(null);
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
    const engine = els.generatorEngineSelect?.value || "home-dogs";
    if (engine === "home-dogs" && els.seedInput?.value.trim() === "2026-class-1") {
      els.seedInput.value = "";
    }
    const rawSeed = els.seedInput?.value.trim() || "";
    const seed = engine === "home-dogs" && !rawSeed
      ? `home-dogs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : (rawSeed || "default");
    const normalizedConfig = engine === "home-dogs"
      ? state.currentConfig
      : await validateConfigObject(state.currentConfig);
    const payload = await api("/api/generator/preview", {
      method: "POST",
      body: JSON.stringify({
        file: state.selectedFile,
        config: normalizedConfig,
        seed,
        locks: state.lockMap,
        engine,
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
    const isHomeDogsPreview = payload.engine === "home-dogs";
    setStatus(
      payload.valid
        ? isHomeDogsPreview
          ? `Generated Home Dogs preview with ${numberFmt(payload.summary?.count || payload.recruits?.length || 0)} recruit(s)`
          : `Generated ${payload.engine || "local"} preview with ${numberFmt(payload.summary?.diffCount || 0)} writable diff(s)`
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
  const engine = preview.engine || els.generatorEngineSelect?.value || "local";
  const diffCount = engine === "home-dogs"
    ? (preview.summary?.count || preview.recruits?.length || 0)
    : (preview.summary?.diffCount || 0);
  const confirmed = window.confirm(
    engine === "home-dogs"
      ? `Run Home Dogs apply for ${numberFmt(diffCount)} generated recruit(s) and write a new modded save copy based on ${state.selectedFile}? The selected save stays unchanged and a backup will be created first.`
      : `Write ${numberFmt(diffCount)} generated field changes to a new modded save copy based on ${state.selectedFile}? The selected save stays unchanged and a backup will be created first.`,
  );
  if (!confirmed) return;
  els.applyPreviewBtn.disabled = true;
  setStatus(engine === "home-dogs" ? "Applying Home Dogs generated preview..." : "Applying generated preview...");
  try {
    const normalizedConfig = engine === "home-dogs"
      ? state.currentConfig
      : await validateConfigObject(state.currentConfig);
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
        engine,
        homeDogsPreviewPath: preview.homeDogs?.previewPath || "",
        saveFingerprint: preview.saveFingerprint || state.saveFingerprint || "",
      }),
    });
    state.lastApplyResult = payload;
    const isHomeDogsApply = payload.engine === "home-dogs";
    setStatus(
      isHomeDogsApply && payload.applied && payload.artifactWriteSucceeded
        ? `Applied Home Dogs class to ${payload.targetFile || "new modded save copy"}`
        : payload.applied && payload.artifactWriteSucceeded
        ? `Wrote ${numberFmt(payload.changedFieldCount || 0)} field change(s) to ${payload.targetFile || "new modded save copy"}`
        : isHomeDogsApply && payload.applied
          ? `Home Dogs apply wrote ${payload.targetFile || "the target save"}, but artifact writing failed: ${payload.artifactError || "unknown error"}`
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
  if (preview.applyMode === "external-preview-only") {
    setStatus("Home Dogs previews do not use the local dry-run patch exporter.", true);
    renderPreviewSummary();
    return;
  }
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
  state.saveDirectory = payload.directory || "";
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
  if (state.activeView === "recruiting") {
    await loadRecruitingBoard();
  }
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
els.chooseSaveFolderBtn.addEventListener("click", () => chooseSaveDirectory().catch((error) => setStatus(error.message, true)));
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
  state.recruiting = {
    ...state.recruiting,
    board: null,
    selectedId: "",
    preview: null,
    prospectScrollTop: 0,
    selectedProspectIds: [],
    stagedAdds: [],
    stagedActions: [],
  };
  loadProfiles().then(() => {
    if (state.activeView === "recruiting") return loadRecruitingBoard();
    return null;
  }).catch((error) => setStatus(error.message, true));
});
els.loadRecruitingBtn.addEventListener("click", () => loadRecruitingBoard().catch((error) => setStatus(error.message, true)));
els.previewRecruitingPlanBtn.addEventListener("click", () => previewRecruitingPlan().catch((error) => setStatus(error.message, true)));
els.recruitingSearch.addEventListener("input", () => {
  state.recruiting.filter = els.recruitingSearch.value;
  state.recruiting.prospectScrollTop = 0;
  renderRecruitingWorkbench();
});
els.recruitingSort.addEventListener("change", () => {
  state.recruiting.sort = els.recruitingSort.value;
  state.recruiting.prospectScrollTop = 0;
  renderRecruitingWorkbench();
});
els.recruitingDetail.addEventListener("scroll", (event) => {
  const body = event.target.closest?.("[data-prospect-virtual-body]");
  if (!body || state.recruiting.activeTab !== "prospects") return;
  state.recruiting.prospectScrollTop = body.scrollTop;
  if (state.recruiting.prospectRenderPending) return;
  state.recruiting.prospectRenderPending = true;
  requestAnimationFrame(() => {
    state.recruiting.prospectRenderPending = false;
    updateProspectVirtualWindow();
  });
}, true);
els.recruitingDetail.addEventListener("change", (event) => {
  const filter = event.target.closest?.("[data-prospect-filter]");
  if (filter) {
    state.recruiting.prospectFilters = {
      ...state.recruiting.prospectFilters,
      [filter.dataset.prospectFilter]: filter.value,
    };
    state.recruiting.prospectScrollTop = 0;
    state.recruiting.selectedProspectIds = [];
    renderRecruitingWorkbench();
    return;
  }
  const select = event.target.closest?.("[data-prospect-select]");
  if (select) {
    updateProspectSelection(select.dataset.prospectSelect, select.checked);
    updateProspectVirtualWindow();
    renderRecruitingWorkbench();
  }
});
els.recruitingDetail.addEventListener("click", (event) => {
  const sortButton = event.target.closest?.("[data-prospect-sort]");
  if (sortButton) {
    const key = sortButton.dataset.prospectSort;
    const current = state.recruiting.prospectSort || { key: "rank", direction: "asc" };
    const defaultDirection = ["stars", "overall"].includes(key) ? "desc" : "asc";
    state.recruiting.prospectSort = {
      key,
      direction: current.key === key ? (current.direction === "asc" ? "desc" : "asc") : defaultDirection,
    };
    state.recruiting.prospectScrollTop = 0;
    renderRecruitingWorkbench();
    return;
  }
  const addButton = event.target.closest?.("[data-prospect-add]");
  if (addButton) {
    stageProspectsForBoard([addButton.dataset.prospectAdd]);
    return;
  }
  const actionButton = event.target.closest?.("[data-recruiting-action]");
  if (actionButton) {
    const target = selectedRecruitingTarget();
    const action = RECRUITING_WEEKLY_ACTIONS.find((item) => item.field === actionButton.dataset.recruitingAction);
    stageRecruitingWeeklyAction(target, action);
    return;
  }
  const clearActionButton = event.target.closest?.("[data-recruiting-clear-action]");
  if (clearActionButton) {
    const key = clearActionButton.dataset.recruitingClearAction;
    state.recruiting.stagedActions = (state.recruiting.stagedActions || [])
      .filter((item) => stagedActionKey(item.targetId, item.actionField) !== key);
    state.recruiting.preview = null;
    renderRecruitingWorkbench();
    return;
  }
  const unstageButton = event.target.closest?.("[data-prospect-unstage]");
  if (unstageButton) {
    const id = unstageButton.dataset.prospectUnstage;
    state.recruiting.stagedAdds = state.recruiting.stagedAdds.filter((item) => item.recruitId !== id);
    state.recruiting.preview = null;
    renderRecruitingWorkbench();
    return;
  }
  if (event.target.closest?.("[data-prospect-select-visible]")) {
    const ids = new Set(state.recruiting.selectedProspectIds || []);
    for (const id of visibleProspectIds()) {
      const profile = profileByRecruitId(id);
      if (canStageProfile(profile)) ids.add(id);
    }
    state.recruiting.selectedProspectIds = [...ids];
    renderRecruitingWorkbench();
    return;
  }
  if (event.target.closest?.("[data-prospect-clear-selection]")) {
    state.recruiting.selectedProspectIds = [];
    renderRecruitingWorkbench();
    return;
  }
  if (event.target.closest?.("[data-prospect-stage-selected]")) {
    stageProspectsForBoard(state.recruiting.selectedProspectIds || []);
    return;
  }
  if (event.target.closest?.("[data-prospect-clear-staged]")) {
    state.recruiting.stagedAdds = [];
    state.recruiting.stagedActions = [];
    state.recruiting.preview = null;
    renderRecruitingWorkbench();
    return;
  }
  if (event.target.closest?.("[data-prospect-preview-staged]")) {
    previewRecruitingPlan().catch((error) => setStatus(error.message, true));
  }
});
for (const tab of els.recruitingTabs) {
  tab.addEventListener("click", () => {
    setRecruitingTab(tab.dataset.recruitingTab || "board");
  });
}
els.recruitingTargetsBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-recruiting-target-id]");
  if (!row) return;
  state.recruiting.selectedId = row.dataset.recruitingTargetId;
  setRecruitingTab("board");
});
window.addEventListener("popstate", () => {
  if (window.location.pathname === "/recruiting") {
    state.recruiting.activeTab = currentRecruitingTabFromLocation();
    renderRecruitingWorkbench();
  }
});
if (window.cfb27Desktop?.selectSaveDirectory) {
  els.desktopOpenSaveBtn.hidden = false;
  els.desktopOpenSaveBtn.addEventListener("click", () => chooseSaveDirectory().catch((error) => setStatus(error.message, true)));
}
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
els.refreshLiveBtn.addEventListener("click", () => loadLiveStatus().catch((error) => setStatus(error.message, true)));
els.unlockDynastyBtn.addEventListener("click", () => unlockDynastyEditing().catch((error) => setStatus(error.message, true)));
els.discoverLivePlayerBtn.addEventListener("click", () => discoverLivePlayer().catch((error) => setStatus(error.message, true)));
els.runLuaBtn.addEventListener("click", () => runLuaSnippet().catch((error) => setStatus(error.message, true)));
els.livePlayerQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") discoverLivePlayer().catch((error) => setStatus(error.message, true));
});
els.livePlayerPanel.addEventListener("click", (event) => {
  const writeButton = event.target.closest("[data-live-write-rating]");
  const restoreButton = event.target.closest("[data-live-restore-rating]");
  const button = writeButton || restoreButton;
  if (!button) return;
  const field = writeButton ? writeButton.dataset.liveWriteRating : restoreButton.dataset.liveRestoreRating;
  const input = els.livePlayerPanel.querySelector(`[data-live-rating-value="${field}"]`);
  const saved = state.live.playerResult?.player?.ratings?.[field];
  const value = restoreButton ? saved : Number(input?.value);
  button.disabled = true;
  writeLiveRating(field, value)
    .catch((error) => setStatus(error.message, true))
    .finally(() => { button.disabled = false; });
});
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
state.recruiting.activeTab = currentRecruitingTabFromLocation();
setActiveView(state.activeView, false);
renderMetrics(null);
renderInspector(null);
renderConfig();
renderPreviewSummary();
renderPreviewBrowser();
renderRecruitingWorkbench();
renderLiveStatus();
renderLivePlayer();
loadGeneratorConfigs()
  .then(initializeFiles)
  .catch((error) => setStatus(error.message, true));
