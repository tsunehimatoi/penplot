const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const IS_DEV = process.argv.includes('--dev') || process.env.PENPLOT_ELECTRON_DEV === '1'
const REPO_ROOT = path.resolve(__dirname, '..')
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : REPO_ROOT

let mainWindow = null
let backendProc = null
let backendPort = null
let backendDataDir = null
let viteProc = null
let viteUrl = null
let quitting = false

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function resolveBackendCommand(port) {
  const exeName = process.platform === 'win32' ? 'penplot-backend.exe' : 'penplot-backend'
  const bundledExe = path.join(RESOURCE_ROOT, 'backend', exeName)
  if (app.isPackaged || fs.existsSync(bundledExe)) {
    return {
      cmd: bundledExe,
      args: ['serve', '--host', '127.0.0.1', '--port', String(port)],
    }
  }
  return {
    cmd: resolvePython(),
    args: ['-m', 'penplot.web', 'serve', '--host', '127.0.0.1', '--port', String(port)],
  }
}

function resolvePython() {
  if (process.env.PENPLOT_PYTHON) return process.env.PENPLOT_PYTHON
  const venvWin = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
  if (process.platform === 'win32' && fs.existsSync(venvWin)) return venvWin
  const venvPosix = path.join(REPO_ROOT, '.venv', 'bin', 'python')
  if (fs.existsSync(venvPosix)) return venvPosix
  return process.platform === 'win32' ? 'python' : 'python3'
}

function waitForUrl(url, timeoutMs = 20000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for ${url} within ${timeoutMs}ms`))
      }
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) return resolve()
        setTimeout(tick, 200)
      })
      req.on('error', () => setTimeout(tick, 200))
      req.setTimeout(1000, () => {
        req.destroy()
        setTimeout(tick, 200)
      })
    }
    tick()
  })
}

function waitForHealth(port, timeoutMs = 20000) {
  return waitForUrl(`http://127.0.0.1:${port}/api/v1/system/health`, timeoutMs)
}

async function startViteDevServer() {
  if (!IS_DEV) return null
  if (process.env.PENPLOT_VITE_URL) {
    viteUrl = process.env.PENPLOT_VITE_URL
    return viteUrl
  }
  const webuiDir = path.join(REPO_ROOT, 'webui')
  const port = await findFreePort()
  viteUrl = `http://127.0.0.1:${port}`
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  viteProc = spawn(npmCmd, ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: webuiDir,
    env: {
      ...process.env,
      PENPLOT_BACKEND: `http://127.0.0.1:${backendPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  viteProc.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`))
  viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`))
  viteProc.on('exit', (code, signal) => {
    viteProc = null
    if (!quitting) {
      console.error(`[desktop] vite exited unexpectedly (code=${code}, signal=${signal})`)
    }
  })
  await waitForUrl(viteUrl, 30000)
  return viteUrl
}

function stopViteDevServer() {
  if (!viteProc) return
  const proc = viteProc
  viteProc = null
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    // ignore
  }
}

async function startBackend() {
  backendPort = Number(process.env.PENPLOT_PORT) || (await findFreePort())
  backendDataDir = process.env.PENPLOT_DATA_DIR || path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(backendDataDir, { recursive: true })

  const staticDir = process.env.PENPLOT_STATIC_DIR || path.join(RESOURCE_ROOT, 'webui', 'dist')
  const fontsDir = process.env.PENPLOT_FONT_DIR || path.join(RESOURCE_ROOT, 'fonts')
  const seedDir = process.env.PENPLOT_SEED_DIR || path.join(RESOURCE_ROOT, 'seed')
  const seedProfile = process.env.PENPLOT_SEED_PROFILE || path.join(RESOURCE_ROOT, 'configs', 'grbl-zpen.json')

  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    PENPLOT_HOST: '127.0.0.1',
    PENPLOT_PORT: String(backendPort),
    PENPLOT_DATA_DIR: backendDataDir,
    PENPLOT_STATIC_DIR: staticDir,
    PENPLOT_SEED_DIR: seedDir,
    PENPLOT_SEED_PROFILE: seedProfile,
    PENPLOT_TASK_MODE: process.env.PENPLOT_TASK_MODE || (process.platform === 'win32' ? 'thread' : 'process'),
    PYTHONPATH: app.isPackaged ? RESOURCE_ROOT : REPO_ROOT,
  }
  if (fs.existsSync(fontsDir)) {
    env.PENPLOT_FONT_DIR = fontsDir
  }

  const { cmd, args } = resolveBackendCommand(backendPort)
  backendProc = spawn(cmd, args, {
    cwd: RESOURCE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  backendProc.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`))
  backendProc.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`))
  backendProc.on('exit', (code, signal) => {
    backendProc = null
    if (!quitting) {
      console.error(`[desktop] backend exited unexpectedly (code=${code}, signal=${signal})`)
    }
  })

  await waitForHealth(backendPort)
}

function stopBackend() {
  if (!backendProc) return
  const proc = backendProc
  backendProc = null
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } else {
      proc.kill('SIGTERM')
    }
  } catch {
    // ignore
  }
}

function buildMenu() {
  const mcpUrl = `http://127.0.0.1:${backendPort}/mcp`
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录',
          click: () => backendDataDir && shell.openPath(backendDataDir),
        },
        {
          label: '复制 MCP 服务地址',
          click: () => {
            clipboard.writeText(mcpUrl)
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'MCP 服务地址已复制',
              message: `已复制到剪贴板:\n${mcpUrl}`,
            })
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const isMac = process.platform === 'darwin'
  const windowIcon = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: 'Penplot',
    icon: fs.existsSync(windowIcon) ? windowIcon : undefined,
    backgroundColor: '#111113',
    frame: isMac,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 10 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('penplot:window-maximized', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('penplot:window-maximized', false)
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.on('did-fail-load', (_ev, code, desc, url) => {
    console.error(`[desktop] did-fail-load (${code}) ${desc}: ${url}`)
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
  })

  mainWindow.webContents.on('render-process-gone', (_ev, details) => {
    console.error('[desktop] render-process-gone:', details)
  })

  mainWindow.webContents.on('console-message', (ev) => {
    if (ev.level >= 2 && !String(ev.message).includes('Electron Security Warning')) {
      console.error(`[renderer] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const targetUrl = IS_DEV && viteUrl
    ? viteUrl
    : `http://127.0.0.1:${backendPort}`
  mainWindow.loadURL(targetUrl)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

ipcMain.handle('penplot:backend-info', () => ({
  port: backendPort,
  url: `http://127.0.0.1:${backendPort}`,
  mcpUrl: `http://127.0.0.1:${backendPort}/mcp`,
  dataDir: backendDataDir,
}))

ipcMain.handle('penplot:open-data-dir', async () => {
  if (backendDataDir) await shell.openPath(backendDataDir)
})

ipcMain.handle('penplot:open-external', async (_ev, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    await shell.openExternal(url)
  }
})

ipcMain.handle('penplot:restart-backend', async () => {
  stopBackend()
  await startBackend()
  if (IS_DEV && !process.env.PENPLOT_VITE_URL) {
    stopViteDevServer()
    await startViteDevServer()
  }
  if (mainWindow) {
    mainWindow.loadURL(IS_DEV && viteUrl ? viteUrl : `http://127.0.0.1:${backendPort}`)
  }
  return { port: backendPort }
})

ipcMain.handle('penplot:window-minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('penplot:window-maximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  return mainWindow.isMaximized()
})

ipcMain.handle('penplot:window-close', () => {
  mainWindow?.close()
})

ipcMain.handle('penplot:window-is-maximized', () => mainWindow?.isMaximized() ?? false)

ipcMain.handle('penplot:copy-mcp-url', () => {
  const mcpUrl = `http://127.0.0.1:${backendPort}/mcp`
  clipboard.writeText(mcpUrl)
  return mcpUrl
})

ipcMain.handle('penplot:toggle-devtools', () => {
  mainWindow?.webContents.toggleDevTools()
})

ipcMain.handle('penplot:reload', (_ev, force) => {
  if (force) mainWindow?.webContents.reloadIgnoringCache()
  else mainWindow?.webContents.reload()
})

ipcMain.handle('penplot:toggle-fullscreen', () => {
  if (!mainWindow) return false
  const next = !mainWindow.isFullScreen()
  mainWindow.setFullScreen(next)
  return next
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  if (!gotLock) return
  try {
    await startBackend()
    await startViteDevServer()
    buildMenu()
    createWindow()
  } catch (err) {
    dialog.showErrorBox('Penplot 启动失败', String(err && err.stack ? err.stack : err))
    app.quit()
  }
})

app.on('before-quit', () => {
  quitting = true
  stopViteDevServer()
  stopBackend()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    createWindow()
  }
})
