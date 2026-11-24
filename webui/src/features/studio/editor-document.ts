import { crc32Utf8 } from '@/lib/crc32'
import type { EditorDocumentNode, FlowEditorDocument } from '@/api/schema'

const BLOCKS: Record<string, string> = {
  p: 'paragraph', div: 'group', h1: 'heading1', h2: 'heading2', h3: 'heading3',
  h4: 'heading4', h5: 'heading5', h6: 'heading6', br: 'lineBreak', hr: 'rule',
  blockquote: 'quote', ul: 'bulletList', ol: 'numberedList', li: 'listItem',
  table: 'table', thead: 'tableHeader', tbody: 'tableBody', tfoot: 'tableFooter', tr: 'tableRow',
  th: 'headerCell', td: 'cell', pre: 'codeBlock', code: 'code',
  strong: 'bold', em: 'italic', u: 'underline', s: 'strike', sup: 'superscript', sub: 'subscript',
  span: 'span', a: 'link',
}
const TAGS = Object.fromEntries(Object.entries(BLOCKS).map(([tag, kind]) => [kind, tag]))
const ALLOWED_ATTRIBUTES = new Set([
  'style', 'align', 'class', 'start', 'data-pagebreak', 'data-chart', 'data-border', 'data-border-edges',
])

/** Convert the editing surface into paragraph/run nodes. Keep the HTML text as a legacy interchange projection. */
export function buildEditorDocument(html: string): FlowEditorDocument | null {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const decode = (node: Node): EditorDocumentNode | null => {
    if (node instanceof Text) return { kind: 'text', text: node.data }
    if (!(node instanceof Element)) return null
    if (node.matches('span.math-inline, div.math-display')) {
      return {
        kind: node.matches('span') ? 'inlineFormula' : 'displayFormula',
        text: node.textContent ?? '',
        attributes: node.getAttribute('data-border') === 'box' ? { 'data-border': 'box' } : undefined,
      }
    }
    const kind = BLOCKS[node.localName]
    if (!kind) return null
    const children = readChildren(node)
    if (!children) return null
    const attributes = Object.fromEntries([...node.attributes]
      .filter((attr) => ALLOWED_ATTRIBUTES.has(attr.name))
      .map((attr) => [attr.name, attr.value]))
    return { kind, children, attributes: Object.keys(attributes).length ? attributes : undefined }
  }
  function readChildren(parent: Node): EditorDocumentNode[] | null {
    const children = []
    for (const child of parent.childNodes) {
      const node = decode(child)
      if (!node) return null
      children.push(node)
    }
    return children
  }
  const blocks = readChildren(body)
  return blocks ? { version: 1, source_crc32: crc32Utf8(html), blocks } : null
}

export function editorDocumentHtml(model: FlowEditorDocument | null | undefined, source: string): string | null {
  if (model?.version !== 1 || model.source_crc32 !== crc32Utf8(source)) return null
  const dom = document.implementation.createHTMLDocument()
  const render = (node: EditorDocumentNode): Node | null => {
    if (node.kind === 'text') return dom.createTextNode(node.text ?? '')
    const formula = node.kind === 'inlineFormula' || node.kind === 'displayFormula'
    const tag = formula ? node.kind === 'inlineFormula' ? 'span' : 'div' : TAGS[node.kind]
    if (!tag || (!formula && !Object.hasOwn(TAGS, node.kind))) return null
    const element = dom.createElement(tag)
    for (const [name, value] of Object.entries(node.attributes ?? {})) {
      if (ALLOWED_ATTRIBUTES.has(name)) element.setAttribute(name, value)
    }
    if (formula) {
      element.className = tag === 'span' ? 'math-inline' : 'math-display'
      element.textContent = node.text ?? ''
    } else {
      for (const child of node.children ?? []) {
        const rendered = render(child)
        if (!rendered) return null
        element.append(rendered)
      }
    }
    return element
  }
  for (const block of model.blocks) {
    const rendered = render(block)
    if (!rendered) return null
    dom.body.append(rendered)
  }
  return dom.body.innerHTML
}
