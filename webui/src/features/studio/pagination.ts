import { useMemo } from 'react'
import type { ProjectDoc } from '@/api/studio'
import { usePapers } from './data'
import { resolveElementRender } from './element-render'
import { paginateFlowHtml } from './flow-preview'
import { lastKeys } from './actions'
import { pagePaperRef, resolvePaper } from './model'
import { useRender } from './render-engine'
import { useStudio } from './store'

/** Physical pages in print order; instant frontend pagination in WYSIWYG mode, backend pages in strokePreview. */
export function usePagination(doc: ProjectDoc | null) {
  const renders = useRender((s) => s.els)
  const strokePreview = useStudio((s) => s.strokePreview)
  const papers = usePapers()

  return useMemo(() => (doc?.pages ?? []).flatMap((page, index) => {
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
      if (strokePreview && exactRender?.status === 'ok' && exactRender.pages?.length) {
        count = Math.max(count, exactRender.pages.length)
      } else {
        const previewPages = paginateFlowHtml(el.props.text, el.props.format, paper, {
          line_num: el.props.line_num,
          text_size: el.props.text_size,
        })
        if (strokePreview) {
          const { r } = resolveElementRender(el.id, exactRender)
          count = Math.max(count, r?.pages?.length ?? previewPages.length)
        } else {
          count = Math.max(count, previewPages.length)
        }
      }
    }
    return Array.from({ length: count }, (_, sub) => ({ page: index, sub }))
  }), [doc, renders, strokePreview, papers.data])
}
