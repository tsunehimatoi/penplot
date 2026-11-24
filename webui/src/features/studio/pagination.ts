import { useMemo } from 'react'
import type { ProjectDoc } from '@/api/studio'
import { lastKeys } from './actions'
import { layoutFlowStrokes, needsBackendRich } from './client-stroke-layout'
import { usePapers } from './data'
import { useGlyphCache } from './glyph-cache'
import { pagePaperRef, resolvePaper, variableValues } from './model'
import { useRender } from './render-engine'

/** Physical pages in print order; instant client-side single-stroke layout with backend override for LaTeX/charts/SVG. */
export function usePagination(doc: ProjectDoc | null) {
  const renders = useRender((s) => s.els)
  const glyphVersion = useGlyphCache((s) => s.version)
  const papers = usePapers()

  return useMemo(() => {
    void glyphVersion
    const vars = doc ? variableValues(doc) : {}
    return (doc?.pages ?? []).flatMap((page, index) => {
      let count = 1
      const paper = resolvePaper(pagePaperRef(doc!, page), papers.data)
      for (const el of page.elements) {
        if (el.hidden) continue
        if (el.type !== 'flow_text') {
          count = Math.max(count, (el.page_offset ?? 0) + 1)
          continue
        }
        const key = lastKeys.get(el.id)
        const exactRender = key ? renders[key] : undefined
        if (needsBackendRich(el, vars) && exactRender?.status === 'ok' && exactRender.pages?.length) {
          count = Math.max(count, exactRender.pages.length)
        } else {
          const clientPages = layoutFlowStrokes(el, paper, vars)
          count = Math.max(count, clientPages.pages.length)
        }
      }
      return Array.from({ length: count }, (_, sub) => ({ page: index, sub }))
    })
  }, [doc, renders, glyphVersion, papers.data])
}
