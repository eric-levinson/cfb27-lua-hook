const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cfb27Desktop", {
  selectSaveDirectory: () => ipcRenderer.invoke("cfb27:selectSaveDirectory"),
  getSaveDirectory: () => ipcRenderer.invoke("cfb27:getSaveDirectory"),
  persistSaveDirectory: (directory) => ipcRenderer.invoke("cfb27:persistSaveDirectory", directory),
});
