import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Dices, FileUp, Maximize2, Pencil, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { importFile, type FlowTextElement, type Jitter, type TextElement } from '@/api/studio'
import { Button, NumberField, Segmented, Textarea } from '@/components/ui'
import { cn } from '@/lib/cn'
import { plainToHtml } from '@/lib/html-to-md'
import { toast } from '@/lib/toast'
import { JITTER_PRESETS, NO_JITTER, DEFAULT_RICH_STYLE } from '../model'
import { usePagination } from '../pagination'
import { studio, useStudio } from '../store'
import { useElementRender } from '../canvas/element-view'
import { Help } from '../ext'
import { FontConfig } from './font-config'
import { pushRecentFont, useBestFont } from './font-picker'
import { Note, Num, RangeRow, Row, Section, SegRow, SliderRow, SwitchRow } from './controls'
import {
  normalizeEditorHtml,
  RichEditorDialog,
  RichFlowEditor,
  toVisualHtml,
  type EditorMode,
  type FlowFormat,
} from './rich-editor'

const ALIGN = [
  { value: 'L' as const, icon: AlignLeft, ariaLabel: '左对齐' },
  { value: 'C' as const, icon: AlignCenter, ariaLabel: '居中' },
  { value: 'R' as const, icon: AlignRight, ariaLabel: '右对齐' },
  { value: 'D' as const, icon: AlignJustify, ariaLabel: '分散对齐' },
]

function stripPlainChars(text: string, format?: FlowFormat): number {
  if (!text) return 0
  if (format === 'html') {
    return text.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
  }
  return text.replace(/\s+/g, '').length
}

export function TextContent({ el, autoFocus }: { el: TextElement | FlowTextElement; autoFocus?: boolean }) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [dlgMode, setDlgMode] = React.useState<EditorMode>('visual')
  const strokePreview = useStudio((s) => s.strokePreview)
  const inlineEditId = useStudio((s) => s.inlineEditId)
  const doc = useStudio((s) => s.doc)
  const pagination = usePagination(doc)
  const { r } = useElementRender(el)

  const pageCount = React.useMemo(() => {
    if (!doc) return 1
    const pi = doc.pages.findIndex((p) => p.elements.some((e) => e.id === el.id))
    return Math.max(1, pagination.filter((p) => p.page === (pi >= 0 ? pi : 0)).length)
  }, [doc, el.id, pagination])

  const charCount = el.type === 'flow_text'
    ? stripPlainChars(el.props.text, el.props.format)
    : stripPlainChars(el.props.text)

  const handleImportFiles = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    try {
      const res = await importFile(file)
      if (res.kind === 'document') {
        const html = normalizeEditorHtml(toVisualHtml(res.data.content, res.data.format as FlowFormat))
        studio.setProps(el.id, { text: html, format: 'html' })
        if (res.data.warnings?.length) toast.warning(file.name, { description: res.data.warnings.join('；') })
        else toast.success(`已导入 ${file.name}`)
      } else if (res.kind === 'text') {
        const html = normalizeEditorHtml(plainToHtml(res.data.text))
        studio.setProps(el.id, { text: html, format: 'html' })
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

  // Compact sheet still provides a direct editor when opened explicitly
  if (autoFocus) {
    return (
      <Section title={el.type === 'flow_text' ? '正文' : '内容'}>
        {el.type === 'flow_text' ? (
          <RichFlowEditor el={el} textareaRef={ref} />
        ) : (
          <Textarea
            ref={ref}
            autoFocus
            value={el.props.text}
            onChange={(e) => studio.setProps(el.id, { text: e.currentTarget.value }, 'text')}
            rows={4}
            className="font-[inherit] text-body"
            placeholder="输入文字，可使用 {{变量}}"
            aria-label="文字内容"
          />
        )}
        {r?.missing?.length ? <MissingGlyphs el={el} missing={r.missing} /> : null}
        {r?.overflow ? <Note tone="orange" icon={<TriangleAlert />}>文字超出文本框高度，多余的行未绘制。</Note> : null}
      </Section>
    )
  }

  return (
    <Section title={el.type === 'flow_text' ? '正文' : '内容'}>
      <div className="flex flex-col gap-1.5 px-1">
        <Button
          type="button"
          size="sm"
          variant="filled"
          icon={<Pencil />}
          onClick={() => {
            const st = useStudio.getState()
            st.select([el.id])
            st.setInlineEdit(inlineEditId === el.id ? null : el.id)
          }}
        >
          {inlineEditId === el.id ? '完成画布编辑' : '画布直接编辑'}
        </Button>

        {el.type === 'flow_text' ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.docx,.html,.htm,.txt"
              className="hidden"
              onChange={(e) => void handleImportFiles(e.currentTarget.files)}
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="gray"
                icon={<FileUp />}
                onClick={() => fileRef.current?.click()}
              >
                导入 MD / Word / HTML
              </Button>
              <Button
                type="button"
                size="sm"
                variant="gray"
                icon={<Maximize2 />}
                onClick={() => setExpanded(true)}
              >
                打开大窗编辑器
              </Button>
            </div>
          </>
        ) : null}

        <SwitchRow
          label="预览笔画"
          checked={strokePreview}
          onChange={(v) => useStudio.getState().setStrokePreview(v)}
          hint="按需计算单线路径"
        />

        <p className="text-footnote tabular-nums text-secondary-label">
          {charCount.toLocaleString('zh-CN')} 字{el.type === 'flow_text' ? ` · 当前共 ${pageCount} 页` : ''}
        </p>
      </div>

      {el.type === 'flow_text' ? (
        <RichEditorDialog
          open={expanded}
          onOpenChange={setExpanded}
          elId={el.id}
          mode={dlgMode}
          onModeChange={setDlgMode}
          fmt={el.props.format ?? 'plain'}
          text={el.props.text ?? ''}
          onCommit={(nextText, nextFmt, coalesce) =>
            studio.setProps(el.id, { text: nextText, format: nextFmt }, coalesce ? 'text' : undefined)
          }
          onFormatChange={(nextFmt) => studio.setProps(el.id, { format: nextFmt })}
          onUpgradeRich={() => {
            const html = normalizeEditorHtml(toVisualHtml(el.props.text ?? '', el.props.format ?? 'plain'))
            studio.setProps(el.id, { text: html, format: 'html' })
            toast.success('已转换为可排版富文本格式')
          }}
          onImportClick={() => fileRef.current?.click()}
        />
      ) : null}

      {r?.missing?.length ? <MissingGlyphs el={el} missing={r.missing} /> : null}
      {r?.overflow ? <Note tone="orange" icon={<TriangleAlert />}>文字超出文本框高度，多余的行未绘制。</Note> : null}
    </Section>
  )
}

function MissingGlyphs({ el, missing }: { el: TextElement | FlowTextElement; missing: string[] }) {
  const best = useBestFont(el.props.text, el.props.font_id)
  const set = new Set(missing)
  const lines = el.props.text.split('\n').filter((l) => [...l].some((c) => set.has(c))).slice(0, 4)
  return (
    <Note tone="orange" icon={<TriangleAlert />}>
      <span className="font-medium">缺 {missing.length} 字：{missing.slice(0, 12).join('')}{missing.length > 12 ? '…' : ''}</span>
      <span className="block text-footnote">这些字会被画成方框。</span>
      <span className="mt-1 block rounded-sm bg-bg-elevated/70 px-1.5 py-1 text-footnote text-label">
        {lines.map((l, i) => (
          <span key={i} className="block truncate">
            {[...l].map((c, j) => (set.has(c) ? <span key={j} className="underline decoration-orange decoration-wavy underline-offset-2">{c}</span> : c))}
          </span>
        ))}
      </span>
      <span className="mt-1.5 flex flex-wrap gap-1.5">
        {best && (best.missing?.length ?? 0) < missing.length ? (
          <Button size="sm" variant="tinted" onClick={() => { pushRecentFont(best.id); studio.setProps(el.id, { font_id: best.id, font_mix: null }) }}>
            换成「{best.display_name}」{best.missing?.length ? `（缺 ${best.missing.length}）` : ''}
          </Button>
        ) : null}
        {best && el.props.font_id ? (
          <Button size="sm" variant="gray" onClick={() => studio.setProps(el.id, { font_mix: [{ font_id: el.props.font_id!, weight: 1 }, { font_id: best.id, weight: 1 }] })}>
            加入混排
          </Button>
        ) : null}
      </span>
    </Note>
  )
}

export function TextStyle({ el }: { el: TextElement | FlowTextElement }) {
  const set = (patch: Record<string, unknown>, k?: string) => studio.setProps(el.id, patch, k)
  const p = el.props
  return (
    <Section title="文字">
      <FontConfig
        fontId={p.font_id}
        fontRoles={p.font_roles}
        fontMix={p.font_mix}
        text={p.text}
        onChange={set}
      />
      {el.type === 'text' ? (
        <>
          <Num label="字号" value={el.props.size_mm} onChange={(v) => set({ size_mm: v })} unit="mm" step={0.5} min={1} max={200} />
          <Num label="行距" value={el.props.line_height} onChange={(v) => set({ line_height: v })} unit="×" step={0.05} min={0.6} max={4} />
        </>
      ) : (
        <>
          <Num label="字号比例" value={el.props.text_size} onChange={(v) => set({ text_size: v })} unit="×" step={0.05} min={0.2} max={3} hint="相对行高" />
          <Num label="行数" value={el.props.line_num ?? null} onChange={(v) => set({ line_num: v > 0 ? Math.round(v) : null })} step={1} min={0} max={80} hint="0 = 按纸张" />
        </>
      )}
      <Num label="字距" value={p.char_space} onChange={(v) => set({ char_space: v })} step={0.05} min={-1} max={5} />
      <Row label="对齐">
        <Segmented value={p.align} onValueChange={(v) => set({ align: v })} options={ALIGN} size="sm" block aria-label="对齐" />
      </Row>
      {el.type === 'text' ? (
        <SwitchRow
          label="自动换行"
          checked={!!el.props.box}
          onChange={(on) => set({ box: on ? { w: 80, h: Math.max(10, el.props.size_mm * el.props.line_height * 3) } : null })}
          hint="按框宽"
        />
      ) : (
        <>
          <SegRow
            label="段首"
            value={String(el.props.paragraph.spe_type) as '0' | '1' | '2'}
            onChange={(v) => set({ paragraph: { ...el.props.paragraph, spe_type: Number(v) } })}
            options={[{ value: '0', label: '无' }, { value: '1', label: '缩进' }, { value: '2', label: '悬挂' }]}
          />
          <Num label="缩进量" value={el.props.paragraph.spe_value} onChange={(v) => set({ paragraph: { ...el.props.paragraph, spe_value: v } })} unit="mm" step={1} min={0} max={80} />
          <Num label="段左" value={el.props.paragraph.left} onChange={(v) => set({ paragraph: { ...el.props.paragraph, left: v } })} unit="mm" step={1} min={0} max={80} />
          <Num label="段右" value={el.props.paragraph.right} onChange={(v) => set({ paragraph: { ...el.props.paragraph, right: v } })} unit="mm" step={1} min={0} max={80} />
          {(el.props.format === 'markdown' || el.props.format === 'html') && (
            <details className="group px-1 pt-1 [&_summary::-webkit-details-marker]:hidden" open>
              <summary className="flex cursor-default list-none items-center gap-1 py-1 text-footnote font-medium text-accent">
                <span className="transition-transform group-open:rotate-90">›</span> 富文本排版
              </summary>
              <div className="-mx-1 flex flex-col gap-1.5 pt-1">
                {(() => {
                  const rs = { ...DEFAULT_RICH_STYLE, ...(el.props.rich_style ?? {}) }
                  const setRs = (patch: Partial<typeof DEFAULT_RICH_STYLE>) => set({ rich_style: { ...rs, ...patch } })
                  return (
                    <>
                      <Num label="标题倍率" value={rs.heading_scale} onChange={(v) => setRs({ heading_scale: v })} unit="×" step={0.05} min={1} max={2.5} />
                      <Num label="图表行数" value={rs.chart_lines} onChange={(v) => setRs({ chart_lines: Math.round(v) })} unit="行" step={1} min={3} max={30} />
                      <Num label="公式缩放" value={rs.math_scale} onChange={(v) => setRs({ math_scale: v })} unit="×" step={0.05} min={0.4} max={2.5} />
                      <SwitchRow label="跨页表头" checked={rs.table_header_repeat} onChange={(v) => setRs({ table_header_repeat: v })} />
                      <SwitchRow label="表格横线" checked={rs.table_hlines} onChange={(v) => setRs({ table_hlines: v })} />
                      <SwitchRow label="代码边框" checked={rs.code_box} onChange={(v) => setRs({ code_box: v })} />
                    </>
                  )
                })()}
              </div>
            </details>
          )}
        </>
      )}
      <SegRow label="缺字时" value={p.missing_glyph} onChange={(v) => set({ missing_glyph: v })} options={[{ value: 'box', label: '画方框' }, { value: 'skip', label: '跳过' }]} />
    </Section>
  )
}

export function Handwriting({ el }: { el: TextElement | FlowTextElement }) {
  const j: Jitter = { ...NO_JITTER, ...(el.props.jitter ?? {}) }
  const setJ = (patch: Partial<Jitter>) => studio.setProps(el.id, { jitter: { ...j, ...patch } }, 'jitter')
  const active = JITTER_PRESETS.find((pr) => Object.entries(pr.jitter).every(([k, v]) => JSON.stringify(j[k as keyof Jitter]) === JSON.stringify(v)))?.id
  return (
    <Section title={<span className="flex items-center gap-1">手写抖动 <Help topic="抖动" /></span>}>
      <div className="grid grid-cols-3 gap-1 px-1">
        {JITTER_PRESETS.map((pr) => (
          <button
            key={pr.id}
            type="button"
            onClick={() => setJ(pr.jitter)}
            className={cn('press focus-ring h-7 rounded-md text-footnote font-medium pointer-coarse:h-10', active === pr.id ? 'bg-accent text-white' : 'bg-fill text-label hover:bg-secondary-fill')}
            aria-pressed={active === pr.id}
          >
            {pr.label}
          </button>
        ))}
      </div>
      <Button size="sm" variant="gray" icon={<Dices />} className="mx-1" onClick={() => studio.setProps(el.id, { seed: Math.floor(Math.random() * 1_000_000) })}>
        换一种写法
      </Button>
      <details className="group px-1 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-default list-none items-center gap-1 py-1 text-footnote font-medium text-accent">
          <span className="transition-transform group-open:rotate-90">›</span> 高级参数
        </summary>
        <div className="-mx-1 flex flex-col gap-1.5 pt-1">
      <Row label={<span className="inline-flex items-center gap-1">种子 <Help topic="种子" /></span>} hint="同一种子＝同一写法">
        <NumberField value={el.props.seed ?? 0} onChange={(v) => studio.setProps(el.id, { seed: Math.round(v) })} step={1} min={0} max={999999} stepper={false} className="min-w-0 flex-1" aria-label="随机种子" />
      </Row>
      <SliderRow label="基线抖动" value={j.randomY} onChange={(v) => setJ({ randomY: v })} min={0} max={0.3} step={0.01} />
      <RangeRow label="字号" value={j.randomFontSize} onChange={(v) => setJ({ randomFontSize: v })} min={0.7} max={1.3} step={0.01} unit="×" />
      <RangeRow label="旋转" value={j.randomRotate} onChange={(v) => setJ({ randomRotate: v })} min={-15} max={15} step={0.5} unit="°" />
      <RangeRow label="字距" value={j.randomSpace} onChange={(v) => setJ({ randomSpace: v })} min={0.5} max={1.6} step={0.01} unit="×" />
      <RangeRow label="X 缩放" value={j.randomXScale} onChange={(v) => setJ({ randomXScale: v })} min={0.7} max={1.3} step={0.01} unit="×" />
      <RangeRow label="Y 缩放" value={j.randomYScale} onChange={(v) => setJ({ randomYScale: v })} min={0.7} max={1.3} step={0.01} unit="×" />
      <SliderRow label="首字位置" value={j.randomFirstPos} onChange={(v) => setJ({ randomFirstPos: v })} min={0} max={10} step={0.5} unit="mm" />
      <SliderRow label="简化" value={j.simple} onChange={(v) => setJ({ simple: v })} min={0} max={2} step={0.05} unit="px" />
        </div>
      </details>
    </Section>
  )
}
