import * as React from 'react'
import { ArrowDown, ArrowLeftRight, ArrowUp, Crosshair, FileText, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { LayoutBox, OriginSpec, PaperBase, Variable } from '@/api/studio'
import { Button, IconButton, Input, NumberField, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  boxLineNum, clone, DEFAULT_ORIGIN, detectLayoutPreset, effectiveLayoutBoxes, machineAxes, makeLayoutPreset, newId,
  originAnchor, paperDims, usedVariables, type LayoutPreset,
} from '../model'
import { useStudio } from '../store'
import { Note, Num, Row, Section, SwitchRow } from './controls'

export function PaperCard({ paper, onOpen, pageOverride }: { paper: PaperBase; onOpen: () => void; pageOverride: boolean }) {
  const { w, h } = paperDims(paper)
  const k = 56 / Math.max(w, h)
  const boxes = paper.layout_boxes ?? []
  return (
    <button type="button" onClick={onOpen} className="press focus-ring mx-1 flex w-[calc(100%-8px)] items-center gap-3 rounded-lg bg-fill/50 p-2.5 text-left hover:bg-fill">
      <span className="flex size-16 shrink-0 items-center justify-center">
        <span className="relative bg-canvas-paper shadow-paper" style={{ width: w * k, height: h * k }}>
          {boxes.length ? (
            boxes.map((b, i) => (
              <span
                key={b.id || i}
                className="absolute border border-accent/65 bg-accent/10"
                style={{ left: b.x_mm * k, top: b.y_mm * k, width: b.w_mm * k, height: b.h_mm * k }}
              />
            ))
          ) : (
            <span
              className="absolute border border-dashed border-gray/60"
              style={{ left: paper.margins.l * k, top: paper.margins.t * k, right: paper.margins.r * k, bottom: paper.margins.b * k }}
            />
          )}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-headline text-label">{paper.name || '自定义'}</span>
        <span className="block text-footnote tabular-nums text-secondary-label">
          {w} × {h} mm · {paper.orientation === 'landscape' ? '横向' : '纵向'}
        </span>
        <span className="block text-footnote tabular-nums text-secondary-label">
          边距 {paper.margins.t === paper.margins.b && paper.margins.l === paper.margins.r ? `上下 ${paper.margins.t} · 左右 ${paper.margins.l}` : `${paper.margins.t}/${paper.margins.r}/${paper.margins.b}/${paper.margins.l}`} mm
          {boxes.length ? ` · ${boxes.length} 框` : ''}
          {pageOverride ? ' · 本页单独设置' : ''}
        </span>
      </span>
      <span className="text-footnote text-accent">更改…</span>
    </button>
  )
}

const LAYOUT_PRESETS: { id: LayoutPreset; label: string }[] = [
  { id: 'single', label: '单栏（默认）' },
  { id: 'two-col', label: '左右双栏' },
  { id: 'two-row', label: '上下双框' },
  { id: 'grid-2x2', label: '四宫格（2×2）' },
  { id: 'three-col', label: '三栏' },
]

const round1 = (v: number) => Math.round(v * 10) / 10

function OptionalIntInput({
  value, placeholder, onChange, min = 1, max = 200, 'aria-label': ariaLabel,
}: {
  value: number | null | undefined
  placeholder: string
  onChange: (v: number | null) => void
  min?: number
  max?: number
  'aria-label'?: string
}) {
  const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : String(Math.round(v)))
  const [draft, setDraft] = React.useState('')
  const [focused, setFocused] = React.useState(false)
  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) {
      setDraft('')
      if (value != null) onChange(null)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) {
      setDraft(fmt(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)))
    setDraft(String(clamped))
    if (clamped !== value) onChange(clamped)
  }
  return (
    <Input
      value={focused ? draft : fmt(value)}
      inputMode="numeric"
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="h-7 px-2 text-right text-footnote tabular-nums"
      onFocus={(e) => {
        const target = e.currentTarget
        setDraft(fmt(value))
        setFocused(true)
        requestAnimationFrame(() => target.select())
      }}
      onBlur={(e) => {
        setFocused(false)
        commit(e.currentTarget.value)
      }}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value)
        else if (e.key === 'Escape') setDraft(fmt(value))
      }}
    />
  )
}

/** Proportional mini paper preview with numbered layout boxes. */
export function PaperLayoutPreview({ paper, maxSize = 96 }: { paper: PaperBase; maxSize?: number }) {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  const boxes = paper.layout_boxes ?? []
  const scale = maxSize / Math.max(w, h, 1)
  return (
    <div className="flex justify-center py-1">
      <svg width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} className="rounded-[2px] bg-canvas-paper shadow-paper" role="img" aria-label="纸张文本框排版示意图">
        <rect
          x={m.l}
          y={m.t}
          width={Math.max(0, w - m.l - m.r)}
          height={Math.max(0, h - m.t - m.b)}
          fill="none"
          stroke="rgb(var(--gray))"
          strokeOpacity={0.5}
          strokeDasharray="3 2"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {boxes.length ? (
          boxes.map((b, i) => (
            <g key={b.id || i}>
              <rect
                x={b.x_mm}
                y={b.y_mm}
                width={b.w_mm}
                height={b.h_mm}
                fill="rgb(var(--accent) / 0.14)"
                stroke="rgb(var(--accent))"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={b.x_mm + b.w_mm / 2}
                y={b.y_mm + b.h_mm / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={Math.max(6, Math.min(b.w_mm * 0.45, b.h_mm * 0.5, Math.max(w, h) * 0.11))}
                fontWeight={700}
                fill="rgb(var(--accent))"
              >
                {i + 1}
              </text>
            </g>
          ))
        ) : (
          <text
            x={m.l + Math.max(1, w - m.l - m.r) / 2}
            y={m.t + Math.max(1, h - m.t - m.b) / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.max(8, Math.max(w, h) * 0.1)}
            fontWeight={600}
            fill="rgb(var(--secondary-label))"
            opacity={0.7}
          >
            1
          </text>
        )}
      </svg>
    </div>
  )
}

/** Shared editor for multi-textbox paper layouts (presets, proportional preview, ordered box list). */
export function PaperLayoutEditor({ paper, onChange }: { paper: PaperBase; onChange: (boxes: LayoutBox[]) => void }) {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  const boxes = paper.layout_boxes ?? []
  const activePreset = detectLayoutPreset(paper)

  const updateBox = (index: number, patch: Partial<LayoutBox>) => {
    onChange(boxes.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }

  const moveBox = (index: number, dir: -1 | 1) => {
    const next = index + dir
    if (next < 0 || next >= boxes.length) return
    const copy = [...boxes]
    ;[copy[index], copy[next]] = [copy[next], copy[index]]
    onChange(copy)
  }

  const removeBox = (index: number) => {
    onChange(boxes.filter((_, i) => i !== index))
  }

  const addBox = () => {
    const bx = m.l
    const by = m.t
    const bw = Math.max(10, w - m.l - m.r)
    const bh = Math.max(10, h - m.t - m.b)
    if (!boxes.length) {
      const base = effectiveLayoutBoxes(paper)[0]
      onChange([{ id: newId('box'), name: '框 1', x_mm: round1(base.x_mm), y_mm: round1(base.y_mm), w_mm: round1(base.w_mm), h_mm: round1(base.h_mm), line_num: null }])
      return
    }
    const last = boxes[boxes.length - 1]
    const gap = 8
    let x = last.x_mm
    let y = last.y_mm + last.h_mm + gap
    let bwNext = last.w_mm
    let bhNext = last.h_mm
    if (y + 10 > h - m.b) {
      x = last.x_mm + last.w_mm + gap
      y = last.y_mm
      if (x + 10 > w - m.r) {
        bwNext = Math.max(20, round1(bw * 0.45))
        bhNext = Math.max(20, round1(bh * 0.4))
        x = round1(Math.min(w - bwNext, bx + ((boxes.length * 8) % Math.max(10, bw - bwNext))))
        y = round1(Math.min(h - bhNext, by + ((boxes.length * 8) % Math.max(10, bh - bhNext))))
      } else {
        bwNext = Math.min(last.w_mm, round1(w - m.r - x))
      }
    } else {
      bhNext = Math.min(last.h_mm, round1(h - m.b - y))
    }
    onChange([
      ...boxes,
      {
        id: newId('box'),
        name: `框 ${boxes.length + 1}`,
        x_mm: round1(Math.max(0, x)),
        y_mm: round1(Math.max(0, y)),
        w_mm: round1(Math.max(1, bwNext)),
        h_mm: round1(Math.max(1, bhNext)),
        line_num: null,
      },
    ])
  }

  return (
    <div className="flex flex-col gap-2 px-1">
      <div className="flex flex-wrap gap-1">
        {LAYOUT_PRESETS.map((p) => {
          const active = activePreset === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(makeLayoutPreset(paper, p.id))}
              aria-pressed={active}
              className={cn(
                'press focus-ring rounded-md px-2 py-1 text-caption font-medium pointer-coarse:py-1.5',
                active ? 'bg-accent text-white' : 'bg-fill text-label hover:bg-secondary-fill',
              )}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      <PaperLayoutPreview paper={paper} />

      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-secondary-label">
          {boxes.length ? `共 ${boxes.length} 个文本框（按序号依次自动填充）` : '当前按纸张边距作为单栏文本框'}
        </span>
        <Button type="button" size="sm" variant="gray" icon={<Plus />} onClick={addBox}>
          添加文本框
        </Button>
      </div>

      {boxes.length ? (
        <div className="flex flex-col gap-2">
          {boxes.map((b, i) => (
            <div key={b.id || i} className="flex flex-col gap-1.5 rounded-lg bg-fill/45 p-2 ring-1 ring-separator/50">
              <div className="flex items-center gap-1">
                <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-accent text-[10px] font-bold text-white">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-footnote font-medium text-label">
                  {b.name || `文本框 ${i + 1}`}
                </span>
                <IconButton label={`上移文本框 ${i + 1}`} size="sm" disabled={i === 0} onClick={() => moveBox(i, -1)}>
                  <ArrowUp />
                </IconButton>
                <IconButton label={`下移文本框 ${i + 1}`} size="sm" disabled={i === boxes.length - 1} onClick={() => moveBox(i, 1)}>
                  <ArrowDown />
                </IconButton>
                <IconButton label={`删除文本框 ${i + 1}`} size="sm" className="hover:text-red" onClick={() => removeBox(i)}>
                  <Trash2 />
                </IconButton>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="flex min-w-0 items-center gap-1">
                  <span className="w-4 shrink-0 text-center text-caption text-secondary-label">X</span>
                  <NumberField value={b.x_mm} onChange={(v) => updateBox(i, { x_mm: v })} unit="mm" step={0.5} min={0} max={2000} stepper={false} className="min-w-0 flex-1" aria-label={`文本框 ${i + 1} X`} />
                </label>
                <label className="flex min-w-0 items-center gap-1">
                  <span className="w-4 shrink-0 text-center text-caption text-secondary-label">Y</span>
                  <NumberField value={b.y_mm} onChange={(v) => updateBox(i, { y_mm: v })} unit="mm" step={0.5} min={0} max={2000} stepper={false} className="min-w-0 flex-1" aria-label={`文本框 ${i + 1} Y`} />
                </label>
                <label className="flex min-w-0 items-center gap-1">
                  <span className="w-4 shrink-0 text-center text-caption text-secondary-label">宽</span>
                  <NumberField value={b.w_mm} onChange={(v) => updateBox(i, { w_mm: Math.max(1, v) })} unit="mm" step={0.5} min={1} max={2000} stepper={false} className="min-w-0 flex-1" aria-label={`文本框 ${i + 1} 宽`} />
                </label>
                <label className="flex min-w-0 items-center gap-1">
                  <span className="w-4 shrink-0 text-center text-caption text-secondary-label">高</span>
                  <NumberField value={b.h_mm} onChange={(v) => updateBox(i, { h_mm: Math.max(1, v) })} unit="mm" step={0.5} min={1} max={2000} stepper={false} className="min-w-0 flex-1" aria-label={`文本框 ${i + 1} 高`} />
                </label>
              </div>
              <label className="flex items-center gap-1.5">
                <span className="shrink-0 text-caption text-secondary-label">行数</span>
                <OptionalIntInput
                  value={b.line_num}
                  placeholder={`自动 (${boxLineNum(paper, b)})`}
                  onChange={(v) => updateBox(i, { line_num: v })}
                  aria-label={`文本框 ${i + 1} 行数`}
                />
              </label>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function PaperLayoutSection({ paper }: { paper: PaperBase }) {
  const applyBoxes = (layout_boxes: LayoutBox[]) => {
    const boxes = clone(layout_boxes)
    const pageIndex = useStudio.getState().view.page
    useStudio.getState().edit((d) => {
      const pg = d.pages[pageIndex]
      const { id: _id, builtin: _b, ...cleanPaper } = paper as PaperBase & { id?: string; builtin?: boolean }
      const nextSpec: PaperBase = { ...clone(cleanPaper), layout_boxes: boxes }
      if (pg?.paper) pg.paper = { paper_id: null, spec: nextSpec }
      else d.paper = { paper_id: null, spec: nextSpec }
    }, { coalesce: 'paper-layout' })
  }
  return (
    <Section title="纸张文本框排版">
      <PaperLayoutEditor paper={paper} onChange={applyBoxes} />
    </Section>
  )
}

const CORNERS: { c: OriginSpec['corner']; x: number; y: number; label: string }[] = [
  { c: 0, x: 0, y: 0, label: '左上' },
  { c: 1, x: 1, y: 0, label: '右上' },
  { c: 2, x: 0, y: 1, label: '左下' },
  { c: 3, x: 1, y: 1, label: '右下' },
]

/** Four-corner origin picker on a paper thumbnail, with live axis arrows. */
export function CornerPicker({ origin, onChange, paper }: { origin: OriginSpec; onChange: (o: OriginSpec) => void; paper: PaperBase }) {
  const { w, h } = paperDims(paper)
  const W = 132
  const H = Math.max(80, Math.min(170, (W * h) / w))
  const ax = machineAxes(origin)
  const cur = CORNERS.find((c) => c.c === origin.corner)!
  const content = originAnchor(origin) === 'content'
  // content anchor: the corners are those of the drawing (a dashed box inside the paper)
  const ix = content ? W * 0.2 : 0
  const iy = content ? H * 0.22 : 0
  const px = (fx: number) => ix + fx * (W - 2 * ix)
  const py = (fy: number) => iy + fy * (H - 2 * iy)
  const ox = px(cur.x)
  const oy = py(cur.y)
  const L = 34
  return (
    <div className="flex items-start gap-3 px-1">
      <div className="relative shrink-0" style={{ width: W + 24, height: H + 24 }}>
        <svg width={W + 24} height={H + 24} className="absolute inset-0" aria-hidden>
          <g transform="translate(12 12)">
            <rect width={W} height={H} rx={2} fill="rgb(var(--canvas-paper))" stroke="rgb(var(--separator) / var(--separator-a))" />
            {content ? (
              <>
                <rect x={ix} y={iy} width={W - 2 * ix} height={H - 2 * iy} fill="rgb(var(--accent) / 0.06)" stroke="rgb(var(--axis-origin))" strokeDasharray="3 2" />
                {[0, 1, 2].map((i) => (
                  <line key={i} x1={ix + 6} x2={W - ix - 6 - i * 10} y1={iy + 8 + i * 9} y2={iy + 8 + i * 9} stroke="rgb(var(--secondary-label) / 0.35)" strokeWidth={2} strokeLinecap="round" />
                ))}
              </>
            ) : null}
            <g transform={`translate(${ox} ${oy})`}>
              <g style={{ transform: `rotate(${(Math.atan2(ax.x.y, ax.x.x) * 180) / Math.PI}deg)`, transition: 'transform var(--dur-base) var(--ease-standard)' }}>
                <line x1={0} y1={0} x2={L - 5} y2={0} stroke="rgb(var(--axis-x))" strokeWidth={2} />
                <path d={`M${L} 0 l-6 -3.5 v7 z`} fill="rgb(var(--axis-x))" />
              </g>
              <g style={{ transform: `rotate(${(Math.atan2(ax.y.y, ax.y.x) * 180) / Math.PI}deg)`, transition: 'transform var(--dur-base) var(--ease-standard)' }}>
                <line x1={0} y1={0} x2={L - 5} y2={0} stroke="rgb(var(--axis-y))" strokeWidth={2} />
                <path d={`M${L} 0 l-6 -3.5 v7 z`} fill="rgb(var(--axis-y))" />
              </g>
            </g>
          </g>
        </svg>
        {CORNERS.map((c) => (
          <button
            key={c.c}
            type="button"
            aria-label={`原点在${content ? '内容' : '纸张'}${c.label}角`}
            aria-pressed={origin.corner === c.c}
            onClick={() => onChange({ ...origin, corner: c.c })}
            className={cn(
              'focus-ring absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full pointer-coarse:size-11',
            )}
            style={{ left: 12 + px(c.x), top: 12 + py(c.y) }}
          >
            <span className={cn('size-3.5 rounded-full border-2 transition-colors', origin.corner === c.c ? 'border-accent bg-accent' : 'border-gray bg-bg-elevated hover:border-accent')} />
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-1 pt-2 text-caption text-secondary-label">
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-axis-x" />+X 方向</span>
        <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-axis-y" />+Y 方向</span>
        <span className="mt-1 text-tertiary-label">
          {content ? '开始前把笔（抬起）停在要写内容的这个角。点选四角切换。' : '开始前把笔（抬起）停在纸张的这个角。点选四角切换。'}
        </span>
      </div>
    </div>
  )
}

export function OriginSection({ origin, overridden, paper, profileName, onOpenPosition }: {
  origin: OriginSpec
  overridden: boolean
  paper: PaperBase
  profileName: string
  onOpenPosition: () => void
}) {
  const setOrigin = (o: OriginSpec | null) =>
    useStudio.getState().edit((d) => {
      d.print = { ...d.print, origin: o }
    }, { coalesce: 'origin' })
  const base = origin ?? DEFAULT_ORIGIN
  const set = (patch: Partial<OriginSpec>) => setOrigin({ ...base, ...patch })
  return (
    <Section
      title="原点与坐标"
      actions={
        overridden ? (
          <button type="button" className="press flex items-center gap-1 text-caption text-accent" onClick={() => setOrigin(null)}>
            <RotateCcw className="size-3" /> 恢复机器配置
          </button>
        ) : null
      }
    >
      <p className="flex items-center gap-1.5 px-1 text-caption text-secondary-label">
        来自机器配置「{profileName}」
        {overridden ? (
          <span className="flex items-center gap-1 text-on-tint-orange">
            · 本项目已覆盖 <span className="size-1.5 rounded-full bg-overridden" aria-label="已覆盖" />
          </span>
        ) : null}
      </p>
      <Segmented<'content' | 'paper'>
        size="sm"
        block
        aria-label="原点对齐"
        value={originAnchor(base)}
        onValueChange={(a) => set({ anchor: a })}
        options={[
          { value: 'content', label: `内容${CORNERS[base.corner].label}角` },
          { value: 'paper', label: `纸张${CORNERS[base.corner].label}角` },
        ]}
        className="mx-1"
      />
      <CornerPicker origin={base} onChange={setOrigin} paper={paper} />
      <Row label="交换 XY">
        <Button size="sm" variant={base.revxy ? 'tinted' : 'gray'} icon={<ArrowLeftRight />} onClick={() => set({ revxy: !base.revxy })} aria-pressed={base.revxy}>
          {base.revxy ? '已交换' : '交换'}
        </Button>
      </Row>
      <SwitchRow label="X 反向" checked={base.x_rev} onChange={(v) => set({ x_rev: v })} />
      <SwitchRow label="Y 反向" checked={base.y_rev} onChange={(v) => set({ y_rev: v })} />
      <Num label="偏移 X" value={base.offset_x_mm} onChange={(v) => set({ offset_x_mm: v })} unit="mm" step={0.5} min={-500} max={500} hint={originAnchor(base) === 'content' ? '自内容的角向内' : '自纸张的角向内'} />
      <Num label="偏移 Y" value={base.offset_y_mm} onChange={(v) => set({ offset_y_mm: v })} unit="mm" step={0.5} min={-500} max={500} />
      <Button size="sm" variant="gray" icon={<Crosshair />} className="mx-1" onClick={onOpenPosition}>
        位置预览…
      </Button>
    </Section>
  )
}

export function VariablesSection() {
  const doc = useStudio((s) => s.doc)
  if (!doc) return null
  const used = usedVariables(doc)
  const vars = doc.variables ?? []
  const missing = used.filter((u) => !vars.some((v) => v.name === u))
  const update = (fn: (v: Variable[]) => Variable[]) =>
    useStudio.getState().edit((d) => {
      d.variables = fn(d.variables ?? [])
    }, { coalesce: 'vars' })
  return (
    <Section
      title="数据 · 变量"
      actions={
        <IconButton label="添加变量" size="sm" onClick={() => update((v) => [...v, { name: `var${v.length + 1}`, default: '', type: 'text', label: null }])}>
          <Plus />
        </IconButton>
      }
    >
      {vars.length === 0 && missing.length === 0 ? (
        <p className="px-1 text-footnote text-secondary-label">在文本中写 {'{{姓名}}'} 即可引用变量；默认值用于预览和单份打印。</p>
      ) : null}
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5 px-1">
          <Input value={v.name} onChange={(e) => { const name = e.currentTarget.value; update((l) => l.map((x, j) => (j === i ? { ...x, name } : x))) }} className="w-24" aria-label="变量名" />
          <Input value={v.default} onChange={(e) => { const val = e.currentTarget.value; update((l) => l.map((x, j) => (j === i ? { ...x, default: val } : x))) }} placeholder="默认值" className="min-w-0 flex-1" aria-label={`${v.name} 默认值`} />
          <IconButton label="删除变量" size="sm" onClick={() => update((l) => l.filter((_, j) => j !== i))}>
            <Trash2 />
          </IconButton>
        </div>
      ))}
      {missing.length ? (
        <Note tone="orange">
          未定义：{missing.map((m) => `{{${m}}}`).join(' ')}{' '}
          <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => update((v) => [...v, ...missing.map((name) => ({ name, default: '', type: 'text' as const, label: null }))])}>
            全部添加
          </button>
        </Note>
      ) : null}
    </Section>
  )
}

export function TextBoxSection({ onSelectFlow }: { onSelectFlow: () => void }) {
  return (
    <Section title="文本框">
      <p className="px-1 text-footnote text-secondary-label">内容在纸张文本框排版内自动流动并按相同排版连续扩页，每页均可选中编辑。</p>
      <Button size="sm" variant="gray" icon={<FileText />} className="mx-1" onClick={onSelectFlow}>
        编辑文本框…
      </Button>
    </Section>
  )
}

