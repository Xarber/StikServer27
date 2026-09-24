const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stikDesktop", Object.freeze({
  remoteLinks: () => ipcRenderer.invoke("stikserver:remote-links"),
  copyRemoteLink: kind => ipcRenderer.invoke("stikserver:copy-remote-link", kind)
}));
