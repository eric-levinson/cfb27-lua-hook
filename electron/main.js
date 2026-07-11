const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const BACKEND_HOST = process.env.CFB27_BACKEND_HOST || "127.0.0.1";
const BACKEND_PORT = Number(process.env.CFB27_BACKEND_PORT || 8765);
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

let backendProcess = null;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function healthCheck() {
  return new Promise((resolve) => {
    const request = http.get(`${BACKEND_URL}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForBackend(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function ensureBackend() {
  if (await healthCheck()) return { started: false, ready: true };
  const root = path.resolve(__dirname, "..");
  const savedDirectory = loadSettings().saveDirectory;
  backendProcess = spawn(
    process.env.CFB27_PYTHON || "python",
    ["server.py", "--host", BACKEND_HOST, "--port", String(BACKEND_PORT)],
    {
      cwd: root,
      env: savedDirectory ? { ...process.env, CFB27_SAVE_DIR: savedDirectory } : process.env,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  backendProcess.unref();
  return { started: true, ready: await waitForBackend() };
}

function defaultSaveDirectory() {
  return loadSettings().saveDirectory || path.join(app.getPath("documents"), "EA SPORTS College Football 27", "saves");
}

async function createWindow() {
  const backend = await ensureBackend();
  if (!backend.ready) {
    dialog.showErrorBox(
      "Backend failed to start",
      `Could not reach ${BACKEND_URL}. Start the server manually with npm start and try again.`,
    );
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "CFB27 Dynasty Lab",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(`${BACKEND_URL}/recruiting`);
}

ipcMain.handle("cfb27:selectSaveDirectory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose CFB27 Save Folder",
    defaultPath: defaultSaveDirectory(),
    buttonLabel: "Use This Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return {
    canceled: result.canceled,
    path: result.filePaths[0] || "",
  };
});

ipcMain.handle("cfb27:getSaveDirectory", () => loadSettings().saveDirectory || "");

ipcMain.handle("cfb27:persistSaveDirectory", (_event, directory) => {
  if (typeof directory !== "string" || !directory.trim()) return false;
  saveSettings({ ...loadSettings(), saveDirectory: directory.trim() });
  return true;
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
