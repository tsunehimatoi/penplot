/**
 * Client-side millisecond-level 1:1 single-stroke layout engine.
 * Mirrors `penplot/rich_layout.py` and `penplot/compose.py` math, pagination,
 * alignment, blank lines, and deterministic handwriting jitter.
 */
import type {
  FlowTextElement,
  FontMixEntry,
  FontRoles,
  Jitter,
  PaperBase,
  RichStyle,
  TextElement,
} from '@/api/studio'
import { markdownToHtml } from '@/lib/html-to-md'
import { pickFontForChar } from './glyph-cache'
import { boxLineNum, effectiveLayoutBoxes, NO_JITTER } from './model'

export interface CharBox {
  blockIdx: number
  charIdx: number
  page: number
  boxIdx: number
  x: number
  y: number
  w: number
  h: number
}

export interface LineAnchor {
  blockIdx: number
  page: number
  boxIdx: number
  x: number
  y: number
  h: number
  endX: number
  startCharIdx: number
  endCharIdx: number
}

export interface ClientRenderedPage {
  d: string
  bbox: [number, number, number, number] | null
  strokes: number
}

export interface ClientFlowLayoutResult {
  pages: ClientRenderedPage[]
  missing: string[]
  overflow: boolean
  charBoxes: CharBox[]
  lineAnchors: LineAnchor[]
}

export interface ClientTextLayoutResult {
  d: string
  bbox: [number, number, number, number] | null
  strokes: number
  missing: string[]
  overflow: boolean
  charBoxes: CharBox[]
  lineAnchors: LineAnchor[]
}

const NO_LINE_START = new Set([
  ',', '，', ';', '；', '.', '。', '!', '！', '?', '？', '>', '》',
  '}', ']', '】', ')', '）', '、', '…', '"', '°', '%', '：', ':', '\n',
])

const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g

export function substituteVars(text: string, vars: Record<string, string>): string {
  if (!text || !text.includes('{{')) return text
  return text.replace(VAR_RE, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** Returns true only when text actually uses backend-only rich features (LaTeX math, charts, or inline SVG). */
export function needsBackendRich(el: FlowTextElement | TextElement, vars: Record<string, string>): boolean {
  if (el.type !== 'flow_text') return false
  const text = substituteVars(el.props.text ?? '', vars)
  if (!text) return false
  if (text.includes('$$') || /\$[^$\n]+\$/.test(text)) return true
  if (text.includes('\\(') || text.includes('\\[')) return true
  if (text.includes('language-chart') || text.includes('```chart')) return true
  if (/<svg[\s>]/i.test(text)) return true
  return false
}

// ------------------------------------------------------------------ Deterministic PRNG (CPython 3 MT19937)

const utf8Encoder = new TextEncoder()

export function crc32Utf8(str: string): number {
  const bytes = utf8Encoder.encode(str)
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Bit-for-bit CPython 3 `random.Random(int_seed)` MT19937 implementation
 * (`init_by_array` + `genrand_res53`).
 */
export function makeRng(seed: number): () => number {
  const N = 624
  const M = 397
  const mt = new Uint32Array(N)
  let mti = N + 1

  const initGenrand = (s: number) => {
    mt[0] = s >>> 0
    for (mti = 1; mti < N; mti++) {
      const prev = mt[mti - 1] ^ (mt[mti - 1] >>> 30)
      mt[mti] = (Math.imul(1812433253, prev) + mti) >>> 0
    }
  }

  const initByArray = (initKey: number[]) => {
    initGenrand(19650218)
    let i = 1
    let j = 0
    let k = N > initKey.length ? N : initKey.length
    for (; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30)
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + initKey[j] + j) >>> 0
      i++
      j++
      if (i >= N) {
        mt[0] = mt[N - 1]
        i = 1
      }
      if (j >= initKey.length) j = 0
    }
    for (k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30)
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0
      i++
      if (i >= N) {
        mt[0] = mt[N - 1]
        i = 1
      }
    }
    mt[0] = 0x80000000
  }

  let absN = Math.abs(Math.trunc(seed))
  const key: number[] = []
  if (absN === 0) {
    key.push(0)
  } else {
    while (absN > 0) {
      key.push(absN % 0x100000000)
      absN = Math.floor(absN / 0x100000000)
    }
  }
  initByArray(key)

  const mag01 = [0, 0x9908b0df]
  const genrandInt32 = (): number => {
    let y: number
    if (mti >= N) {
      let kk = 0
      for (; kk < N - M; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff)
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff)
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0
      }
      y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff)
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0
      mti = 0
    }
    y = mt[mti++]
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18
    return y >>> 0
  }

  return () => {
    const a = genrandInt32() >>> 5
    const b = genrandInt32() >>> 6
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0)
  }
}

function randPair(pair: readonly [number, number] | number[] | undefined, rng: () => number, def = 1): number {
  if (!pair || pair.length < 2) return def
  const lo = pair[0]
  const hi = pair[1]
  return lo === hi ? lo : lo + rng() * (hi - lo)
}

// ------------------------------------------------------------------ Polyline collector (Float32Array -> SVG d + bbox)

const f2 = (v: number): string => (Math.round(v * 100) / 100).toFixed(2)

class PageCollector {
  chunks: string[] = []
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity
  strokes = 0

  addSeg(seg: Float32Array, dx: number, dy: number): void {
    const n = seg.length
    if (n < 4) return
    this.strokes += 1
    const x0 = seg[0] + dx
    const y0 = seg[1] + dy
    this.updateBounds(x0, y0)
    let s = `M${f2(x0)} ${f2(y0)}`
    for (let i = 2; i < n; i += 2) {
      const x = seg[i] + dx
      const y = seg[i + 1] + dy
      this.updateBounds(x, y)
      s += `L${f2(x)} ${f2(y)}`
    }
    this.chunks.push(s)
  }

  addLine(x1: number, y1: number, x2: number, y2: number): void {
    this.strokes += 1
    this.updateBounds(x1, y1)
    this.updateBounds(x2, y2)
    this.chunks.push(`M${f2(x1)} ${f2(y1)}L${f2(x2)} ${f2(y2)}`)
  }

  addRect(x: number, y: number, w: number, h: number): void {
    this.strokes += 1
    const x2 = x + w
    const y2 = y + h
    this.updateBounds(x, y)
    this.updateBounds(x2, y2)
    this.chunks.push(`M${f2(x)} ${f2(y)}L${f2(x2)} ${f2(y)}L${f2(x2)} ${f2(y2)}L${f2(x)} ${f2(y2)}Z`)
  }

  addCircle(cx: number, cy: number, r: number): void {
    this.strokes += 1
    let s = ''
    for (let k = 0; k <= 8; k++) {
      const a = (k * Math.PI * 2) / 8
      const px = cx + r * Math.cos(a)
      const py = cy + r * Math.sin(a)
      this.updateBounds(px, py)
      s += (k === 0 ? 'M' : 'L') + `${f2(px)} ${f2(py)}`
    }
    this.chunks.push(s)
  }

  private updateBounds(x: number, y: number): void {
    if (x < this.minX) this.minX = x
    if (y < this.minY) this.minY = y
    if (x > this.maxX) this.maxX = x
    if (y > this.maxY) this.maxY = y
  }

  finish(): ClientRenderedPage {
    const bbox: [number, number, number, number] | null =
      this.strokes > 0 && Number.isFinite(this.minX)
        ? [this.minX, this.minY, this.maxX, this.maxY]
        : null
    return {
      d: this.chunks.join(''),
      bbox,
      strokes: this.strokes,
    }
  }
}

// ------------------------------------------------------------------ Rich IR & HTML/Markdown parser

interface TextRun {
  text: string
  italic?: boolean
  underline?: boolean
  strike?: boolean
  sup?: boolean
  sub?: boolean
  code?: boolean
}

type AlignType = 'L' | 'C' | 'R' | 'D'

type RichBlock =
  | { kind: 'pagebreak' }
  | { kind: 'hr' }
  | { kind: 'heading'; level: number; align?: AlignType; runs: TextRun[] }
  | { kind: 'paragraph'; align?: AlignType; runs: TextRun[] }
  | { kind: 'quote'; blocks: RichBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: { runs: TextRun[]; children: RichBlock[] }[] }
  | { kind: 'code'; code: string }
  | { kind: 'table'; headers: TextRun[][]; rows: TextRun[][][]; aligns: AlignType[] }

function parseAlignAttr(el: Element): AlignType | undefined {
  const style = (el.getAttribute('style') ?? '').toLowerCase()
  const alignAttr = (el.getAttribute('align') ?? '').toLowerCase()
  const m = /text-align\s*:\s*(left|center|right|justify)/.exec(style)
  const val = m ? m[1] : alignAttr
  if (val === 'center') return 'C'
  if (val === 'right') return 'R'
  if (val === 'justify') return 'D'
  if (val === 'left') return 'L'
  return undefined
}

function isPageBreakElement(el: Element): boolean {
  if (el.getAttribute('data-pagebreak') === 'true') return true
  const st = (el.getAttribute('style') ?? '').toLowerCase()
  return (
    (st.includes('page-break-after') && st.includes('always'))
    || (st.includes('page-break-before') && st.includes('always'))
  )
}

function collectRuns(node: Node, style: Omit<TextRun, 'text'> = {}): TextRun[] {
  const out: TextRun[] = []
  const walk = (n: Node, cur: Omit<TextRun, 'text'>, inPre = false) => {
    if (n.nodeType === 3) {
      const raw = n.textContent ?? ''
      const txt = inPre ? raw : raw.replace(/[ \t\r\n]+/g, ' ')
      if (txt) out.push({ text: txt, ...cur })
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      out.push({ text: '\n', ...cur })
      return
    }
    const next = { ...cur }
    if (tag === 'em' || tag === 'i') next.italic = true
    if (tag === 'u') next.underline = true
    if (tag === 's' || tag === 'del' || tag === 'strike') next.strike = true
    if (tag === 'sup') next.sup = true
    if (tag === 'sub') next.sub = true
    if (tag === 'code') next.code = true
    const st = (el.getAttribute('style') ?? '').toLowerCase()
    if (st.includes('font-style') && st.includes('italic')) next.italic = true
    if (st.includes('text-decoration') && st.includes('underline')) next.underline = true
    if (st.includes('text-decoration') && st.includes('line-through')) next.strike = true

    const nextInPre = inPre || tag === 'pre'
    for (let i = 0; i < el.childNodes.length; i++) {
      walk(el.childNodes[i], next, nextInPre)
    }
  }
  walk(node, style)
  return out
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'ul', 'ol', 'pre', 'table', 'hr',
])

function parseHtmlToBlocks(html: string): RichBlock[] {
  if (typeof DOMParser === 'undefined') {
    return html.split(/\r?\n/).map((line) => ({
      kind: 'paragraph',
      runs: [{ text: line }],
    }))
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks: RichBlock[] = []

  const processChildren = (parent: Node, target: RichBlock[]) => {
    let inlineAcc: TextRun[] = []
    let hasExplicitBr = false
    const flushInline = () => {
      if (inlineAcc.length > 0) {
        const textOnly = inlineAcc.map((r) => r.text).join('')
        if (textOnly.trim().length > 0 || hasExplicitBr) {
          target.push({ kind: 'paragraph', runs: inlineAcc })
        }
        inlineAcc = []
        hasExplicitBr = false
      }
    }

    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i]
      if (node.nodeType === 3) {
        const txt = (node.textContent ?? '').replace(/[ \t\r\n]+/g, ' ')
        if (txt) inlineAcc.push({ text: txt })
        continue
      }
      if (node.nodeType !== 1) continue
      const el = node as Element
      const tag = el.tagName.toLowerCase()

      if (isPageBreakElement(el)) {
        flushInline()
        target.push({ kind: 'pagebreak' })
        continue
      }
      if (tag === 'hr') {
        flushInline()
        target.push({ kind: 'hr' })
        continue
      }
      if (/^h[1-6]$/.test(tag)) {
        flushInline()
        target.push({
          kind: 'heading',
          level: Number(tag[1]),
          align: parseAlignAttr(el),
          runs: collectRuns(el),
        })
        continue
      }
      if (tag === 'blockquote') {
        flushInline()
        const inner: RichBlock[] = []
        processChildren(el, inner)
        if (inner.length > 0) target.push({ kind: 'quote', blocks: inner })
        continue
      }
      if (tag === 'ul' || tag === 'ol') {
        flushInline()
        const ordered = tag === 'ol'
        const start = Number(el.getAttribute('start') || '1') || 1
        const items: { runs: TextRun[]; children: RichBlock[] }[] = []
        for (let j = 0; j < el.children.length; j++) {
          const li = el.children[j]
          if (li.tagName.toLowerCase() !== 'li') continue
          const runs: TextRun[] = []
          const children: RichBlock[] = []
          for (let k = 0; k < li.childNodes.length; k++) {
            const cn = li.childNodes[k]
            if (cn.nodeType === 1) {
              const ctag = (cn as Element).tagName.toLowerCase()
              if (ctag === 'ul' || ctag === 'ol') {
                processChildren(cn, children)
                continue
              }
            }
            runs.push(...collectRuns(cn))
          }
          items.push({ runs, children })
        }
        target.push({ kind: 'list', ordered, start, items })
        continue
      }
      if (tag === 'pre') {
        flushInline()
        target.push({ kind: 'code', code: (el.textContent ?? '').replace(/\n$/, '') })
        continue
      }
      if (tag === 'table') {
        flushInline()
        const headers: TextRun[][] = []
        const rows: TextRun[][][] = []
        const aligns: AlignType[] = []
        const trs = el.querySelectorAll('tr')
        trs.forEach((tr, rIdx) => {
          const cells = tr.querySelectorAll('th, td')
          const isHeaderRow = rIdx === 0 && (tr.parentElement?.tagName.toLowerCase() === 'thead' || tr.querySelector('th') !== null)
          const rowRuns: TextRun[][] = []
          cells.forEach((cell, cIdx) => {
            if (rIdx === 0) aligns[cIdx] = parseAlignAttr(cell) ?? 'L'
            rowRuns.push(collectRuns(cell))
          })
          if (isHeaderRow) {
            headers.push(...rowRuns)
          } else {
            rows.push(rowRuns)
          }
        })
        target.push({ kind: 'table', headers, rows, aligns })
        continue
      }
      if (tag === 'p' || tag === 'div') {
        flushInline()
        // Check if div wraps block elements
        let hasChildBlock = false
        for (let k = 0; k < el.children.length; k++) {
          if (BLOCK_TAGS.has(el.children[k].tagName.toLowerCase())) {
            hasChildBlock = true
            break
          }
        }
        if (tag === 'div' && hasChildBlock) {
          processChildren(el, target)
        } else {
          // Collapse trailing single <br> inside empty <p><br></p> so it occupies 1 line instead of 2
          const runs = collectRuns(el)
          const nonNl = runs.some((r) => r.text.replace(/\n/g, '').length > 0)
          const finalRuns = nonNl ? runs : [{ text: '' }]
          target.push({
            kind: 'paragraph',
            align: parseAlignAttr(el),
            runs: finalRuns,
          })
        }
        continue
      }
      // Inline element at block level
      if (tag === 'br' || el.querySelector('br') !== null) {
        hasExplicitBr = true
      }
      inlineAcc.push(...collectRuns(el))
    }
    flushInline()
  }

  processChildren(doc.body, blocks)
  return blocks.length > 0 ? blocks : [{ kind: 'paragraph', runs: [{ text: '' }] }]
}

function parseRichBlocks(text: string, format: 'plain' | 'markdown' | 'html' | undefined): RichBlock[] {
  if (!text) return [{ kind: 'paragraph', runs: [{ text: '' }] }]
  if (format === 'html') return parseHtmlToBlocks(text)
  if (format === 'markdown') {
    // Support === pagebreak in markdown just like backend parse_rich
    const parts = text.split(/^[ \t]*===[ \t]*$/m)
    if (parts.length > 1) {
      const blocks: RichBlock[] = []
      parts.forEach((part, idx) => {
        if (idx > 0) blocks.push({ kind: 'pagebreak' })
        if (part.trim()) blocks.push(...parseHtmlToBlocks(markdownToHtml(part)))
      })
      return blocks.length ? blocks : [{ kind: 'paragraph', runs: [{ text: '' }] }]
    }
    return parseHtmlToBlocks(markdownToHtml(text))
  }
  // Plain text: each line is a paragraph
  return text.split(/\r?\n/).map((line) => ({
    kind: 'paragraph',
    runs: [{ text: line }],
  }))
}

// ------------------------------------------------------------------ Glyph placement & line emitter

interface RichItem {
  segs: Float32Array[]
  /** Extra non-glyph shapes (missing box) in local line coords */
  rects?: [number, number, number, number][]
  adv: number
  step: number
  isSpace: boolean
  underline: boolean
  strike: boolean
  charIdx?: number
}

interface BoxGeom {
  leftMm: number
  topMm: number
  bodyW: number
  bodyH: number
  lineNum: number
  lineH: number
}

interface LayoutOpts {
  primaryFontId: string | null | undefined
  fontRoles?: FontRoles | null
  fontMix?: FontMixEntry[] | null
  jitter: Jitter
  rng: () => number
  textSize: number
  charSpace: number
  pageSpace: number
  missingGlyph: 'box' | 'skip'
  richStyle?: RichStyle | null
  missing: Set<string>
}

function isSpecialChar(chars: string | null | undefined, ch: string): boolean {
  return !!chars && chars.includes(ch)
}

function buildGlyphItem(
  ch: string,
  lineH: number,
  scaleMult: number,
  italic: boolean,
  underline: boolean,
  strike: boolean,
  applyJitter: boolean,
  opts: LayoutOpts,
): RichItem {
  const fs = opts.jitter
  const baseline = lineH * 0.75 * (fs.baseLine ?? 1)
  const effSize = opts.textSize * scaleMult

  const picked = pickFontForChar(ch, opts.primaryFontId, opts.fontRoles, opts.fontMix, opts.rng)
  const g = picked.glyph

  if (ch === '\t') {
    const adv = lineH * effSize * 0.6
    const pGap = opts.pageSpace * randPair(fs.randomSpace, opts.rng, 1)
    return { segs: [], adv, step: adv + opts.charSpace + pGap, isSpace: true, underline, strike }
  }

  if (g && g.segs.length > 0) {
    const jSize = applyJitter ? randPair(fs.randomFontSize, opts.rng, 1) : 1
    const jXs = applyJitter ? randPair(fs.randomXScale, opts.rng, 1) : 1
    const jYs = applyJitter ? randPair(fs.randomYScale, opts.rng, 1) : 1
    const jRot = applyJitter ? randPair(fs.randomRotate, opts.rng, 0) : 0
    const jY = applyJitter && fs.randomY ? (-fs.randomY + 2 * fs.randomY * opts.rng()) * lineH : 0

    const sc = (lineH / picked.refSize) * jSize * effSize
    const sx = sc * jXs
    const sy = sc * jYs
    const cosR = jRot ? Math.cos((jRot * Math.PI) / 180) : 1
    const sinR = jRot ? Math.sin((jRot * Math.PI) / 180) : 0

    let minX = Infinity
    let maxX = -Infinity
    const transformedSegs: Float32Array[] = new Array(g.segs.length)

    for (let sIdx = 0; sIdx < g.segs.length; sIdx++) {
      const src = g.segs[sIdx]
      const dst = new Float32Array(src.length)
      for (let i = 0; i < src.length; i += 2) {
        let x = src[i] * sx
        let y = src[i + 1] * sy
        if (jRot) {
          const rx = x * cosR - y * sinR
          const ry = x * sinR + y * cosR
          x = rx
          y = ry
        }
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        dst[i] = x
        dst[i + 1] = y
      }
      transformedSegs[sIdx] = dst
    }

    if (!Number.isFinite(minX)) {
      return { segs: [], adv: 0, step: opts.charSpace, isSpace: false, underline, strike }
    }

    let shift = minX < 0 ? -minX : 0
    let adv = g.hasAdvance && g.w > 0 ? g.w * (lineH / picked.refSize) * effSize : (maxX - minX) + Math.max(0, minX)
    if (applyJitter && isSpecialChar(fs.chars, ch)) {
      shift += fs.widthAdd ?? 0
      adv += shift
    }
    const yOff = baseline + jY
    for (let sIdx = 0; sIdx < transformedSegs.length; sIdx++) {
      const dst = transformedSegs[sIdx]
      for (let i = 0; i < dst.length; i += 2) {
        const x = dst[i] + shift
        const y = dst[i + 1] + yOff
        dst[i] = italic ? x - 0.22 * (y - baseline) : x
        dst[i + 1] = y
      }
    }

    const pGap = opts.pageSpace * randPair(fs.randomSpace, opts.rng, 1)
    return {
      segs: transformedSegs,
      adv,
      step: adv + opts.charSpace + pGap,
      isSpace: ch === ' ',
      underline,
      strike,
    }
  }

  // Space or glyph with advance only
  if (g && g.w > 0) {
    const adv = g.w * (lineH / picked.refSize) * effSize
    const pGap = opts.pageSpace * randPair(fs.randomSpace, opts.rng, 1)
    return { segs: [], adv, step: adv + opts.charSpace + pGap, isSpace: ch === ' ', underline, strike }
  }

  if (ch === ' ') {
    const adv = lineH * effSize * 0.3
    const pGap = opts.pageSpace * randPair(fs.randomSpace, opts.rng, 1)
    return { segs: [], adv, step: adv + opts.charSpace + pGap, isSpace: true, underline, strike }
  }

  if (picked.pending) {
    // Still loading from /fonts/{id}/glyphs — reserve approximate width without flagging missing_glyph
    const code = ch.codePointAt(0) ?? 0
    const adv = lineH * effSize * (code > 0x2e7f ? 0.85 : 0.45)
    const pGap = opts.pageSpace * randPair(fs.randomSpace, opts.rng, 1)
    return { segs: [], adv, step: adv + opts.charSpace + pGap, isSpace: false, underline, strike }
  }

  // Confirmed missing glyph
  opts.missing.add(ch)
  const adv = lineH * effSize * 0.3
  const pGap = opts.pageSpace * randPair(fs.randomSpace, opts.rng, 1)
  if (opts.missingGlyph === 'skip') {
    return { segs: [], adv, step: adv + opts.charSpace + pGap, isSpace: false, underline, strike }
  }
  return {
    segs: [],
    rects: [[0, baseline - lineH * effSize * 0.7, adv, lineH * effSize * 0.75]],
    adv,
    step: adv + opts.charSpace + pGap,
    isSpace: false,
    underline,
    strike,
  }
}

function buildCharRunItem(ch: string, run: TextRun, lineH: number, scaleMult: number, opts: LayoutOpts): RichItem {
  const sc = scaleMult * (run.sup || run.sub ? 0.68 : 1.0)
  const yShift = run.sup ? -lineH * 0.22 : run.sub ? lineH * 0.16 : 0
  const item = buildGlyphItem(ch, lineH, sc, !!run.italic, !!run.underline, !!run.strike, true, opts)
  if (yShift) {
    for (const seg of item.segs) {
      for (let i = 1; i < seg.length; i += 2) seg[i] += yShift
    }
    if (item.rects) {
      for (const r of item.rects) r[1] += yShift
    }
  }
  return item
}

interface EmitGeomOut {
  charBoxes: CharBox[]
  lineAnchors: LineAnchor[]
  blockIdx: number
  page: number
  boxIdx: number
  startCharIdx: number
  endCharIdx: number
  anchorY?: number
  anchorH?: number
}

function emitLineItems(
  collector: PageCollector,
  items: RichItem[],
  xStart: number,
  availW: number,
  yTop: number,
  lineH: number,
  align: AlignType,
  scaleMult: number,
  opts: LayoutOpts,
  geomOut?: EmitGeomOut,
): void {
  let contentW = 0
  for (const it of items) contentW += it.step
  let off = 0
  if (align === 'R') off = Math.max(0, availW - contentW)
  else if (align === 'C') off = Math.max(0, (availW - contentW) * 0.5)

  let extra = 0
  if (align === 'D' && items.length > 1) {
    let nonZero = 0
    for (const it of items) {
      if (!it.isSpace && it.adv > 0) nonZero++
    }
    if (nonZero > 1) extra = Math.max(0, (availW - contentW) / (nonZero - 1))
  }

  const baselineY = yTop + lineH * 0.75 * (opts.jitter.baseLine ?? 1)
  let rel = 0
  for (const it of items) {
    const x = xStart + off + rel
    for (const seg of it.segs) collector.addSeg(seg, x, yTop)
    if (it.rects) {
      for (const r of it.rects) collector.addRect(x + r[0], yTop + r[1], r[2], r[3])
    }
    if (it.underline && it.adv > 0) {
      const uy = baselineY + lineH * opts.textSize * scaleMult * 0.14
      collector.addLine(x, uy, x + it.step, uy)
    }
    if (it.strike && it.adv > 0) {
      const sy = baselineY - lineH * opts.textSize * scaleMult * 0.28
      collector.addLine(x, sy, x + it.step, sy)
    }
    const stepW = it.step + extra
    if (geomOut && it.charIdx !== undefined) {
      geomOut.charBoxes.push({
        blockIdx: geomOut.blockIdx,
        charIdx: it.charIdx,
        page: geomOut.page,
        boxIdx: geomOut.boxIdx,
        x,
        y: geomOut.anchorY ?? yTop,
        w: stepW,
        h: geomOut.anchorH ?? lineH,
      })
    }
    rel += stepW
  }
  if (geomOut) {
    geomOut.lineAnchors.push({
      blockIdx: geomOut.blockIdx,
      page: geomOut.page,
      boxIdx: geomOut.boxIdx,
      x: xStart + off,
      y: geomOut.anchorY ?? yTop,
      h: geomOut.anchorH ?? lineH,
      endX: xStart + off + rel,
      startCharIdx: geomOut.startCharIdx,
      endCharIdx: geomOut.endCharIdx,
    })
  }
}

function drawPlainString(
  collector: PageCollector,
  text: string,
  xMm: number,
  baselineYMm: number,
  fontHMm: number,
  align: AlignType,
  opts: LayoutOpts,
): void {
  const virtLh = fontHMm / Math.max(0.2, opts.textSize)
  const items: RichItem[] = []
  let totalW = 0
  for (const ch of text) {
    const it = buildGlyphItem(ch, virtLh, 1.0, false, false, false, false, opts)
    items.push(it)
    totalW += it.adv + opts.charSpace
  }
  if (items.length > 0) totalW -= opts.charSpace
  let curX = xMm
  if (align === 'C') curX = xMm - totalW * 0.5
  else if (align === 'R') curX = xMm - totalW
  const dy = baselineYMm - virtLh * 0.75 * (opts.jitter.baseLine ?? 1)
  for (const it of items) {
    for (const seg of it.segs) collector.addSeg(seg, curX, dy)
    curX += it.adv + opts.charSpace
  }
}

// ------------------------------------------------------------------ FlowText layout engine

export function layoutFlowStrokes(
  el: FlowTextElement,
  paper: PaperBase,
  vars: Record<string, string>,
): ClientFlowLayoutResult {
  const pr = el.props
  const rawText = substituteVars(pr.text ?? '', vars)
  const seed = pr.seed != null ? Math.trunc(pr.seed) : crc32Utf8(el.id)
  const rng = makeRng(seed)

  const jitter: Jitter = { ...NO_JITTER, ...(pr.jitter ?? {}) }
  const rs: Partial<RichStyle> = pr.rich_style ?? {}
  const headingScale = Number(rs.heading_scale ?? 1.35) || 1.35
  const tableHeaderRepeat = rs.table_header_repeat ?? true
  const tableHlines = rs.table_hlines ?? false
  const codeBox = rs.code_box ?? true

  const opts: LayoutOpts = {
    primaryFontId: pr.font_id,
    fontRoles: pr.font_roles,
    fontMix: pr.font_mix,
    jitter,
    rng,
    textSize: Number(pr.text_size ?? 1.0) || 1.0,
    charSpace: Number(pr.char_space ?? 0.0) || 0.0,
    pageSpace: 1.0,
    missingGlyph: pr.missing_glyph ?? 'box',
    richStyle: pr.rich_style,
    missing: new Set(),
  }

  const rawBoxes = effectiveLayoutBoxes(paper)
  const boxes: BoxGeom[] = rawBoxes.map((b) => {
    const ln = boxLineNum(paper, b, pr.line_num)
    return {
      leftMm: b.x_mm,
      topMm: b.y_mm,
      bodyW: Math.max(10, b.w_mm),
      bodyH: Math.max(10, b.h_mm),
      lineNum: ln,
      lineH: Math.max(1, b.h_mm) / ln,
    }
  })

  const pages: PageCollector[] = [new PageCollector()]
  let curPage = pages[0]
  let curPageIdx = 0
  let boxIdx = 0
  let lineIdx = 0
  const charBoxes: CharBox[] = []
  const lineAnchors: LineAnchor[] = []

  const curBox = () => boxes[boxIdx]

  const newPage = () => {
    curPage = new PageCollector()
    pages.push(curPage)
    curPageIdx = pages.length - 1
    boxIdx = 0
    lineIdx = 0
  }

  const nextBox = () => {
    if (boxIdx + 1 < boxes.length) {
      boxIdx += 1
      lineIdx = 0
    } else {
      newPage()
    }
  }

  const ensureLines = (needed: number) => {
    if (lineIdx > 0 && lineIdx + needed > curBox().lineNum) {
      nextBox()
    }
  }

  const advanceLines = (count = 1) => {
    lineIdx += count
    if (lineIdx >= curBox().lineNum) nextBox()
  }

  const lineY = (li = lineIdx) => curBox().topMm + li * curBox().lineH

  const para = pr.paragraph ?? { spe_type: 0, spe_value: 0, left: 0, right: 0 }
  const fmtLeft = Number(para.left ?? 0) || 0
  const fmtRight = Number(para.right ?? 0) || 0
  const speType = Number(para.spe_type ?? 0) || 0
  const speValue = Number(para.spe_value ?? 0) || 0
  const defaultAlign: AlignType = pr.align ?? 'L'

  const boxFrame = (indentLeft = 0): [number, number] => {
    const b = curBox()
    const baseLeft = b.leftMm + fmtLeft + indentLeft
    const avail = Math.max(Math.min(10, b.bodyW), b.bodyW - fmtLeft - indentLeft - fmtRight)
    return [baseLeft, avail]
  }

  const drawQuoteBars = (depth: number, yTop: number, lines: number) => {
    const b = curBox()
    for (let d = 0; d < depth; d++) {
      const bx = b.leftMm + d * 5.0 + 1.5
      curPage.addLine(bx, yTop + 0.4, bx, yTop + lines * b.lineH - 0.4)
    }
  }

  const layoutRuns = (
    runs: TextRun[],
    scaleMult: number,
    prepareLine: (li: number) => [number, number],
    emitLine: (li: number, items: RichItem[], startCharIdx: number, endCharIdx: number) => void,
    charCursor: { val: number },
  ) => {
    let runIdx = 0
    let charIdx = 0
    let li = 0
    let emittedAny = false
    let pending: { ch: string; run: TextRun; item: RichItem; builtLh: number } | null = null

    const advanceCursor = () => {
      while (runIdx < runs.length) {
        const r = runs[runIdx]
        if (charIdx < r.text.length) {
          if (r.text[charIdx] === '\r') {
            charIdx++
            continue
          }
          return
        }
        runIdx++
        charIdx = 0
      }
    }

    advanceCursor()
    while (runIdx < runs.length || pending !== null) {
      const [avail, curLh] = prepareLine(li)
      const cur: RichItem[] = []
      let curW = 0
      let lineStartChar = charCursor.val

      if (pending !== null) {
        let item = pending.item
        const prevCharIdx = item.charIdx
        if (pending.builtLh !== curLh) {
          item = buildCharRunItem(pending.ch, pending.run, curLh, scaleMult, opts)
          item.charIdx = prevCharIdx
        }
        pending = null
        if (item.charIdx !== undefined) lineStartChar = item.charIdx
        cur.push(item)
        curW += item.step
      }

      let lineClosed = false
      while (runIdx < runs.length && !lineClosed) {
        const run = runs[runIdx]
        const text = run.text
        while (charIdx < text.length) {
          const ch = text[charIdx]
          charIdx++
          if (ch === '\r') continue
          if (ch === '\n') {
            const lineEndChar = charCursor.val
            charCursor.val++
            advanceCursor()
            emitLine(li, cur, lineStartChar, lineEndChar)
            li++
            emittedAny = true
            lineClosed = true
            break
          }
          const item = buildCharRunItem(ch, run, curLh, scaleMult, opts)
          const thisCharIdx = charCursor.val++
          item.charIdx = thisCharIdx
          if (cur.length > 0 && curW + item.adv > avail && !NO_LINE_START.has(ch)) {
            advanceCursor()
            emitLine(li, cur, lineStartChar, thisCharIdx)
            li++
            emittedAny = true
            pending = { ch, run, item, builtLh: curLh }
            lineClosed = true
            break
          }
          cur.push(item)
          curW += item.step
        }
        if (!lineClosed) advanceCursor()
      }

      if (!lineClosed) {
        if (cur.length > 0 || !emittedAny) {
          emitLine(li, cur, lineStartChar, charCursor.val)
          li++
          emittedAny = true
        }
      }
    }

    if (!emittedAny) {
      prepareLine(0)
      emitLine(0, [], charCursor.val, charCursor.val)
    }
  }

  const runsToWrappedLines = (
    runs: TextRun[],
    avail: number,
    lineH: number,
    scaleMult: number,
    charCursor?: { val: number },
  ): { items: RichItem[]; startCharIdx: number; endCharIdx: number }[] => {
    const lines: { items: RichItem[]; startCharIdx: number; endCharIdx: number }[] = []
    let cur: RichItem[] = []
    let curW = 0
    let lineStart = charCursor?.val ?? 0
    for (const run of runs) {
      for (const ch of run.text) {
        if (ch === '\r') continue
        if (ch === '\n') {
          const lineEnd = charCursor ? charCursor.val++ : 0
          lines.push({ items: cur, startCharIdx: lineStart, endCharIdx: lineEnd })
          cur = []
          curW = 0
          lineStart = charCursor?.val ?? 0
          continue
        }
        const item = buildCharRunItem(ch, run, lineH, scaleMult, opts)
        const thisIdx = charCursor ? (charCursor.val += ch.length, charCursor.val - ch.length) : undefined
        item.charIdx = thisIdx
        if (cur.length > 0 && curW + item.adv > avail && !NO_LINE_START.has(ch)) {
          const wrapEnd = thisIdx ?? 0
          lines.push({ items: cur, startCharIdx: lineStart, endCharIdx: wrapEnd })
          cur = []
          curW = 0
          lineStart = wrapEnd
        }
        cur.push(item)
        curW += item.step
      }
    }
    if (cur.length > 0 || lines.length === 0) {
      lines.push({ items: cur, startCharIdx: lineStart, endCharIdx: charCursor?.val ?? 0 })
    }
    return lines
  }

  const layoutBlocks = (
    blocks: RichBlock[],
    indentLeft = 0,
    quoteDepth = 0,
    parentBlockIdx?: number,
    parentCharCursor?: { val: number },
  ) => {
    for (let bi = 0; bi < blocks.length; bi++) {
      const blk = blocks[bi]
      const blkIdx = parentBlockIdx ?? bi
      const charCursor = parentCharCursor ?? { val: 0 }
      if (blk.kind === 'pagebreak') {
        if (lineIdx > 0 || boxIdx > 0 || curPage.strokes > 0) newPage()
        continue
      }
      if (blk.kind === 'hr') {
        ensureLines(1)
        const b = curBox()
        const [baseLeft] = boxFrame(indentLeft)
        lineAnchors.push({
          blockIdx: blkIdx,
          page: curPageIdx,
          boxIdx,
          x: baseLeft,
          y: lineY(),
          h: b.lineH,
          endX: baseLeft,
          startCharIdx: 0,
          endCharIdx: 0,
        })
        advanceLines(1)
        continue
      }
      if (blk.kind === 'heading') {
        const lvlFactor = Math.max(1.0, headingScale - (blk.level - 1) * 0.12)
        const align = blk.align ?? defaultAlign
        layoutRuns(
          blk.runs,
          lvlFactor,
          () => {
            const b = curBox()
            const linesPerRow = lvlFactor >= 1.3 && b.lineNum >= 2 ? 2 : 1
            ensureLines(linesPerRow)
            const [, availBase] = boxFrame(indentLeft)
            return [availBase, curBox().lineH]
          },
          (_li, wl, startCharIdx, endCharIdx) => {
            const b = curBox()
            const linesPerRow = lvlFactor >= 1.3 && b.lineNum >= 2 ? 2 : 1
            const [baseLeft, availBase] = boxFrame(indentLeft)
            const yTop = lineY()
            const yDraw = yTop + (linesPerRow - 1) * b.lineH * 0.5
            emitLineItems(curPage, wl, baseLeft, availBase, yDraw, b.lineH, align, lvlFactor, opts, {
              charBoxes,
              lineAnchors,
              blockIdx: blkIdx,
              page: curPageIdx,
              boxIdx,
              startCharIdx,
              endCharIdx,
            })
            if (quoteDepth) drawQuoteBars(quoteDepth, yTop, linesPerRow)
            advanceLines(linesPerRow)
          },
          charCursor,
        )
        continue
      }
      if (blk.kind === 'paragraph') {
        const align = blk.align ?? defaultAlign
        const spe1 = align === 'C' || align === 'R' ? 0 : speType === 1 ? speValue : 0
        const spe2 = align === 'C' || align === 'R' ? 0 : speType === 2 ? speValue : 0

        const paraGeom = (li: number) => {
          const [baseLeft, availBase] = boxFrame(indentLeft)
          const ind = li === 0 ? spe1 : spe2
          const wLine = Math.max(Math.min(8, availBase), availBase - ind)
          return [baseLeft, ind, wLine] as const
        }
        layoutRuns(
          blk.runs,
          1.0,
          (li) => {
            ensureLines(1)
            const [, , wLine] = paraGeom(li)
            return [wLine, curBox().lineH]
          },
          (li, wl, startCharIdx, endCharIdx) => {
            const [baseLeft, ind, wLine] = paraGeom(li)
            const yTop = lineY()
            emitLineItems(curPage, wl, baseLeft + ind, wLine, yTop, curBox().lineH, align, 1.0, opts, {
              charBoxes,
              lineAnchors,
              blockIdx: blkIdx,
              page: curPageIdx,
              boxIdx,
              startCharIdx,
              endCharIdx,
            })
            if (quoteDepth) drawQuoteBars(quoteDepth, yTop, 1)
            advanceLines(1)
          },
          charCursor,
        )
        continue
      }
      if (blk.kind === 'quote') {
        layoutBlocks(blk.blocks, indentLeft + 5.0, quoteDepth + 1, blkIdx, charCursor)
        continue
      }
      if (blk.kind === 'list') {
        const markerW = 5.5
        blk.items.forEach((item, idx) => {
          const prefix = blk.ordered ? `${blk.start + idx}.` : '•'
          layoutRuns(
            item.runs,
            1.0,
            () => {
              ensureLines(1)
              const [, availBase] = boxFrame(indentLeft)
              const wLine = Math.max(Math.min(8, availBase), availBase - markerW)
              return [wLine, curBox().lineH]
            },
            (li, wl, startCharIdx, endCharIdx) => {
              const [baseLeft, availBase] = boxFrame(indentLeft)
              const wLine = Math.max(Math.min(8, availBase), availBase - markerW)
              const b = curBox()
              const yTop = lineY()
              if (li === 0) {
                if (blk.ordered) {
                  drawPlainString(
                    curPage,
                    prefix,
                    baseLeft + 0.5,
                    yTop + b.lineH * 0.75 * (opts.jitter.baseLine ?? 1),
                    b.lineH * opts.textSize * 0.9,
                    'L',
                    opts,
                  )
                } else {
                  const br = Math.max(0.5, Math.min(1.0, b.lineH * 0.11))
                  curPage.addCircle(baseLeft + 2.2, yTop + b.lineH * 0.52, br)
                }
              }
              emitLineItems(curPage, wl, baseLeft + markerW, wLine, yTop, b.lineH, 'L', 1.0, opts, {
                charBoxes,
                lineAnchors,
                blockIdx: blkIdx,
                page: curPageIdx,
                boxIdx,
                startCharIdx,
                endCharIdx,
              })
              if (quoteDepth) drawQuoteBars(quoteDepth, yTop, 1)
              advanceLines(1)
            },
            charCursor,
          )
          if (item.children.length > 0) {
            layoutBlocks(item.children, indentLeft + markerW, quoteDepth, blkIdx, charCursor)
          }
        })
        continue
      }
      if (blk.kind === 'code') {
        const pad = 2.0
        const codeLines = blk.code.split('\n')
        let boxStartLine: number | null = null
        let boxLeft = 0
        let boxW = 0

        const flushCodeBox = () => {
          if (codeBox && boxStartLine !== null && lineIdx > boxStartLine) {
            const y0 = lineY(boxStartLine)
            const h = (lineIdx - boxStartLine) * curBox().lineH
            curPage.addRect(boxLeft, y0 + 0.3, boxW, Math.max(0.5, h - 0.6))
          }
          boxStartLine = null
        }

        for (let cli = 0; cli < codeLines.length; cli++) {
          const cl = codeLines[cli]
          layoutRuns(
            [{ text: cl, code: true }],
            0.88,
            () => {
              if (lineIdx >= curBox().lineNum) {
                flushCodeBox()
                nextBox()
              }
              const [baseLeft, availBase] = boxFrame(indentLeft)
              if (boxStartLine === null) {
                boxStartLine = lineIdx
                boxLeft = baseLeft
                boxW = availBase
              }
              const cw = Math.max(Math.min(8, availBase), availBase - pad * 2)
              return [cw, curBox().lineH]
            },
            (_li, wl, startCharIdx, endCharIdx) => {
              const [baseLeft, availBase] = boxFrame(indentLeft)
              const cw = Math.max(Math.min(8, availBase), availBase - pad * 2)
              const b = curBox()
              emitLineItems(curPage, wl, baseLeft + pad, cw, lineY(), b.lineH, 'L', 0.88, opts, {
                charBoxes,
                lineAnchors,
                blockIdx: blkIdx,
                page: curPageIdx,
                boxIdx,
                startCharIdx,
                endCharIdx,
              })
              lineIdx++
              if (lineIdx >= b.lineNum) {
                flushCodeBox()
                nextBox()
              }
            },
            charCursor,
          )
          if (cli + 1 < codeLines.length) charCursor.val++
        }
        flushCodeBox()
        if (lineIdx >= curBox().lineNum) nextBox()
        continue
      }
      if (blk.kind === 'table') {
        const ncols = Math.max(blk.headers.length, ...blk.rows.map((r) => r.length), 0)
        if (ncols <= 0) continue
        const padX = 1.5
        const boxTableGeom = () => {
          const [x0, availW] = boxFrame(indentLeft)
          const colW = availW / ncols
          const innerW = Math.max(4, colW - padX * 2)
          return { x0, availW, colW, innerW }
        }
        const prepareRow = (cells: TextRun[][], innerW: number, lh: number, trackCursor: boolean) =>
          Array.from({ length: ncols }, (_, ci) =>
            runsToWrappedLines(cells[ci] ?? [], innerW, lh, 0.92, trackCursor ? charCursor : undefined),
          )

        const drawRow = (
          wcols: { items: RichItem[]; startCharIdx: number; endCharIdx: number }[][],
          isHdr: boolean,
          geom: { x0: number; availW: number; colW: number; innerW: number },
          recordGeom = true,
        ) => {
          const rowLines = Math.max(1, ...wcols.map((wc) => wc.length))
          const b = curBox()
          const yRowTop = lineY()
          for (let li = 0; li < rowLines; li++) {
            const yLine = lineY()
            for (let ci = 0; ci < wcols.length; ci++) {
              const wc = wcols[ci]
              if (li < wc.length) {
                const al = blk.aligns[ci] ?? 'L'
                emitLineItems(
                  curPage,
                  wc[li].items,
                  geom.x0 + ci * geom.colW + padX,
                  geom.innerW,
                  yLine,
                  b.lineH,
                  al,
                  0.92,
                  opts,
                  recordGeom
                    ? {
                        charBoxes,
                        lineAnchors,
                        blockIdx: blkIdx,
                        page: curPageIdx,
                        boxIdx,
                        startCharIdx: wc[li].startCharIdx,
                        endCharIdx: wc[li].endCharIdx,
                      }
                    : undefined,
                )
              }
            }
            lineIdx++
          }
          const rowH = rowLines * b.lineH
          if (tableHlines) {
            curPage.addRect(geom.x0, yRowTop, geom.availW, rowH)
          } else {
            curPage.addLine(geom.x0, yRowTop, geom.x0, yRowTop + rowH)
            curPage.addLine(geom.x0 + geom.availW, yRowTop, geom.x0 + geom.availW, yRowTop + rowH)
          }
          for (let ci = 1; ci < ncols; ci++) {
            const vx = geom.x0 + ci * geom.colW
            curPage.addLine(vx, yRowTop, vx, yRowTop + rowH)
          }
          if (isHdr && tableHlines) {
            curPage.addLine(geom.x0, yRowTop + rowH - 0.35, geom.x0 + geom.availW, yRowTop + rowH - 0.35)
          }
        }

        let geom = boxTableGeom()
        let hdrWrapped = blk.headers.length > 0 ? prepareRow(blk.headers, geom.innerW, curBox().lineH, true) : null
        const rawRows: { isHdr: boolean; cells: TextRun[][] }[] = [
          ...(blk.headers.length > 0 ? [{ isHdr: true, cells: blk.headers }] : []),
          ...blk.rows.map((cells) => ({ isHdr: false, cells })),
        ]

        for (const row of rawRows) {
          let wcols = row.isHdr && hdrWrapped ? hdrWrapped : prepareRow(row.cells, geom.innerW, curBox().lineH, true)
          let needed = Math.max(1, ...wcols.map((wc) => wc.length))
          if (lineIdx > 0 && lineIdx + needed > curBox().lineNum) {
            const prev = `${curBox().bodyW}:${curBox().lineH}`
            nextBox()
            geom = boxTableGeom()
            if (`${curBox().bodyW}:${curBox().lineH}` !== prev) {
              hdrWrapped = blk.headers.length > 0 ? prepareRow(blk.headers, geom.innerW, curBox().lineH, false) : null
              wcols = row.isHdr && hdrWrapped ? hdrWrapped : prepareRow(row.cells, geom.innerW, curBox().lineH, false)
              needed = Math.max(1, ...wcols.map((wc) => wc.length))
            }
            if (!row.isHdr && hdrWrapped && tableHeaderRepeat) {
              const hNeed = Math.max(1, ...hdrWrapped.map((wc) => wc.length))
              if (lineIdx + hNeed + needed <= curBox().lineNum) {
                drawRow(hdrWrapped, true, geom, false)
              }
            }
          }
          drawRow(wcols, row.isHdr, geom, true)
          if (lineIdx >= curBox().lineNum) {
            const prev = `${curBox().bodyW}:${curBox().lineH}`
            nextBox()
            geom = boxTableGeom()
            if (`${curBox().bodyW}:${curBox().lineH}` !== prev) {
              hdrWrapped = blk.headers.length > 0 ? prepareRow(blk.headers, geom.innerW, curBox().lineH, false) : null
            }
          }
        }
      }
    }
  }

  const blocks = parseRichBlocks(rawText, pr.format)
  layoutBlocks(blocks)

  while (pages.length > 1 && pages[pages.length - 1].strokes === 0) {
    pages.pop()
  }

  return {
    pages: pages.map((p) => p.finish()),
    missing: [...opts.missing].sort(),
    overflow: false,
    charBoxes,
    lineAnchors,
  }
}

// ------------------------------------------------------------------ Free TextBox layout engine

export function layoutTextBoxStrokes(el: TextElement, vars: Record<string, string>): ClientTextLayoutResult {
  const pr = el.props
  const rawText = substituteVars(pr.text ?? '', vars)
  const size = Number(pr.size_mm ?? 8.0) || 8.0
  const lh = Number(pr.line_height ?? 1.3) || 1.3
  const pitch = size * lh
  const box = pr.box
  const availW = box?.w ? Number(box.w) : 100000
  const nlines = rawText.split('\n').length
  const maxLines = box?.w
    ? Math.max(1, Math.floor((Number(box.h || pitch * nlines)) / pitch + 1e-9))
    : Infinity

  const seed = pr.seed != null ? Math.trunc(pr.seed) : crc32Utf8(el.id)
  const rng = makeRng(seed)
  const jitter: Jitter = { ...NO_JITTER, ...(pr.jitter ?? {}) }

  const opts: LayoutOpts = {
    primaryFontId: pr.font_id,
    fontRoles: pr.font_roles,
    fontMix: pr.font_mix,
    jitter,
    rng,
    textSize: 1.0 / lh,
    charSpace: Number(pr.char_space ?? 0.0) || 0.0,
    pageSpace: 1.0,
    missingGlyph: pr.missing_glyph ?? 'box',
    missing: new Set(),
  }

  const lines: { items: RichItem[]; startCharIdx: number; endCharIdx: number }[] = []
  let cur: RichItem[] = []
  let curW = 0
  let lineStart = 0
  let rawIdx = 0

  for (const ch of rawText) {
    const chLen = ch.length
    const curIdx = rawIdx
    rawIdx += chLen
    if (ch === '\r') continue
    if (ch === '\n') {
      lines.push({ items: cur, startCharIdx: lineStart, endCharIdx: curIdx })
      cur = []
      curW = 0
      lineStart = rawIdx
      continue
    }
    const item = buildGlyphItem(ch, pitch, 1.0, false, false, false, true, opts)
    item.charIdx = curIdx
    if (cur.length > 0 && curW + item.adv > availW && !NO_LINE_START.has(ch)) {
      lines.push({ items: cur, startCharIdx: lineStart, endCharIdx: curIdx })
      cur = []
      curW = 0
      lineStart = curIdx
    }
    cur.push(item)
    curW += item.step
  }
  if (cur.length > 0 || lines.length === 0) {
    lines.push({ items: cur, startCharIdx: lineStart, endCharIdx: rawIdx })
  }

  const overflow = lines.length > maxLines
  const drawCount = Math.min(lines.length, maxLines)
  const collector = new PageCollector()
  const align: AlignType = pr.align ?? 'L'
  const emitW = box?.w ? availW : 0
  const charBoxes: CharBox[] = []
  const lineAnchors: LineAnchor[] = []

  for (let i = 0; i < drawCount; i++) {
    emitLineItems(collector, lines[i].items, 0, emitW, i * pitch, pitch, align, 1.0, opts, {
      charBoxes,
      lineAnchors,
      blockIdx: 0,
      page: 0,
      boxIdx: 0,
      startCharIdx: lines[i].startCharIdx,
      endCharIdx: lines[i].endCharIdx,
    })
  }

  const res = collector.finish()
  return {
    ...res,
    missing: [...opts.missing].sort(),
    overflow,
    charBoxes,
    lineAnchors,
  }
}

/** Unified text render resolver: uses client-side stroke engine for regular/rich text, backend for LaTeX/charts/SVG. */
export function resolveTextRender(
  el: FlowTextElement | TextElement,
  paper: PaperBase,
  vars: Record<string, string>,
  sub = 0,
): {
  d: string
  pages?: ClientRenderedPage[]
  bbox: [number, number, number, number] | null
  strokes: number
  missing: string[]
  overflow: boolean
  isBackendRich: boolean
  charBoxes: CharBox[]
  lineAnchors: LineAnchor[]
} {
  const isBackendRich = needsBackendRich(el, vars)
  if (el.type === 'flow_text') {
    const res = layoutFlowStrokes(el, paper, vars)
    const p = res.pages[sub]
    return {
      d: p?.d ?? '',
      pages: res.pages,
      bbox: p?.bbox ?? null,
      strokes: p?.strokes ?? 0,
      missing: res.missing,
      overflow: res.overflow,
      isBackendRich,
      charBoxes: res.charBoxes,
      lineAnchors: res.lineAnchors,
    }
  }
  const res = layoutTextBoxStrokes(el, vars)
  return {
    d: res.d,
    bbox: res.bbox,
    strokes: res.strokes,
    missing: res.missing,
    overflow: res.overflow,
    isBackendRich,
    charBoxes: res.charBoxes,
    lineAnchors: res.lineAnchors,
  }
}
