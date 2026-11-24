/**
 * Frontend instant WYSIWYG flow_text paginator.
 * Splits semantic HTML into top-level blocks and distributes them across `effectiveLayoutBoxes(paper)`
 * in < 5ms with zero backend requests.
 */
import type { PaperBase } from '@/api/studio'
import { markdownToHtml, plainToHtml, sanitizePastedHtml } from '@/lib/html-to-md'
import { boxLineNum, effectiveLayoutBoxes } from './model'

export interface FlowPreviewBox {
  boxId: string
  x_mm: number
  y_mm: number
  w_mm: number
  h_mm: number
  lineNum: number
  html: string
}

export interface FlowPreviewPage {
  sub: number
  boxes: FlowPreviewBox[]
}

function toPreviewHtml(text: string, format: 'plain' | 'markdown' | 'html' | undefined): string {
  if (!text) return ''
  if (format === 'html') return sanitizePastedHtml(text)
  if (format === 'markdown') return markdownToHtml(text)
  return plainToHtml(text)
}

function isPageBreak(el: Element): boolean {
  if (el.getAttribute('data-pagebreak') === 'true') return true
  const st = (el.getAttribute('style') ?? '').toLowerCase()
  return (st.includes('page-break-after') && st.includes('always')) || (st.includes('page-break-before') && st.includes('always'))
}

function estimateTextWidthMm(text: string, fontSizeMm: number): number {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 10 || code === 13) continue
    // CJK / full-width characters vs ASCII
    w += code > 0x2e7f ? fontSizeMm * 0.98 : fontSizeMm * 0.54
  }
  return w
}

function estimateWrappedLines(text: string, boxWidthMm: number, fontSizeMm: number): number {
  const usableW = Math.max(4, boxWidthMm - 2)
  const segments = text.split(/\r?\n/)
  let lines = 0
  for (const seg of segments) {
    const trimmed = seg.replace(/[\u200b\ufeff]/g, '')
    if (!trimmed.length) {
      lines += 1
      continue
    }
    const w = estimateTextWidthMm(trimmed, fontSizeMm)
    lines += Math.max(1, Math.ceil(w / usableW))
  }
  return Math.max(1, lines)
}

function estimateBlockLines(el: Element, boxWidthMm: number, fontSizeMm: number): number {
  const tag = el.tagName.toLowerCase()
  if (tag === 'hr') return 1
  if (tag === 'pre') {
    const raw = (el.textContent ?? '').replace(/\n$/, '')
    const rawLines = raw ? raw.split(/\r?\n/).length : 1
    return Math.max(2, rawLines + 1)
  }
  if (tag === 'table') {
    const rows = el.querySelectorAll('tr').length
    return Math.max(2, rows + 1)
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = el.querySelectorAll(':scope > li')
    if (!items.length) return 1
    let sum = 0
    for (const li of items) {
      sum += estimateWrappedLines(li.textContent ?? '', Math.max(4, boxWidthMm - 6), fontSizeMm)
    }
    return Math.max(1, sum)
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1])
    const scale = level === 1 ? 1.45 : level === 2 ? 1.25 : 1.12
    const wrapped = estimateWrappedLines(el.textContent ?? '', boxWidthMm, fontSizeMm * scale)
    return level <= 2 ? Math.max(2, wrapped) : Math.max(1, wrapped)
  }
  // p, blockquote, div
  const txt = (el.textContent ?? '').replace(/[\u00a0\u200b\ufeff\s]+/g, '')
  if (!txt && !el.querySelector('svg, math, [data-chart], img')) {
    const brCount = el.querySelectorAll('br').length
    return Math.max(1, brCount)
  }
  const brs = el.querySelectorAll('br').length
  const wrapped = estimateWrappedLines(el.textContent ?? '', boxWidthMm, fontSizeMm)
  return Math.max(1, wrapped + (brs > 0 && !txt ? brs - 1 : 0))
}

function createEmptyPage(
  sub: number,
  paper: PaperBase,
  layoutBoxes: ReturnType<typeof effectiveLayoutBoxes>,
  overrideLineNum?: number | null,
): { page: FlowPreviewPage; buffers: string[][] } {
  const boxes: FlowPreviewBox[] = layoutBoxes.map((b) => ({
    boxId: b.id,
    x_mm: b.x_mm,
    y_mm: b.y_mm,
    w_mm: b.w_mm,
    h_mm: b.h_mm,
    lineNum: boxLineNum(paper, b, overrideLineNum),
    html: '',
  }))
  return {
    page: { sub, boxes },
    buffers: boxes.map(() => []),
  }
}

export function paginateFlowHtml(
  text: string,
  format: 'plain' | 'markdown' | 'html' | undefined,
  paper: PaperBase,
  props?: { line_num?: number | null; text_size?: number },
): FlowPreviewPage[] {
  const layoutBoxes = effectiveLayoutBoxes(paper)
  const overrideLineNum = props?.line_num ?? null
  const textSizeRatio = props?.text_size ?? 0.72

  const pages: { page: FlowPreviewPage; buffers: string[][] }[] = [
    createEmptyPage(0, paper, layoutBoxes, overrideLineNum),
  ]

  const html = toPreviewHtml(text, format)
  if (!html.trim()) {
    return pages.map((p) => p.page)
  }

  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks: Element[] = []
  for (const node of parsed.body.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      blocks.push(node as Element)
    } else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) {
      const p = parsed.createElement('p')
      p.textContent = node.textContent
      blocks.push(p)
    }
  }

  if (!blocks.length) {
    return pages.map((p) => p.page)
  }

  let pageIdx = 0
  let boxIdx = 0
  let usedLines = 0

  const advancePage = () => {
    pageIdx += 1
    boxIdx = 0
    usedLines = 0
    if (!pages[pageIdx]) {
      pages.push(createEmptyPage(pageIdx, paper, layoutBoxes, overrideLineNum))
    }
  }

  const advanceBox = () => {
    if (boxIdx + 1 < layoutBoxes.length) {
      boxIdx += 1
      usedLines = 0
    } else {
      advancePage()
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i]
    if (isPageBreak(blk)) {
      // Only create a new physical page if current page has content or there are more blocks after
      if (usedLines > 0 || boxIdx > 0 || i < blocks.length - 1) {
        advancePage()
      }
      continue
    }

    const curBox = pages[pageIdx].page.boxes[boxIdx]
    const lineH = curBox.h_mm / Math.max(1, curBox.lineNum)
    const fontSizeMm = lineH * textSizeRatio
    const needLines = estimateBlockLines(blk, curBox.w_mm, fontSizeMm)

    if (usedLines > 0 && usedLines + needLines > curBox.lineNum) {
      advanceBox()
    }

    const targetBox = pages[pageIdx].page.boxes[boxIdx]
    const targetLineH = targetBox.h_mm / Math.max(1, targetBox.lineNum)
    const finalLines = estimateBlockLines(blk, targetBox.w_mm, targetLineH * textSizeRatio)
    pages[pageIdx].buffers[boxIdx].push(blk.outerHTML)
    usedLines += finalLines
  }

  for (const entry of pages) {
    for (let i = 0; i < entry.page.boxes.length; i++) {
      entry.page.boxes[i].html = entry.buffers[i].join('')
    }
  }

  return pages.map((p) => p.page)
}
