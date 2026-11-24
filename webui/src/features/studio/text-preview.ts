import { useMemo } from 'react'
import type { Element, PaperBase } from '@/api/studio'
import { needsBackendRich, resolveTextRender } from './client-stroke-layout'
import { renderedElementPage, useElementRender } from './element-render'
import { useGlyphCache } from './glyph-cache'
import { variableValues } from './model'
import { useStudio } from './store'

/** Use the same page paths in the canvas and navigator. Keep edits responsive while a render is pending. */
export function useElementPreview(el: Element, paper: PaperBase, sub: number) {
  const { r, stale } = useElementRender(el)
  const isText = el.type === 'flow_text' || el.type === 'text'
  const doc = useStudio((s) => isText ? s.doc : null)
  const editing = useStudio((s) => isText && s.focusedTextId === el.id)
  const glyphVersion = useGlyphCache((s) => isText ? s.version : 0)

  return useMemo(() => {
    const exact = renderedElementPage(el, sub, r)
    if (!isText) return { d: exact?.d, bbox: exact?.bbox, r, stale, isText }
    const vars = doc ? variableValues(doc) : {}
    const rich = needsBackendRich(el, vars)
    if (r?.status === 'ok' && !stale && (!editing || rich)) {
      return { d: exact?.d, bbox: exact?.bbox, r, stale: false, isText }
    }
    void glyphVersion
    const client = resolveTextRender(el, paper, vars, sub)
    return { d: client.d, bbox: client.bbox, r: rich ? r : undefined, stale: false, isText }
  }, [el, paper, sub, r, stale, isText, doc, editing, glyphVersion])
}
