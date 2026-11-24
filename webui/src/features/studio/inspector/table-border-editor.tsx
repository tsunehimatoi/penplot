import * as React from 'react'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { TABLE_BORDER_EDGES, readTableBorderEdges, type BorderEdge } from '../table-border-edges'

const ALL_EDGES = TABLE_BORDER_EDGES.map(([edge]) => edge)
const OUTER_EDGES: BorderEdge[] = ['top', 'right', 'bottom', 'left']

export function TableBorderEditor({ getTables, getActiveTable, documentGrid, onApply }: {
  getTables: () => HTMLTableElement[]
  getActiveTable: () => HTMLTableElement | null
  documentGrid: boolean
  onApply: (table: HTMLTableElement, edges: BorderEdge[] | null) => void
}) {
  const [tables, setTables] = React.useState<HTMLTableElement[]>([])
  const [tableIndex, setTableIndex] = React.useState(0)
  const [edges, setEdges] = React.useState<BorderEdge[]>([])
  const [open, setOpen] = React.useState(false)

  const changeTable = (table: HTMLTableElement[], index: number) => {
    setTableIndex(index)
    setEdges(readTableBorderEdges(table[index], documentGrid))
  }

  const changeOpen = (next: boolean) => {
    if (next) {
      const current = getTables()
      if (!current.length) return
      const active = getActiveTable()
      setTables(current)
      changeTable(current, Math.max(0, active ? current.indexOf(active) : 0))
    }
    setOpen(next)
  }

  const apply = (value: BorderEdge[] | null) => {
    onApply(tables[tableIndex], value)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="plain" onMouseDown={(event) => event.preventDefault()}>
          表格边框
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="表格边框" className="w-72 space-y-3"
        onPointerDown={(event) => event.stopPropagation()} onCloseAutoFocus={(event) => event.preventDefault()}>
        {tables.length > 1 && (
          <label className="flex items-center justify-between gap-2 text-footnote">
            表格
            <select value={tableIndex} onChange={(event) => changeTable(tables, Number(event.currentTarget.value))}
              className="rounded border border-separator bg-bg-elevated px-2 py-1">
              {tables.map((_, index) => <option key={index} value={index}>表格 {index + 1}</option>)}
            </select>
          </label>
        )}
        <div className="flex items-start gap-3">
          <div className="m-1 grid size-14 shrink-0 grid-cols-2 grid-rows-2 text-accent" aria-hidden
            style={{
              borderWidth: 1,
              borderColor: ['top', 'right', 'bottom', 'left']
                .map((edge) => edges.includes(edge as BorderEdge) ? 'currentColor' : 'transparent').join(' '),
              background: 'rgb(var(--accent) / 0.08)',
            }}>
            <div style={{ borderRight: edges.includes('vertical') ? '1px solid' : undefined,
              borderBottom: edges.includes('horizontal') ? '1px solid' : undefined }} />
            <div style={{ borderBottom: edges.includes('horizontal') ? '1px solid' : undefined }} />
            <div style={{ borderRight: edges.includes('vertical') ? '1px solid' : undefined }} />
            <div />
          </div>
          <div className="grid flex-1 grid-cols-2 gap-1">
            {TABLE_BORDER_EDGES.map(([edge, label]) => (
              <Button key={edge} size="sm" variant={edges.includes(edge) ? 'tinted' : 'gray'}
                aria-pressed={edges.includes(edge)}
                onClick={() => setEdges((prev) => prev.includes(edge) ? prev.filter((it) => it !== edge) : [...prev, edge])}>
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="plain" onClick={() => setEdges(ALL_EDGES)}>全部</Button>
          <Button size="sm" variant="plain" onClick={() => setEdges(OUTER_EDGES)}>仅外框</Button>
          <Button size="sm" variant="plain" onClick={() => setEdges([])}>无边框</Button>
          <Button size="sm" variant="plain" onClick={() => apply(null)}>跟随文档</Button>
          <Button size="sm" className="ml-auto" onClick={() => apply(ALL_EDGES.filter((edge) => edges.includes(edge)))}>
            应用边框
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
