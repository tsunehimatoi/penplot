export interface PenplotDesktopBridge {
  isDesktop: boolean
  platform: string
  versions: {
    electron: string
    node: string
    chrome: string
  }
  getBackendInfo: () => Promise<{ port: number; url: string; mcpUrl: string; dataDir: string }>
  openDataDir: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  restartBackend: () => Promise<{ port: number }>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<boolean>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChange: (cb: (maximized: boolean) => void) => () => void
  copyMcpUrl: () => Promise<string>
  toggleDevTools: () => Promise<void>
  reloadWindow: (force?: boolean) => Promise<void>
  toggleFullscreen: () => Promise<boolean>
}

export function getDesktopBridge(): PenplotDesktopBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & { penplotDesktop?: PenplotDesktopBridge }
  return w.penplotDesktop?.isDesktop ? w.penplotDesktop : null
}

export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null
}
