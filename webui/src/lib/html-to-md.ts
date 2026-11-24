/**
 * Lightweight Word / Web HTML <-> Markdown / Plain converters and HTML sanitizer.
 */

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'hr', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'center',
])

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'strike', 'sup', 'sub',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'span', 'svg', 'math',
])

const SVG_ATTRS = new Set([
  'viewbox', 'width', 'height', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'transform',
  'xmlns', 'opacity', 'text-anchor', 'font-size', 'class',
])

const ALIGN_VALUES = new Set(['left', 'center', 'right', 'justify'])

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function safeHref(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^(?:https?:|mailto:|tel:|#|\/)/i.test(s)) return s
  return null
}

function extractAlign(el: Element): string | null {
  const styleAttr = el.getAttribute('style') ?? ''
  const m = /text-align\s*:\s*(left|center|right|justify)/i.exec(styleAttr)
  if (m) return m[1].toLowerCase()
  const alignAttr = (el.getAttribute('align') ?? '').trim().toLowerCase()
  if (ALIGN_VALUES.has(alignAttr)) return alignAttr
  return null
}

function isPageBreakElement(el: Element): boolean {
  if (el.getAttribute('data-pagebreak') === 'true') return true
  const style = (el.getAttribute('style') ?? '').toLowerCase()
  const cls = (el.getAttribute('class') ?? '').toLowerCase()
  return (
    (style.includes('page-break-after') && style.includes('always')) ||
    (style.includes('page-break-before') && style.includes('always')) ||
    cls.includes('pagebreak')
  )
}

function isMathOrChartSpecial(el: Element): boolean {
  if (el.hasAttribute('data-chart')) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'svg' || tag === 'math') return true
  for (const cls of el.classList) {
    if (cls === 'katex' || cls.startsWith('katex-') || cls === 'math-inline' || cls === 'math-display' || cls.startsWith('language-')) {
      return true
    }
  }
  return false
}

function hasBlockDescendant(el: Element): boolean {
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase()
    if (BLOCK_TAGS.has(tag) || hasBlockDescendant(child)) return true
  }
  return false
}

function isVisuallyEmptyLeaf(el: Element): boolean {
  if (el.querySelectorAll('br').length > 1) return false
  if (el.querySelector('svg, math, [data-chart], [data-pagebreak], img, table, pre, hr')) return false
  const txt = (el.textContent ?? '').replace(/[\t ]*[\r\n][\t \r\n]*|[\u200b\ufeff]/g, '')
  return txt.length === 0
}

export function isEmptyList(el: Element): boolean {
  return el.matches('ol, ul') &&
    !(el.textContent ?? '').replace(/[\s\u200b\ufeff]+/g, '') &&
    !el.querySelector('svg, math, .math-inline, .math-display, [data-chart], [data-pagebreak], img, table, pre, hr')
}

function unwrapElement(el: Element): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

function wrapChildrenWithTag(el: Element, tagName: string): void {
  const doc = el.ownerDocument
  const wrapper = doc.createElement(tagName)
  while (el.firstChild) wrapper.appendChild(el.firstChild)
  el.appendChild(wrapper)
}

function renameElement(el: Element, newTag: string): Element {
  const next = el.ownerDocument.createElement(newTag)
  for (const attr of [...el.attributes]) next.setAttribute(attr.name, attr.value)
  while (el.firstChild) next.appendChild(el.firstChild)
  el.parentNode?.replaceChild(next, el)
  return next
}

function cleanStyleAttribute(el: Element, keepInlineMathStyle: boolean): void {
  const rawStyle = el.getAttribute('style') ?? ''
  // Remove mso-* rules before checking anything else
  const filteredParts: string[] = []
  const align = extractAlign(el)
  if (align) filteredParts.push(`text-align:${align}`)
  if (isPageBreakElement(el)) filteredParts.push('page-break-after: always')

  if (keepInlineMathStyle && rawStyle) {
    for (const decl of rawStyle.split(';')) {
      const idx = decl.indexOf(':')
      if (idx <= 0) continue
      const prop = decl.slice(0, idx).trim().toLowerCase()
      const val = decl.slice(idx + 1).trim()
      if (!prop || !val || prop.startsWith('mso-') || prop === 'text-align' || prop.startsWith('page-break')) continue
      if (!/url\s*\(|expression\s*\(/i.test(val)) {
        filteredParts.push(`${prop}:${val}`)
      }
    }
  }

  if (filteredParts.length > 0) el.setAttribute('style', filteredParts.join('; '))
  else el.removeAttribute('style')
  el.removeAttribute('align')
}

function cleanClassAttribute(el: Element, inKatexOrMath: boolean): void {
  if (inKatexOrMath) {
    const cls = el.getAttribute('class')
    if (cls === '') el.removeAttribute('class')
    return
  }
  const kept = [...el.classList].filter(
    (c) => c === 'katex' || c.startsWith('katex-') || c === 'math-inline' || c === 'math-display' || c.startsWith('language-') || c === 'pagebreak',
  )
  if (kept.length > 0) el.setAttribute('class', kept.join(' '))
  else el.removeAttribute('class')
}

export function sanitizePastedHtml(rawHtml: string, { discardEmptyLists = false } = {}): string {
  const preCleaned = rawHtml
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!\[if[^\]]*\]>/gi, '')
    .replace(/<!\[endif\]>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const doc = new DOMParser().parseFromString(preCleaned, 'text/html')
  for (const sentinel of doc.querySelectorAll('br[data-editor-sentinel]')) sentinel.remove()

  for (const el of doc.body.querySelectorAll('.katex-display, .katex, math')) {
    if (!doc.body.contains(el)) continue
    const latex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
    if (!latex) continue
    const block = el.matches('.katex-display, math[display="block"]')
    const component = doc.createElement(block ? 'div' : 'span')
    component.className = block ? 'math-display' : 'math-inline'
    component.textContent = latex
    el.replaceWith(component)
  }

  for (const el of doc.querySelectorAll('script, style, meta, link, title, xml, noscript, iframe, object, embed, o\\:p')) {
    el.remove()
  }
  for (const el of [...doc.body.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase()
    if (/^(?:o|w|v|m|st1):/i.test(tag)) {
      el.remove()
    } else if (tag === 'br' && el.classList.contains('Apple-interchange-newline')) {
      el.remove()
    }
  }

  const sanitizeNode = (el: Element, inSvg: boolean, inKatexOrMath: boolean): void => {
    const tag = el.tagName.toLowerCase()
    const nextInSvg = inSvg || tag === 'svg'
    const nextInMath = inKatexOrMath || tag === 'math' ||
      el.matches('.katex, .katex-display, span.math-inline, div.math-display')

    // Process children bottom-up or snapshot first
    for (const child of [...el.children]) {
      sanitizeNode(child, nextInSvg, nextInMath)
    }

    if (!el.parentNode) return

    if (nextInSvg) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on') || (!SVG_ATTRS.has(name) && name !== 'style')) {
          el.removeAttribute(attr.name)
        }
      }
      cleanStyleAttribute(el, false)
      return
    }

    if (nextInMath) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name)
        } else if (!(name === 'data-border' && attr.value === 'box' &&
                     el.matches('span.math-inline, div.math-display')) &&
                   !['class', 'style', 'encoding', 'display', 'xmlns', 'aria-hidden', 'mathvariant', 'stretchy'].includes(name)) {
          el.removeAttribute(attr.name)
        }
      }
      cleanStyleAttribute(el, el.classList.contains('katex') || !!el.closest('.katex'))
      cleanClassAttribute(el, true)
      return
    }

    if (tag === 'center') {
      const p = renameElement(el, 'p')
      p.setAttribute('style', 'text-align:center')
      for (const attr of [...p.attributes]) {
        if (attr.name.toLowerCase() !== 'style') p.removeAttribute(attr.name)
      }
      return
    }

    // Google Docs / browser wrap normal text in <b style="font-weight:normal">
    if (tag === 'b' || tag === 'strong') {
      const st = (el.getAttribute('style') ?? '').toLowerCase()
      if (/font-weight\s*:\s*(?:normal|400)\b/.test(st)) {
        unwrapElement(el)
        return
      }
    }
    if (tag === 'i' || tag === 'em') {
      const st = (el.getAttribute('style') ?? '').toLowerCase()
      if (/font-style\s*:\s*normal\b/.test(st)) {
        unwrapElement(el)
        return
      }
    }

    if (tag === 'span') {
      if (!isMathOrChartSpecial(el)) {
        const st = (el.getAttribute('style') ?? '').toLowerCase()
        const isBold = /font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/.test(st)
        const isItalic = /font-style\s*:\s*(?:italic|oblique)\b/.test(st)
        const isUnder = /text-decoration(?:-line)?\s*:[^;]*underline/.test(st)
        const isStrike = /text-decoration(?:-line)?\s*:[^;]*line-through/.test(st)
        const isSup = /vertical-align\s*:\s*super\b/.test(st)
        const isSub = /vertical-align\s*:\s*sub\b/.test(st)
        if (isSup) wrapChildrenWithTag(el, 'sup')
        if (isSub) wrapChildrenWithTag(el, 'sub')
        if (isStrike) wrapChildrenWithTag(el, 's')
        if (isUnder) wrapChildrenWithTag(el, 'u')
        if (isItalic) wrapChildrenWithTag(el, 'em')
        if (isBold) wrapChildrenWithTag(el, 'strong')
        unwrapElement(el)
        return
      }
    }

    if (!ALLOWED_TAGS.has(tag)) {
      if (BLOCK_TAGS.has(tag) && !hasBlockDescendant(el)) {
        const p = renameElement(el, 'p')
        cleanStyleAttribute(p, false)
        for (const attr of [...p.attributes]) {
          if (attr.name.toLowerCase() !== 'style') p.removeAttribute(attr.name)
        }
        if (isVisuallyEmptyLeaf(p)) p.innerHTML = '<br>'
        return
      }
      unwrapElement(el)
      return
    }

    // Clean attributes on allowed tags
    const isPb = isPageBreakElement(el)
    cleanStyleAttribute(el, false)
    cleanClassAttribute(el, false)

    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name === 'style' || name === 'class' || name === 'data-chart') continue
      if (tag === 'table' && name === 'data-border' && ['none', 'vertical', 'grid'].includes(attr.value)) continue
      if (tag === 'table' && name === 'data-border-edges' &&
          attr.value.split(/\s+/).every((edge) => !edge || ['top', 'right', 'bottom', 'left', 'horizontal', 'vertical'].includes(edge))) continue
      if (name === 'data-pagebreak' && isPb) continue
      if (tag === 'a' && name === 'href') {
        const safe = safeHref(attr.value)
        if (safe) el.setAttribute('href', safe)
        else el.removeAttribute(attr.name)
        continue
      }
      if ((tag === 'th' || tag === 'td') && (name === 'colspan' || name === 'rowspan')) continue
      if (tag === 'ol' && name === 'start') continue
      el.removeAttribute(attr.name)
    }

    if (isPb) {
      el.setAttribute('data-pagebreak', 'true')
      el.setAttribute('style', 'page-break-after: always')
      el.innerHTML = ''
      return
    }

    // Unwrap pure layout wrapper <div>s (after propagating any text-align to block children)
    if (tag === 'div' && !isMathOrChartSpecial(el) && hasBlockDescendant(el)) {
      const parentAlign = extractAlign(el)
      if (parentAlign) {
        for (const child of el.children) {
          const ctag = child.tagName.toLowerCase()
          if (BLOCK_TAGS.has(ctag) && !extractAlign(child)) {
            child.setAttribute('style', `text-align:${parentAlign}${child.getAttribute('style') ? `; ${child.getAttribute('style')}` : ''}`)
          }
        }
      }
      if (!el.getAttribute('class')) {
        unwrapElement(el)
      }
      return
    }

    // Preserve empty paragraphs / leaf divs cleanly
    if ((tag === 'p' || tag === 'div') && !hasBlockDescendant(el) && isVisuallyEmptyLeaf(el)) {
      el.innerHTML = '<br>'
    }
  }

  if (doc.body) {
    for (const child of [...doc.body.children]) {
      sanitizeNode(child, false, false)
    }
    if (discardEmptyLists) {
      for (const list of doc.body.querySelectorAll('ol, ul')) {
        if (isEmptyList(list)) list.remove()
      }
    }
    return doc.body.innerHTML.trim()
  }
  return rawHtml.trim()
}

function wrapMarkdownInline(text: string, marker: string): string {
  const body = text.trim()
  return body ? text.replace(body, () => marker + body + marker) : text
}

export function htmlToMarkdown(rawHtml: string): string {
  const cleaned = rawHtml
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const doc = new DOMParser().parseFromString(cleaned, 'text/html')
  for (const el of doc.querySelectorAll('script, style, meta, link, title, xml, o\\:p')) {
    el.remove()
  }

  const walk = (node: Node, listDepth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').replace(/[ \t]*[\r\n]+[ \t\r\n]*/g, ' ').replaceAll('\u00a0', ' ')
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as Element
    const tag = el.tagName.toLowerCase()

    if (isPageBreakElement(el)) return '\n\n===\n\n'
    if (tag === 'svg') return `\n\n${el.outerHTML}\n\n`
    if (el.hasAttribute('data-chart')) {
      return `\n\n\`\`\`chart\n${el.getAttribute('data-chart')}\n\`\`\`\n\n`
    }
    if (el.classList.contains('katex-html')) return ''
    if (el.matches('div.math-display, span.math-inline')) {
      const tex = el.textContent?.trim() ?? ''
      if (el.matches('div.math-display')) return `\n\n$$\n${tex}\n$$\n\n`
      return `$${tex}$`
    }
    if (el.classList.contains('katex-display')) {
      const tex = el.querySelector('annotation')?.textContent?.trim()
      if (tex) return `\n\n$$\n${tex}\n$$\n\n`
    }
    if (el.classList.contains('katex') || tag === 'math') {
      const tex = el.querySelector('annotation')?.textContent?.trim()
      if (tex) {
        const isBlock = tag === 'math' && el.getAttribute('display') === 'block'
        return isBlock ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`
      }
    }

    const inner = () => [...el.childNodes].map((c) => walk(c, listDepth)).join('')

    switch (tag) {
      case 'br':
        // A literal break is needed where a newline would finish a table
        // row, list item, or paragraph instead of advancing within it.
        return listDepth > 0 || el.closest('td, th') || !el.previousSibling || !el.nextSibling ||
          el.previousSibling instanceof HTMLBRElement || el.nextSibling instanceof HTMLBRElement ||
          !el.parentElement?.matches('p, div, body')
          ? '<br>' : '\n'
      case 'hr':
        return '\n\n---\n\n'
      case 'h1':
        return `\n\n# ${inner().trim()}\n\n`
      case 'h2':
        return `\n\n## ${inner().trim()}\n\n`
      case 'h3':
        return `\n\n### ${inner().trim()}\n\n`
      case 'h4':
        return `\n\n#### ${inner().trim()}\n\n`
      case 'h5':
        return `\n\n##### ${inner().trim()}\n\n`
      case 'h6':
        return `\n\n###### ${inner().trim()}\n\n`
      case 'p':
      case 'div': {
        if (!hasBlockDescendant(el) && isVisuallyEmptyLeaf(el)) {
          return '\n\n\u200BBLANK\u200B\n\n'
        }
        const s = inner().replace(/^\n+|\n+$/g, '')
        return s ? `\n\n${s}\n\n` : ''
      }
      case 'strong':
      case 'b': {
        return wrapMarkdownInline(inner(), '**')
      }
      case 'em':
      case 'i': {
        return wrapMarkdownInline(inner(), '*')
      }
      case 'u':
      case 'ins': {
        const s = inner().trim()
        return s ? `<u>${s}</u>` : ''
      }
      case 's':
      case 'del':
      case 'strike': {
        return wrapMarkdownInline(inner(), '~~')
      }
      case 'sup': {
        const s = inner().trim()
        return s ? `<sup>${s}</sup>` : ''
      }
      case 'sub': {
        const s = inner().trim()
        return s ? `<sub>${s}</sub>` : ''
      }
      case 'code': {
        if (el.parentElement?.tagName.toLowerCase() === 'pre') return el.textContent ?? ''
        const s = (el.textContent ?? '').trim()
        return s ? `\`${s}\`` : ''
      }
      case 'pre': {
        const codeEl = el.querySelector('code')
        const cls = codeEl?.getAttribute('class') ?? ''
        const lang = /language-([\w+-]+)/.exec(cls)?.[1] ?? ''
        const body = (codeEl?.textContent ?? el.textContent ?? '').replace(/\n+$/, '')
        return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`
      }
      case 'blockquote': {
        const lines = inner()
          .trim()
          .split('\n')
          .map((l) => `> ${l.replace(/\u200BBLANK\u200B/g, '').trim()}`)
        return `\n\n${lines.join('\n')}\n\n`
      }
      case 'ul':
      case 'ol': {
        if (isEmptyList(el)) return ''
        const ordered = tag === 'ol'
        const items: string[] = []
        let idx = ordered ? (el as HTMLOListElement).start : 1
        for (const child of el.children) {
          if (child.tagName.toLowerCase() !== 'li') continue
          const pad = '  '.repeat(listDepth)
          const marker = ordered ? `${idx++}. ` : '- '
          const txt = [...child.childNodes]
            .map((c) => walk(c, listDepth + 1))
            .join('')
            .replace(/\u200BBLANK\u200B/g, '')
            .trim()
            .replace(/\n{2,}/g, '\n')
          const [first, ...continuation] = txt.split('\n')
          const indent = pad + ' '.repeat(marker.length)
          items.push(`${pad}${marker}${first}` + continuation.map(
            (line) => `\n${line.startsWith(pad + '  ') ? line : indent + line}`,
          ).join(''))
        }
        return `\n\n${items.join('\n')}\n\n`
      }
      case 'table': {
        const rows: { cells: string[]; aligns: string[] }[] = []
        for (const tr of el.querySelectorAll('tr')) {
          const cellEls = [...tr.querySelectorAll('th, td')]
          const cells = cellEls.map((td) =>
            walk(td, listDepth)
              .replace(/\u200BBLANK\u200B/g, '')
              .trim()
              .replace(/\s*\n\s*/g, ' ')
              .replace(/\|/g, '\\|'),
          )
          const aligns = cellEls.map((td) => extractAlign(td) ?? 'left')
          if (cells.length) rows.push({ cells, aligns })
        }
        if (!rows.length) return ''
        const ncols = Math.max(...rows.map((r) => r.cells.length))
        const padRow = (r: string[]) => `| ${Array.from({ length: ncols }, (_, i) => r[i] ?? '').join(' | ')} |`
        const sepCell = (a?: string) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---')
        const sep = `| ${Array.from({ length: ncols }, (_, i) => sepCell(rows[0].aligns[i])).join(' | ')} |`
        return `\n\n${[padRow(rows[0].cells), sep, ...rows.slice(1).map((r) => padRow(r.cells))].join('\n')}\n\n`
      }
      case 'a': {
        const label = inner().trim()
        const href = el.getAttribute('href')
        return href && label ? `[${label}](${href})` : label
      }
      default:
        return inner()
    }
  }

  const raw = doc.body ? walk(doc.body) : ''
  // Reconstruct blocks while preserving intentional blank lines as extra newlines
  const tokens = raw.split(/\n{2,}/).map((t) => t.replace(/^\n+|\n+$/g, '')).filter((t) => t.trim().length > 0)
  let out = ''
  let blanks = 0
  let seenContent = false
  for (const tok of tokens) {
    if (tok === '\u200BBLANK\u200B') {
      blanks++
      continue
    }
    if (seenContent) {
      out += '\n'.repeat(2 + blanks)
    } else if (blanks > 0) {
      out += '\n'.repeat(blanks)
    }
    out += tok
    blanks = 0
    seenContent = true
  }
  if (blanks > 0) {
    out += seenContent ? '\n'.repeat(1 + blanks) : '\n'.repeat(blanks)
  }
  return out
}

// ------------------------------------------------------------------ Markdown / Plain -> HTML

// Keep these bare-expression forms synchronized with penplot/rich_text.py.
const BARE_TEX_TERMS = [
  String.raw`(?:\d+(?:\.\d+)?(?:\\[,;: ]|[ \t])*)?\^\s*(?:\{\s*\\circ\s*\}|\\circ(?![A-Za-z]))(?:[ \t]*(?:\\(?:text|mathrm)\{\s*C\s*\}|C(?![A-Za-z])))?`,
  String.raw`(?:\d+(?:\.\d+)?[ \t]*)?(?:℃|°[ \t]*C(?![A-Za-z])|°)`,
  String.raw`(?:[+-]?\d+(?:\.\d+)?[ \t]*)?\\(?:text|mathrm)\{[^{}\n]+\}`,
  String.raw`[A-Za-z0-9()]+[\^_]\{[^{}]*\\[A-Za-z]+[^{}]*\}(?:\s*[+\-*/=<>]\s*[A-Za-z0-9()\\^{}_+\-*/=<> ]*)?`,
  String.raw`(?:\([A-Za-z0-9]+\)|[A-Za-z0-9]+)?\\(?:frac|dfrac|tfrac|bar|overline|underline|hat|widehat|vec|sqrt|lim|sum|prod|int|iint|oint|pi|phi|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega|Delta|Omega|infty|pm|mp|times|div|cdot|to|rightarrow|leftarrow|Rightarrow|leq|geq|neq|approx|partial|nabla|sin|cos|tan|log|ln|exp)(?![A-Za-z])(?:[A-Za-z0-9\s+\-*/=<>^_{}()\[\]\\.,]*[A-Za-z0-9)}\\]|[^{}\s]*)`,
]
export const BARE_TEX_SOURCE = String.raw`(?<![A-Za-z0-9_\\])(?:${BARE_TEX_TERMS.join('|')})`

export function formulaHtml(latex: string, block: boolean): string {
  const tag = block ? 'div' : 'span'
  return `<${tag} class="math-${block ? 'display' : 'inline'}">${escapeHtml(latex)}</${tag}>`
}

const TEX_BRACKETS = String.raw`\\\((?:\\.|[^\\])+?\\\)|\\\[(?:\\.|[^\\])+?\\\]`
const TEX_DOLLARS = String.raw`(?<![\\$])\$\$(?!\$)(?:\\.|[^$\n])+?\$\$(?!\$)|(?<![\\$])\$(?![\s$])(?:\\.|[^$\n])+?(?<![\s$])\$(?!\$)`
export const DELIMITED_FORMULA_SOURCE = `${TEX_BRACKETS}|${TEX_DOLLARS}`

export function formulaBody(token: string): string {
  const edge = token.startsWith('$') && !token.startsWith('$$') ? 1 : 2
  return token.slice(edge, -edge).trim()
}

const INLINE_MD_SOURCE = [
  `(${TEX_BRACKETS})`,
  `(${TEX_DOLLARS})`,
  '(`+[^`]+`+)', // `code`
  '(<br\\s*/?>)', // <br>
  '(<(u|sup|sub|s|del|strong|b|em|i)>([\\s\\S]*?)</\\6>)', // inline HTML tags
  '(\\*{3}(?=\\S)(?:\\\\.|[^*])+?(?<=\\S)\\*{3})', // ***bold italic***
  '(\\*{2}(?=\\S)(?:\\\\.|[^*]|\\*(?!\\*))+?(?<=\\S)\\*{2})', // **bold**
  '(__(?=\\S)(?:\\\\.|[^_]|_(?!_))+?(?<=\\S)__)', // __bold__
  '(~~(?=\\S)(?:\\\\.|[^~]|~(?!~))+?(?<=\\S)~~)', // ~~strike~~
  '(\\*(?=\\S)(?:\\\\.|[^*])+?(?<=\\S)\\*)', // *italic*
  '((?<![A-Za-z0-9])_(?=\\S)(?:\\\\.|[^_])+?(?<=\\S)_(?![A-Za-z0-9]))', // _italic_
  '(!\\[([^\\]]*)\\]\\([^)]+\\))', // ![alt](url)
  '(\\[([^\\]]+)\\]\\(([^)]+)\\))', // [label](url)
].join('|')

function parseInlineMdToHtml(text: string): string {
  if (!text) return ''
  let out = ''
  let pos = 0
  // Each recursive call needs its own RegExp instance so lastIndex is not reset mid-loop.
  const re = new RegExp(INLINE_MD_SOURCE, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > pos) {
      out += escapeHtml(text.slice(pos, m.index))
    }
    const tok = m[0]
    if (m[1] || m[2]) {
      out += formulaHtml(formulaBody(tok), false)
    } else if (m[3]) {
      // `code`
      const stripped = tok.replace(/^`+|`+$/g, '')
      out += `<code>${escapeHtml(stripped)}</code>`
    } else if (m[4]) {
      // <br>
      out += '<br>'
    } else if (m[5]) {
      // <u>, <sup>, <sub>, <s>, <del>, <strong>, <b>, <em>, <i>
      const rawTag = (m[6] ?? '').toLowerCase()
      const innerMd = m[7] ?? ''
      const normTag =
        rawTag === 'b' ? 'strong' : rawTag === 'i' ? 'em' : rawTag === 'del' ? 's' : rawTag
      out += `<${normTag}>${parseInlineMdToHtml(innerMd)}</${normTag}>`
    } else if (m[8]) {
      // ***bold italic***
      out += `<strong><em>${parseInlineMdToHtml(tok.slice(3, -3))}</em></strong>`
    } else if (m[9] || m[10]) {
      // **bold** or __bold__
      out += `<strong>${parseInlineMdToHtml(tok.slice(2, -2))}</strong>`
    } else if (m[11]) {
      // ~~strike~~
      out += `<s>${parseInlineMdToHtml(tok.slice(2, -2))}</s>`
    } else if (m[12] || m[13]) {
      // *italic* or _italic_
      out += `<em>${parseInlineMdToHtml(tok.slice(1, -1))}</em>`
    } else if (m[14]) {
      // ![alt](url)
      const alt = m[15] ?? ''
      out += alt ? escapeHtml(`[${alt}]`) : ''
    } else if (m[16]) {
      // [label](url)
      const label = m[17] ?? ''
      const href = safeHref(m[18] ?? '')
      const labelHtml = parseInlineMdToHtml(label)
      out += href ? `<a href="${escapeHtml(href)}">${labelHtml}</a>` : labelHtml
    }
    pos = m.index + tok.length
  }
  if (pos < text.length) {
    out += escapeHtml(text.slice(pos))
  }
  return out
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE_RE = /^(`{3,}|~{3,})\s*([\w+-]*)\s*$/
const HR_RE = /^\s*(?:[-*_]\s*){3,}\s*$/
const PAGEBREAK_RE = /^\s*(?:={3,}|\\newpage|\\pagebreak|<!--\s*pagebreak\s*-->)\s*$/i
const UL_RE = /^(\s*)[-*+]\s+(.*)$/
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*(?::?-{1,}:?\s*\|\s*)*:?-+:?\s*\|?\s*$/

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // Handle escaped \| inside cells
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += s[i]
    }
  }
  cells.push(cur.trim())
  return cells
}

function parseTableAligns(sepLine: string, ncols: number): ('left' | 'center' | 'right')[] {
  const cells = splitTableRow(sepLine)
  const aligns: ('left' | 'center' | 'right')[] = []
  for (let i = 0; i < ncols; i++) {
    const c = (cells[i] ?? '').trim()
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center')
    else if (c.endsWith(':')) aligns.push('right')
    else aligns.push('left')
  }
  return aligns
}

function joinParagraphLines(plines: string[]): string {
  let acc = ''
  for (let idx = 0; idx < plines.length; idx++) {
    const raw = plines[idx].trimEnd()
    const cleaned = idx < plines.length - 1 ? raw.replace(/(?<!\\)\\$/, '') : raw
    acc += parseInlineMdToHtml(cleaned)
    if (idx < plines.length - 1) {
      acc += '<br>'
    }
  }
  return acc
}

function readDisplayMath(lines: string[], start: number, parentIndent?: number): { latex: string; end: number } | null {
  const first = lines[start].trim()
  const close = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\]' : null
  if (!close) return null
  if (first.length > 4 && first.endsWith(close)) return { latex: first.slice(2, -2).trim(), end: start + 1 }
  const body = [first.slice(2)]
  for (let index = start + 1; index < lines.length; index++) {
    const raw = lines[index]
    const line = raw.trim()
    if (parentIndent !== undefined && line && raw.length - raw.trimStart().length <= parentIndent) break
    if (line.startsWith('\\[') || (line.startsWith('$$') && line !== '$$')) break
    if (line.endsWith(close)) {
      body.push(line.slice(0, -2))
      return { latex: body.join('\n').trim(), end: index + 1 }
    }
    body.push(lines[index])
  }
  return null
}

export function markdownToHtml(md: string): string {
  const normalized = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) {
    const emptyCount = normalized.split('\n').length - 1
    return emptyCount > 0 ? '<p><br></p>'.repeat(emptyCount) : ''
  }

  const lines = normalized.split('\n')
  const n = lines.length
  const htmlBlocks: string[] = []
  let i = 0
  let pendingBlanks = 0
  let hasContentBlock = false

  const flushPendingBlanks = () => {
    if (pendingBlanks <= 0) return
    // Between two MD blocks, 1 blank line is the standard block separator; extra blank lines become <p><br></p>.
    const extra = hasContentBlock ? pendingBlanks - 1 : pendingBlanks
    for (let k = 0; k < extra; k++) {
      htmlBlocks.push('<p><br></p>')
    }
    pendingBlanks = 0
  }

  while (i < n) {
    const line = lines[i]
    const stripped = line.trim()

    if (!stripped) {
      pendingBlanks++
      i++
      continue
    }

    flushPendingBlanks()

    // Page break
    if (PAGEBREAK_RE.test(line)) {
      htmlBlocks.push('<div style="page-break-after: always" data-pagebreak="true"></div>')
      hasContentBlock = true
      i++
      continue
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      htmlBlocks.push('<hr>')
      hasContentBlock = true
      i++
      continue
    }

    // Fenced code block
    const fm = FENCE_RE.exec(line)
    if (fm) {
      const fence = fm[1]
      const lang = fm[2].toLowerCase()
      i++
      const bodyLines: string[] = []
      while (i < n && !lines[i].trim().startsWith(fence)) {
        bodyLines.push(lines[i])
        i++
      }
      if (i < n) i++
      const body = bodyLines.join('\n')
      if (lang === 'svg' && body.toLowerCase().includes('<svg')) {
        htmlBlocks.push(sanitizePastedHtml(body))
      } else if (['math', 'latex', 'tex'].includes(lang)) {
        htmlBlocks.push(formulaHtml(body.trim(), true))
      } else if (lang) {
        htmlBlocks.push(`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(body)}</code></pre>`)
      } else {
        htmlBlocks.push(`<pre><code>${escapeHtml(body)}</code></pre>`)
      }
      hasContentBlock = true
      continue
    }

    const display = readDisplayMath(lines, i)
    if (display) {
      htmlBlocks.push(formulaHtml(display.latex, true))
      hasContentBlock = true
      i = display.end
      continue
    }

    // Inline <svg> ... </svg>
    if (stripped.toLowerCase().startsWith('<svg')) {
      const svgLines = [line]
      if (!stripped.toLowerCase().includes('</svg>')) {
        i++
        while (i < n) {
          svgLines.push(lines[i])
          if (lines[i].toLowerCase().includes('</svg>')) {
            i++
            break
          }
          i++
        }
      } else {
        i++
      }
      htmlBlocks.push(sanitizePastedHtml(svgLines.join('\n')))
      hasContentBlock = true
      continue
    }

    // Inline HTML <table> ... </table>
    if (stripped.toLowerCase().startsWith('<table')) {
      const tblLines = [line]
      if (!stripped.toLowerCase().includes('</table>')) {
        i++
        while (i < n) {
          tblLines.push(lines[i])
          if (lines[i].toLowerCase().includes('</table>')) {
            i++
            break
          }
          i++
        }
      } else {
        i++
      }
      htmlBlocks.push(sanitizePastedHtml(tblLines.join('\n')))
      hasContentBlock = true
      continue
    }

    // ATX Heading
    const hm = HEADING_RE.exec(line)
    if (hm) {
      const level = hm[1].length
      htmlBlocks.push(`<h${level}>${parseInlineMdToHtml(hm[2])}</h${level}>`)
      hasContentBlock = true
      i++
      continue
    }

    // GFM Table
    if (line.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1])) {
      const headerCells = splitTableRow(line)
      const ncols = headerCells.length
      const aligns = parseTableAligns(lines[i + 1], ncols)
      i += 2
      const bodyRows: string[][] = []
      while (i < n && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitTableRow(lines[i])
        while (cells.length < ncols) cells.push('')
        bodyRows.push(cells.slice(0, ncols))
        i++
      }
      const ths = headerCells.map((c, idx) => `<th style="text-align:${aligns[idx]}">${parseInlineMdToHtml(c)}</th>`).join('')
      const trs = bodyRows
        .map((row) => `<tr>${row.map((c, idx) => `<td style="text-align:${aligns[idx]}">${parseInlineMdToHtml(c)}</td>`).join('')}</tr>`)
        .join('')
      htmlBlocks.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`)
      hasContentBlock = true
      continue
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const qlines: string[] = []
      while (i < n) {
        const qm = QUOTE_RE.exec(lines[i])
        if (!qm) break
        qlines.push(qm[1])
        i++
      }
      const innerHtml = markdownToHtml(qlines.join('\n'))
      htmlBlocks.push(`<blockquote>${innerHtml || '<p><br></p>'}</blockquote>`)
      hasContentBlock = true
      continue
    }

    // List (ul / ol)
    const um = UL_RE.exec(line)
    const om = OL_RE.exec(line)
    if (um || om) {
      const ordered = Boolean(om)
      const baseIndent = (om ?? um)![1].length
      const start = om ? Number(om[2]) : 1
      const liParts: string[] = []
      let itemHasBlocks = false

      while (i < n) {
        const curLine = lines[i]
        if (!curLine.trim()) break
        const curU = UL_RE.exec(curLine)
        const curO = OL_RE.exec(curLine)
        const mCur = ordered ? curO : curU
        if (mCur && mCur[1].length === baseIndent) {
          const txt = ordered ? mCur[3] : mCur[2]
          liParts.push(parseInlineMdToHtml(txt))
          itemHasBlocks = false
          i++
        } else if ((curU || curO) && (curU ?? curO)![1].length > baseIndent) {
          const subIndent = (curU ?? curO)![1].length
          const subLines: string[] = []
          while (i < n && (!lines[i].trim() || lines[i].length - lines[i].trimStart().length >= subIndent)) {
            subLines.push(lines[i].length >= subIndent ? lines[i].slice(subIndent) : lines[i])
            i++
          }
          if (liParts.length > 0) {
            liParts[liParts.length - 1] += markdownToHtml(subLines.join('\n'))
            itemHasBlocks = true
          }
        } else if (!curU && !curO && liParts.length && curLine.length - curLine.trimStart().length > baseIndent) {
          const display = readDisplayMath(lines, i, baseIndent)
          if (display) {
            liParts[liParts.length - 1] += formulaHtml(display.latex, true)
            itemHasBlocks = true
            i = display.end
          } else {
            const content = parseInlineMdToHtml(curLine.trim())
            liParts[liParts.length - 1] += itemHasBlocks ? `<p>${content}</p>` : '<br>' + content
            i++
          }
        } else {
          break
        }
      }

      const tag = ordered ? 'ol' : 'ul'
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : ''
      htmlBlocks.push(`<${tag}${startAttr}>${liParts.map((p) => `<li>${p}</li>`).join('')}</${tag}>`)
      hasContentBlock = true
      continue
    }

    // Paragraph
    const plines: string[] = []
    while (i < n) {
      const cur = lines[i]
      const cs = cur.trim()
      if (
        !cs ||
        HEADING_RE.test(cur) ||
        FENCE_RE.test(cur) ||
        HR_RE.test(cur) ||
        PAGEBREAK_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur) ||
        readDisplayMath(lines, i) !== null ||
        cs.toLowerCase().startsWith('<svg') ||
        cs.toLowerCase().startsWith('<table')
      ) {
        break
      }
      if (cur.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1])) {
        break
      }
      plines.push(cur)
      i++
    }
    htmlBlocks.push(`<p>${joinParagraphLines(plines)}</p>`)
    hasContentBlock = true
  }

  // Trailing explicit blank lines (e.g. "hello\n\n" -> trailing blankCount = 2 -> 1 extra blank line)
  if (pendingBlanks > 1) {
    for (let k = 0; k < pendingBlanks - 1; k++) {
      htmlBlocks.push('<p><br></p>')
    }
  }

  return htmlBlocks.join('')
}

export function plainToHtml(text: string): string {
  if (!text) return ''
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return lines.map((line) => (line.length > 0 ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>')).join('')
}

export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false
  return /(^|\n)#{1,6}\s|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\((?:\\.|[^\\])+?\\\)|\$(?!\s)(?:\\.|[^$\n])+?(?<!\s)\$|(^|\n)(?:```|~~~)|(^|\n)\|.+\|\s*\n\s*\|[\s:-]+\||\*\*[^*\n]+\*\*|~~[^~\n]+~~|(^|\n)\s*[-*+]\s+\S|(^|\n)\s*\d+[.)]\s+\S|(^|\n)\s*>\s+\S|(^|\n)\s*={3,}\s*$|(^|\n)\s*---\s*$/m.test(
    text,
  )
}
