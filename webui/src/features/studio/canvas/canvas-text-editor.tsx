/**
 * Canvas-level direct-on-stroke writing layer + move handle.
 * Renders a transparent clickable `role="textbox"` overlay aligned 1:1 with the
 * client-side single-stroke paths so users write directly on the strokes with zero
 * ghosting and zero mode switching.
 */
import { GripVertical } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { importFile, type Element, type FlowTextElement, type PaperBase, type TextElement } from '@/api/studio'
import { cn } from '@/lib/cn'
import { plainToHtml } from '@/lib/html-to-md'
import { toast } from '@/lib/toast'
import { boxLineNum, effectiveLayoutBoxes } from '../model'
import { studio, useStudio } from '../store'
import {
  normalizeEditorHtml,
  toVisualHtml,
  WysiwygSurface,
  type EditorMode,
  type FlowFormat,
} from '../inspector/rich-editor'
import { sx, sy, type Viewport } from './overlays'

const ALIGN_CSS: Record<'L' | 'C' | 'R' | 'D', 'left' | 'center' | 'right' | 'justify'> = {
  L: 'left',
  C: 'center',
  R: 'right',
  D: 'justify',
}

export function CanvasTextLayer({
  paper,
  v,
  els,
  sub,
  focusedTextId,
  readOnly,
  onStartMove,
}: {
  paper: PaperBase
  v: Viewport
  els: Element[]
  sub: number
  focusedTextId: string | null
  readOnly: boolean
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const editTextOf = useStudio((s) => s.editTextOf)

  // Focus the canvas textbox when triggered by `editTextOf` (e.g. new letter, Enter key, or inspector button)
  React.useEffect(() => {
    if (!editTextOf) return
    const st = useStudio.getState()
    st.setFocusedTextId(editTextOf)
    st.setEditText(null)
    requestAnimationFrame(() => {
      const box = document.querySelector(`[data-inline-editor="${editTextOf}"] [role="textbox"], [data-inline-editor="${editTextOf}"] textarea`) as HTMLElement | null
      box?.focus({ preventScroll: true })
    })
  }, [editTextOf])

  if (readOnly) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <style>{`
        .studio-transparent-text::selection,
        .studio-transparent-text *::selection {
          background: rgb(var(--accent) / 0.24);
          color: transparent;
        }
      `}</style>
      {els.map((el) => {
        if (el.hidden || el.locked) return null
        if (el.type === 'flow_text') {
          return (
            <FlowDirectEditor
              key={el.id}
              el={el}
              paper={paper}
              v={v}
              sub={sub}
              focused={focusedTextId === el.id}
              onStartMove={onStartMove}
            />
          )
        }
        if (el.type === 'text') {
          return (
            <TextDirectEditor
              key={el.id}
              el={el}
              v={v}
              focused={focusedTextId === el.id}
              onStartMove={onStartMove}
            />
          )
        }
        return null
      })}
    </div>
  )
}

function MoveHandle({
  el,
  left,
  top,
  width,
  onStartMove,
}: {
  el: Element
  left: number
  top: number
  width: number
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const label = `移动${el.type === 'flow_text' ? '文本框' : '自由文本框'}`
  return (
    <button
      type="button"
      data-move-handle={el.id}
      aria-label={label}
      title={label}
      onPointerDown={(e) => onStartMove(el, e)}
      onClick={(e) => e.stopPropagation()}
      className="pointer-events-auto absolute z-30 flex h-5 items-center gap-0.5 rounded-t border border-b-0 border-separator/70 bg-bg-elevated/92 px-1.5 text-[11px] font-medium text-secondary-label shadow-sm backdrop-blur-sm transition-colors hover:border-accent hover:text-label active:cursor-grabbing"
      style={{
        left: left + Math.max(0, width / 2 - 26),
        top: Math.max(2, top - 22),
        cursor: 'grab',
      }}
    >
      <GripVertical className="size-3" />
      <span>移动</span>
    </button>
  )
}

function FlowDirectEditor({
  el,
  paper,
  v,
  sub,
  focused,
  onStartMove,
}: {
  el: FlowTextElement
  paper: PaperBase
  v: Viewport
  sub: number
  focused: boolean
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const [mode, setMode] = React.useState<EditorMode>('visual')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const fmt: FlowFormat = el.props.format ?? 'plain'
  const text = el.props.text ?? ''

  const layoutBoxes = effectiveLayoutBoxes(paper)
  const activeBox = layoutBoxes[0]
  const lineNum = boxLineNum(paper, activeBox, el.props.line_num)
  const ox = el.transform.x
  const oy = el.transform.y

  const left = sx(v, activeBox.x_mm + ox)
  const top = sy(v, activeBox.y_mm + oy)
  const width = activeBox.w_mm * v.zoom
  const height = activeBox.h_mm * v.zoom
  const lineH = (activeBox.h_mm / Math.max(1, lineNum)) * v.zoom
  const fontSize = Math.max(6, lineH * (el.props.text_size || 1) * 0.72)
  const spe1 = el.props.paragraph?.spe_type === 1 ? (el.props.paragraph.spe_value ?? 0) * v.zoom : 0
  const headingScale = el.props.rich_style?.heading_scale ?? 1.35
  const h1Lines = headingScale >= 1.3 ? 2 : 1
  const ruledVars: Record<string, string> = {
    '--ruled-lh': `${lineH}px`,
    '--ruled-indent': `${spe1}px`,
    '--ruled-h1-lh': `${lineH * h1Lines}px`,
  }
  const textAlign = ALIGN_CSS[el.props.align] ?? 'left'
  const padLeft = (el.props.paragraph?.left ?? 0) * v.zoom
  const padRight = (el.props.paragraph?.right ?? 0) * v.zoom

  const commitProps = React.useCallback(
    (patch: Record<string, unknown>, coalesce?: string) => {
      studio.setProps(el.id, patch, coalesce)
    },
    [el.id],
  )

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

  const safeTop = Math.max(0, top)
  const maxEditorH = Math.max(80, Math.min(height, v.height - safeTop - 72))
  const editorW = Math.max(120, width)
  const maxToolbarW = Math.max(220, v.width - 24)
  const toolbarW = Math.min(maxToolbarW, Math.max(editorW, 480))
  const toolbarLeft = Math.max(12 - left, Math.min(0, v.width - 12 - left - toolbarW))
  const toolbarBelow = top < 88

  return (
    <>
      <MoveHandle el={el} left={left} top={top} width={editorW} onStartMove={onStartMove} />
      <div
        data-inline-editor={el.id}
        data-page-sub={sub}
        className={cn('pointer-events-auto absolute select-text', focused ? 'z-20' : 'z-10')}
        style={{
          left,
          top,
          width: editorW,
          height: maxEditorH,
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          const st = useStudio.getState()
          if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
          if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
        }}
        onFocus={() => {
          const st = useStudio.getState()
          if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
          if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            if (useStudio.getState().focusedTextId === el.id) {
              useStudio.getState().setFocusedTextId(null)
            }
          }
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.docx,.html,.htm,.txt"
          className="hidden"
          onChange={(e) => void handleImportFiles(e.currentTarget.files)}
        />
        <WysiwygSurface
          elId={el.id}
          mode={mode}
          fmt={fmt}
          text={text}
          compact
          showModeToggle
          onModeChange={setMode}
          onFormatChange={(nextFmt) => commitProps({ format: nextFmt })}
          onImportClick={() => fileRef.current?.click()}
          onToolbarPointerDown={(e) => e.stopPropagation()}
          toolbarClassName={focused ? 'mat-thin bg-bg-elevated/95 shadow-lg backdrop-blur-md' : 'hidden'}
          toolbarStyle={{
            position: 'absolute',
            ...(toolbarBelow ? { top: '100%', marginTop: 6 } : { bottom: '100%', marginBottom: 6 }),
            left: toolbarLeft,
            width: toolbarW,
            maxWidth: maxToolbarW,
            zIndex: 30,
          }}
          wrapperClassName={cn(
            '!min-h-0 !shadow-none',
            mode === 'visual' && 'studio-transparent-text',
            mode === 'source'
              ? 'bg-bg-elevated/92 ring-2 ring-accent'
              : focused
                ? '!bg-transparent ring-1 ring-accent/55'
                : '!bg-transparent !ring-0',
          )}
          wrapperStyle={{
            height: maxEditorH,
            maxHeight: maxEditorH,
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: padLeft,
            paddingRight: padRight,
          }}
          editorClassName="studio-ruled-editor"
          editorStyle={
            {
              fontSize,
              lineHeight: `${lineH}px`,
              letterSpacing: `${(el.props.char_space ?? 0) * v.zoom}px`,
              textAlign,
              ...ruledVars,
              ...(mode === 'visual'
                ? {
                    color: 'transparent',
                    background: 'transparent',
                    caretColor: 'rgb(var(--accent))',
                  }
                : {
                    color: 'rgb(var(--ink))',
                  }),
            } as React.CSSProperties
          }
          onCommit={(nextText, nextFmt, coalesce) =>
            commitProps({ text: nextText, format: nextFmt }, coalesce ? 'text' : undefined)
          }
        />
      </div>
    </>
  )
}

function TextDirectEditor({
  el,
  v,
  focused,
  onStartMove,
}: {
  el: TextElement
  v: Viewport
  focused: boolean
  onStartMove: (el: Element, e: React.PointerEvent) => void
}) {
  const lineHeight = el.props.size_mm * el.props.line_height * v.zoom
  const fontSize = Math.max(6, el.props.size_mm * v.zoom * 0.78)
  const align = ALIGN_CSS[el.props.align] ?? 'left'
  const left = sx(v, el.transform.x)
  const top = sy(v, el.transform.y)
  const width = Math.max(80, (el.props.box?.w ?? 80) * v.zoom)
  const height = Math.max(28, (el.props.box?.h ?? el.props.size_mm * el.props.line_height * Math.max(1, el.props.text.split('\n').length)) * v.zoom)

  return (
    <>
      <MoveHandle el={el} left={left} top={top} width={width} onStartMove={onStartMove} />
      <div
        data-inline-editor={el.id}
        className={cn('pointer-events-auto absolute', focused ? 'z-20' : 'z-10')}
        style={{
          left,
          top,
          width,
          height,
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          const st = useStudio.getState()
          if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
          if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <textarea
          role="textbox"
          aria-multiline="true"
          aria-label="文本框内容"
          spellCheck={false}
          value={el.props.text}
          onFocus={() => {
            const st = useStudio.getState()
            if (st.selection.length !== 1 || st.selection[0] !== el.id) st.select([el.id])
            if (st.focusedTextId !== el.id) st.setFocusedTextId(el.id)
          }}
          onBlur={() => {
            if (useStudio.getState().focusedTextId === el.id) {
              useStudio.getState().setFocusedTextId(null)
            }
          }}
          onChange={(e) => studio.setProps(el.id, { text: e.currentTarget.value }, 'text')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              e.currentTarget.blur()
              useStudio.getState().setFocusedTextId(null)
              ;(document.querySelector('[data-studio-canvas]') as HTMLElement | null)?.focus({ preventScroll: true })
            }
          }}
          className={cn(
            'studio-transparent-text h-full w-full resize-none overflow-hidden rounded-sm bg-transparent p-0 outline-none',
            focused ? 'ring-1 ring-accent/55' : 'ring-0',
          )}
          style={{
            fontSize,
            lineHeight: `${lineHeight}px`,
            padding: 0,
            textAlign: align,
            color: 'transparent',
            background: 'transparent',
            caretColor: 'rgb(var(--accent))',
          }}
        />
      </div>
    </>
  )
}
