const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('squeezeNative', {
  chooseDir: () => ipcRenderer.invoke('save-choose-dir'),
  saveOpen: (name) => ipcRenderer.invoke('save-open', name),
  saveWrite: (id, bytes) => ipcRenderer.invoke('save-write', id, bytes),
  saveClose: (id, ok) => ipcRenderer.invoke('save-close', id, ok),
  saveFinish: () => ipcRenderer.invoke('save-finish'),
  saveTemp: (tmpPath, name) => ipcRenderer.invoke('save-temp', tmpPath, name),
  saveTempAs: (tmpPath, name) => ipcRenderer.invoke('save-temp-as', tmpPath, name),

  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  nativeReady: () => ipcRenderer.invoke('native-ready'),
  nativeCompress: (job) => ipcRenderer.invoke('native-compress', job),
  discardTemp: (p) => ipcRenderer.invoke('native-discard', p),
  onNativeProgress: (cb) => ipcRenderer.on('native-progress', (_e, id, pct) => cb(id, pct)),

  cpuUsage: () => ipcRenderer.invoke('cpu-usage'),

  fitHeight: (h) => ipcRenderer.send('fit-height', h),

  closeApp: () => ipcRenderer.send('close-app')
});


// Hello from the developer :D