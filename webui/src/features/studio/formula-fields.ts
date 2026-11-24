export interface FormulaPart {
  value: string
  kind: 'number' | 'symbol' | 'text' | 'syntax'
}

/** Expose editable operands while retaining TeX commands and delimiters verbatim. */
export function formulaParts(latex: string): FormulaPart[] {
  const parts: FormulaPart[] = []
  const tokens = /\\text\s*\{([^{}\\]*)\}|\\[A-Za-z]+|\\[\s\S]|(?:\d+(?:\.\d*)?|\.\d+)|\p{L}+/gu
  let start = 0
  for (const match of latex.matchAll(tokens)) {
    const index = match.index
    if (index > start) parts.push({ kind: 'syntax', value: latex.slice(start, index) })
    const token = match[0]
    if (match[1] !== undefined) {
      const open = token.indexOf('{') + 1
      parts.push({ kind: 'syntax', value: token.slice(0, open) },
        { kind: 'text', value: match[1] }, { kind: 'syntax', value: '}' })
    } else {
      const kind = token.startsWith('\\') ? 'syntax' : /^[\d.]/.test(token) ? 'number' : 'symbol'
      parts.push({ kind, value: token })
    }
    start = index + token.length
  }
  if (start < latex.length) parts.push({ kind: 'syntax', value: latex.slice(start) })
  return parts
}
