const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fisync', {
  sendFrame: buf => ipcRenderer.send('frame', buf),
  failed: msg => ipcRenderer.send('capture-failed', msg),
});
