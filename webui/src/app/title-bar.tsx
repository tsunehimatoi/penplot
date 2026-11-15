import {
  ChevronDown,
  Copy,
  FolderOpen,
  Maximize2,
  Minus,
  PenTool,
  Power,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  X,
} from 'lucide-react'
import * as React from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { getDesktopBridge } from '@/lib/desktop'
import { toast } from '@/lib/toast'
import { useChrome } from './chrome'

/** Custom frameless desktop title bar (rendered only inside Electron). */
export function TitleBar() {
  const bridge = getDesktopBridge()
  const title = useChrome((c) => c.title)
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!bridge) return
    let mounted = true
    void bridge.isWindowMaximized().then((v) => {
      if (mounted) setMaximized(v)
    })
    const off = bridge.onWindowMaximizedChange((v) => setMaximized(v))
    return () => {
      mounted = false
      off()
    }
  }, [bridge])

  if (!bridge) return null

  const isMac = bridge.platform === 'darwin'

  return (
    <div
      className={cn(
        'app-drag mat-toolbar hairline-b relative z-40 flex h-[var(--titlebar-h)] shrink-0 select-none items-center justify-between text-label',
        isMac ? 'pl-[76px] pr-3' : 'pl-3 pr-0',
      )}
    >
      <div className="app-no-drag flex min-w-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="focus-ring flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-footnote font-semibold text-label transition-colors hover:bg-quaternary-fill"
              aria-label="PenPlot 应用菜单"
            >
              <span className="flex size-4 items-center justify-center rounded-[4px] bg-gradient-to-b from-accent to-accent/80 text-white shadow-xs">
                <PenTool className="size-2.5" strokeWidth={2.5} aria-hidden />
              </span>
              <span>PenPlot</span>
              <ChevronDown className="size-3 text-tertiary-label" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem
              icon={<Copy />}
              onSelect={async () => {
                const url = await bridge.copyMcpUrl()
                toast.success('MCP 服务地址已复制', { description: url })
              }}
            >
              复制 MCP 服务地址
            </DropdownMenuItem>
            <DropdownMenuItem icon={<FolderOpen />} onSelect={() => void bridge.openDataDir()}>
              打开数据目录
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<RotateCcw />}
              onSelect={async () => {
                toast.info('正在重启本地服务…')
                await bridge.restartBackend()
              }}
            >
              重启本地服务
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<RefreshCw />} shortcut="mod+r" onSelect={() => void bridge.reloadWindow(false)}>
              刷新界面
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Terminal />} onSelect={() => void bridge.toggleDevTools()}>
              开发者工具
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Maximize2 />} onSelect={() => void bridge.toggleFullscreen()}>
              切换全屏
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Power />} destructive onSelect={() => void bridge.closeWindow()}>
              退出 PenPlot
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="pointer-events-none absolute inset-x-0 flex justify-center px-40">
        <span className="truncate text-footnote font-medium text-secondary-label">
          {title ? `${title} — PenPlot` : 'PenPlot'}
        </span>
      </div>

      {!isMac ? (
        <div className="app-no-drag flex h-full items-center">
          <button
            type="button"
            onClick={() => void bridge.minimizeWindow()}
            className="flex h-full w-11 items-center justify-center text-secondary-label transition-colors hover:bg-quaternary-fill hover:text-label"
            aria-label="最小化"
            title="最小化"
          >
            <Minus className="size-3.5" strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => void bridge.toggleMaximizeWindow()}
            className="flex h-full w-11 items-center justify-center text-secondary-label transition-colors hover:bg-quaternary-fill hover:text-label"
            aria-label={maximized ? '还原窗口' : '最大化'}
            title={maximized ? '还原窗口' : '最大化'}
          >
            {maximized ? (
              <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
                <rect x="1.5" y="3.5" width="7" height="7" rx="0.75" />
                <path d="M3.5 3.5V2a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H8.5" />
              </svg>
            ) : (
              <Square className="size-3" strokeWidth={1.6} aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => void bridge.closeWindow()}
            className="flex h-full w-11 items-center justify-center text-secondary-label transition-colors hover:bg-red hover:text-white"
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-3.5" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="w-4 shrink-0" />
      )}
    </div>
  )
}
