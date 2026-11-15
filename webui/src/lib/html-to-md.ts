/**
 * Lightweight Word / Web HTML -> Markdown converter and HTML sanitizer for clipboard paste.
 */

export function sanitizePastedHtml(rawHtml: string): string {
  const doc = new DOMParser().parseFromString(
    rawHtml.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, ''),
    'text/html',
  )
  for (const el of doc.querySelectorAll('script, style, meta, link, title, xml, o\\:p')) {
    el.remove()
  }
  const cleanNode = (el: Element) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name === 'style') {
        const align = /text-align\s*:\s*(left|center|right|justify)/i.exec(attr.value)
        if (align) el.setAttribute('style', `text-align:${align[1].toLowerCase()}`)
        else el.removeAttribute('style')
      } else if (!['href', 'colspan', 'rowspan', 'align', 'class', 'data-chart', 'viewbox', 'width', 'height', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'points'].includes(name)) {
        el.removeAttribute(attr.name)
      }
    }
    for (const child of el.children) cleanNode(child)
  }
  if (doc.body) {
    for (const child of doc.body.children) cleanNode(child)
    return doc.body.innerHTML.trim()
  }
  return rawHtml.trim()
}

export function htmlToMarkdown(rawHtml: string): string {
  const cleaned = rawHtml.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
  const doc = new DOMParser().parseFromString(cleaned, 'text/html')
  for (const el of doc.querySelectorAll('script, style, meta, link, title, xml')) {
    el.remove()
  }
  const walk = (node: Node, listDepth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').replace(/\s+/g, ' ')
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as Element
    const tag = el.tagName.toLowerCase()

    if (tag === 'svg') return `\n\n${el.outerHTML}\n\n`
    if (el.hasAttribute('data-chart')) {
      return `\n\n\`\`\`chart\n${el.getAttribute('data-chart')}\n\`\`\`\n\n`
    }
    if (el.classList.contains('katex-html')) return ''
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
      case 'br': return '\n'
      case 'hr': return '\n\n---\n\n'
      case 'h1': return `\n\n# ${inner().trim()}\n\n`
      case 'h2': return `\n\n## ${inner().trim()}\n\n`
      case 'h3': return `\n\n### ${inner().trim()}\n\n`
      case 'h4': return `\n\n#### ${inner().trim()}\n\n`
      case 'h5': return `\n\n##### ${inner().trim()}\n\n`
      case 'h6': return `\n\n###### ${inner().trim()}\n\n`
      case 'p':
      case 'div': {
        const s = inner().trim()
        return s ? `\n\n${s}\n\n` : ''
      }
      case 'strong':
      case 'b': {
        const s = inner().trim()
        return s ? `**${s}**` : ''
      }
      case 'em':
      case 'i': {
        const s = inner().trim()
        return s ? `*${s}*` : ''
      }
      case 'u':
      case 'ins': {
        const s = inner().trim()
        return s ? `<u>${s}</u>` : ''
      }
      case 's':
      case 'del':
      case 'strike': {
        const s = inner().trim()
        return s ? `~~${s}~~` : ''
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
        const lines = inner().trim().split('\n').map((l) => `> ${l.trim()}`)
        return `\n\n${lines.join('\n')}\n\n`
      }
      case 'ul':
      case 'ol': {
        const ordered = tag === 'ol'
        const items: string[] = []
        let idx = 1
        for (const child of el.children) {
          if (child.tagName.toLowerCase() !== 'li') continue
          const pad = '  '.repeat(listDepth)
          const marker = ordered ? `${idx++}. ` : '- '
          const txt = [...child.childNodes].map((c) => walk(c, listDepth + 1)).join('').trim().replace(/\n{2,}/g, '\n')
          items.push(`${pad}${marker}${txt}`)
        }
        return `\n\n${items.join('\n')}\n\n`
      }
      case 'table': {
        const rows: string[][] = []
        for (const tr of el.querySelectorAll('tr')) {
          const cells = [...tr.querySelectorAll('th, td')].map((td) =>
            walk(td, listDepth).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'),
          )
          if (cells.length) rows.push(cells)
        }
        if (!rows.length) return ''
        const ncols = Math.max(...rows.map((r) => r.length))
        const padRow = (r: string[]) => `| ${Array.from({ length: ncols }, (_, i) => r[i] ?? '').join(' | ')} |`
        const sep = `| ${Array.from({ length: ncols }, () => '---').join(' | ')} |`
        return `\n\n${[padRow(rows[0]), sep, ...rows.slice(1).map(padRow)].join('\n')}\n\n`
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

  return (doc.body ? walk(doc.body) : '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
