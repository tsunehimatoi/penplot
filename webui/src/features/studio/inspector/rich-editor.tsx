import {
  BarChart3, Bold, Code, FileUp, Heading1, Heading2, Italic, List, ListOrdered,
  Maximize2, Quote, Sigma, Strikethrough, Table, Underline, WrapText,
} from 'lucide-react'
import * as React from 'react'
import type { FlowTextElement } from '@/api/studio'
import { importFile } from '@/api/studio'
import {
  Button, Dialog, DialogContent, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  Segmented, Textarea,
} from '@/components/ui'
import { errorMessage } from '@/api/client'
import { htmlToMarkdown, sanitizePastedHtml } from '@/lib/html-to-md'
import { toast } from '@/lib/toast'
import { studio } from '../store'

export type FlowFormat = 'plain' | 'markdown' | 'html'

const FORMAT_OPTIONS = [
  { value: 'markdown' as const, label: 'MD' },
  { value: 'html' as const, label: 'H5' },
  { value: 'plain' as const, label: 'TXT' },
]

const FORMULA_PRESETS = [
  { label: '行内公式 $...$', md: '$E = mc^2$' },
  { label: '二次求根公式', md: '\n$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$\n' },
  { label: '定积分', md: '\n$$\n\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n' },
  { label: '求和级数', md: '\n$$\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n$$\n' },
  { label: '矩阵', md: '\n$$\nA = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\n' },
]

const CHART_PRESETS = [
  {
    label: '柱状图 (Bar)',
    spec: { type: 'bar', title: '季度对比', x: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '系列A', data: [12, 19, 15, 24] }, { name: '系列B', data: [8, 14, 18, 20] }] },
  },
  {
    label: '折线图 (Line)',
    spec: { type: 'line', title: '趋势曲线', x: ['1月', '2月', '3月', '4月', '5月'], series: [{ name: '数值', data: [10, 22, 18, 30, 27] }] },
  },
  {
    label: '饼图 (Pie)',
    spec: { type: 'pie', title: '占比分布', x: ['A', 'B', 'C'], series: [{ data: [45, 35, 20] }] },
  },
  {
    label: '函数曲线 (Function)',
    spec: { type: 'function', title: 'y = sin(x)', expr: 'sin(x)', xmin: -6.28, xmax: 6.28 },
  },
]

function insertAtCursor(
  el: HTMLTextAreaElement | null,
  current: string,
  snippet: string,
  wrapEnd?: string,
): { next: string; selStart: number; selEnd: number } {
  if (!el) {
    const next = current + snippet + (wrapEnd ?? '')
    return { next, selStart: next.length, selEnd: next.length }
  }
  const start = el.selectionStart ?? current.length
  const end = el.selectionEnd ?? current.length
  const selected = current.slice(start, end)
  const inserted = wrapEnd !== undefined ? `${snippet}${selected || '文本'}${wrapEnd}` : snippet
  const next = current.slice(0, start) + inserted + current.slice(end)
  const pos = wrapEnd !== undefined && !selected
    ? { selStart: start + snippet.length, selEnd: start + snippet.length + 2 }
    : { selStart: start + inserted.length, selEnd: start + inserted.length }
  return { next, ...pos }
}

export function RichFlowEditor({
  el,
  textareaRef,
}: {
  el: FlowTextElement
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [expanded, setExpanded] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const fmt: FlowFormat = el.props.format ?? 'plain'
  const text = el.props.text ?? ''

  const setText = (next: string, key = 'text') => studio.setProps(el.id, { text: next }, key)
  const setFormat = (next: FlowFormat) => studio.setProps(el.id, { format: next })

  const applyInsert = (
    targetRef: React.RefObject<HTMLTextAreaElement | null>,
    snippet: string,
    wrapEnd?: string,
  ) => {
    if (fmt === 'plain') setFormat('markdown')
    const { next, selStart, selEnd } = insertAtCursor(targetRef.current, text, snippet, wrapEnd)
    setText(next)
    requestAnimationFrame(() => {
      targetRef.current?.focus()
      targetRef.current?.setSelectionRange(selStart, selEnd)
    })
  }

  const handlePaste = (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    targetRef: React.RefObject<HTMLTextAreaElement | null>,
  ) => {
    const htmlData = e.clipboardData.getData('text/html')
    const plainData = e.clipboardData.getData('text/plain')

    if (!htmlData) {
      if (fmt === 'plain' && plainData) {
        const looksHtml = /<(h[1-6]|table|ul|ol|blockquote|svg)\b/i.test(plainData)
        const looksMd = /(^|\n)#{1,6}\s|\$\$[\s\S]+?\$\$|\$[^$\s][^$\n]*\$|(^|\n)```|(^|\n)\|.+\|\s*\n\s*\|[\s:-]+\||\*\*[^*\n]+\*\*/m.test(plainData)
        if (looksHtml) {
          setFormat('html')
          toast.info('检测到 HTML 内容，已自动切换为 H5 富文本格式')
        } else if (looksMd) {
          setFormat('markdown')
          toast.info('检测到 Markdown / 公式内容，已自动切换为 MD 富文本格式')
        }
      }
      return
    }

    const hasRich = /<(h[1-6]|b|strong|i|em|u|s|del|ul|ol|li|table|blockquote|pre|code|svg)\b/i.test(htmlData)
    if (!hasRich && fmt === 'plain') {
      if (plainData && /(^|\n)#{1,6}\s|\$\$[\s\S]+?\$\$|\$[^$\s][^$\n]*\$|(^|\n)```|\*\*[^*\n]+\*\*/m.test(plainData)) {
        setFormat('markdown')
        toast.info('检测到 Markdown / 公式内容，已自动切换为 MD 富文本格式')
      }
      return
    }
    e.preventDefault()
    let converted = ''
    if (fmt === 'html') {
      converted = sanitizePastedHtml(htmlData)
    } else {
      converted = htmlToMarkdown(htmlData)
      if (fmt === 'plain') {
        setFormat('markdown')
        toast.info('已自动切换为 MD 富文本格式')
      }
    }
    const { next, selStart, selEnd } = insertAtCursor(targetRef.current, text, converted)
    setText(next)
    requestAnimationFrame(() => {
      targetRef.current?.setSelectionRange(selStart, selEnd)
    })
  }

  const handleImportFiles = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    try {
      const r = await importFile(file)
      if (r.kind === 'document') {
        studio.setProps(el.id, { text: r.data.content, format: r.data.format })
        if (r.data.warnings?.length) toast.warning(file.name, { description: r.data.warnings.join('；') })
        else toast.success(`已导入 ${file.name}`)
      } else if (r.kind === 'text') {
        studio.setProps(el.id, { text: r.data.text, format: 'plain' })
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

  const renderToolbar = (targetRef: React.RefObject<HTMLTextAreaElement | null>, compact: boolean) => {
    const isHtml = fmt === 'html'
    const btnCls = 'h-6 px-1.5 text-footnote'
    return (
      <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-separator/70 bg-fill/40 p-1">
        <Button type="button" size="sm" variant="plain" className={btnCls} title="一级标题"
          onClick={() => applyInsert(targetRef, isHtml ? '<h1>' : '# ', isHtml ? '</h1>' : undefined)}>
          <Heading1 className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="二级标题"
          onClick={() => applyInsert(targetRef, isHtml ? '<h2>' : '## ', isHtml ? '</h2>' : undefined)}>
          <Heading2 className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="加粗"
          onClick={() => applyInsert(targetRef, isHtml ? '<strong>' : '**', isHtml ? '</strong>' : '**')}>
          <Bold className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="斜体"
          onClick={() => applyInsert(targetRef, isHtml ? '<em>' : '*', isHtml ? '</em>' : '*')}>
          <Italic className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="下划线"
          onClick={() => applyInsert(targetRef, '<u>', '</u>')}>
          <Underline className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="删除线"
          onClick={() => applyInsert(targetRef, isHtml ? '<s>' : '~~', isHtml ? '</s>' : '~~')}>
          <Strikethrough className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="无序列表"
          onClick={() => applyInsert(targetRef, isHtml ? '\n<ul>\n  <li>项目一</li>\n  <li>项目二</li>\n</ul>\n' : '\n- 项目一\n- 项目二\n')}>
          <List className="size-3.5" />
        </Button>
        <Button type="button" size="sm" variant="plain" className={btnCls} title="有序列表"
          onClick={() => applyInsert(targetRef, isHtml ? '\n<ol>\n  <li>第一项</li>\n  <li>第二项</li>\n</ol>\n' : '\n1. 第一项\n2. 第二项\n')}>
          <ListOrdered className="size-3.5" />
        </Button>
        {!compact && (
          <>
            <Button type="button" size="sm" variant="plain" className={btnCls} title="引用"
              onClick={() => applyInsert(targetRef, isHtml ? '\n<blockquote>引用内容</blockquote>\n' : '\n> 引用内容\n')}>
              <Quote className="size-3.5" />
            </Button>
            <Button type="button" size="sm" variant="plain" className={btnCls} title="代码块"
              onClick={() => applyInsert(targetRef, isHtml ? '\n<pre><code>' : '\n```\n', isHtml ? '</code></pre>\n' : '\n```\n')}>
              <Code className="size-3.5" />
            </Button>
          </>
        )}
        <Button type="button" size="sm" variant="plain" className={btnCls} title="插入表格"
          onClick={() => applyInsert(
            targetRef,
            isHtml
              ? '\n<table>\n  <tr><th>列1</th><th>列2</th></tr>\n  <tr><td>数据1</td><td>数据2</td></tr>\n</table>\n'
              : '\n| 列1 | 列2 |\n| --- | --- |\n| 数据1 | 数据2 |\n',
          )}>
          <Table className="size-3.5" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="plain" className={btnCls} title="插入 LaTeX 公式">
              <Sigma className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {FORMULA_PRESETS.map((p) => (
              <DropdownMenuItem key={p.label} onSelect={() => applyInsert(targetRef, p.md)}>
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="plain" className={btnCls} title="插入图表">
              <BarChart3 className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {CHART_PRESETS.map((p) => (
              <DropdownMenuItem
                key={p.label}
                onSelect={() => {
                  const json = JSON.stringify(p.spec, null, 2)
                  const snippet = isHtml
                    ? `\n<pre><code class="language-chart">\n${json}\n</code></pre>\n`
                    : `\n\`\`\`chart\n${json}\n\`\`\`\n`
                  applyInsert(targetRef, snippet)
                }}
              >
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button type="button" size="sm" variant="plain" className={btnCls} title="插入分页符"
          onClick={() => applyInsert(targetRef, isHtml ? '\n<div style="page-break-after: always"></div>\n' : '\n===\n')}>
          <WrapText className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.docx,.html,.htm,.txt"
        className="hidden"
        onChange={(e) => void handleImportFiles(e.currentTarget.files)}
      />

      <div className="flex items-center justify-between gap-1">
        <Segmented
          value={fmt}
          onValueChange={(v) => setFormat(v as FlowFormat)}
          options={FORMAT_OPTIONS}
          size="sm"
          aria-label="正文格式"
        />
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="gray" icon={<FileUp />} onClick={() => fileRef.current?.click()} title="导入 MD / Word(.docx) / HTML / TXT">
            导入
          </Button>
          <Button type="button" size="sm" variant="gray" icon={<Maximize2 />} onClick={() => setExpanded(true)} title="打开富文本大窗编辑器" aria-label="展开编辑器" />
        </div>
      </div>

      {fmt !== 'plain' && renderToolbar(textareaRef, true)}

      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onPaste={(e) => handlePaste(e, textareaRef)}
        rows={10}
        className="font-mono text-footnote leading-relaxed"
        placeholder={
          fmt === 'html'
            ? '支持粘贴 Word / 网页 HTML、<table>、$LaTeX$ 公式、图表代码块…'
            : fmt === 'markdown'
              ? '支持 Markdown、直接粘贴 Word/网页内容、$LaTeX$ 公式、```chart 图表、表格…'
              : '尊敬的…（直接输入，自动换行分页；也可切换为 Markdown/HTML 富文本）'
        }
        aria-label="信笺正文内容"
      />

      <RichEditorDialog
        open={expanded}
        onOpenChange={setExpanded}
        fmt={fmt}
        onFormatChange={setFormat}
        text={text}
        onTextChange={setText}
        onPaste={handlePaste}
        onImportClick={() => fileRef.current?.click()}
        renderToolbar={renderToolbar}
      />
    </div>
  )
}

function RichEditorDialog({
  open, onOpenChange, fmt, onFormatChange, text, onTextChange, onPaste, onImportClick, renderToolbar,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  fmt: FlowFormat
  onFormatChange: (v: FlowFormat) => void
  text: string
  onTextChange: (v: string) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>, ref: React.RefObject<HTMLTextAreaElement | null>) => void
  onImportClick: () => void
  renderToolbar: (ref: React.RefObject<HTMLTextAreaElement | null>, compact: boolean) => React.ReactNode
}) {
  const dlgRef = React.useRef<HTMLTextAreaElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] max-w-3xl flex-col gap-3">
        <DialogHeader className="flex flex-row items-center justify-between gap-2 pr-6">
          <DialogTitle>信笺富文本编辑器</DialogTitle>
          <div className="flex items-center gap-2">
            <Segmented value={fmt} onValueChange={(v) => onFormatChange(v as FlowFormat)} options={FORMAT_OPTIONS} size="sm" />
            <Button type="button" size="sm" variant="gray" icon={<FileUp />} onClick={onImportClick}>
              导入 MD / Word / HTML
            </Button>
          </div>
        </DialogHeader>
        {renderToolbar(dlgRef, false)}
        <Textarea
          ref={dlgRef}
          value={text}
          onChange={(e) => onTextChange(e.currentTarget.value)}
          onPaste={(e) => onPaste(e, dlgRef)}
          rows={18}
          className="min-h-[340px] flex-1 resize-none font-mono text-body leading-relaxed"
          placeholder="可直接从 Word / 网页复制粘贴，或输入 Markdown、HTML、$LaTeX$ 公式、```chart 图表…"
        />
        <p className="text-footnote text-secondary-label">
          提示：所有文字将使用右侧选定的手写/矢量字体，LaTeX 公式（<code>$...$</code> / <code>$$...$$</code>）与图表（<code>```chart</code>）将自动转为路径并按纸张行数跨页排版。
        </p>
      </DialogContent>
    </Dialog>
  )
}
