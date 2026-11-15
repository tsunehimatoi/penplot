import type { Element } from '@/api/studio'
import { lastKeys } from './actions'
import { useRender, type ElRender } from './render-engine'

/** Last successful render per element id, shown (dimmed) while a new version renders — avoids flicker while typing. */
const lastGood = new Map<string, ElRender>()

export function useElementRender(el: Element): { r: ElRender | undefined; stale: boolean } {
  const key = lastKeys.get(el.id)
  const r = useRender((s) => (key ? s.els[key] : undefined))
  return resolveElementRender(el.id, r)
}

export function resolveElementRender(id: string, r: ElRender | undefined): { r: ElRender | undefined; stale: boolean } {
  if ((r?.status === 'pending' || r?.status === 'error') && r.pages) return { r, stale: false }
  if (r?.status === 'ok') {
    lastGood.set(id, r)
    return { r, stale: false }
  }
  const prev = lastGood.get(id)
  if (prev) return { r: r?.status === 'error' ? { ...prev, status: 'error', error: r.error, code: r.code } : prev, stale: true }
  return { r, stale: false }
}

