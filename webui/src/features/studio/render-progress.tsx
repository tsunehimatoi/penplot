import { lastKeys } from './actions'
import { cancelElementRender, retryErrors, useRender } from './render-engine'
import { useStudio } from './store'

/** Kept outside the SVG, so progress and cancellation stay available after page one appears. */
export function RenderProgress() {
  const doc = useStudio(s => s.doc)
  const els = useRender(s => s.els)
  const preparing = useRender(s => s.page.status === 'running')
  const keys = new Set(doc?.pages.flatMap(p => p.elements.filter(e => !e.hidden).map(e => lastKeys.get(e.id))))
  const entries = Object.entries(els).filter(([key, value]) => keys.has(key) && (value.status === 'pending' || value.status === 'error'))
  if (!entries.length) return preparing ? <div className="shrink-0 p-2 text-caption text-secondary-label" role="status">画布预览已就绪，正在准备打印统计…</div> : null
  const pending = entries.filter(([, r]) => r.status === 'pending')
  const current = pending[0] ?? entries[0]
  const r = current[1]
  return <div className="shrink-0 rounded-md bg-secondary-fill p-2 text-caption" role="status" aria-live="polite">
    <div>{r.message && pending.length ? r.message : r.error ?? '正在生成预览…'}</div>
    {pending.length > 0 && <progress className="w-full" aria-label="预览进度" value={r.progress ?? 0} max={1} />}
    <button type="button" className="focus-ring mt-1 text-accent" onClick={() => {
      if (pending.length) pending.forEach(([key]) => cancelElementRender(key))
      else retryErrors()
    }}>{pending.length ? '取消预览' : '重试预览'}</button>
  </div>
}
