import { useMemo } from 'react'
import type { ProjectDoc } from '@/api/studio'
import { resolveElementRender } from './element-render'
import { lastKeys } from './actions'
import { useRender } from './render-engine'

/** Physical pages in print order; keep the last pagination while text is rendering. */
export function usePagination(doc: ProjectDoc | null) {
  const renders = useRender((s) => s.els)
  return useMemo(() => (doc?.pages ?? []).flatMap((page, index) => {
    let count = 1
    for (const el of page.elements) {
      if (el.hidden) continue
      if (el.type !== 'flow_text') {
        count = Math.max(count, (el.page_offset ?? 0) + 1)
        continue
      }
      const key = lastKeys.get(el.id)
      const { r } = resolveElementRender(el.id, key ? renders[key] : undefined)
      const n = Math.max(1, r?.pages?.length ?? 1)
      count = Math.max(count, n)
    }
    return Array.from({ length: count }, (_, sub) => ({ page: index, sub }))
  }), [doc, renders])
}
