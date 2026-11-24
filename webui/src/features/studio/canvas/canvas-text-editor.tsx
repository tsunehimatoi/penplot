/**
 * Canvas-level direct-on-stroke writing layer + move handle.
 * Renders a transparent clickable `role="textbox"` overlay aligned 1:1 with the
 * client-side single-stroke paths so users write directly on the strokes with zero
 * ghosting and zero mode switching.
 */
import { GripVertical } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { importFile, type Element, type FlowTextElement, type PaperBase, type TextElement } from '@/api/studio'
import { cn } from '@/lib/cn'
import { plainToHtml } from '@/lib/html-to-md'
import { toast } from '@/lib/toast'
import { resolveTextRender, type CharBox, type LineAnchor } from '../client-stroke-layout'
import { useElementRender } from '../element-render'
import { useGlyphCache } from '../glyph-cache'
import { boxLineNum, effectiveLayoutBoxes, variableValues } from '../model'
import { studio, useStudio } from '../store'
import {
  EDIT_SELECTED_FORMULA_EVENT,
  normalizeEditorHtml,
  toVisualHtml,
  WysiwygSurface,
  type EditorMode,
  type FlowFormat,
} from '../inspector/rich-editor'
import { sx, sy, type Viewport } from './overlays'

const ALIGN_CSS: Record<'L' | 'C' | 'R' | 'D', 'left' | 'center' | 'right' | 'justify'> = {
  L: 'left',
  C: 'center',
  R: 'right',
  D: 'justify',
}

export function CanvasTextLayer({
  paper,
  v,
  els,
  sub,
  focusedTextId,
  readOnly,
  onStartMove,
}: {
  paper: PaperBase
  v: Viewport
  els: Element[]
  sub: number
  focusedTextId: string | null
  readOnly: boolean
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const editTextOf = useStudio((s) => s.editTextOf)

  // Focus the canvas textbox when triggered by `editTextOf` (e.g. new letter, Enter key, or inspector button)
  React.useEffect(() => {
    if (!editTextOf) return
    const st = useStudio.getState()
    st.setFocusedTextId(editTextOf)
    st.setEditText(null)
    requestAnimationFrame(() => {
      const box = document.querySelector(`[data-inline-editor="${editTextOf}"] [role="textbox"], [data-inline-editor="${editTextOf}"] textarea`) as HTMLElement | null
      box?.focus({ preventScroll: true })
    })
  }, [editTextOf])

  if (readOnly) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <style>{`
        .studio-transparent-text::selection,
        .studio-transparent-text *::selection {
          background: transparent !important;
          color: transparent !important;
        }
      `}</style>
      {els.map((el) => {
        if (el.hidden || el.locked) return null
        if (el.type === 'flow_text') {
          return (
            <FlowDirectEditor
              key={el.id}
              el={el}
              paper={paper}
              v={v}
              sub={sub}
              focused={focusedTextId === el.id}
              onStartMove={onStartMove}
            />
          )
        }
        if (el.type === 'text') {
          return (
            <TextDirectEditor
              key={el.id}
              el={el}
              paper={paper}
              v={v}
              focused={focusedTextId === el.id}
              onStartMove={onStartMove}
            />
          )
        }
        return null
      })}
    </div>
  )
}

function MoveHandle({
  el,
  left,
  top,
  width,
  maxRight,
  onStartMove,
}: {
  el: Element
  left: number
  top: number
  width: number
  maxRight?: number
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const label = `移动${el.type === 'flow_text' ? '文本框' : '自由文本框'}`
  const rawLeft = left + Math.max(0, width - 54)
  const clampedLeft = maxRight !== undefined ? Math.max(2, Math.min(rawLeft, maxRight - 58)) : Math.max(2, rawLeft)
  return (
    <button
      type="button"
      data-move-handle={el.id}
      aria-label={label}
      title={label}
      onPointerDown={(e) => onStartMove(el, e)}
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto absolute z-30 flex h-5 items-center gap-0.5 rounded-t border border-b-0 border-separator/70 bg-bg-elevated/92 px-1.5 text-[11px] font-medium text-secondary-label shadow-sm backdrop-blur-sm transition-colors hover:border-accent hover:text-label active:cursor-grabbing"
      style={{
        left: clampedLeft,
        top: Math.max(2, top - 22),
        cursor: 'grab',
      }}
    >
      <GripVertical className="size-3" />
      <span>移动</span>
    </button>
  )
}

interface BlockChar {
  blockIdx: number
  charIdx: number
}

function cmpBC(a: BlockChar, b: BlockChar): number {
  return a.blockIdx !== b.blockIdx ? a.blockIdx - b.blockIdx : a.charIdx - b.charIdx
}

function hitTestBlockChar(
  localMmX: number,
  localMmY: number,
  pageCharBoxes: CharBox[],
  pageLineAnchors: LineAnchor[],
): { bc: BlockChar; anchor: LineAnchor | null; atom?: CharBox } {
  if (pageLineAnchors.length === 0) return { bc: { blockIdx: 0, charIdx: 0 }, anchor: null }
  let bestAnchor = pageLineAnchors[0]
  let bestDy = Infinity
  let bestDx = Infinity

  for (const anchor of pageLineAnchors) {
    const dy =
      localMmY >= anchor.y && localMmY <= anchor.y + anchor.h
        ? 0
        : Math.min(Math.abs(localMmY - anchor.y), Math.abs(localMmY - (anchor.y + anchor.h)))
    const dx =
      localMmX >= anchor.x && localMmX <= anchor.endX
        ? 0
        : Math.min(Math.abs(localMmX - anchor.x), Math.abs(localMmX - anchor.endX))
    if (dy < bestDy - 1e-4 || (Math.abs(dy - bestDy) <= 1e-4 && dx < bestDx)) {
      bestDy = dy
      bestDx = dx
      bestAnchor = anchor
    }
  }

  const lineChars = pageCharBoxes
    .filter(
      (cb) =>
        cb.blockIdx === bestAnchor.blockIdx &&
        cb.boxIdx === bestAnchor.boxIdx &&
        Math.abs(cb.y - bestAnchor.y) < 1e-4 &&
        cb.charIdx >= bestAnchor.startCharIdx &&
        cb.charIdx < bestAnchor.endCharIdx,
    )
    .sort((a, b) => a.x - b.x)

  if (lineChars.length === 0) {
    return { bc: { blockIdx: bestAnchor.blockIdx, charIdx: bestAnchor.startCharIdx }, anchor: bestAnchor }
  }
  for (const cb of lineChars) {
    if (cb.atomic && localMmX > cb.x + cb.w * 0.15 && localMmX < cb.x + cb.w * 0.85) {
      const charIdx = localMmX < cb.x + cb.w * 0.5 ? cb.charIdx : cb.endCharIdx ?? cb.charIdx + 1
      return { bc: { blockIdx: cb.blockIdx, charIdx }, anchor: bestAnchor, atom: cb }
    }
    if (localMmX < cb.x + cb.w * 0.5) {
      return { bc: { blockIdx: bestAnchor.blockIdx, charIdx: cb.charIdx }, anchor: bestAnchor }
    }
  }
  return { bc: { blockIdx: bestAnchor.blockIdx, charIdx: bestAnchor.endCharIdx }, anchor: bestAnchor }
}

function computeCaretAndSelection(
  startBC: BlockChar,
  endBC: BlockChar,
  pageCharBoxes: CharBox[],
  pageLineAnchors: LineAnchor[],
): {
  caret: { x: number; y: number; h: number } | null
  rects: { x: number; y: number; w: number; h: number }[]
} {
  if (startBC.blockIdx === endBC.blockIdx && startBC.charIdx === endBC.charIdx) {
    const cb = pageCharBoxes.find((c) => c.blockIdx === startBC.blockIdx && c.charIdx === startBC.charIdx)
    if (cb) {
      return { caret: { x: cb.x, y: cb.y, h: cb.h }, rects: [] }
    }
    let matchedAnchor: LineAnchor | null = null
    for (const a of pageLineAnchors) {
      if (a.blockIdx === startBC.blockIdx && startBC.charIdx >= a.startCharIdx && startBC.charIdx <= a.endCharIdx) {
        matchedAnchor = a
      }
    }
    if (matchedAnchor) {
      return { caret: { x: matchedAnchor.endX, y: matchedAnchor.y, h: matchedAnchor.h }, rects: [] }
    }
    return { caret: null, rects: [] }
  }

  const [selStart, selEnd] = cmpBC(startBC, endBC) <= 0 ? [startBC, endBC] : [endBC, startBC]
  const lineGroups = new Map<string, { x0: number; x1: number; y: number; h: number }>()

  for (const cb of pageCharBoxes) {
    const pos = { blockIdx: cb.blockIdx, charIdx: cb.charIdx }
    if (cmpBC(pos, selStart) >= 0 && cmpBC(pos, selEnd) < 0) {
      const key = `${cb.boxIdx}:${Math.round(cb.y * 1000)}`
      const prev = lineGroups.get(key)
      if (!prev) {
        lineGroups.set(key, { x0: cb.x, x1: cb.x + cb.w, y: cb.y, h: cb.h })
      } else {
        if (cb.x < prev.x0) prev.x0 = cb.x
        if (cb.x + cb.w > prev.x1) prev.x1 = cb.x + cb.w
      }
    }
  }

  // Highlight empty lines spanned by multi-block selection
  for (const a of pageLineAnchors) {
    if (
      a.startCharIdx === a.endCharIdx &&
      a.blockIdx >= selStart.blockIdx &&
      a.blockIdx < selEnd.blockIdx
    ) {
      const key = `${a.boxIdx}:${Math.round(a.y * 1000)}`
      if (!lineGroups.has(key)) {
        lineGroups.set(key, { x0: a.x, x1: a.x + 2.5, y: a.y, h: a.h })
      }
    }
  }

  const rects: { x: number; y: number; w: number; h: number }[] = []
  for (const g of lineGroups.values()) {
    rects.push({ x: g.x0, y: g.y, w: Math.max(0.5, g.x1 - g.x0), h: g.h })
  }
  return { caret: null, rects }
}

const DOM_BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'ul', 'ol', 'pre', 'table', 'hr',
])

function isDomPageBreak(el: globalThis.Element): boolean {
  if (el.getAttribute('data-pagebreak') === 'true') return true
  const st = (el.getAttribute('style') ?? '').toLowerCase()
  return (
    (st.includes('page-break-after') && st.includes('always')) ||
    (st.includes('page-break-before') && st.includes('always'))
  )
}

interface DomBlockInfo {
  nodes: Node[]
  isEmptyBlock: boolean
  isPre: boolean
}

function hasNonNewlineText(nodes: Node[]): boolean {
  for (const n of nodes) {
    if (n.nodeType === 3) {
      if ((n.textContent ?? '').replace(/[\r\n]/g, '').length > 0) return true
    } else if (n.nodeType === 1) {
      const el = n as globalThis.Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'br') continue
      if (hasNonNewlineText([...el.childNodes])) return true
    }
  }
  return false
}

function getDomBlocks(editorEl: HTMLElement): DomBlockInfo[] {
  const out: DomBlockInfo[] = []
  const process = (parent: Node) => {
    let inlineAcc: Node[] = []
    let hasBr = false
    const flushInline = () => {
      if (inlineAcc.length === 0) return
      const hasText = inlineAcc.some((n) => {
        if (n.nodeType === 3) return (n.textContent ?? '').trim().length > 0
        return true
      })
      if (hasText || hasBr) {
        out.push({ nodes: inlineAcc, isEmptyBlock: !hasNonNewlineText(inlineAcc), isPre: false })
      }
      inlineAcc = []
      hasBr = false
    }

    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i]
      if (node.nodeType === 3) {
        if (node.textContent) inlineAcc.push(node)
        continue
      }
      if (node.nodeType !== 1) continue
      const el = node as globalThis.Element
      const tag = el.tagName.toLowerCase()
      if (
        isDomPageBreak(el) ||
        tag === 'hr' ||
        /^h[1-6]$/.test(tag) ||
        tag === 'blockquote' ||
        tag === 'ul' ||
        tag === 'ol' ||
        tag === 'pre' ||
        tag === 'table'
      ) {
        flushInline()
        out.push({
          nodes: [el],
          isEmptyBlock: tag === 'hr' || isDomPageBreak(el) ? true : !hasNonNewlineText([el]),
          isPre: tag === 'pre',
        })
        continue
      }
      if (tag === 'p' || tag === 'div') {
        flushInline()
        let hasChildBlock = false
        for (let k = 0; k < el.children.length; k++) {
          if (DOM_BLOCK_TAGS.has(el.children[k].tagName.toLowerCase())) {
            hasChildBlock = true
            break
          }
        }
        if (tag === 'div' && hasChildBlock) {
          process(el)
        } else {
          out.push({ nodes: [el], isEmptyBlock: !hasNonNewlineText([el]) &&
            el.querySelectorAll('br:not([data-editor-sentinel])').length <= 1, isPre: false })
        }
        continue
      }
      if (tag === 'br' || el.querySelector('br') !== null) hasBr = true
      inlineAcc.push(el)
    }
    flushInline()
  }
  process(editorEl)
  return out
}

function collapsedTextLen(raw: string, inPre: boolean): number {
  return inPre ? raw.length : raw.replace(/[ \t]*[\r\n]+[ \t\r\n]*/g, ' ').length
}

function rawOffsetForCollapsed(raw: string, targetCollapsed: number, inPre: boolean): number {
  if (inPre) return Math.min(raw.length, targetCollapsed)
  let offset = targetCollapsed
  for (const whitespace of raw.matchAll(/[ \t]*[\r\n]+[ \t\r\n]*/g)) {
    if (whitespace.index >= offset) break
    offset += whitespace[0].length - 1
  }
  return Math.min(raw.length, offset)
}

function countNodeChars(node: Node, isEmptyBlock: boolean, inPre: boolean): number {
  if (node.nodeType === 3) return collapsedTextLen(node.textContent ?? '', inPre)
  if (node.nodeType !== 1) return 0
  const el = node as globalThis.Element
  if (el.matches('.math-inline, .math-display')) return 1
  const tag = el.tagName.toLowerCase()
  if (tag === 'br') return isEmptyBlock || el.hasAttribute('data-editor-sentinel') ? 0 : 1
  const nextPre = inPre || tag === 'pre'
  let sum = tag === 'td' || tag === 'th' ? 1 : 0
  for (let i = 0; i < el.childNodes.length; i++) {
    sum += countNodeChars(el.childNodes[i], isEmptyBlock, nextPre)
  }
  return sum
}

function domPointToBlockChar(editorEl: HTMLElement, container: Node, offset: number): BlockChar | null {
  if (!editorEl.contains(container)) return null
  const blocks = getDomBlocks(editorEl)
  if (blocks.length === 0) return { blockIdx: 0, charIdx: 0 }

  if (container === editorEl) {
    if (offset <= 0) return { blockIdx: 0, charIdx: 0 }
    if (offset < editorEl.childNodes.length) {
      const targetNode = editorEl.childNodes[offset]
      const bi = blocks.findIndex((b) => b.nodes.some((n) => n === targetNode || n.contains(targetNode)))
      if (bi >= 0) return { blockIdx: bi, charIdx: 0 }
    }
    const lastIdx = blocks.length - 1
    const lastTotal = blocks[lastIdx].nodes.reduce(
      (s, n) => s + countNodeChars(n, blocks[lastIdx].isEmptyBlock, blocks[lastIdx].isPre),
      0,
    )
    return { blockIdx: lastIdx, charIdx: lastTotal }
  }

  let blockIdx = blocks.findIndex((b) => b.nodes.some((n) => n === container || n.contains(container)))
  if (blockIdx < 0) {
    return { blockIdx: 0, charIdx: 0 }
  }
  const blk = blocks[blockIdx]
  let acc = 0

  const walk = (n: Node, inPre: boolean): number | null => {
    if (n instanceof globalThis.Element && n.matches('.math-inline, .math-display')) {
      if (n.contains(container)) return acc + (offset > 0 ? 1 : 0)
      acc++
      return null
    }
    if (n === container) {
      if (n.nodeType === 3) {
        return acc + collapsedTextLen((n.textContent ?? '').slice(0, offset), inPre)
      }
      let subSum = 0
      const nextPre = inPre || (n.nodeType === 1 && (n as globalThis.Element).tagName.toLowerCase() === 'pre')
      for (let i = 0; i < Math.min(offset, n.childNodes.length); i++) {
        subSum += countNodeChars(n.childNodes[i], blk.isEmptyBlock, nextPre)
      }
      return acc + subSum
    }
    if (n.nodeType === 3) {
      acc += collapsedTextLen(n.textContent ?? '', inPre)
      return null
    }
    if (n.nodeType !== 1) return null
    const el = n as globalThis.Element
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      acc += countNodeChars(el, blk.isEmptyBlock, false)
      return null
    }
    const nextPre = inPre || tag === 'pre'
    if (el.contains(container)) {
      for (let i = 0; i < el.childNodes.length; i++) {
        const res = walk(el.childNodes[i], nextPre)
        if (res !== null) return res
      }
      return acc
    }
    acc += countNodeChars(el, blk.isEmptyBlock, nextPre)
    return null
  }

  for (const n of blk.nodes) {
    const res = walk(n, blk.isPre)
    if (res !== null) return { blockIdx, charIdx: res }
  }
  return { blockIdx, charIdx: acc }
}

function blockCharToDomPoint(
  editorEl: HTMLElement,
  targetBlockIdx: number,
  targetCharIdx: number,
): { container: Node; offset: number } | null {
  const blocks = getDomBlocks(editorEl)
  if (blocks.length === 0) return { container: editorEl, offset: 0 }
  const bIdx = Math.max(0, Math.min(targetBlockIdx, blocks.length - 1))
  const blk = blocks[bIdx]
  let rem = Math.max(0, targetCharIdx)

  const walk = (n: Node, inPre: boolean): { container: Node; offset: number } | null => {
    if (n.nodeType === 3) {
      const raw = n.textContent ?? ''
      const len = collapsedTextLen(raw, inPre)
      if (rem <= len) {
        return { container: n, offset: rawOffsetForCollapsed(raw, rem, inPre) }
      }
      rem -= len
      return null
    }
    if (n.nodeType !== 1) return null
    const el = n as globalThis.Element
    if (el.matches('.math-inline, .math-display') && el.parentNode) {
      const index = Array.from(el.parentNode.childNodes).indexOf(el)
      if (rem <= 1) return { container: el.parentNode, offset: index + rem }
      rem--
      return null
    }
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      const p = el.parentNode
      if (!p) return null
      const idx = Array.prototype.indexOf.call(p.childNodes, el)
      if (blk.isEmptyBlock || rem === 0) {
        return { container: p, offset: idx }
      }
      rem -= countNodeChars(el, blk.isEmptyBlock, false)
      return null
    }
    const nextPre = inPre || tag === 'pre'
    for (let i = 0; i < el.childNodes.length; i++) {
      const res = walk(el.childNodes[i], nextPre)
      if (res) return res
    }
    if (tag === 'td' || tag === 'th') {
      if (rem === 0) return { container: el, offset: el.childNodes.length }
      rem--
    }
    return null
  }

  for (const n of blk.nodes) {
    const res = walk(n, blk.isPre)
    if (res) return res
  }

  const last = blk.nodes[blk.nodes.length - 1]
  if (last.nodeType === 3) {
    return { container: last, offset: (last.textContent ?? '').length }
  }
  return { container: last, offset: last.childNodes.length }
}

function domSelectionToRange(editorEl: HTMLElement, sel: Selection | null): { start: BlockChar; end: BlockChar } | null {
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!editorEl.contains(range.commonAncestorContainer)) return null
  const anchorNode = sel.anchorNode ?? range.startContainer
  const anchorOffset = sel.anchorNode ? sel.anchorOffset : range.startOffset
  const focusNode = sel.focusNode ?? range.endContainer
  const focusOffset = sel.focusNode ? sel.focusOffset : range.endOffset
  const start = domPointToBlockChar(editorEl, anchorNode, anchorOffset)
  const end = domPointToBlockChar(editorEl, focusNode, focusOffset)
  if (!start || !end) return null
  return { start, end }
}

function setDomSelectionRange(editorEl: HTMLElement, startBC: BlockChar, endBC: BlockChar): void {
  const startPt = blockCharToDomPoint(editorEl, startBC.blockIdx, startBC.charIdx)
  const endPt = blockCharToDomPoint(editorEl, endBC.blockIdx, endBC.charIdx)
  if (!startPt || !endPt) return
  const sel = window.getSelection()
  if (!sel) return
  if (typeof sel.setBaseAndExtent === 'function') {
    sel.setBaseAndExtent(startPt.container, startPt.offset, endPt.container, endPt.offset)
    return
  }
  const [a, b] = cmpBC(startBC, endBC) <= 0 ? [startPt, endPt] : [endPt, startPt]
  const range = document.createRange()
  range.setStart(a.container, a.offset)
  range.setEnd(b.container, b.offset)
  sel.removeAllRanges()
  sel.addRange(range)
}

function FlowDirectEditor({
  el,
  paper,
  v,
  sub,
  focused,
  onStartMove,
}: {
  el: FlowTextElement
  paper: PaperBase
  v: Viewport
  sub: number
  focused: boolean
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const [mode, setMode] = React.useState<EditorMode>('visual')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dragAnchorRef = React.useRef<BlockChar | null>(null)
  const [selRange, setSelRange] = React.useState<{ start: BlockChar; end: BlockChar } | null>(null)
  const glyphVersion = useGlyphCache((s) => s.version)
  const doc = useStudio((s) => s.doc)
  const fmt: FlowFormat = el.props.format ?? 'plain'
  const text = el.props.text ?? ''

  const layoutBoxes = effectiveLayoutBoxes(paper)
  const activeBox = layoutBoxes[0]
  const lineNum = boxLineNum(paper, activeBox, el.props.line_num)
  const ox = el.transform.x
  const oy = el.transform.y

  const boxLeft = Math.min(...layoutBoxes.map((box) => box.x_mm))
  const boxTop = Math.min(...layoutBoxes.map((box) => box.y_mm))
  const left = sx(v, boxLeft + ox)
  const top = sy(v, boxTop + oy)
  const width = (Math.max(...layoutBoxes.map((box) => box.x_mm + box.w_mm)) - boxLeft) * v.zoom
  const height = (Math.max(...layoutBoxes.map((box) => box.y_mm + box.h_mm)) - boxTop) * v.zoom
  const lineH = (activeBox.h_mm / Math.max(1, lineNum)) * v.zoom
  const fontSize = Math.max(6, lineH * (el.props.text_size || 1) * 0.72)
  const headingScale = el.props.rich_style?.heading_scale ?? 1.35
  const h1Lines = headingScale >= 1.3 ? 2 : 1
  const ruledVars: Record<string, string> = {
    '--ruled-lh': `${lineH}px`,
    '--ruled-h1-lh': `${lineH * h1Lines}px`,
  }
  const textAlign = ALIGN_CSS[el.props.align] ?? 'left'

  const clientText = React.useMemo(() => {
    void glyphVersion
    return resolveTextRender(el, paper, doc ? variableValues(doc) : {}, sub)
  }, [el, paper, doc, sub, glyphVersion])
  const { r, stale } = useElementRender(el)
  const exactLayout = clientText.isBackendRich && !stale && r?.status === 'ok' ? r.editorLayout : undefined
  const textLayout = React.useMemo(() => {
    if (!exactLayout?.lineAnchors.length) return clientText
    const mapped = new Set(exactLayout.lineAnchors.map((line) => line.blockIdx))
    return {
      charBoxes: exactLayout.charBoxes.concat(clientText.charBoxes.filter((box) => !mapped.has(box.blockIdx))),
      lineAnchors: exactLayout.lineAnchors.concat(clientText.lineAnchors.filter((line) => !mapped.has(line.blockIdx))),
    }
  }, [clientText, exactLayout])

  const pageCharBoxes = React.useMemo(
    () => textLayout.charBoxes.filter((c) => c.page === sub),
    [textLayout.charBoxes, sub],
  )
  const pageLineAnchors = React.useMemo(
    () => textLayout.lineAnchors.filter((a) => a.page === sub),
    [textLayout.lineAnchors, sub],
  )

  const syncSelection = React.useCallback(() => {
    if (mode !== 'visual') {
      setSelRange(null)
      return
    }
    const ed = containerRef.current?.querySelector('[role="textbox"]') as HTMLElement | null
    if (!ed || document.activeElement !== ed) return
    const next = domSelectionToRange(ed, window.getSelection())
    if (next) setSelRange(next)
  }, [mode])

  React.useEffect(() => {
    if (!focused || mode !== 'visual') {
      setSelRange(null)
      return
    }
    syncSelection()
    const onSelChange = () => syncSelection()
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [focused, mode, syncSelection, text])

  const caretGeom = React.useMemo(() => {
    if (!focused || mode !== 'visual' || !selRange) return null
    return computeCaretAndSelection(selRange.start, selRange.end, pageCharBoxes, pageLineAnchors)
  }, [focused, mode, selRange, pageCharBoxes, pageLineAnchors])

  React.useLayoutEffect(() => {
    if (!focused || mode !== 'visual' || !selRange || cmpBC(selRange.start, selRange.end) !== 0 || caretGeom?.caret) return
    const ed = containerRef.current?.querySelector('[role="textbox"]')
    if (document.activeElement !== ed) return
    const { blockIdx, charIdx } = selRange.end
    const anchor = textLayout.lineAnchors.find((line) =>
      line.blockIdx === blockIdx && charIdx >= line.startCharIdx && charIdx <= line.endCharIdx,
    )
    const state = useStudio.getState()
    if (anchor && anchor.page !== sub && state.focusedTextId === el.id) {
      state.setView({ ...state.view, sub: anchor.page }, true)
    }
  }, [caretGeom, textLayout.lineAnchors, el.id, focused, mode, selRange, sub])

  const commitProps = React.useCallback(
    (patch: Record<string, unknown>, coalesce?: string) => {
      studio.setProps(el.id, patch, coalesce)
    },
    [el.id],
  )

  const handleImportFiles = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    try {
      const r = await importFile(file)
      if (r.kind === 'document') {
        const html = normalizeEditorHtml(toVisualHtml(r.data.content, r.data.format as FlowFormat))
        commitProps({ text: html, format: 'html' })
        setMode('visual')
        if (r.data.warnings?.length) toast.warning(file.name, { description: r.data.warnings.join('；') })
        else toast.success(`已导入 ${file.name}`)
      } else if (r.kind === 'text') {
        const html = normalizeEditorHtml(plainToHtml(r.data.text))
        commitProps({ text: html, format: 'html' })
        setMode('visual')
        toast.success(`已导入 ${file.name}`)
      } else {
        toast.error('请选择 .md / .docx / .html / .txt 文件')
      }
    } catch (err) {
      toast.error(`导入失败：${file.name}`, { description: errorMessage(err) })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const editorW = width
  const maxToolbarW = Math.max(220, v.width - 24)
  const toolbarW = Math.min(maxToolbarW, Math.max(editorW, 480))
  const toolbarLeft = Math.max(12 - left, Math.min(0, v.width - 12 - left - toolbarW))
  const toolbarBelow = top < 88

  const toLocalMm = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const canvasX = clientX - rect.left + left
    const canvasY = clientY - rect.top + top
    return {
      x: (canvasX - v.panX) / v.zoom - ox,
      y: (canvasY - v.panY) / v.zoom - oy,
    }
  }

  const handleEditorPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const st = useStudio.getState()
    if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
    if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)

    if (mode !== 'visual' || e.button !== 0) return
    const ed = containerRef.current?.querySelector('[role="textbox"]') as HTMLElement | null
    if (!ed || (e.target as HTMLElement).closest('button, input, textarea')) return

    e.preventDefault()
    ed.focus({ preventScroll: true })
    const pt = toLocalMm(e.clientX, e.clientY)
    const { bc, anchor, atom } = hitTestBlockChar(pt.x, pt.y, pageCharBoxes, pageLineAnchors)

    if (atom && !e.shiftKey) {
      const start = { blockIdx: atom.blockIdx, charIdx: atom.charIdx }
      const end = { blockIdx: atom.blockIdx, charIdx: atom.endCharIdx ?? atom.charIdx + 1 }
      dragAnchorRef.current = start
      setDomSelectionRange(ed, start, end)
      setSelRange({ start, end })
      return
    }
    if (e.detail >= 2 && anchor) {
      const startBC: BlockChar = { blockIdx: anchor.blockIdx, charIdx: anchor.startCharIdx }
      const endBC: BlockChar = { blockIdx: anchor.blockIdx, charIdx: anchor.endCharIdx }
      dragAnchorRef.current = startBC
      setDomSelectionRange(ed, startBC, endBC)
      setSelRange({ start: startBC, end: endBC })
      return
    }

    const anchorBC = e.shiftKey && dragAnchorRef.current ? dragAnchorRef.current : bc
    dragAnchorRef.current = anchorBC
    setDomSelectionRange(ed, anchorBC, bc)
    setSelRange({ start: anchorBC, end: bc })

    const onMove = (me: PointerEvent) => {
      const mPt = toLocalMm(me.clientX, me.clientY)
      const { bc: moveBC } = hitTestBlockChar(mPt.x, mPt.y, pageCharBoxes, pageLineAnchors)
      setDomSelectionRange(ed, anchorBC, moveBC)
      setSelRange({ start: anchorBC, end: moveBC })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <>
      <MoveHandle el={el} left={left} top={top} width={editorW} maxRight={v.width} onStartMove={onStartMove} />
      <div
        ref={containerRef}
        data-inline-editor={el.id}
        data-page-sub={sub}
        className={cn('studio-page-editor pointer-events-auto absolute select-text', focused ? 'z-20' : 'z-10')}
        style={{
          left,
          top,
          width: editorW,
          height,
        }}
        onPointerDown={handleEditorPointerDown}
        onInput={() => requestAnimationFrame(syncSelection)}
        onKeyUp={() => syncSelection()}
        onFocus={() => {
          const st = useStudio.getState()
          if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
          if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
          requestAnimationFrame(syncSelection)
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setSelRange(null)
            if (useStudio.getState().focusedTextId === el.id) {
              useStudio.getState().setFocusedTextId(null)
            }
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (mode !== 'visual') return
          const pt = toLocalMm(e.clientX, e.clientY)
          if (!hitTestBlockChar(pt.x, pt.y, pageCharBoxes, pageLineAnchors).atom) return
          const ed = containerRef.current?.querySelector('[role="textbox"]')
          ed?.dispatchEvent(new CustomEvent(EDIT_SELECTED_FORMULA_EVENT, { detail: { x: e.clientX, y: e.clientY } }))
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.docx,.html,.htm,.txt"
          className="hidden"
          onChange={(e) => void handleImportFiles(e.currentTarget.files)}
        />
        <WysiwygSurface
          elId={el.id}
          mode={mode}
          fmt={fmt}
          text={text}
          editorDocument={el.props.editor_document}
          compact
          showModeToggle
          onModeChange={setMode}
          onImportClick={() => fileRef.current?.click()}
          onToolbarPointerDown={(e) => e.stopPropagation()}
          toolbarClassName={focused ? 'mat-thin bg-bg-elevated/95 shadow-lg backdrop-blur-md' : 'hidden'}
          toolbarStyle={{
            position: 'absolute',
            ...(toolbarBelow ? { top: '100%', marginTop: 6 } : { bottom: '100%', marginBottom: 6 }),
            left: toolbarLeft,
            width: toolbarW,
            maxWidth: maxToolbarW,
            zIndex: 30,
          }}
          wrapperClassName={cn(
            '!min-h-0 !overflow-clip !shadow-none',
            mode === 'visual' && 'studio-transparent-text',
            mode === 'source'
              ? 'bg-bg-elevated/92 ring-2 ring-accent'
              : focused
                ? '!bg-transparent ring-1 ring-accent/55'
                : '!bg-transparent !ring-0',
          )}
          wrapperStyle={{
            height,
            maxHeight: height,
            paddingTop: 0,
            paddingBottom: 0,
          }}
          editorClassName="studio-ruled-editor"
          editorStyle={
            {
              fontSize,
              lineHeight: `${lineH}px`,
              letterSpacing: `${(el.props.char_space ?? 0) * v.zoom}px`,
              textAlign,
              ...ruledVars,
              ...(mode === 'visual'
                ? {
                    color: 'transparent',
                    background: 'transparent',
                    caretColor: 'transparent',
                    opacity: 0,
                  }
                : {
                    color: 'rgb(var(--ink))',
                  }),
            } as React.CSSProperties
          }
          onCommit={(nextText, nextFmt, coalesce) =>
            commitProps({ text: nextText, format: nextFmt }, coalesce ? 'text' : undefined)
          }
        />
      </div>
      {focused && mode === 'visual' && caretGeom ? (
        <>
          {caretGeom.rects.map((r, idx) => (
            <div
              key={idx}
              aria-hidden
              className="pointer-events-none absolute z-20 rounded-[1px] bg-accent/25"
              style={{
                left: sx(v, r.x + ox),
                top: sy(v, r.y + oy),
                width: r.w * v.zoom,
                height: r.h * v.zoom,
              }}
            />
          ))}
          {caretGeom.caret ? (
            <div
              aria-hidden
              className="pointer-events-none absolute z-20 w-[1.5px] bg-accent"
              style={{
                left: sx(v, caretGeom.caret.x + ox),
                top: sy(v, caretGeom.caret.y + oy),
                height: caretGeom.caret.h * v.zoom,
                animation: 'studio-caret-blink 1s infinite',
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  )
}

function TextDirectEditor({
  el,
  paper,
  v,
  focused,
  onStartMove,
}: {
  el: TextElement
  paper: PaperBase
  v: Viewport
  focused: boolean
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const dragAnchorRef = React.useRef<number | null>(null)
  const [selPos, setSelPos] = React.useState<{ start: number; end: number } | null>(null)
  const glyphVersion = useGlyphCache((s) => s.version)
  const doc = useStudio((s) => s.doc)

  const lineHeight = el.props.size_mm * el.props.line_height * v.zoom
  const fontSize = Math.max(6, el.props.size_mm * v.zoom * 0.78)
  const align = ALIGN_CSS[el.props.align] ?? 'left'
  const ox = el.transform.x
  const oy = el.transform.y
  const left = sx(v, ox)
  const top = sy(v, oy)
  const width = Math.max(80, (el.props.box?.w ?? 80) * v.zoom)
  const height = Math.max(28, (el.props.box?.h ?? el.props.size_mm * el.props.line_height * Math.max(1, el.props.text.split('\n').length)) * v.zoom)

  const clientText = React.useMemo(() => {
    void glyphVersion
    return resolveTextRender(el, paper, doc ? variableValues(doc) : {}, 0)
  }, [el, paper, doc, glyphVersion])

  const syncTaSelection = React.useCallback(() => {
    const ta = taRef.current
    if (!ta || document.activeElement !== ta) return
    setSelPos({ start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 })
  }, [])

  React.useEffect(() => {
    if (!focused) {
      setSelPos(null)
      return
    }
    syncTaSelection()
    const onSelChange = () => syncTaSelection()
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
  }, [focused, syncTaSelection, el.props.text])

  const caretGeom = React.useMemo(() => {
    if (!focused || !selPos) return null
    return computeCaretAndSelection(
      { blockIdx: 0, charIdx: selPos.start },
      { blockIdx: 0, charIdx: selPos.end },
      clientText.charBoxes,
      clientText.lineAnchors,
    )
  }, [focused, selPos, clientText.charBoxes, clientText.lineAnchors])

  const toLocalMm = (clientX: number, clientY: number) => {
    const rect = taRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left) / v.zoom,
      y: (clientY - rect.top) / v.zoom,
    }
  }

  return (
    <>
      <MoveHandle el={el} left={left} top={top} width={width} maxRight={v.width} onStartMove={onStartMove} />
      <div
        data-inline-editor={el.id}
        className={cn('pointer-events-auto absolute', focused ? 'z-20' : 'z-10')}
        style={{
          left,
          top,
          width,
          height,
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          const st = useStudio.getState()
          if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
          if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <textarea
          ref={taRef}
          role="textbox"
          aria-multiline="true"
          aria-label="文本框内容"
          spellCheck={false}
          value={el.props.text}
          onPointerDown={(e) => {
            e.stopPropagation()
            const st = useStudio.getState()
            if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
            if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
            if (e.button !== 0 || !taRef.current) return
            e.preventDefault()
            const ta = taRef.current
            ta.focus({ preventScroll: true })
            const pt = toLocalMm(e.clientX, e.clientY)
            const { bc, anchor } = hitTestBlockChar(pt.x, pt.y, clientText.charBoxes, clientText.lineAnchors)
            if (e.detail >= 2 && anchor) {
              dragAnchorRef.current = anchor.startCharIdx
              ta.setSelectionRange(anchor.startCharIdx, anchor.endCharIdx)
              setSelPos({ start: anchor.startCharIdx, end: anchor.endCharIdx })
              return
            }
            const anchorIdx = e.shiftKey && dragAnchorRef.current !== null ? dragAnchorRef.current : bc.charIdx
            dragAnchorRef.current = anchorIdx
            const lo = Math.min(anchorIdx, bc.charIdx)
            const hi = Math.max(anchorIdx, bc.charIdx)
            ta.setSelectionRange(lo, hi, bc.charIdx < anchorIdx ? 'backward' : 'forward')
            setSelPos({ start: anchorIdx, end: bc.charIdx })

            const onMove = (me: PointerEvent) => {
              const mPt = toLocalMm(me.clientX, me.clientY)
              const { bc: moveBC } = hitTestBlockChar(mPt.x, mPt.y, clientText.charBoxes, clientText.lineAnchors)
              const mLo = Math.min(anchorIdx, moveBC.charIdx)
              const mHi = Math.max(anchorIdx, moveBC.charIdx)
              ta.setSelectionRange(mLo, mHi, moveBC.charIdx < anchorIdx ? 'backward' : 'forward')
              setSelPos({ start: anchorIdx, end: moveBC.charIdx })
            }
            const onUp = () => {
              window.removeEventListener('pointermove', onMove)
              window.removeEventListener('pointerup', onUp)
            }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
          }}
          onFocus={() => {
            const st = useStudio.getState()
            if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
            if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
            requestAnimationFrame(syncTaSelection)
          }}
          onBlur={() => {
            setSelPos(null)
            if (useStudio.getState().focusedTextId === el.id) {
              useStudio.getState().setFocusedTextId(null)
            }
          }}
          onChange={(e) => {
            studio.setProps(el.id, { text: e.currentTarget.value }, 'text')
            requestAnimationFrame(syncTaSelection)
          }}
          onKeyUp={() => syncTaSelection()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              e.currentTarget.blur()
              useStudio.getState().setFocusedTextId(null)
              ;(document.querySelector('[data-studio-canvas]') as HTMLElement | null)?.focus({ preventScroll: true })
            }
          }}
          className={cn(
            'studio-transparent-text h-full w-full resize-none overflow-hidden rounded-sm bg-transparent p-0 outline-none',
            focused ? 'ring-1 ring-accent/55' : 'ring-0',
          )}
          style={{
            fontSize,
            lineHeight: `${lineHeight}px`,
            padding: 0,
            textAlign: align,
            color: 'transparent',
            background: 'transparent',
            caretColor: 'transparent',
          }}
        />
      </div>
      {focused && caretGeom ? (
        <>
          {caretGeom.rects.map((r, idx) => (
            <div
              key={idx}
              aria-hidden
              className="pointer-events-none absolute z-20 rounded-[1px] bg-accent/25"
              style={{
                left: sx(v, r.x + ox),
                top: sy(v, r.y + oy),
                width: r.w * v.zoom,
                height: r.h * v.zoom,
              }}
            />
          ))}
          {caretGeom.caret ? (
            <div
              aria-hidden
              className="pointer-events-none absolute z-20 w-[1.5px] bg-accent"
              style={{
                left: sx(v, caretGeom.caret.x + ox),
                top: sy(v, caretGeom.caret.y + oy),
                height: caretGeom.caret.h * v.zoom,
                animation: 'studio-caret-blink 1s infinite',
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  )
}
