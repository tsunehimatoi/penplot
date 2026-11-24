import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight,
  BarChart3, Bold, Check, Code, CornerDownLeft, FileUp,
  Heading1, Heading2, Heading3, Italic, List, ListOrdered,
  Maximize2, Pilcrow, Quote, SeparatorHorizontal, Sigma,
  Sparkles, Strikethrough, Table, Underline,
} from 'lucide-react'
import * as React from 'react'
import type { FlowTextElement } from '@/api/studio'
import { importFile } from '@/api/studio'
import { errorMessage } from '@/api/client'
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  Input, Popover, PopoverAnchor, PopoverContent,
  Segmented, Textarea,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  BARE_TEX_SOURCE, DELIMITED_FORMULA_SOURCE, formulaBody, formulaHtml, htmlToMarkdown,
  isEmptyList, looksLikeMarkdown, markdownToHtml, plainToHtml, sanitizePastedHtml,
} from '@/lib/html-to-md'
import { toast } from '@/lib/toast'
import { editorDocumentHtml } from '../editor-document'
import { formulaParts, type FormulaPart } from '../formula-fields'
import { TableBorderEditor } from './table-border-editor'
import { studio, useStudio } from '../store'

export type FlowFormat = 'plain' | 'markdown' | 'html'
type SourceFormat = Exclude<FlowFormat, 'html'>
export type EditorMode = 'visual' | 'source'
export type AlignKind = 'left' | 'center' | 'right' | 'justify'
export type BlockTag = 'p' | 'h1' | 'h2' | 'h3'

export const MODE_OPTIONS: { value: EditorMode; label: string }[] = [
  { value: 'visual', label: '可视化' },
  { value: 'source', label: '源码' },
]

const SOURCE_FORMAT_OPTIONS: { value: SourceFormat; label: string }[] = [
  { value: 'markdown', label: 'MD' },
  { value: 'plain', label: 'TXT' },
]

export const FORMULA_PRESETS = [
  { label: '行内公式 $...$', md: '$E = mc^2$', block: false },
  { label: '二次求根公式', md: '$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$', block: true },
  { label: '定积分', md: '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$', block: true },
  { label: '求和级数', md: '$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$', block: true },
  { label: '矩阵', md: '$$A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$', block: true },
]

const CHART_PRESETS = [
  {
    label: '柱状图 (Bar)',
    spec: {
      type: 'bar',
      title: '季度对比',
      x: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [{ name: '系列A', data: [12, 19, 15, 24] }, { name: '系列B', data: [8, 14, 18, 20] }],
    },
  },
  {
    label: '折线图 (Line)',
    spec: {
      type: 'line',
      title: '趋势曲线',
      x: ['1月', '2月', '3月', '4月', '5月'],
      series: [{ name: '数值', data: [10, 22, 18, 30, 27] }],
    },
  },
  {
    label: '饼图 (Pie)',
    spec: {
      type: 'pie',
      title: '占比分布',
      x: ['A', 'B', 'C'],
      series: [{ data: [45, 35, 20] }],
    },
  },
  {
    label: '函数曲线 (Function)',
    spec: { type: 'function', title: 'y = sin(x)', expr: 'sin(x)', xmin: -6.28, xmax: 6.28 },
  },
]

const TOP_BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr', 'div',
])
const ALIGNABLE_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'th', 'td', 'blockquote'])
const HEADING_SWITCH_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const RICH_COMPONENT_SELECTOR = 'table, span.math-inline, div.math-display'
const FORMULA_SELECTOR = 'span.math-inline, div.math-display'
export const EDIT_SELECTED_FORMULA_EVENT = 'penplot:edit-selected-formula'
const COMPONENT_FORMULA_RE = new RegExp(
  `${DELIMITED_FORMULA_SOURCE}|${BARE_TEX_SOURCE}`, 'g',
)

function lockFormulaElements(root: ParentNode) {
  for (const node of root.querySelectorAll<HTMLElement>(FORMULA_SELECTOR)) node.contentEditable = 'false'
}

function commitTypedFormula(editor: HTMLElement) {
  const range = getSelectionInside(editor)
  const node = range?.startContainer
  if (!range?.collapsed || !(node instanceof Text) || range.startOffset !== node.length ||
      node.parentElement?.closest('pre, code, .math-inline, .math-display')) return
  const block = node.parentElement
  const display = block?.matches('p, div') && block.childNodes.length === 1
    ? /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])$/.exec(node.data.trim())
    : null
  const inline = Array.from(node.data.matchAll(new RegExp(DELIMITED_FORMULA_SOURCE, 'g'))).at(-1)
  if (!display && (!inline || inline.index + inline[0].length !== node.length)) return
  const template = editor.ownerDocument.createElement('template')
  const token = inline?.[0] ?? ''
  template.innerHTML = formulaHtml(display ? (display[1] ?? display[2]).trim() : formulaBody(token), !!display)
  const formula = template.content.firstElementChild as HTMLElement
  formula.contentEditable = 'false'
  if (display && block) {
    const next = editor.ownerDocument.createElement('p')
    next.append(editor.ownerDocument.createElement('br'))
    block.replaceWith(formula, next)
    placeCaretInsideBlock(next, true)
  } else if (inline) {
    node.deleteData(inline.index, token.length)
    node.after(formula)
    range.setStartAfter(formula)
    range.collapse(true)
    setSelectionRange(range)
  }
}

function materializeFormulas(editor: HTMLElement) {
  const doc = editor.ownerDocument
  const template = doc.createElement('template')
  for (const p of editor.querySelectorAll('p')) {
    if (p.children.length) continue
    const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])$/.exec(p.textContent?.trim() ?? '')
    if (match) {
      template.innerHTML = formulaHtml((match[1] ?? match[2]).trim(), true)
      p.replaceWith(template.content)
    }
  }
  const walker = doc.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('pre, code, .math-inline, .math-display, math, svg')) nodes.push(node as Text)
  }
  for (const node of nodes) {
    const text = node.data
    const matches = [...text.matchAll(COMPONENT_FORMULA_RE)]
    if (!matches.length) continue
    const parts = doc.createDocumentFragment()
    let position = 0
    for (const match of matches) {
      const start = match.index!
      const token = match[0]
      const latex = token.startsWith('$') || /^\\[([]/.test(token) ? formulaBody(token) : token
      parts.append(text.slice(position, start))
      template.innerHTML = formulaHtml(latex.trim(), false)
      parts.append(template.content)
      position = start + match[0].length
    }
    parts.append(text.slice(position))
    node.replaceWith(parts)
  }
  lockFormulaElements(editor)
}

export interface ActiveFormatState {
  block: string
  align: AlignKind
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  ul: boolean
  ol: boolean
  blockquote: boolean
  pre: boolean
}

export const DEFAULT_ACTIVE: ActiveFormatState = {
  block: 'p',
  align: 'left',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  ul: false,
  ol: false,
  blockquote: false,
  pre: false,
}

function richClipboardHtml(clipboard: DataTransfer, plain: string): string {
  const raw = clipboard.getData('text/html')
  if (!raw) return ''
  const html = sanitizePastedHtml(raw, { discardEmptyLists: true })
  if (!html || !plain) return html
  const hasRichFormatting =
    /<(h[1-6]|b|strong|i|em|u|ins|s|del|strike|sup|sub|ul|ol|li|table|blockquote|pre|code|svg|math|hr)\b|class="[^"]*(?:katex|math-)|text-align\s*:|data-pagebreak=/i.test(html)
  return hasRichFormatting || (/<p\b/i.test(html) && !looksLikeMarkdown(plain)) ? html : ''
}

export function toVisualHtml(text: string, format: FlowFormat): string {
  if (!text) return ''
  if (format === 'html') return sanitizePastedHtml(text)
  if (format === 'markdown') return markdownToHtml(text)
  return plainToHtml(text)
}

function sourceTextFor(text: string, from: FlowFormat, to: SourceFormat): string {
  if (from === to) return text
  const html = toVisualHtml(text, from)
  if (to === 'markdown') return htmlToMarkdown(html)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replaceAll('\u00a0', ' ')
    if (!(node instanceof Element)) return ''
    if (node.matches('br')) return '\n'
    if (node.matches('.math-inline')) return `$${node.textContent ?? ''}$`
    if (node.matches('.math-display')) return `$$${node.textContent ?? ''}$$\n`
    if (node.matches('tr')) return Array.from(node.children, (cell) => textOf(cell).trim()).join('\t') + '\n'
    const content = Array.from(node.childNodes, textOf).join('')
    return TOP_BLOCK_TAGS.has(node.localName) && !content.endsWith('\n') ? content + '\n' : content
  }
  return Array.from(doc.body.childNodes, textOf).join('').replace(/\n$/, '')
}

function isPageBreakNode(el: Element): boolean {
  if (el.getAttribute('data-pagebreak') === 'true') return true
  const st = (el.getAttribute('style') ?? '').toLowerCase()
  return (st.includes('page-break-after') && st.includes('always')) || (st.includes('page-break-before') && st.includes('always'))
}

function isInsertTab(e: React.KeyboardEvent): boolean {
  return e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
}

function isBlockElement(node: Node | null): node is HTMLElement {
  return !!node && node.nodeType === Node.ELEMENT_NODE && TOP_BLOCK_TAGS.has((node as Element).tagName.toLowerCase())
}

function isEmptyBlockNode(el: Element): boolean {
  if (el.querySelector('svg, math, [data-chart], [data-pagebreak], table, pre, hr, ul, ol')) return false
  return (el.textContent ?? '').replace(/[\r\n\u200b\ufeff]+/g, '').length === 0
}

function normalizeEmptyParagraph(el: Element): void {
  if (isEmptyBlockNode(el) && el.querySelectorAll('br').length <= 1) {
    el.innerHTML = '<br>'
  }
}

/** Normalize browser contentEditable DOM HTML into clean semantic HTML compatible with backend _RichHTMLParser. */
export function normalizeEditorHtml(rawHtml: string): string {
  if (!rawHtml.trim()) return ''
  const sanitized = sanitizePastedHtml(rawHtml)
  if (!sanitized) return ''

  const doc = new DOMParser().parseFromString(sanitized, 'text/html')
  const body = doc.body
  if (!body) return ''

  // Convert leaf <div>s into <p> and ensure top-level bare inline/text nodes are wrapped in <p>
  for (const child of [...body.children]) {
    const tag = child.tagName.toLowerCase()
    if (tag === 'div' && !isPageBreakNode(child) && !child.classList.contains('katex-display') && !child.classList.contains('math-display') && !child.hasAttribute('data-chart')) {
      const p = doc.createElement('p')
      const align = (child as HTMLElement).style?.textAlign
      if (align) p.style.textAlign = align
      while (child.firstChild) p.appendChild(child.firstChild)
      body.replaceChild(p, child)
    } else if (tag === 'div' && isPageBreakNode(child)) {
      child.removeAttribute('contenteditable')
      child.setAttribute('data-pagebreak', 'true')
      child.setAttribute('style', 'page-break-after: always')
      child.innerHTML = ''
    }
  }

  // Group consecutive top-level text/inline nodes into <p>
  const grouped: Node[] = []
  let inlineBuf: Node[] = []
  const flushInlineBuf = () => {
    if (!inlineBuf.length) return
    const hasMeaningful = inlineBuf.some((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const text = n.textContent ?? ''
        return text.length > 0 && (!/[\r\n]/.test(text) || text.trim().length > 0)
      }
      return true
    })
    if (hasMeaningful) {
      const p = doc.createElement('p')
      for (const n of inlineBuf) p.appendChild(n)
      grouped.push(p)
    }
    inlineBuf = []
  }

  for (const node of [...body.childNodes]) {
    if (isBlockElement(node)) {
      flushInlineBuf()
      grouped.push(node)
    } else {
      inlineBuf.push(node)
    }
  }
  flushInlineBuf()

  body.innerHTML = ''
  for (const n of grouped) body.appendChild(n)

  const tagMap: Record<string, string> = { b: 'strong', i: 'em', del: 's', strike: 's', ins: 'u' }
  for (const inlineEl of [...body.querySelectorAll('b, i, del, strike, ins')]) {
    const targetTag = tagMap[inlineEl.tagName.toLowerCase()]
    if (!targetTag) continue
    const next = doc.createElement(targetTag)
    while (inlineEl.firstChild) next.appendChild(inlineEl.firstChild)
    inlineEl.replaceWith(next)
  }

  for (const block of [...body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')]) {
    block.removeAttribute('align')
    if (block.tagName.toLowerCase() === 'p' || block.tagName.toLowerCase() === 'li') {
      normalizeEmptyParagraph(block)
    }
  }

  // Single empty <p><br></p> without alignment represents a cleared/empty textbox
  if (
    body.children.length === 1 &&
    body.firstElementChild?.tagName.toLowerCase() === 'p' &&
    !body.firstElementChild.getAttribute('style') &&
    isEmptyBlockNode(body.firstElementChild) &&
    body.firstElementChild.querySelectorAll('br').length <= 1
  ) {
    return ''
  }

  return body.innerHTML.trim()
}

export function hydrateEditorDom(editor: HTMLElement, html: string): void {
  editor.innerHTML = html
  lockFormulaElements(editor)
  for (const pb of editor.querySelectorAll('[data-pagebreak="true"], div[style*="page-break-after"], div[style*="page-break-before"]')) {
    pb.setAttribute('contenteditable', 'false')
    pb.setAttribute('data-pagebreak', 'true')
  }
}

export function getSelectionInside(editor: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return editor.contains(range.commonAncestorContainer) ? range : null
}

export function setSelectionRange(range: Range): void {
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

export function placeCaretAtEnd(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  setSelectionRange(range)
}

export function placeCaretInsideBlock(block: HTMLElement, atStart = false): void {
  const range = document.createRange()
  if (isEmptyBlockNode(block)) {
    range.setStart(block, 0)
    range.collapse(true)
  } else {
    range.selectNodeContents(block)
    range.collapse(atStart)
  }
  setSelectionRange(range)
}

function findClosestBlock(editor: HTMLElement, node: Node | null): HTMLElement | null {
  let cur: Node | null = node
  while (cur && cur !== editor) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (ALIGNABLE_TAGS.has(tag) || tag === 'pre' || (tag === 'div' && !isPageBreakNode(el))) {
        return el
      }
    }
    cur = cur.parentNode
  }
  return null
}

function findTopBlockChild(editor: HTMLElement, node: Node | null): HTMLElement | null {
  let cur: Node | null = node
  while (cur && cur.parentNode !== editor) {
    cur = cur.parentNode
  }
  return cur && cur.nodeType === Node.ELEMENT_NODE ? (cur as HTMLElement) : null
}

/** Ensure caret/selection lives inside a block element rather than raw text under editor root. */
function ensureCaretInBlock(editor: HTMLElement, range: Range): HTMLElement {
  const existing = findClosestBlock(editor, range.startContainer)
  if (existing) return existing

  if (editor.childNodes.length === 0) {
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    editor.appendChild(p)
    placeCaretInsideBlock(p, true)
    return p
  }

  // Caret is directly in editor or a top-level inline/text node: wrap contiguous inline run into <p>
  let anchor: Node | null = range.startContainer
  let offset = range.startOffset
  if (anchor === editor) {
    const child = editor.childNodes[Math.min(offset, editor.childNodes.length - 1)]
    if (child && child.nodeType === Node.ELEMENT_NODE && TOP_BLOCK_TAGS.has((child as Element).tagName.toLowerCase())) {
      const blk = child as HTMLElement
      if (!isPageBreakNode(blk)) {
        placeCaretInsideBlock(blk, false)
        return blk
      }
    }
    if (child) {
      anchor = child
      offset = 0
    }
  }
  while (anchor && anchor.parentNode !== editor) {
    anchor = anchor.parentNode
  }
  if (!anchor || isBlockElement(anchor)) {
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    editor.appendChild(p)
    placeCaretInsideBlock(p, true)
    return p
  }

  // Find contiguous non-block siblings around `anchor`
  let first: Node = anchor
  while (first.previousSibling && !isBlockElement(first.previousSibling)) {
    first = first.previousSibling
  }
  const nodes: Node[] = []
  let cur: Node | null = first
  while (cur && !isBlockElement(cur)) {
    nodes.push(cur)
    cur = cur.nextSibling
  }
  const p = document.createElement('p')
  editor.insertBefore(p, first)
  for (const n of nodes) p.appendChild(n)
  if (isEmptyBlockNode(p)) p.innerHTML = '<br>'

  const nextRange = document.createRange()
  if (range.startContainer !== editor && p.contains(range.startContainer)) {
    nextRange.setStart(range.startContainer, offset)
    nextRange.collapse(true)
    setSelectionRange(nextRange)
  } else {
    placeCaretInsideBlock(p, false)
  }
  return p
}

function collectSelectedBlocks(editor: HTMLElement, range: Range): HTMLElement[] {
  if (range.collapsed) {
    return [ensureCaretInBlock(editor, range)]
  }
  // Ensure any bare root inline nodes are wrapped before collecting
  if (!findClosestBlock(editor, range.startContainer)) {
    ensureCaretInBlock(editor, range)
  }
  const candidates = [...editor.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, th, td')] as HTMLElement[]
  const hits: HTMLElement[] = []
  for (const blk of candidates) {
    if (blk.tagName.toLowerCase() === 'p' && blk.parentElement?.tagName.toLowerCase() === 'li') continue
    const bRange = document.createRange()
    bRange.selectNodeContents(blk)
    const startsBeforeEnd = range.compareBoundaryPoints(Range.END_TO_START, bRange) < 0
    const endsAfterStart = range.compareBoundaryPoints(Range.START_TO_END, bRange) > 0
    const fullyContainsEmpty =
      isEmptyBlockNode(blk) &&
      range.compareBoundaryPoints(Range.START_TO_START, bRange) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, bRange) >= 0
    if ((startsBeforeEnd && endsAfterStart) || fullyContainsEmpty) {
      hits.push(blk)
    }
  }
  if (hits.length > 0) return hits
  const fallback = findClosestBlock(editor, range.startContainer)
  return fallback ? [fallback] : []
}

function insertAtCursor(
  el: HTMLTextAreaElement | null,
  current: string,
  snippet: string,
  wrapEnd?: string,
): { next: string; selStart: number; selEnd: number } {
  if (!el) {
    const next = current + snippet + (wrapEnd ?? '')
    return { next, selStart: next.length, selEnd: next.length }
  }
  const start = el.selectionStart ?? current.length
  const end = el.selectionEnd ?? current.length
  const selected = current.slice(start, end)
  const inserted = wrapEnd !== undefined ? `${snippet}${selected || '文本'}${wrapEnd}` : snippet
  const next = current.slice(0, start) + inserted + current.slice(end)
  const pos =
    wrapEnd !== undefined && !selected
      ? { selStart: start + snippet.length, selEnd: start + snippet.length + 2 }
      : { selStart: start + inserted.length, selEnd: start + inserted.length }
  return { next, ...pos }
}

export function readActiveFormat(editor: HTMLElement): ActiveFormatState {
  const range = getSelectionInside(editor)
  if (!range) return DEFAULT_ACTIVE
  const blk = findClosestBlock(editor, range.startContainer)
  const tag = blk?.tagName.toLowerCase() ?? 'p'
  const rawAlign = blk?.style.textAlign || blk?.getAttribute('align') || 'left'
  const align: AlignKind =
    rawAlign === 'center' || rawAlign === 'right' || rawAlign === 'justify' ? rawAlign : 'left'
  const block = HEADING_SWITCH_TAGS.has(tag) ? tag : 'p'
  let bold = false
  let italic = false
  let underline = false
  let strike = false
  try {
    bold = document.queryCommandState('bold')
    italic = document.queryCommandState('italic')
    underline = document.queryCommandState('underline')
    strike = document.queryCommandState('strikeThrough')
  } catch {
    /* ignore */
  }
  const nodeEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  return {
    block,
    align,
    bold,
    italic,
    underline,
    strike,
    ul: !!nodeEl?.closest('ul'),
    ol: !!nodeEl?.closest('ol'),
    blockquote: !!nodeEl?.closest('blockquote'),
    pre: !!nodeEl?.closest('pre'),
  }
}

export function applyBlockAlign(ed: HTMLElement, range: Range, align: AlignKind): void {
  const blocks = collectSelectedBlocks(ed, range)
  for (const blk of blocks) {
    blk.removeAttribute('align')
    blk.style.textAlign = align
  }
  if (blocks.length === 1 && isEmptyBlockNode(blocks[0])) {
    placeCaretInsideBlock(blocks[0], true)
  }
}

export function insertBlankLine(ed: HTMLElement, range: Range): void {
  if (ed.childNodes.length === 0 || (ed.children.length === 1 && isEmptyBlockNode(ed.children[0]) && !ed.children[0].getAttribute('style'))) {
    ed.innerHTML = '<p><br></p><p><br></p>'
    const second = ed.children[1] as HTMLElement
    placeCaretInsideBlock(second, true)
    return
  }
  const blk = ensureCaretInBlock(ed, range)
  const topBlk = findTopBlockChild(ed, blk) ?? blk
  const blank = document.createElement('p')
  blank.innerHTML = '<br>'
  topBlk.after(blank)
  placeCaretInsideBlock(blank, true)
}

export function RichFlowEditor({
  el,
  textareaRef,
}: {
  el: FlowTextElement
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [expanded, setExpanded] = React.useState(false)
  const [mode, setMode] = React.useState<EditorMode>('visual')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const localSourceRef = React.useRef<HTMLTextAreaElement>(null)
  const activeSourceRef = textareaRef ?? localSourceRef
  const fmt: FlowFormat = el.props.format ?? 'plain'
  const text = el.props.text ?? ''

  const commitProps = React.useCallback(
    (patch: Record<string, unknown>, coalesce?: string) => {
      studio.setProps(el.id, patch, coalesce)
    },
    [el.id],
  )

  const handleUpgradeToRichHtml = React.useCallback(() => {
    const html = normalizeEditorHtml(toVisualHtml(text, fmt))
    commitProps({ text: html, format: 'html' })
    toast.success('已转换为可排版富文本格式')
  }, [commitProps, fmt, text])

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

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.docx,.html,.htm,.txt"
        className="hidden"
        onChange={(e) => void handleImportFiles(e.currentTarget.files)}
      />

      <div className="flex flex-wrap items-center justify-between gap-1">
        <Segmented
          value={mode}
          onValueChange={setMode}
          options={MODE_OPTIONS}
          size="sm"
          aria-label="编辑模式"
        />
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="gray"
            icon={<FileUp />}
            onClick={() => fileRef.current?.click()}
            title="导入 MD / Word(.docx) / HTML / TXT"
          >
            导入
          </Button>
          <Button
            type="button"
            size="sm"
            variant="gray"
            icon={<Maximize2 />}
            onClick={() => setExpanded(true)}
            title="打开富文本大窗编辑器"
            aria-label="展开编辑器"
          />
        </div>
      </div>

      {mode === 'visual' && fmt !== 'html' && text.trim().length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-accent/10 px-2 py-1 text-caption text-accent">
          <span className="truncate">
            当前为 {fmt === 'markdown' ? 'MD' : 'TXT'}，可直接编辑或排版
          </span>
          <button
            type="button"
            onClick={handleUpgradeToRichHtml}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-accent/15"
          >
            <Sparkles className="size-3" />
            转为可排版富文本
          </button>
        </div>
      )}

      <WysiwygSurface
        elId={el.id}
        mode={mode}
        fmt={fmt}
        text={text}
        editorDocument={el.props.editor_document}
        compact
        sourceRef={activeSourceRef}
        onCommit={(nextText, nextFmt, coalesce) => commitProps({ text: nextText, format: nextFmt }, coalesce ? 'text' : undefined)}
      />

      <RichEditorDialog
        open={expanded}
        onOpenChange={setExpanded}
        elId={el.id}
        mode={mode}
        onModeChange={setMode}
        fmt={fmt}
        text={text}
        editorDocument={el.props.editor_document}
        onCommit={(nextText, nextFmt, coalesce) => commitProps({ text: nextText, format: nextFmt }, coalesce ? 'text' : undefined)}
        onUpgradeRich={handleUpgradeToRichHtml}
        onImportClick={() => fileRef.current?.click()}
      />
    </div>
  )
}

export interface WysiwygSurfaceProps {
  elId: string
  mode: EditorMode
  fmt: FlowFormat
  text: string
  editorDocument?: FlowTextElement['props']['editor_document']
  compact?: boolean
  sourceRef?: React.RefObject<HTMLTextAreaElement | null>
  onCommit: (text: string, format: FlowFormat, coalesce?: boolean) => void
  autoFocus?: boolean
  onModeChange?: (m: EditorMode) => void
  onImportClick?: () => void
  onDone?: () => void
  doneLabel?: string
  showModeToggle?: boolean
  toolbarClassName?: string
  toolbarStyle?: React.CSSProperties
  wrapperClassName?: string
  wrapperStyle?: React.CSSProperties
  editorClassName?: string
  editorStyle?: React.CSSProperties
  onToolbarPointerDown?: (e: React.PointerEvent) => void
}

export function WysiwygSurface({
  elId,
  mode,
  fmt,
  text,
  editorDocument,
  compact = false,
  sourceRef: externalSourceRef,
  onCommit,
  autoFocus = false,
  onModeChange,
  onImportClick,
  onDone,
  doneLabel = '完成',
  showModeToggle = false,
  toolbarClassName,
  toolbarStyle,
  wrapperClassName,
  wrapperStyle,
  editorClassName,
  editorStyle,
  onToolbarPointerDown,
}: WysiwygSurfaceProps) {
  const localSourceRef = React.useRef<HTMLTextAreaElement>(null)
  const sourceRef = externalSourceRef ?? localSourceRef
  const editorRef = React.useRef<HTMLDivElement>(null)
  const composingRef = React.useRef(false)
  const lastEmittedHtmlRef = React.useRef<string | null>(null)
  const hydratedNodeRef = React.useRef<HTMLDivElement | null>(null)
  const savedRangeRef = React.useRef<Range | null>(null)
  const [active, setActive] = React.useState<ActiveFormatState>(DEFAULT_ACTIVE)
  const [components, setComponents] = React.useState<HTMLElement[]>([])
  const [componentIndex, setComponentIndex] = React.useState(0)
  const [componentBorder, setComponentBorder] = React.useState('')
  const [componentLatex, setComponentLatex] = React.useState('')
  const [formulaEdit, setFormulaEdit] = React.useState<{
    node: HTMLElement | null
    range: Range | null
    latex: string
    parts: FormulaPart[]
    mode: 'content' | 'source'
    x: number
    y: number
  } | null>(null)
  const formulaInput = React.useRef<HTMLTextAreaElement>(null)
  const formulaPanel = React.useRef<HTMLDivElement>(null)
  const component = components[componentIndex]
  const [sourceFormat, setSourceFormat] = React.useState<SourceFormat | null>(null)
  const sourceFmt = sourceFormat ?? (fmt === 'plain' ? 'plain' : 'markdown')
  const sourceText = React.useMemo(() => mode === 'source' ? sourceTextFor(text, fmt, sourceFmt) : '',
    [mode, text, fmt, sourceFmt])
  React.useEffect(() => {
    if (mode !== 'source') setSourceFormat(null)
  }, [mode, elId])

  const editTextOf = useStudio((s) => s.editTextOf)
  const tableGrid = useStudio((s) => {
    const element = s.doc?.pages[s.view.page]?.elements.find((el) => el.id === elId)
    return element?.type === 'flow_text' && !!element.props.rich_style?.table_hlines
  })
  React.useEffect(() => {
    if (mode === 'visual' && (editTextOf === elId || autoFocus) && editorRef.current) {
      editorRef.current.focus()
      placeCaretAtEnd(editorRef.current)
    } else if (mode === 'source' && autoFocus && sourceRef.current) {
      sourceRef.current.focus()
    }
  }, [editTextOf, elId, mode, autoFocus, sourceRef])

  const externalVisualHtml = React.useMemo(
    () => normalizeEditorHtml((fmt === 'html' ? editorDocumentHtml(editorDocument, text) : null) ?? toVisualHtml(text, fmt)),
    [text, fmt, editorDocument],
  )

  // Sync external state into contentEditable only when it did not originate from this surface
  React.useEffect(() => {
    if (mode !== 'visual') return
    const ed = editorRef.current
    if (!ed || composingRef.current) return
    if (hydratedNodeRef.current === ed && (lastEmittedHtmlRef.current === externalVisualHtml || (fmt === 'html' && lastEmittedHtmlRef.current === text))) {
      return
    }
    hydrateEditorDom(ed, externalVisualHtml)
    hydratedNodeRef.current = ed
    lastEmittedHtmlRef.current = externalVisualHtml
  }, [elId, mode, fmt, text, externalVisualHtml])

  // Track active toolbar state via selectionchange
  React.useEffect(() => {
    if (mode !== 'visual') return
    const onSelectionChange = () => {
      const ed = editorRef.current
      if (!ed) return
      const range = getSelectionInside(ed)
      if (!range) return
      savedRangeRef.current = range.cloneRange()
      const next = readActiveFormat(ed)
      setActive((prev) =>
        prev.block === next.block &&
        prev.align === next.align &&
        prev.bold === next.bold &&
        prev.italic === next.italic &&
        prev.underline === next.underline &&
        prev.strike === next.strike &&
        prev.ul === next.ul &&
        prev.ol === next.ol &&
        prev.blockquote === next.blockquote &&
        prev.pre === next.pre
          ? prev
          : next,
      )
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [mode])

  const emitVisualDom = React.useCallback((coalesce = false) => {
    const ed = editorRef.current
    if (!ed) return
    const normalized = normalizeEditorHtml(ed.innerHTML)
    if (normalized === '' && ed.innerHTML !== '' && !composingRef.current) {
      ed.innerHTML = ''
    }
    lastEmittedHtmlRef.current = normalized
    onCommit(normalized, 'html', coalesce)
    setActive(readActiveFormat(ed))
  }, [onCommit])

  const editFormulaAt = React.useCallback((anchor?: { x: number; y: number }, target?: HTMLElement) => {
    const ed = editorRef.current
    if (!ed) return false
    const range = getSelectionInside(ed)
    const source = range?.toString().trim() ?? ''
    const node = target ?? (range && !range.collapsed ? [...ed.querySelectorAll<HTMLElement>(FORMULA_SELECTOR)]
      .find((el) => range.intersectsNode(el) && el.textContent?.trim() === source) : null)
    let latex = node?.textContent ?? ''
    if (!node) {
      if (!source || !range || range.startContainer !== range.endContainer) return false
      const tokens = [...source.matchAll(COMPONENT_FORMULA_RE)]
      if (tokens.length !== 1 || tokens[0][0] !== source) return false
      latex = source.startsWith('$') || /^\\[([]/.test(source) ? formulaBody(source) : source
    }
    const rect = node?.getBoundingClientRect() ?? range?.getBoundingClientRect()
    const parts = formulaParts(latex)
    const mode = parts.some((part) => part.kind !== 'syntax') ? 'content' : 'source'
    setFormulaEdit({ node: node ?? null, range: range?.cloneRange() ?? null, latex, parts, mode,
      x: anchor?.x ?? rect?.left ?? 0, y: anchor?.y ?? rect?.bottom ?? 0 })
    return true
  }, [])

  React.useEffect(() => {
    if (mode !== 'visual' || !editorRef.current) return
    const ed = editorRef.current
    const open = (event: Event) => {
      const { x, y } = (event as CustomEvent<{ x: number; y: number }>).detail
      editFormulaAt({ x, y })
    }
    ed.addEventListener(EDIT_SELECTED_FORMULA_EVENT, open)
    return () => ed.removeEventListener(EDIT_SELECTED_FORMULA_EVENT, open)
  }, [mode, editFormulaAt])

  const applyFormulaEdit = () => {
    const ed = editorRef.current
    if (!ed || !formulaEdit || !formulaEdit.latex.trim()) return
    const { node, range, latex } = formulaEdit
    let formula = node
    if (formula && ed.contains(formula)) formula.textContent = latex.trim()
    else if (!formula && range && ed.contains(range.commonAncestorContainer)) {
      formula = ed.ownerDocument.createElement('span')
      formula.className = 'math-inline'
      formula.contentEditable = 'false'
      formula.textContent = latex.trim()
      range.deleteContents()
      range.insertNode(formula)
    } else {
      setFormulaEdit(null)
      return
    }
    emitVisualDom()
    setFormulaEdit(null)
    requestAnimationFrame(() => {
      ed.focus({ preventScroll: true })
      if (!ed.contains(formula)) return
      const caret = ed.ownerDocument.createRange()
      caret.setStartAfter(formula)
      caret.collapse(true)
      setSelectionRange(caret)
    })
  }

  const cancelFormulaEdit = () => {
    setFormulaEdit(null)
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }

  const saveSelection = () => {
    const ed = editorRef.current
    if (!ed) return
    const range = getSelectionInside(ed)
    if (range) savedRangeRef.current = range.cloneRange()
  }

  const withVisualSelection = (fn: (ed: HTMLElement, range: Range) => void) => {
    const ed = editorRef.current
    if (!ed) return
    ed.focus()
    let range = getSelectionInside(ed)
    if (!range && savedRangeRef.current && ed.contains(savedRangeRef.current.startContainer)) {
      range = savedRangeRef.current
      setSelectionRange(range)
    }
    if (!range) {
      placeCaretAtEnd(ed)
      range = getSelectionInside(ed) ?? document.createRange()
    }
    fn(ed, range)
    emitVisualDom()
  }

  const applyAlignment = (align: AlignKind) => {
    withVisualSelection((ed, range) => applyBlockAlign(ed, range, align))
  }

  const applyBlockTag = (tag: BlockTag) => {
    withVisualSelection((ed, range) => {
      const blocks = collectSelectedBlocks(ed, range)
      const replacementTarget: HTMLElement[] = []
      for (const blk of blocks) {
        const curTag = blk.tagName.toLowerCase()
        if (!HEADING_SWITCH_TAGS.has(curTag)) continue
        const targetTag: BlockTag = curTag === tag && tag !== 'p' ? 'p' : tag
        if (curTag === targetTag) {
          replacementTarget.push(blk)
          continue
        }
        const nextEl = document.createElement(targetTag)
        if (blk.style.textAlign) nextEl.style.textAlign = blk.style.textAlign
        while (blk.firstChild) nextEl.appendChild(blk.firstChild)
        if (isEmptyBlockNode(nextEl)) nextEl.innerHTML = '<br>'
        blk.replaceWith(nextEl)
        replacementTarget.push(nextEl)
      }
      if (replacementTarget.length > 0) {
        const last = replacementTarget[replacementTarget.length - 1]
        placeCaretInsideBlock(last, false)
      }
    })
  }

  const applyInlineCommand = (cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough') => {
    withVisualSelection((ed, range) => {
      ensureCaretInBlock(ed, range)
      try {
        document.execCommand(cmd, false)
      } catch {
        /* ignore */
      }
    })
  }

  const applyList = (ordered: boolean) => {
    withVisualSelection((ed, range) => {
      ensureCaretInBlock(ed, range)
      try {
        document.execCommand(ordered ? 'insertOrderedList' : 'insertUnorderedList', false)
      } catch {
        /* ignore */
      }
    })
  }

  const toggleQuote = () => {
    withVisualSelection((ed, range) => {
      const blk = ensureCaretInBlock(ed, range)
      const existingQuote = blk.closest('blockquote')
      if (existingQuote && ed.contains(existingQuote)) {
        const children = [...existingQuote.childNodes]
        for (const c of children) existingQuote.parentNode?.insertBefore(c, existingQuote)
        existingQuote.remove()
        placeCaretInsideBlock(blk, false)
        return
      }
      const topBlk = findTopBlockChild(ed, blk) ?? blk
      const q = document.createElement('blockquote')
      topBlk.replaceWith(q)
      q.appendChild(topBlk)
      placeCaretInsideBlock(topBlk, false)
    })
  }

  const insertBlockNodeAfterCaret = (ed: HTMLElement, range: Range, node: HTMLElement, ensureTrailingPara = false): HTMLElement => {
    const blk = ensureCaretInBlock(ed, range)
    const topBlk = findTopBlockChild(ed, blk) ?? blk
    const canReplaceEmpty = isEmptyBlockNode(topBlk) && topBlk.tagName.toLowerCase() === 'p' && !topBlk.style.textAlign
    if (canReplaceEmpty) {
      topBlk.replaceWith(node)
    } else {
      topBlk.after(node)
    }
    if (ensureTrailingPara && (!node.nextElementSibling || isPageBreakNode(node.nextElementSibling))) {
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      node.after(p)
      return p
    }
    return node
  }

  const insertEmptyLine = () => {
    withVisualSelection((ed, range) => insertBlankLine(ed, range))
  }

  const insertCodeBlock = (lang = '', body = '代码内容') => {
    withVisualSelection((ed, range) => {
      const curPre = (range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
      )?.closest('pre')
      if (curPre && ed.contains(curPre) && !lang) {
        const p = document.createElement('p')
        p.textContent = curPre.textContent ?? ''
        if (isEmptyBlockNode(p)) p.innerHTML = '<br>'
        curPre.replaceWith(p)
        placeCaretInsideBlock(p, false)
        return
      }
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (lang) code.className = `language-${lang}`
      const selText = !lang && !range.collapsed ? range.toString() : body
      code.textContent = selText
      pre.appendChild(code)
      insertBlockNodeAfterCaret(ed, range, pre, true)
      const r = document.createRange()
      r.selectNodeContents(code)
      setSelectionRange(r)
    })
  }

  const insertTable = () => {
    withVisualSelection((ed, range) => {
      const table = document.createElement('table')
      table.innerHTML =
        '<thead><tr><th style="text-align:left">列1</th><th style="text-align:left">列2</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">数据1</td><td style="text-align:left">数据2</td></tr></tbody>'
      insertBlockNodeAfterCaret(ed, range, table, true)
      const firstCell = table.querySelector('th') as HTMLElement | null
      if (firstCell) placeCaretInsideBlock(firstCell, false)
    })
  }

  const insertFormula = (preset: (typeof FORMULA_PRESETS)[number]) => {
    withVisualSelection((ed, range) => {
      const tpl = document.createElement('template')
      const edge = preset.block ? 2 : 1
      tpl.innerHTML = formulaHtml(preset.md.slice(edge, -edge), preset.block)
      const formula = tpl.content.firstElementChild as HTMLElement
      formula.contentEditable = 'false'
      if (preset.block) {
        insertBlockNodeAfterCaret(ed, range, formula, true)
        const after = document.createRange()
        after.setStartAfter(formula)
        after.collapse(true)
        setSelectionRange(after)
      } else {
        ensureCaretInBlock(ed, range)
        const curRange = getSelectionInside(ed) ?? range
        curRange.deleteContents()
        curRange.insertNode(formula)
        const nextRange = document.createRange()
        nextRange.setStartAfter(formula)
        nextRange.collapse(true)
        setSelectionRange(nextRange)
      }
    })
  }

  const selectComponent = (nodes: HTMLElement[], index: number) => {
    setComponents(nodes)
    setComponentIndex(index)
    setComponentBorder(nodes[index].hasAttribute('data-border-edges') ? 'custom' : nodes[index].dataset.border ?? '')
    setComponentLatex(nodes[index].textContent ?? '')
  }

  const openComponentSettings = () => {
    const ed = editorRef.current
    if (!ed) return
    const anchor = getSelectionInside(ed)?.startContainer ?? savedRangeRef.current?.startContainer
    const current = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest(RICH_COMPONENT_SELECTOR)
    materializeFormulas(ed)
    const nodes = [...ed.querySelectorAll<HTMLElement>(RICH_COMPONENT_SELECTOR)]
    if (!nodes.length) {
      toast.info('先插入表格或使用 $…$ 输入公式')
      return
    }
    selectComponent(nodes, Math.max(0, nodes.findIndex((node) => node === current)))
  }

  const applyComponentSettings = () => {
    if (!component || !editorRef.current?.contains(component)) return
    if (componentBorder !== 'custom') {
      component.removeAttribute('data-border-edges')
      if (componentBorder) component.dataset.border = componentBorder
      else delete component.dataset.border
    }
    if (component.localName !== 'table') component.textContent = componentLatex
    emitVisualDom()
    setComponents([])
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }

  const insertPageBreak = () => {
    withVisualSelection((ed, range) => {
      const pb = document.createElement('div')
      pb.setAttribute('data-pagebreak', 'true')
      pb.setAttribute('contenteditable', 'false')
      pb.setAttribute('style', 'page-break-after: always')
      const nextPara = insertBlockNodeAfterCaret(ed, range, pb, true)
      placeCaretInsideBlock(nextPara, true)
    })
  }

  const handleVisualPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const plainData = e.clipboardData.getData('text/plain')
    const richHtml = richClipboardHtml(e.clipboardData, plainData)
    if (!richHtml && !plainData) {
      if (e.clipboardData.getData('text/html')) e.preventDefault()
      return
    }

    e.preventDefault()

    const htmlToInsert = richHtml || (looksLikeMarkdown(plainData) ? markdownToHtml(plainData) : plainToHtml(plainData))
    if (!htmlToInsert) return

    const ed = editorRef.current
    if (!ed) return
    ed.focus()
    let range = getSelectionInside(ed)
    if (!range) {
      placeCaretAtEnd(ed)
      range = getSelectionInside(ed)
    }
    if (!range) return

    range.deleteContents()

    const tpl = document.createElement('template')
    tpl.innerHTML = htmlToInsert
    const frag = tpl.content
    lockFormulaElements(frag)

    const containsBlockTags = [...frag.children].some(
      (c) => TOP_BLOCK_TAGS.has(c.tagName.toLowerCase()) || isPageBreakNode(c),
    )
    const singlePlainLineParagraph =
      frag.children.length === 1 &&
      frag.firstElementChild?.tagName.toLowerCase() === 'p' &&
      !frag.firstElementChild.getAttribute('style') &&
      !plainData.includes('\n')

    // Insert inline when pasting inline HTML or a single plain line into a non-empty block
    const curBlk = findClosestBlock(ed, range.startContainer)
    if (!containsBlockTags || (singlePlainLineParagraph && curBlk && !isEmptyBlockNode(curBlk))) {
      const innerNodes = singlePlainLineParagraph ? [...frag.firstElementChild!.childNodes] : [...frag.childNodes]
      let lastInserted: Node | null = null
      for (const n of innerNodes) {
        range.insertNode(n)
        range.setStartAfter(n)
        range.collapse(true)
        lastInserted = n
      }
      if (lastInserted) {
        const nextR = document.createRange()
        nextR.setStartAfter(lastInserted)
        nextR.collapse(true)
        setSelectionRange(nextR)
      }
      emitVisualDom()
      return
    }

    // Multi-block / paragraph paste: split current block cleanly so we never nest <p> inside <p>
    const nodes = [...frag.childNodes].filter((n) => {
      if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').trim().length > 0
      return true
    })
    if (!nodes.length) return

    const ensuredBlk = ensureCaretInBlock(ed, range)
    const topBlk = findTopBlockChild(ed, ensuredBlk) ?? ensuredBlk
    const splitRange = getSelectionInside(ed) ?? range

    // Split tail content after caret in `topBlk`
    const tailRange = document.createRange()
    tailRange.setStart(splitRange.endContainer, splitRange.endOffset)
    tailRange.setEnd(topBlk, topBlk.childNodes.length)
    const tailFrag = tailRange.extractContents()
    const tailHasContent =
      (tailFrag.textContent ?? '').replace(/[\u00a0\u200b\ufeff\s]+/g, '').length > 0 ||
      !!tailFrag.querySelector('svg, math, [data-chart], table, pre')

    const replaceCurrentEmpty = isEmptyList(topBlk) ||
      (topBlk.matches('p') && isEmptyBlockNode(topBlk) && !topBlk.style.textAlign)

    let anchorNode: Node = topBlk
    let lastPasted: Node | null = null
    for (let i = 0; i < nodes.length; i++) {
      let node = nodes[i]
      if (node.nodeType === Node.TEXT_NODE) {
        const p = document.createElement('p')
        p.textContent = node.textContent
        node = p
      }
      if (i === 0 && replaceCurrentEmpty) {
        topBlk.replaceWith(node)
      } else {
        (anchorNode as Element).after(node)
      }
      anchorNode = node
      lastPasted = node
    }

    if (tailHasContent) {
      const tailPara = document.createElement('p')
      tailPara.appendChild(tailFrag)
      ;(anchorNode as Element).after(tailPara)
      placeCaretInsideBlock(tailPara, true)
    } else if (lastPasted && lastPasted.nodeType === Node.ELEMENT_NODE) {
      const elNode = lastPasted as HTMLElement
      if (isPageBreakNode(elNode)) {
        const p = document.createElement('p')
        p.innerHTML = '<br>'
        elNode.after(p)
        placeCaretInsideBlock(p, true)
      } else {
        placeCaretInsideBlock(elNode, false)
      }
    }

    for (const pb of ed.querySelectorAll('[data-pagebreak="true"], div[style*="page-break-after"]')) {
      pb.setAttribute('contenteditable', 'false')
    }
    emitVisualDom()
  }

  const handleVisualKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return
    const ed = editorRef.current
    if (!ed) return
    if (isInsertTab(e)) {
      const range = getSelectionInside(ed)
      if (!range) return
      e.preventDefault()
      range.deleteContents()
      const block = ensureCaretInBlock(ed, range)
      const placeholder = block.childNodes.length === 1 && block.firstChild instanceof HTMLBRElement
        ? block.firstChild : null
      const current = getSelectionInside(ed) ?? range
      const tab = document.createTextNode('\t')
      current.insertNode(tab)
      current.setStartAfter(tab)
      current.collapse(true)
      placeholder?.remove()
      setSelectionRange(current)
      emitVisualDom()
      return
    }
    if ((e.key === 'F2' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) && editFormulaAt()) {
      e.preventDefault()
      e.stopPropagation()
      return
    }

    if (e.key === 'Enter') {
      const range = getSelectionInside(ed)
      if (!range) return
      const preEl = (range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
      )?.closest('pre')

      if (preEl && ed.contains(preEl)) {
        e.preventDefault()
        if (e.ctrlKey || e.metaKey) {
          const p = document.createElement('p')
          p.innerHTML = '<br>'
          preEl.after(p)
          placeCaretInsideBlock(p, true)
        } else {
          range.deleteContents()
          const tn = document.createTextNode('\n')
          range.insertNode(tn)
          const nextR = document.createRange()
          nextR.setStartAfter(tn)
          nextR.collapse(true)
          setSelectionRange(nextR)
        }
        emitVisualDom()
        return
      }

      if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        ensureCaretInBlock(ed, range)
        const current = getSelectionInside(ed) ?? range
        current.deleteContents()
        const br = document.createElement('br')
        current.insertNode(br)
        if (!br.nextSibling || (br.nextSibling instanceof Text && !br.nextSibling.length && !br.nextSibling.nextSibling)) {
          const sentinel = document.createElement('br')
          sentinel.dataset.editorSentinel = ''
          br.after(sentinel)
        }
        current.setStartAfter(br)
        current.collapse(true)
        setSelectionRange(current)
        emitVisualDom()
        return
      }

      if (!e.shiftKey) {
        if (ed.childNodes.length === 0) {
          e.preventDefault()
          ed.innerHTML = '<p><br></p><p><br></p>'
          placeCaretInsideBlock(ed.children[1] as HTMLElement, true)
          emitVisualDom()
          return
        }
        const blk = findClosestBlock(ed, range.startContainer)
        if (blk && /^h[1-6]$/i.test(blk.tagName)) {
          // Pressing Enter at the end of a heading starts a regular paragraph like Word
          const endCheck = document.createRange()
          endCheck.selectNodeContents(blk)
          endCheck.setStart(range.endContainer, range.endOffset)
          if (endCheck.toString().length === 0) {
            e.preventDefault()
            range.deleteContents()
            const p = document.createElement('p')
            p.innerHTML = '<br>'
            blk.after(p)
            placeCaretInsideBlock(p, true)
            emitVisualDom()
            return
          }
        }
      }
    }

    if (e.key === 'Backspace') {
      const range = getSelectionInside(ed)
      if (!range || !range.collapsed) return
      const blk = findTopBlockChild(ed, range.startContainer)
      if (blk && blk.previousElementSibling && isPageBreakNode(blk.previousElementSibling)) {
        const atStart = document.createRange()
        atStart.selectNodeContents(blk)
        atStart.setEnd(range.startContainer, range.startOffset)
        if (atStart.toString().length === 0) {
          e.preventDefault()
          blk.previousElementSibling.remove()
          emitVisualDom()
        }
      }
    }
  }

  // Source mode handlers
  const handleSourceInsert = (snippet: string, wrapEnd?: string) => {
    const nextFmt = sourceFmt === 'plain' ? 'markdown' : sourceFmt
    const { next, selStart, selEnd } = insertAtCursor(sourceRef.current, sourceText, snippet, wrapEnd)
    setSourceFormat(nextFmt)
    onCommit(next, nextFmt)
    requestAnimationFrame(() => {
      sourceRef.current?.focus()
      sourceRef.current?.setSelectionRange(selStart, selEnd)
    })
  }

  const handleSourcePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (sourceFmt === 'plain' || !e.clipboardData.getData('text/html')) return
    e.preventDefault()
    const plainData = e.clipboardData.getData('text/plain')
    const html = richClipboardHtml(e.clipboardData, plainData)
    const converted = html ? htmlToMarkdown(html) : plainData
    if (!converted) return
    const { next, selStart, selEnd } = insertAtCursor(sourceRef.current, sourceText, converted)
    onCommit(next, sourceFmt)
    requestAnimationFrame(() => {
      sourceRef.current?.setSelectionRange(selStart, selEnd)
    })
  }

  const isEmptyVisual = externalVisualHtml.length === 0
  const canRecoverRichText = fmt !== 'html' &&
    /^\s*<(?:p|div|h[1-6]|table|ul|ol|blockquote|pre)\b[\s\S]*<\/(?:p|div|h[1-6]|table|ul|ol|blockquote|pre)>\s*$/i.test(text)

  return (
    <div className={cn('flex flex-col gap-1.5', !compact && 'min-h-0 flex-1')}>
      <RichFormatToolbar
        mode={mode}
        sourceFmt={sourceFmt}
        compact={compact}
        active={active}
        onSourceInsert={handleSourceInsert}
        onBlockTag={applyBlockTag}
        onInlineCommand={applyInlineCommand}
        onAlign={applyAlignment}
        onInsertEmptyLine={insertEmptyLine}
        onList={applyList}
        onQuote={toggleQuote}
        onCodeBlock={insertCodeBlock}
        onTable={insertTable}
        onFormula={insertFormula}
        onComponentSettings={openComponentSettings}
        tableBorderControl={/<table\b/i.test(externalVisualHtml) && (
          <TableBorderEditor
            getTables={() => [...(editorRef.current?.querySelectorAll('table') ?? [])]}
            getActiveTable={() => {
              const start = savedRangeRef.current?.startContainer
              return (start instanceof Element ? start : start?.parentElement)?.closest('table') ?? null
            }}
            documentGrid={tableGrid}
            onApply={(table, edges) => {
              const ed = editorRef.current
              if (!ed?.contains(table)) return
              table.removeAttribute('data-border')
              if (edges === null) table.removeAttribute('data-border-edges')
              else table.setAttribute('data-border-edges', edges.join(' '))
              emitVisualDom()
              const selection = savedRangeRef.current
              requestAnimationFrame(() => {
                ed.focus({ preventScroll: true })
                if (selection && ed.contains(selection.commonAncestorContainer)) setSelectionRange(selection)
              })
            }}
          />
        )}
        onRecoverRichText={canRecoverRichText ? () => onCommit(normalizeEditorHtml(text), 'html') : undefined}
        onPageBreak={insertPageBreak}
        onSaveSelection={saveSelection}
        showModeToggle={showModeToggle}
        onModeChange={onModeChange}
        onFormatChange={setSourceFormat}
        onImportClick={onImportClick}
        onDone={onDone}
        doneLabel={doneLabel}
        className={toolbarClassName}
        style={toolbarStyle}
        onPointerDown={onToolbarPointerDown}
      />

      {mode === 'visual' ? (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && editorRef.current) {
              editorRef.current.focus()
              placeCaretAtEnd(editorRef.current)
            }
          }}
          style={wrapperStyle}
          className={cn(
            'cursor-text overflow-y-auto rounded-sm bg-bg-elevated shadow-[inset_0_0_0_0.5px_rgb(var(--separator)/var(--separator-a)),0_0.5px_1px_rgb(0_0_0/0.04)]',
            'focus-within:shadow-[inset_0_0_0_1px_rgb(var(--accent)),0_0_0_3px_rgb(var(--accent)/0.3)]',
            compact ? 'min-h-[200px] max-h-[360px] px-2.5 py-2' : 'min-h-[360px] flex-1 px-4 py-3',
            wrapperClassName,
          )}
        >
          <div
            ref={editorRef}
            role="textbox"
            aria-multiline="true"
            aria-label="文本框内容"
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            data-empty={isEmptyVisual ? 'true' : undefined}
            data-placeholder="像 Word 一样直接输入或粘贴 Word / Markdown / 网页内容，支持选中行居中、插空行、表格、公式与图表…"
            style={editorStyle}
            className={cn('rich-wysiwyg min-h-full', editorClassName)}
            onFocus={() => {
              try {
                document.execCommand('defaultParagraphSeparator', false, 'p')
              } catch {
                /* ignore */
              }
            }}
            onBlur={saveSelection}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
              if (editorRef.current) commitTypedFormula(editorRef.current)
              emitVisualDom(true)
            }}
            onInput={() => {
              if (!composingRef.current && editorRef.current) {
                commitTypedFormula(editorRef.current)
                emitVisualDom(true)
              }
            }}
            onPaste={handleVisualPaste}
            onDoubleClick={(e) => {
              const target = (e.target as Element).closest<HTMLElement>(FORMULA_SELECTOR)
              if (target && editFormulaAt({ x: e.clientX, y: e.clientY }, target)) e.stopPropagation()
            }}
            onKeyDown={handleVisualKeyDown}
          />
        </div>
      ) : (
        <Textarea
          ref={sourceRef}
          value={sourceText}
          onChange={(e) => onCommit(e.currentTarget.value, sourceFmt, true)}
          onKeyDown={(e) => {
            if (!isInsertTab(e) || e.nativeEvent.isComposing) return
            e.preventDefault()
            if (document.execCommand('insertText', false, '\t')) return
            const { next, selEnd } = insertAtCursor(e.currentTarget, sourceText, '\t')
            onCommit(next, sourceFmt)
            requestAnimationFrame(() => sourceRef.current?.setSelectionRange(selEnd, selEnd))
          }}
          onPaste={handleSourcePaste}
          rows={compact ? 10 : 18}
          className={cn('font-mono leading-relaxed [tab-size:2]', compact ? 'text-footnote' : 'min-h-[360px] flex-1 resize-none text-body')}
          placeholder={
            sourceFmt === 'markdown'
                ? '支持 Markdown、直接粘贴 Word/网页内容、$LaTeX$ 公式、```chart 图表、表格…'
                : '直接输入纯文本，自动换行分页；也可切换为可视化编辑器或 Markdown/HTML…'
          }
          aria-label="文本框内容"
        />
      )}
      <Popover open={!!formulaEdit} onOpenChange={(open) => { if (!open) setFormulaEdit(null) }}>
        {formulaEdit && (
          <PopoverAnchor asChild>
            <span aria-hidden className="pointer-events-none fixed" style={{ left: formulaEdit.x, top: formulaEdit.y }} />
          </PopoverAnchor>
        )}
        <PopoverContent ref={formulaPanel} align="start" className="w-96 space-y-2" aria-label="就地编辑公式"
          onOpenAutoFocus={(e) => {
            const field = formulaInput.current ?? formulaPanel.current?.querySelector('input')
            if (!field) return
            e.preventDefault()
            field.focus({ preventScroll: true })
            if (field instanceof HTMLInputElement) field.select()
            else field.setSelectionRange(field.value.length, field.value.length)
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            cancelFormulaEdit()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing &&
                (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
              e.preventDefault()
              applyFormulaEdit()
            }
          }}>
          <div className="flex items-center justify-between">
            <span className="text-footnote font-medium">编辑公式</span>
            <Segmented value={formulaEdit?.mode ?? 'source'} size="sm" aria-label="公式编辑模式"
              options={[{ value: 'content', label: '内容' }, { value: 'source', label: 'LaTeX' }]}
              onValueChange={(mode) => setFormulaEdit((current) => current
                ? { ...current, mode, parts: mode === 'content' ? formulaParts(current.latex) : current.parts }
                : null)} />
          </div>
          {formulaEdit?.mode === 'content' ? (
            <div className="max-h-52 overflow-y-auto">
              {formulaEdit.parts.some((part) => part.kind !== 'syntax') ? (
                <div className="grid grid-cols-2 gap-2">
                  {formulaEdit.parts.map((part, index) => {
                    if (part.kind === 'syntax') return null
                    const label = part.kind === 'number' ? '数字' : part.kind === 'symbol' ? '字母' : '文本'
                    const order = formulaEdit.parts.slice(0, index + 1).filter((item) => item.kind === part.kind).length
                    return (
                      <label key={index} className="flex min-w-0 flex-col gap-1 text-footnote">
                        {label} {order}
                        <Input value={part.value} className="font-mono"
                          inputMode={part.kind === 'number' ? 'decimal' : 'text'}
                          onChange={(e) => {
                            const value = e.currentTarget.value
                            if (part.kind === 'number' && !/^[\d.]*$/.test(value)) return
                            if (part.kind === 'symbol' && !/^\p{L}*$/u.test(value)) return
                            if (part.kind === 'text' && /[{}\\]/.test(value)) return
                            setFormulaEdit((current) => {
                              if (!current) return null
                              const parts = current.parts.map((item, i) => i === index ? { ...item, value } : item)
                              return { ...current, parts, latex: parts.map((item) => item.value).join('') }
                            })
                          }} />
                      </label>
                    )
                  })}
                </div>
              ) : <p className="text-footnote text-secondary-label">此公式可在 LaTeX 视图中编辑。</p>}
            </div>
          ) : (
            <Textarea aria-label="LaTeX 公式" ref={formulaInput} rows={2} className="min-h-0 font-mono"
              value={formulaEdit?.latex ?? ''}
              onChange={(e) => {
                const latex = e.currentTarget.value
                setFormulaEdit((current) => current ? { ...current, latex } : null)
              }} />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="plain" onClick={cancelFormulaEdit}>取消</Button>
            <Button size="sm" disabled={!formulaEdit?.latex.trim()} onClick={applyFormulaEdit}>应用公式</Button>
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={!!component} onOpenChange={(open) => { if (!open) setComponents([]) }}>
        <DialogContent className="space-y-3 p-5">
          <DialogHeader><DialogTitle>表格与公式设置</DialogTitle></DialogHeader>
          <label className="flex flex-col gap-1 text-footnote">
            组件
            <select value={componentIndex} onChange={(e) => selectComponent(components, Number(e.currentTarget.value))} className="rounded border border-separator bg-bg-elevated p-1.5">
              {components.map((node, index) => (
                <option key={index} value={index}>{index + 1}. {node.localName === 'table' ? '表格' : '公式'}</option>
              ))}
            </select>
          </label>
          {component?.localName !== 'table' && (
            <label className="flex flex-col gap-1 text-footnote">
              LaTeX
              <Textarea value={componentLatex} onChange={(e) => setComponentLatex(e.currentTarget.value)} />
            </label>
          )}
          <label className="flex flex-col gap-1 text-footnote">
            边框
            <select value={componentBorder} onChange={(e) => setComponentBorder(e.currentTarget.value)} className="rounded border border-separator bg-bg-elevated p-1.5">
              {component?.localName === 'table' ? (
                <>
                  {component.hasAttribute('data-border-edges') && <option value="custom" disabled>自定义边框</option>}
                  <option value="">跟随文档</option><option value="none">无边框</option><option value="vertical">仅竖线</option><option value="grid">完整网格</option>
                </>
              ) : (
                <><option value="">无边框</option><option value="box">外框</option></>
              )}
            </select>
          </label>
          <Button type="button" size="sm" onClick={applyComponentSettings}>应用</Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export interface RichFormatToolbarProps {
  mode: EditorMode
  sourceFmt: SourceFormat
  compact?: boolean
  active: ActiveFormatState
  onSourceInsert: (snippet: string, wrapEnd?: string) => void
  onBlockTag: (tag: BlockTag) => void
  onInlineCommand: (cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough') => void
  onAlign: (align: AlignKind) => void
  onInsertEmptyLine: () => void
  onList: (ordered: boolean) => void
  onQuote: () => void
  onCodeBlock: (lang?: string, body?: string) => void
  onTable: () => void
  onFormula: (preset: (typeof FORMULA_PRESETS)[number]) => void
  onComponentSettings?: () => void
  tableBorderControl?: React.ReactNode
  onRecoverRichText?: () => void
  onPageBreak: () => void
  onSaveSelection: () => void
  showModeToggle?: boolean
  onModeChange?: (m: EditorMode) => void
  onFormatChange?: (f: SourceFormat) => void
  onImportClick?: () => void
  onDone?: () => void
  doneLabel?: string
  className?: string
  style?: React.CSSProperties
  onPointerDown?: (e: React.PointerEvent) => void
}

export function RichFormatToolbar({
  mode,
  sourceFmt,
  compact = false,
  active,
  onSourceInsert,
  onBlockTag,
  onInlineCommand,
  onAlign,
  onInsertEmptyLine,
  onList,
  onQuote,
  onCodeBlock,
  onTable,
  onFormula,
  onComponentSettings,
  tableBorderControl,
  onRecoverRichText,
  onPageBreak,
  onSaveSelection,
  showModeToggle = false,
  onModeChange,
  onFormatChange,
  onImportClick,
  onDone,
  doneLabel = '完成',
  className,
  style,
  onPointerDown,
}: RichFormatToolbarProps) {
  const btnCls = compact ? 'h-6 px-1.5 text-footnote' : 'h-7 px-2 text-footnote'
  const activeBtnCls = 'bg-accent/15 text-accent'
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  const extraTail = (showModeToggle || onImportClick || onDone || (mode === 'source' && onFormatChange)) ? (
    <>
      <span className="mx-0.5 h-4 w-px bg-separator/60" aria-hidden />
      {onImportClick ? (
        <Button type="button" size="sm" variant="plain" className={btnCls} title="导入 MD / Word / HTML / TXT" onClick={onImportClick}>
          <FileUp className="size-3.5" />
          {!compact && <span>导入</span>}
        </Button>
      ) : null}
      {showModeToggle && onModeChange ? (
        <Segmented value={mode} onValueChange={onModeChange} options={MODE_OPTIONS} size="sm" aria-label="画布编辑模式" />
      ) : null}
      {mode === 'source' && onFormatChange ? (
        <Segmented value={sourceFmt} onValueChange={onFormatChange} options={SOURCE_FORMAT_OPTIONS} size="sm" aria-label="源码格式" />
      ) : null}
      {onDone ? (
        <Button type="button" size="sm" variant="filled" className="h-6 px-2 text-footnote" icon={<Check className="size-3.5" />} onClick={onDone}>
          {doneLabel}
        </Button>
      ) : null}
    </>
  ) : null

  if (mode === 'source') {
    return (
      <div
        className={cn('flex flex-wrap items-center gap-0.5 rounded-md border border-separator/70 bg-fill/40 p-1', className)}
        style={style}
        onPointerDown={onPointerDown}
      >
        <Button type="button" size="sm" variant="plain" className={btnCls} title="一级标题"
          onClick={() => onSourceInsert('# ')}>
          <Heading1 className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="二级标题"
          onClick={() => onSourceInsert('## ')}>
          <Heading2 className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="三级标题"
          onClick={() => onSourceInsert('### ')}>
          <Heading3 className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="加粗"
          onClick={() => onSourceInsert('**', '**')}>
          <Bold className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="斜体"
          onClick={() => onSourceInsert('*', '*')}>
          <Italic className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="下划线"
          onClick={() => onSourceInsert('<u>', '</u>')}>
          <Underline className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="删除线"
          onClick={() => onSourceInsert('~~', '~~')}>
          <Strikethrough className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="插入空行"
          onClick={() => onSourceInsert('\n\n')}>
          <CornerDownLeft className="size-3.5" />
          {!compact && <span>插入空行</span>}
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="无序列表"
          onClick={() => onSourceInsert('\n- 项目一\n- 项目二\n')}>
          <List className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="有序列表"
          onClick={() => onSourceInsert('\n1. 第一项\n2. 第二项\n')}>
          <ListOrdered className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="引用"
          onClick={() => onSourceInsert('\n> 引用内容\n')}>
          <Quote className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="代码块"
          onClick={() => onSourceInsert('\n```\n', '\n```\n')}>
          <Code className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="插入表格"
          onClick={() => onSourceInsert(
            '\n| 列1 | 列2 |\n| --- | --- |\n| 数据1 | 数据2 |\n',
          )}>
          <Table className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="plain" className={btnCls} title="插入 LaTeX 公式">
              <Sigma className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {FORMULA_PRESETS.map((p) => (
              <DropdownMenuItem key={p.label} onSelect={() => onSourceInsert(p.block ? `\n${p.md}\n` : p.md)}>
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="plain" className={btnCls} title="插入图表">
              <BarChart3 className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {CHART_PRESETS.map((p) => (
              <DropdownMenuItem
                key={p.label}
                onSelect={() => {
                  const json = JSON.stringify(p.spec, null, 2)
                  const snippet = `\n\`\`\`chart\n${json}\n\`\`\`\n`
                  onSourceInsert(snippet)
                }}
              >
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="插入分页符"
          onClick={() => onSourceInsert('\n===\n')}>
          <SeparatorHorizontal className="size-3.5" />
        </Button>
        {extraTail}
      </div>
    )
  }

  return (
    <div
      className={cn('flex flex-wrap items-center gap-0.5 rounded-md border border-separator/70 bg-fill/40 p-1', className)}
      style={style}
      onPointerDown={onPointerDown}
    >
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.block === 'p' && activeBtnCls)} title="正文"
        aria-pressed={active.block === 'p'} onMouseDown={keepFocus} onClick={() => onBlockTag('p')}>
        <Pilcrow className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.block === 'h1' && activeBtnCls)} title="一级标题"
        aria-pressed={active.block === 'h1'} onMouseDown={keepFocus} onClick={() => onBlockTag('h1')}>
        <Heading1 className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.block === 'h2' && activeBtnCls)} title="二级标题"
        aria-pressed={active.block === 'h2'} onMouseDown={keepFocus} onClick={() => onBlockTag('h2')}>
        <Heading2 className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.block === 'h3' && activeBtnCls)} title="三级标题"
        aria-pressed={active.block === 'h3'} onMouseDown={keepFocus} onClick={() => onBlockTag('h3')}>
        <Heading3 className="size-3.5" />
      </Button>

      <span className="mx-0.5 h-4 w-px bg-separator/60" aria-hidden />

      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.bold && activeBtnCls)} title="加粗"
        aria-pressed={active.bold} onMouseDown={keepFocus} onClick={() => onInlineCommand('bold')}>
        <Bold className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.italic && activeBtnCls)} title="斜体"
        aria-pressed={active.italic} onMouseDown={keepFocus} onClick={() => onInlineCommand('italic')}>
        <Italic className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.underline && activeBtnCls)} title="下划线"
        aria-pressed={active.underline} onMouseDown={keepFocus} onClick={() => onInlineCommand('underline')}>
        <Underline className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.strike && activeBtnCls)} title="删除线"
        aria-pressed={active.strike} onMouseDown={keepFocus} onClick={() => onInlineCommand('strikeThrough')}>
        <Strikethrough className="size-3.5" />
      </Button>

      <span className="mx-0.5 h-4 w-px bg-separator/60" aria-hidden />

      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.align === 'left' && activeBtnCls)} title="左对齐"
        aria-pressed={active.align === 'left'} onMouseDown={keepFocus} onClick={() => onAlign('left')}>
        <AlignLeft className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.align === 'center' && activeBtnCls)} title="居中对齐"
        aria-pressed={active.align === 'center'} onMouseDown={keepFocus} onClick={() => onAlign('center')}>
        <AlignCenter className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.align === 'right' && activeBtnCls)} title="右对齐"
        aria-pressed={active.align === 'right'} onMouseDown={keepFocus} onClick={() => onAlign('right')}>
        <AlignRight className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.align === 'justify' && activeBtnCls)} title="两端对齐"
        aria-pressed={active.align === 'justify'} onMouseDown={keepFocus} onClick={() => onAlign('justify')}>
        <AlignJustify className="size-3.5" />
      </Button>

      <span className="mx-0.5 h-4 w-px bg-separator/60" aria-hidden />

      <Button type="button" size="sm" variant="plain" className={btnCls} title="插入空行"
        onMouseDown={keepFocus} onClick={onInsertEmptyLine}>
        <CornerDownLeft className="size-3.5" />
        <span>{compact ? '空行' : '插入空行'}</span>
      </Button>

      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.ul && activeBtnCls)} title="无序列表"
        aria-pressed={active.ul} onMouseDown={keepFocus} onClick={() => onList(false)}>
        <List className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.ol && activeBtnCls)} title="有序列表"
        aria-pressed={active.ol} onMouseDown={keepFocus} onClick={() => onList(true)}>
        <ListOrdered className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.blockquote && activeBtnCls)} title="引用"
        aria-pressed={active.blockquote} onMouseDown={keepFocus} onClick={onQuote}>
        <Quote className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="plain" className={cn(btnCls, active.pre && activeBtnCls)} title="代码块"
        aria-pressed={active.pre} onMouseDown={keepFocus} onClick={() => onCodeBlock()}>
        <Code className="size-3.5" />
      </Button>

      <span className="mx-0.5 h-4 w-px bg-separator/60" aria-hidden />

      <Button type="button" size="sm" variant="plain" className={btnCls} title="插入表格"
        onMouseDown={keepFocus} onClick={onTable}>
        <Table className="size-3.5" />
      </Button>

      <DropdownMenu onOpenChange={(open) => { if (open) onSaveSelection() }}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="plain" className={btnCls} title="插入 LaTeX 公式" onPointerDown={onSaveSelection}>
            <Sigma className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {FORMULA_PRESETS.map((p) => (
            <DropdownMenuItem key={p.label} onSelect={() => onFormula(p)}>
              {p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu onOpenChange={(open) => { if (open) onSaveSelection() }}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="plain" className={btnCls} title="插入图表" onPointerDown={onSaveSelection}>
            <BarChart3 className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {CHART_PRESETS.map((p) => (
            <DropdownMenuItem
              key={p.label}
              onSelect={() => onCodeBlock('chart', JSON.stringify(p.spec, null, 2))}
            >
              {p.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button type="button" size="sm" variant="plain" className={btnCls} title="插入分页符"
        onMouseDown={keepFocus} onClick={onPageBreak}>
        <SeparatorHorizontal className="size-3.5" />
      </Button>
      {onComponentSettings && (
        <Button type="button" size="sm" variant="plain" className={btnCls} onMouseDown={keepFocus} onClick={onComponentSettings}>
          组件设置
        </Button>
      )}
      {tableBorderControl}
      {onRecoverRichText && (
        <Button type="button" size="sm" variant="tinted" className={btnCls} onMouseDown={keepFocus} onClick={onRecoverRichText}>
          恢复富文本
        </Button>
      )}
      {extraTail}
    </div>
  )
}

export function RichEditorDialog({
  open,
  onOpenChange,
  elId,
  mode,
  onModeChange,
  fmt,
  text,
  editorDocument,
  onCommit,
  onUpgradeRich,
  onImportClick,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  elId: string
  mode: EditorMode
  onModeChange: (m: EditorMode) => void
  fmt: FlowFormat
  text: string
  editorDocument?: FlowTextElement['props']['editor_document']
  onCommit: (nextText: string, nextFmt: FlowFormat, coalesce?: boolean) => void
  onUpgradeRich: () => void
  onImportClick: () => void
}) {
  const dlgSourceRef = React.useRef<HTMLTextAreaElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="flex max-h-[88vh] flex-col gap-3 p-5">
        <DialogHeader className="flex flex-row flex-wrap items-center justify-between gap-2 p-0 pr-8">
          <DialogTitle>文本框富文本编辑器</DialogTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={mode} onValueChange={onModeChange} options={MODE_OPTIONS} size="sm" aria-label="大窗编辑模式" />
            <Button type="button" size="sm" variant="gray" icon={<FileUp />} onClick={onImportClick}>
              导入 MD / Word / HTML
            </Button>
          </div>
        </DialogHeader>

        {mode === 'visual' && fmt !== 'html' && text.trim().length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-accent/10 px-3 py-1.5 text-footnote text-accent">
            <span>当前内容为 {fmt === 'markdown' ? 'Markdown' : '纯文本'}，编辑或使用工具栏将自动转为可排版富文本</span>
            <button
              type="button"
              onClick={onUpgradeRich}
              className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 font-medium hover:bg-accent/15"
            >
              <Sparkles className="size-3.5" />
              转为可排版富文本
            </button>
          </div>
        )}

        <WysiwygSurface
          elId={elId}
          mode={mode}
          fmt={fmt}
          text={text}
          editorDocument={editorDocument}
          compact={false}
          sourceRef={dlgSourceRef}
          onCommit={onCommit}
        />

        <p className="text-footnote text-secondary-label">
          提示：可直接从 Word / 网页 / Markdown 复制粘贴，在可视化模式选中任意行设置居中、对齐或插入空行；LaTeX 公式（<code>$...$</code> / <code>$$...$$</code>）与图表（<code>```chart</code>）将自动转为路径并按纸张文本框跨页排版。
        </p>
      </DialogContent>
    </Dialog>
  )
}
