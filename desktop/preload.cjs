const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('penplotDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  getBackendInfo: () => ipcRenderer.invoke('penplot:backend-info'),
  openDataDir: () => ipcRenderer.invoke('penplot:open-data-dir'),
  openExternal: (url) => ipcRenderer.invoke('penplot:open-external', url),
  restartBackend: () => ipcRenderer.invoke('penplot:restart-backend'),
  minimizeWindow: () => ipcRenderer.invoke('penplot:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('penplot:window-maximize'),
  closeWindow: () => ipcRenderer.invoke('penplot:window-close'),
  isWindowMaximized: () => ipcRenderer.invoke('penplot:window-is-maximized'),
  onWindowMaximizedChange: (cb) => {
    const handler = (_ev, val) => cb(Boolean(val))
    ipcRenderer.on('penplot:window-maximized', handler)
    return () => ipcRenderer.removeListener('penplot:window-maximized', handler)
  },
  copyMcpUrl: () => ipcRenderer.invoke('penplot:copy-mcp-url'),
  toggleDevTools: () => ipcRenderer.invoke('penplot:toggle-devtools'),
  reloadWindow: (force = false) => ipcRenderer.invoke('penplot:reload', force),
  toggleFullscreen: () => ipcRenderer.invoke('penplot:toggle-fullscreen'),
})
