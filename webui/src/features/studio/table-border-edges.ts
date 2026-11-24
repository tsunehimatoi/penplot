export const TABLE_BORDER_EDGES = [
  ['top', '上框线'], ['right', '右框线'], ['bottom', '下框线'], ['left', '左框线'],
  ['horizontal', '内部横线'], ['vertical', '内部竖线'],
] as const

export type BorderEdge = (typeof TABLE_BORDER_EDGES)[number][0]

export function readTableBorderEdges(table: Element, documentGrid: boolean): BorderEdge[] {
  const custom = table.getAttribute('data-border-edges')
  if (custom !== null) {
    const tokens = new Set(custom.split(/\s+/))
    return TABLE_BORDER_EDGES.map(([edge]) => edge).filter((edge) => tokens.has(edge))
  }
  const preset = table.getAttribute('data-border')
  if (preset === 'none') return []
  if (preset === 'grid' || (preset !== 'vertical' && documentGrid)) return TABLE_BORDER_EDGES.map(([edge]) => edge)
  return ['right', 'left', 'vertical']
}
