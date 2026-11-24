/**
 * Canvas-level WYSIWYG text display & inline editor overlay.
 * Aligns 1:1 with paper layout boxes in screen space (`sx`, `sy`, `zoom`),
 * rendering instant HTML in display mode and a Word-like contentEditable surface in edit mode.
 */
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { importFile, type Element, type FlowTextElement, type PaperBase, type TextElement } from '@/api/studio'
import { plainToHtml } from '@/lib/html-to-md'
import { toast } from '@/lib/toast'
import { paginateFlowHtml } from '../flow-preview'
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
  strokePreview,
  inlineEditId,
}: {
  paper: PaperBase
  v: Viewport
  els: Element[]
  sub: number
  strokePreview: boolean
  inlineEditId: string | null
}) {
  const editTextOf = useStudio((s) => s.editTextOf)

  // Bridge legacy `editTextOf` triggers (e.g. insertText / setMode) to canvas inline editing
  React.useEffect(() => {
    if (!editTextOf) return
    const st = useStudio.getState()
    st.setInlineEdit(editTextOf)
    st.setEditText(null)
  }, [editTextOf])

  if (strokePreview) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={inlineEditId == null}>
      {els.map((el) => {
        if (el.type === 'flow_text') {
          if (inlineEditId === el.id) {
            return <FlowInlineEditor key={el.id} el={el} paper={paper} v={v} sub={sub} />
          }
          return <FlowDisplay key={el.id} el={el} paper={paper} v={v} sub={sub} />
        }
        if (el.type === 'text') {
          if (inlineEditId === el.id) {
            return <TextInlineEditor key={el.id} el={el} v={v} />
          }
          return <TextDisplay key={el.id} el={el} v={v} />
        }
        return null
      })}
    </div>
  )
}

const FlowDisplay = React.memo(function FlowDisplay({
  el,
  paper,
  v,
  sub,
}: {
  el: FlowTextElement
  paper: PaperBase
  v: Viewport
  sub: number
}) {
  const pages = React.useMemo(
    () =>
      paginateFlowHtml(el.props.text, el.props.format, paper, {
        line_num: el.props.line_num,
        text_size: el.props.text_size,
      }),
    [el.props.text, el.props.format, paper, el.props.line_num, el.props.text_size],
  )
  const pageData = pages[sub]
  if (!pageData) return null

  const ox = el.transform.x
  const oy = el.transform.y
  const textAlign = ALIGN_CSS[el.props.align] ?? 'left'
  const padLeft = (el.props.paragraph?.left ?? 0) * v.zoom
  const padRight = (el.props.paragraph?.right ?? 0) * v.zoom
  const indent = el.props.paragraph?.spe_type === 1 ? (el.props.paragraph.spe_value ?? 0) * v.zoom : 0

  return (
    <div style={{ opacity: el.hidden ? 0.3 : 1 }}>
      {pageData.boxes.map((box) => {
        const lineH = (box.h_mm / Math.max(1, box.lineNum)) * v.zoom
        const fontSize = Math.max(6, lineH * (el.props.text_size || 0.72))
        return (
          <div
            key={box.boxId}
            className="pointer-events-none absolute overflow-hidden select-none"
            style={{
              left: sx(v, box.x_mm + ox),
              top: sy(v, box.y_mm + oy),
              width: box.w_mm * v.zoom,
              height: box.h_mm * v.zoom,
              paddingLeft: padLeft,
              paddingRight: padRight,
            }}
          >
            {box.html ? (
              <div
                className="rich-wysiwyg"
                style={{
                  fontSize,
                  lineHeight: `${lineH}px`,
                  textAlign,
                  textIndent: indent || undefined,
                  color: 'rgb(var(--ink))',
                }}
                dangerouslySetInnerHTML={{ __html: box.html }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
})

function FlowInlineEditor({
  el,
  paper,
  v,
  sub,
}: {
  el: FlowTextElement
  paper: PaperBase
  v: Viewport
  sub: number
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
  const fontSize = Math.max(6, lineH * (el.props.text_size || 0.72))
  const textAlign = ALIGN_CSS[el.props.align] ?? 'left'

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
  const editorW = Math.max(180, width)
  const maxToolbarW = Math.max(220, v.width - 24)
  const toolbarW = Math.min(maxToolbarW, Math.max(editorW, 480))
  const toolbarLeft = Math.max(12 - left, Math.min(0, v.width - 12 - left - toolbarW))
  const toolbarBelow = top < 88

  return (
    <div
      data-inline-editor={el.id}
      data-page-sub={sub}
      className="pointer-events-auto absolute z-20 select-text"
      style={{
        left,
        top,
        width: editorW,
        height: maxEditorH,
      }}
      onPointerDown={(e) => e.stopPropagation()}
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
        autoFocus
        showModeToggle
        onModeChange={setMode}
        onFormatChange={(nextFmt) => commitProps({ format: nextFmt })}
        onImportClick={() => fileRef.current?.click()}
        onDone={() => useStudio.getState().setInlineEdit(null)}
        onToolbarPointerDown={(e) => e.stopPropagation()}
        toolbarClassName="mat-thin bg-bg-elevated/95 shadow-lg backdrop-blur-md"
        toolbarStyle={{
          position: 'absolute',
          ...(toolbarBelow ? { top: '100%', marginTop: 6 } : { bottom: '100%', marginBottom: 6 }),
          left: toolbarLeft,
          width: toolbarW,
          maxWidth: maxToolbarW,
          zIndex: 30,
        }}
        wrapperClassName="!min-h-0 bg-bg-elevated/92 ring-2 ring-accent shadow-sm"
        wrapperStyle={{
          height: maxEditorH,
          maxHeight: maxEditorH,
          padding: '2px 4px',
        }}
        editorStyle={{
          fontSize,
          lineHeight: `${lineH}px`,
          textAlign,
          color: 'rgb(var(--ink))',
        }}
        onCommit={(nextText, nextFmt, coalesce) =>
          commitProps({ text: nextText, format: nextFmt }, coalesce ? 'text' : undefined)
        }
      />
    </div>
  )
}

const TextDisplay = React.memo(function TextDisplay({ el, v }: { el: TextElement; v: Viewport }) {
  const sc = el.transform.scale || 1
  const fontSize = Math.max(6, el.props.size_mm * v.zoom * sc)
  const align = ALIGN_CSS[el.props.align] ?? 'left'
  const rotDeg = el.transform.rotation || 0

  return (
    <div
      className="pointer-events-none absolute select-none"
      style={{
        left: sx(v, el.transform.x),
        top: sy(v, el.transform.y),
        width: el.props.box ? el.props.box.w * v.zoom : undefined,
        height: el.props.box ? el.props.box.h * v.zoom : undefined,
        fontSize,
        lineHeight: el.props.line_height,
        textAlign: align,
        whiteSpace: el.props.box ? 'pre-wrap' : 'pre',
        color: 'rgb(var(--ink))',
        opacity: el.hidden ? 0.3 : 1,
        transform: rotDeg ? `rotate(${rotDeg}deg)` : undefined,
        transformOrigin: '0 0',
      }}
    >
      {el.props.text}
    </div>
  )
})

function TextInlineEditor({ el, v }: { el: TextElement; v: Viewport }) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const sc = el.transform.scale || 1
  const fontSize = Math.max(10, el.props.size_mm * v.zoom * sc)
  const align = ALIGN_CSS[el.props.align] ?? 'left'

  React.useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [el.id])

  return (
    <div
      data-inline-editor={el.id}
      className="pointer-events-auto absolute z-20"
      style={{
        left: sx(v, el.transform.x),
        top: sy(v, el.transform.y),
        width: Math.max(140, (el.props.box?.w ?? 80) * v.zoom),
        minHeight: Math.max(36, (el.props.box?.h ?? el.props.size_mm * el.props.line_height * 2) * v.zoom),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        aria-label="文字内容"
        value={el.props.text}
        onChange={(e) => studio.setProps(el.id, { text: e.currentTarget.value }, 'text')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            useStudio.getState().setInlineEdit(null)
          }
        }}
        placeholder="输入文字，可使用 {{变量}}"
        className="h-full w-full resize rounded-sm bg-bg-elevated/90 px-1.5 py-1 text-label outline-none ring-2 ring-accent"
        style={{
          fontSize,
          lineHeight: el.props.line_height,
          textAlign: align,
          minHeight: Math.max(36, (el.props.box?.h ?? el.props.size_mm * el.props.line_height * 2) * v.zoom),
        }}
      />
    </div>
  )
}
