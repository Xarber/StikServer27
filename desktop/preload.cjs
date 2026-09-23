const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stikDesktop", Object.freeze({
  copyRemoteLink: () => ipcRenderer.invoke("stikserver:copy-remote-link")
}));
