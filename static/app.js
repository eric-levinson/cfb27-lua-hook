const state = {
  files: [],
  selectedFile: "",
  players: [],
  filtered: [],
  selectedPlayer: null,
  selectedDetails: null,
  tables: [],
  selectedTable: null,
  tableRows: [],
  tableColumns: [],
  dynastyPlayers: [],
  dynastyColumns: [],
  schemaEntries: [],
  schemaOccurrences: [],
  selectedSchema: null,
  dirty: false,
};

const els = {
  status: document.querySelector("#status"),
  fileSelect: document.querySelector("#fileSelect"),
  refreshBtn: document.querySelector("#refreshBtn"),
  backupBtn: document.querySelector("#backupBtn"),
  metrics: document.querySelector("#metrics"),
  searchInput: document.querySelector("#searchInput"),
  playersBody: document.querySelector("#playersBody"),
  editForm: document.querySelector("#editForm"),
  saveBtn: document.querySelector("#saveBtn"),
  revertBtn: document.querySelector("#revertBtn"),
  selectionName: document.querySelector("#selectionName"),
  inspectorBody: document.querySelector("#inspectorBody"),
  playersTab: document.querySelector("#playersTab"),
  tablesTab: document.querySelector("#tablesTab"),
  dynastyTab: document.querySelector("#dynastyTab"),
  schemaTab: document.querySelector("#schemaTab"),
  playersView: document.querySelector("#playersView"),
  tablesView: document.querySelector("#tablesView"),
  dynastyView: document.querySelector("#dynastyView"),
  schemaView: document.querySelector("#schemaView"),
  tableList: document.querySelector("#tableList"),
  tableTitle: document.querySelector("#tableTitle"),
  tableNote: document.querySelector("#tableNote"),
  tableSearch: document.querySelector("#tableSearch"),
  reloadTablesBtn: document.querySelector("#reloadTablesBtn"),
  genericHead: document.querySelector("#genericHead"),
  genericBody: document.querySelector("#genericBody"),
  dynastyTitle: document.querySelector("#dynastyTitle"),
  dynastyNote: document.querySelector("#dynastyNote"),
  dynastySearch: document.querySelector("#dynastySearch"),
  reloadDynastyBtn: document.querySelector("#reloadDynastyBtn"),
  dynastyHead: document.querySelector("#dynastyHead"),
  dynastyBody: document.querySelector("#dynastyBody"),
  schemaSearch: document.querySelector("#schemaSearch"),
  loadSchemaBtn: document.querySelector("#loadSchemaBtn"),
  scanSchemaBtn: document.querySelector("#scanSchemaBtn"),
  schemaList: document.querySelector("#schemaList"),
  schemaTitle: document.querySelector("#schemaTitle"),
  schemaNote: document.querySelector("#schemaNote"),
  schemaOccurrences: document.querySelector("#schemaOccurrences"),
  schemaAttributes: document.querySelector("#schemaAttributes"),
};

function setStatus(message, isDirty = false) {
  els.status.textContent = message;
  els.status.classList.toggle("dirty", isDirty);
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

function numberFmt(value) {
  if (value === undefined || value === null) return "-";
  return new Intl.NumberFormat().format(value);
}

function dateFmt(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString();
}

function renderMetrics(file) {
  if (!file) {
    els.metrics.innerHTML = "";
    return;
  }
  const items = [
    ["Size", `${numberFmt(file.size)} bytes`],
    ["Players", numberFmt(file.player_count)],
    ["Compressed", `${numberFmt(file.compressed_payload_size)} bytes`],
    ["Decompressed", `${numberFmt(file.decompressed_payload_size)} bytes`],
    ["Modified", dateFmt(file.modified)],
  ];
  els.metrics.innerHTML = items
    .map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function renderFiles() {
  els.fileSelect.innerHTML = state.files
    .map((file) => `<option value="${file.name}">${file.name}</option>`)
    .join("");
  if (state.selectedFile) {
    els.fileSelect.value = state.selectedFile;
  }
  renderMetrics(state.files.find((file) => file.name === state.selectedFile));
}

function applyFilter() {
  const query = els.searchInput.value.trim().toLowerCase();
  if (!query) {
    state.filtered = state.players.slice(0, 500);
    return;
  }
  state.filtered = state.players
    .filter((player) => {
      const text = [
        player.internal_id,
        player.first_name,
        player.last_name,
        player.hometown,
        player.offset,
      ]
        .join(" ")
        .toLowerCase();
      return text.includes(query);
    })
    .slice(0, 500);
}

function renderPlayers() {
  applyFilter();
  if (!state.filtered.length) {
    els.playersBody.innerHTML = '<tr class="empty-row"><td colspan="5">No players found</td></tr>';
    return;
  }
  els.playersBody.innerHTML = state.filtered
    .map((player) => {
      const selected = state.selectedPlayer && state.selectedPlayer.id === player.id ? " selected" : "";
      return `
        <tr class="${selected}" data-id="${player.id}">
          <td title="${player.last_name}">${player.last_name}</td>
          <td title="${player.first_name}">${player.first_name}</td>
          <td title="${player.hometown}">${player.hometown}</td>
          <td title="${player.internal_id}">${player.internal_id}</td>
          <td>${player.offset}</td>
        </tr>
      `;
    })
    .join("");
}

function setView(view) {
  const isPlayers = view === "players";
  const isTables = view === "tables";
  const isDynasty = view === "dynasty";
  const isSchema = view === "schema";
  els.playersView.classList.toggle("hidden", !isPlayers);
  els.tablesView.classList.toggle("hidden", !isTables);
  els.dynastyView.classList.toggle("hidden", !isDynasty);
  els.schemaView.classList.toggle("hidden", !isSchema);
  els.playersTab.classList.toggle("active", isPlayers);
  els.tablesTab.classList.toggle("active", isTables);
  els.dynastyTab.classList.toggle("active", isDynasty);
  els.schemaTab.classList.toggle("active", isSchema);
  if (isTables && !state.tables.length) {
    loadTables().catch((error) => setStatus(error.message));
  }
  if (isSchema && !state.schemaEntries.length) {
    loadSchema().catch((error) => setStatus(error.message));
  }
  if (isDynasty && !state.dynastyPlayers.length) {
    loadDynastyPlayers().catch((error) => setStatus(error.message));
  }
}

async function loadTables() {
  setStatus("Scanning inferred tables...");
  const payload = await api("/api/tables");
  state.tables = [];
  for (const fileGroup of payload.files || []) {
    for (const table of fileGroup.tables || []) {
      state.tables.push({ ...table, file: fileGroup.file.name });
    }
  }
  renderTableList(payload.files || []);
  setStatus(`Found ${state.tables.length.toLocaleString()} inferred tables/groups`);
}

function renderTableList(fileGroups) {
  if (!fileGroups.length) {
    els.tableList.innerHTML = '<div class="selection">No tables discovered</div>';
    return;
  }
  els.tableList.innerHTML = fileGroups
    .map((group) => {
      const tables = group.tables || [];
      const cards = tables.length
        ? tables
            .map(
              (table) => `
                <button class="table-card" type="button" data-file="${group.file.name}" data-table="${table.id}">
                  <strong>${table.name}</strong>
                  <span>${table.recordCount.toLocaleString()} records | ${table.confidence} confidence | ${table.stringEditable ? "string editable" : "read-only"}</span>
                  <span>Anchor ${table.anchorKey}</span>
                </button>
              `,
            )
            .join("")
        : '<div class="table-card"><strong>No confident TLV tables</strong><span>File parses, but no repeated aligned table anchors were found.</span></div>';
      return `<section class="file-group"><h3>${group.file.name}</h3>${cards}</section>`;
    })
    .join("");
}

async function selectTable(file, tableId) {
  const summary = state.tables.find((item) => item.file === file && item.id === tableId);
  state.selectedTable = summary || { file, id: tableId, name: tableId };
  els.tableTitle.textContent = `${state.selectedTable.file} / ${state.selectedTable.name}`;
  els.tableNote.textContent = state.selectedTable.notes || "Loading rows...";
  els.genericHead.innerHTML = "";
  els.genericBody.innerHTML = '<tr class="empty-row"><td>Loading...</td></tr>';
  const payload = await api(`/api/table/${encodeURIComponent(file)}/${encodeURIComponent(tableId)}?limit=500`);
  state.tableRows = payload.rows || [];
  state.tableColumns = payload.columns || [];
  renderGenericTable();
}

function renderGenericTable() {
  const filter = els.tableSearch.value.trim().toLowerCase();
  const rows = filter
    ? state.tableRows.filter((row) => JSON.stringify(row).toLowerCase().includes(filter))
    : state.tableRows;
  if (!state.tableColumns.length) {
    els.genericHead.innerHTML = "";
    els.genericBody.innerHTML = '<tr class="empty-row"><td>No rows</td></tr>';
    return;
  }
  els.genericHead.innerHTML = `<tr>${state.tableColumns
    .map((column) => `<th title="${column.key}">${column.label}${column.writable ? " *" : ""}</th>`)
    .join("")}</tr>`;
  els.genericBody.innerHTML = rows.length
    ? rows
        .map(
          (row) => `<tr data-row-id="${row._id}">${state.tableColumns
            .map((column) => {
              const value = row[column.key] === undefined || row[column.key] === null ? "" : row[column.key];
              if (column.writable && column.type === "string") {
                return `<td title="${String(value)}"><input class="cell-input" data-column="${column.key}" value="${escapeHtml(String(value))}"></td>`;
              }
              return `<td title="${String(value)}">${escapeHtml(String(value))}</td>`;
            })
            .join("")}</tr>`,
        )
        .join("")
    : `<tr class="empty-row"><td colspan="${state.tableColumns.length}">No visible rows</td></tr>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

async function loadDynastyPlayers() {
  if (!state.selectedFile) return;
  setStatus(`Loading recruit table in ${state.selectedFile}...`);
  const payload = await api(`/api/recruits/${encodeURIComponent(state.selectedFile)}?limit=5000`);
  state.dynastyPlayers = payload.players || [];
  state.dynastyColumns = payload.columns || [];
  els.dynastyTitle.textContent = `${state.selectedFile} / Recruits`;
  els.dynastyNote.textContent = payload.notes || "Structured recruit table.";
  renderDynastyPlayers();
  setStatus(`Loaded ${numberFmt(payload.recordCount || state.dynastyPlayers.length)} recruits`);
}

function renderDynastyPlayers() {
  if (!state.dynastyColumns.length) {
    els.dynastyHead.innerHTML = "";
    els.dynastyBody.innerHTML = '<tr class="empty-row"><td>No dynasty player rows found</td></tr>';
    return;
  }
  const filter = els.dynastySearch.value.trim().toLowerCase();
  const rows = filter
    ? state.dynastyPlayers.filter((row) => JSON.stringify(row).toLowerCase().includes(filter))
    : state.dynastyPlayers;
  const visibleRows = rows.slice(0, 300);
  els.dynastyHead.innerHTML = `<tr>${state.dynastyColumns
    .map((column) => {
      const title = [column.group, column.title || column.key].filter(Boolean).join(" / ");
      return `<th title="${escapeHtml(title)}">${escapeHtml(column.label)}${column.writable ? " *" : ""}</th>`;
    })
    .join("")}</tr>`;
  els.dynastyBody.innerHTML = visibleRows.length
    ? visibleRows
        .map(
          (row) => `<tr data-row-id="${row.id}">${state.dynastyColumns
            .map((column) => {
              const value = row[column.key] === undefined || row[column.key] === null ? "" : row[column.key];
              if (column.writable) {
                const maxLength = column.maxLength ? ` maxlength="${column.maxLength}"` : "";
                if (column.type === "select") {
                  const options = (column.options || [])
                    .map((option) => {
                      const optionValue = typeof option === "object" ? option.value : option;
                      const optionLabel = typeof option === "object" ? option.label : option;
                      const selected = String(optionValue) === String(value) ? " selected" : "";
                      return `<option value="${escapeHtml(String(optionValue))}"${selected}>${escapeHtml(String(optionLabel))}</option>`;
                    })
                    .join("");
                  return `<td title="${escapeHtml(String(value))}"><select class="dynasty-input" data-column="${column.key}">${options}</select></td>`;
                }
                if (column.type === "number") {
                  const min = column.min === undefined ? "" : ` min="${column.min}"`;
                  const max = column.max === undefined ? "" : ` max="${column.max}"`;
                  return `<td title="${escapeHtml(String(value))}"><input class="dynasty-input" data-column="${column.key}" type="number" value="${escapeHtml(String(value))}"${min}${max}></td>`;
                }
                return `<td title="${escapeHtml(String(value))}"><input class="dynasty-input" data-column="${column.key}" value="${escapeHtml(String(value))}"${maxLength}></td>`;
              }
              return `<td title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</td>`;
            })
            .join("")}</tr>`,
        )
        .join("")
    : `<tr class="empty-row"><td colspan="${state.dynastyColumns.length}">No visible rows</td></tr>`;
}

async function saveDynastyCell(input) {
  if (!state.selectedFile) return;
  const row = input.closest("tr[data-row-id]");
  if (!row) return;
  const rowId = row.dataset.rowId;
  const column = input.dataset.column;
  const originalRow = state.dynastyPlayers.find((item) => String(item.id) === String(rowId));
  if (!originalRow || String(originalRow[column] || "") === input.value) return;
  input.disabled = true;
  setStatus("Saving recruit field and creating backup...");
  try {
    await api(
      `/api/recruits/${encodeURIComponent(state.selectedFile)}/players/${encodeURIComponent(rowId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ changes: { [column]: input.value } }),
      },
    );
    await loadDynastyPlayers();
    setStatus(`Saved recruit ${column}`);
  } catch (error) {
    input.value = originalRow[column] || "";
    input.disabled = false;
    setStatus(error.message);
  }
}

async function loadSchema() {
  const query = els.schemaSearch.value.trim();
  setStatus("Loading recruiting schema index...");
  const [schemaPayload, occurrencePayload] = await Promise.all([
    api(`/api/schema?domain=recruiting&limit=500&query=${encodeURIComponent(query)}`),
    state.selectedFile
      ? api(`/api/schema/occurrences?file=${encodeURIComponent(state.selectedFile)}&domain=recruiting&limit=500&query=${encodeURIComponent(query)}`)
      : Promise.resolve({ entries: [], count: 0, scanned: 0 }),
  ]);
  state.schemaEntries = schemaPayload.entries || [];
  state.schemaOccurrences = occurrencePayload.entries || [];
  renderSchemaList(schemaPayload.count || state.schemaEntries.length);
  renderSchemaOccurrences();
  renderSchemaAttributes(state.selectedSchema);
  setStatus(
    `Loaded ${numberFmt(schemaPayload.count || 0)} recruiting schema entries; ${numberFmt(occurrencePayload.count || 0)} match ${state.selectedFile || "the selected save"}`,
  );
}

function renderSchemaList(totalCount) {
  if (!state.schemaEntries.length) {
    els.schemaList.innerHTML = '<div class="selection">No schema entries found</div>';
    return;
  }
  els.schemaList.innerHTML = `
    <div class="schema-count">${numberFmt(totalCount)} matching schema entries</div>
    ${state.schemaEntries
      .map((entry) => {
        const selected = state.selectedSchema && state.selectedSchema.name === entry.name ? " active" : "";
        return `
          <button class="schema-card${selected}" type="button" data-name="${escapeHtml(entry.name)}">
            <strong>${escapeHtml(entry.name)}</strong>
            <span>${escapeHtml(entry.kind || "schema")} | ${numberFmt(entry.attributeCount || 0)} attrs</span>
            <span>${escapeHtml(entry.fileName || "")}</span>
          </button>
        `;
      })
      .join("")}
  `;
}

function renderSchemaOccurrences() {
  if (!state.schemaOccurrences.length) {
    els.schemaOccurrences.innerHTML = '<tr class="empty-row"><td colspan="4">No selected-save occurrences found</td></tr>';
    return;
  }
  els.schemaOccurrences.innerHTML = state.schemaOccurrences
    .map((entry) => {
      const offsets = (entry.offsets || []).slice(0, 8).join(", ");
      const context = entry.contexts && entry.contexts[0] ? entry.contexts[0].text : "";
      return `
        <tr data-schema-name="${escapeHtml(entry.name)}">
          <td title="${escapeHtml(entry.fileName || "")}">${escapeHtml(entry.name)}</td>
          <td>${numberFmt(entry.occurrenceCount || 0)}</td>
          <td title="${escapeHtml(offsets)}">${escapeHtml(offsets)}</td>
          <td title="${escapeHtml(context)}">${escapeHtml(context)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSchemaAttributes(entry) {
  if (!entry) {
    els.schemaTitle.textContent = "Recruiting Schema";
    els.schemaNote.textContent = "Select a schema entry to inspect attributes and matching save offsets.";
    els.schemaAttributes.innerHTML = '<tr class="empty-row"><td colspan="4">No schema selected</td></tr>';
    return;
  }
  els.schemaTitle.textContent = entry.name;
  els.schemaNote.textContent = `${entry.fileName || ""} | ${entry.kind || "schema"} | read-only mapping`;
  const attrs = entry.attributes || [];
  if (!attrs.length) {
    els.schemaAttributes.innerHTML = '<tr class="empty-row"><td colspan="4">No attributes listed</td></tr>';
    return;
  }
  els.schemaAttributes.innerHTML = attrs
    .map((attr) => {
      const range = [
        attr.minValue !== undefined || attr.maxValue !== undefined ? `${attr.minValue || ""}..${attr.maxValue || ""}` : "",
        attr.default !== undefined ? `default ${attr.default}` : "",
        attr.value !== undefined ? `value ${attr.value}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      return `
        <tr>
          <td>${escapeHtml(String(attr.idx || ""))}</td>
          <td title="${escapeHtml(attr.name || "")}">${escapeHtml(attr.name || "")}</td>
          <td title="${escapeHtml(attr.type || "")}">${escapeHtml(attr.type || "")}</td>
          <td title="${escapeHtml(range)}">${escapeHtml(range)}</td>
        </tr>
      `;
    })
    .join("");
}

function selectSchema(name) {
  state.selectedSchema =
    state.schemaEntries.find((entry) => entry.name === name) ||
    state.schemaOccurrences.find((entry) => entry.name === name) ||
    null;
  renderSchemaList(state.schemaEntries.length);
  renderSchemaAttributes(state.selectedSchema);
}

async function saveGenericCell(input) {
  if (!state.selectedTable) return;
  const row = input.closest("tr[data-row-id]");
  if (!row) return;
  const rowId = row.dataset.rowId;
  const column = input.dataset.column;
  const originalRow = state.tableRows.find((item) => String(item._id) === String(rowId));
  if (!originalRow || String(originalRow[column] || "") === input.value) return;
  input.disabled = true;
  setStatus("Saving table cell and creating backup...");
  try {
    await api(
      `/api/table/${encodeURIComponent(state.selectedTable.file)}/${encodeURIComponent(state.selectedTable.id)}/rows/${encodeURIComponent(rowId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ changes: { [column]: input.value } }),
      },
    );
    await selectTable(state.selectedTable.file, state.selectedTable.id);
    setStatus(`Saved ${state.selectedTable.name} cell`);
  } catch (error) {
    input.value = originalRow[column] || "";
    input.disabled = false;
    setStatus(error.message);
  }
}

function fillForm(player) {
  for (const field of ["internal_id", "first_name", "last_name", "hometown"]) {
    els.editForm.elements[field].value = player ? player[field] || "" : "";
    els.editForm.elements[field].disabled = !player;
  }
  state.dirty = false;
  els.saveBtn.disabled = true;
  els.revertBtn.disabled = !player;
  els.selectionName.textContent = player ? `${player.first_name} ${player.last_name}`.trim() : "None";
}

function renderInspector(details) {
  if (!details) {
    els.inspectorBody.textContent = "Select a row";
    return;
  }
  els.inspectorBody.textContent = JSON.stringify(
    {
      offset: details.offset,
      fields: details.fields,
    },
    null,
    2,
  );
}

async function selectPlayer(rowId) {
  const player = state.players.find((item) => item.id === rowId);
  state.selectedPlayer = player || null;
  fillForm(player);
  renderPlayers();
  renderInspector(null);
  if (!player) return;

  try {
    const details = await api(`/api/roster/${encodeURIComponent(state.selectedFile)}/players/${encodeURIComponent(rowId)}`);
    state.selectedDetails = details;
    renderInspector(details);
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadFiles() {
  setStatus("Loading save files...");
  const payload = await api("/api/files");
  state.files = payload.files;
  if (!state.files.length) {
    state.selectedFile = "";
    renderFiles();
    setStatus("No editable FBCHUNKS files found");
    return;
  }
  if (!state.selectedFile || !state.files.some((file) => file.name === state.selectedFile)) {
    state.selectedFile = state.files[0].name;
  }
  renderFiles();
  await loadRoster();
  if (!els.dynastyView.classList.contains("hidden")) {
    state.dynastyPlayers = [];
    state.dynastyColumns = [];
    await loadDynastyPlayers();
  } else if (!els.schemaView.classList.contains("hidden")) {
    await loadSchema();
  }
}

async function loadRoster() {
  if (!state.selectedFile) return;
  setStatus(`Loading ${state.selectedFile}...`);
  const payload = await api(`/api/roster/${encodeURIComponent(state.selectedFile)}`);
  state.players = payload.players || [];
  state.selectedPlayer = null;
  state.selectedDetails = null;
  fillForm(null);
  renderInspector(null);
  renderPlayers();
  renderMetrics(payload.file);
  setStatus(`${state.players.length.toLocaleString()} editable player rows loaded from ${state.selectedFile}`);
}

function currentChanges() {
  if (!state.selectedPlayer) return {};
  const changes = {};
  for (const field of ["internal_id", "first_name", "last_name", "hometown"]) {
    const value = els.editForm.elements[field].value;
    if (value !== (state.selectedPlayer[field] || "")) {
      changes[field] = value;
    }
  }
  return changes;
}

function updateDirtyState() {
  state.dirty = Object.keys(currentChanges()).length > 0;
  els.saveBtn.disabled = !state.selectedPlayer || !state.dirty;
  els.revertBtn.disabled = !state.selectedPlayer;
  setStatus(state.dirty ? "Unsaved player changes" : `${state.players.length.toLocaleString()} editable player rows loaded`, state.dirty);
}

async function saveSelected(event) {
  event.preventDefault();
  if (!state.selectedPlayer) return;
  const changes = currentChanges();
  if (!Object.keys(changes).length) return;
  els.saveBtn.disabled = true;
  setStatus("Saving player and creating backup...");
  try {
    const payload = await api(
      `/api/roster/${encodeURIComponent(state.selectedFile)}/players/${encodeURIComponent(state.selectedPlayer.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ changes }),
      },
    );
    await loadFiles();
    const updatedId = payload.player && payload.player.id ? payload.player.id : state.selectedPlayer.id;
    await selectPlayer(updatedId);
    setStatus(`Saved. Backup: ${payload.backup.backup}`);
  } catch (error) {
    setStatus(error.message);
    updateDirtyState();
  }
}

async function backupCurrent() {
  if (!state.selectedFile) return;
  setStatus("Creating backup...");
  try {
    const payload = await api(`/api/backup/${encodeURIComponent(state.selectedFile)}`, { method: "POST" });
    setStatus(`Backup created: ${payload.backup}`);
  } catch (error) {
    setStatus(error.message);
  }
}

els.refreshBtn.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message)));
els.backupBtn.addEventListener("click", () => backupCurrent());
els.playersTab.addEventListener("click", () => setView("players"));
els.tablesTab.addEventListener("click", () => setView("tables"));
els.dynastyTab.addEventListener("click", () => setView("dynasty"));
els.schemaTab.addEventListener("click", () => setView("schema"));
els.fileSelect.addEventListener("change", () => {
  state.selectedFile = els.fileSelect.value;
  loadRoster()
    .then(() => {
      state.dynastyPlayers = [];
      state.dynastyColumns = [];
      if (!els.dynastyView.classList.contains("hidden")) {
        return loadDynastyPlayers();
      }
      if (!els.schemaView.classList.contains("hidden")) {
        return loadSchema();
      }
      return null;
    })
    .catch((error) => setStatus(error.message));
});
els.searchInput.addEventListener("input", renderPlayers);
els.playersBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (row) selectPlayer(row.dataset.id);
});
els.tableList.addEventListener("click", (event) => {
  const card = event.target.closest(".table-card[data-file][data-table]");
  if (!card) return;
  for (const item of els.tableList.querySelectorAll(".table-card")) item.classList.remove("active");
  card.classList.add("active");
  selectTable(card.dataset.file, card.dataset.table).catch((error) => setStatus(error.message));
});
els.tableSearch.addEventListener("input", renderGenericTable);
els.reloadTablesBtn.addEventListener("click", () => loadTables().catch((error) => setStatus(error.message)));
els.dynastySearch.addEventListener("input", renderDynastyPlayers);
els.reloadDynastyBtn.addEventListener("click", () => loadDynastyPlayers().catch((error) => setStatus(error.message)));
els.loadSchemaBtn.addEventListener("click", () => loadSchema().catch((error) => setStatus(error.message)));
els.scanSchemaBtn.addEventListener("click", () => loadSchema().catch((error) => setStatus(error.message)));
els.schemaSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadSchema().catch((error) => setStatus(error.message));
  }
});
els.schemaList.addEventListener("click", (event) => {
  const card = event.target.closest(".schema-card[data-name]");
  if (card) selectSchema(card.dataset.name);
});
els.schemaOccurrences.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-schema-name]");
  if (row) selectSchema(row.dataset.schemaName);
});
els.genericBody.addEventListener("change", (event) => {
  const input = event.target.closest(".cell-input");
  if (input) saveGenericCell(input);
});
els.dynastyBody.addEventListener("change", (event) => {
  const input = event.target.closest(".dynasty-input");
  if (input) saveDynastyCell(input);
});
els.editForm.addEventListener("input", updateDirtyState);
els.editForm.addEventListener("submit", saveSelected);
els.revertBtn.addEventListener("click", () => fillForm(state.selectedPlayer));

fillForm(null);
loadFiles().catch((error) => setStatus(error.message));
