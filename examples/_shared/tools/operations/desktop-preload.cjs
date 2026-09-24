const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notes', { save: value => ipcRenderer.invoke('save-note', value) });
