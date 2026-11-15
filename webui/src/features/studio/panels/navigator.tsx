/** Left column: page navigator (thumbnails) + layers list of the current page. */
import { Copy, Eye, EyeOff, FileCode2, Image as ImageIcon, Lock, LockOpen, PenTool, Plus, ScrollText, Shapes, Trash2, Type } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DocPage, Element, ElementType, PaperBase } from '@/api/studio'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, IconButton, Segmented,
} from '@/components/ui'
import { useInView } from '@/lib/use-in-view'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { addPage, deletePage, duplicatePage, moveToIndex, movePage, papersCache, toggleHidden, toggleLock } from '../actions'
import { patchBackground } from '../background'
import { svgTransform } from '../geometry'
import { elementOnPage, elementName, pagePaperRef, paperDims, resolvePaper, sortedByZ } from '../model'
import { usePagination } from '../pagination'
import { useElementRender } from '../element-render'
import { studio, useStudio } from '../store'

export const TYPE_ICON: Record<ElementType, typeof Type> = { text: Type, flow_text: ScrollText, image: ImageIcon, svg: PenTool, dxf: PenTool, shape: Shapes, gcode: FileCode2 }

function ThumbEl({ el, sub }: { el: Element; sub: number }) {
  const { r } = useElementRender(el)
  const d = el.type === 'flow_text' ? r?.pages?.[sub]?.d : elementOnPage(el, sub) ? r?.d : undefined
  if (!d || el.hidden) return null
  return <path d={d} transform={svgTransform(el.transform)} fill="none" stroke="rgb(var(--ink))" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
}

export const PageThumb = React.memo(function PageThumb({ page, paper, sub = 0, size = 72 }: { page: DocPage; paper: PaperBase; sub?: number; size?: number }) {
  const { ref, visible } = useInView<SVGSVGElement>()
  const { w, h } = paperDims(paper)
  const k = size / Math.max(w, h)
  return (
    <svg ref={ref} width={w * k} height={h * k} viewBox={`0 0 ${w} ${h}`} className="block bg-canvas-paper shadow-paper" aria-hidden>
      {visible && sortedByZ(page.elements).map((e) => (!elementOnPage(e, sub) ? null : <ThumbEl key={e.id} el={e} sub={sub} />))}
    </svg>
  )
})

export function PagesList({ horizontal = false }: { horizontal?: boolean }) {
  const { doc, view } = useStudio(useShallow((s) => ({ doc: s.doc, view: s.view })))
  const pagination = usePagination(doc)
  const [dragFrom, setDragFrom] = React.useState<number | null>(null)
  if (!doc) return null
  const papers = papersCache()
  return (
    <div className={cn(horizontal ? 'flex items-center gap-2 overflow-x-auto px-3 py-2 scrollbar-none' : 'flex flex-col gap-3 p-3')} role="listbox" aria-label="页面">
      {doc.pages.map((p, i) => (
        <PageItem
          key={p.id}
          page={p}
          index={i}
          firstNumber={pagination.findIndex((v) => v.page === i) + 1}
          count={pagination.filter((v) => v.page === i).length}
          paper={resolvePaper(pagePaperRef(doc, p), papers)}
          active={view.page === i}
          activeSub={view.page === i ? view.sub : -1}
          horizontal={horizontal}
          canDelete={doc.pages.length > 1}
          onDragStart={() => setDragFrom(i)}
          onDrop={() => {
            if (dragFrom != null) movePage(dragFrom, i)
            setDragFrom(null)
          }}
        />
      ))}
      <button
        type="button"
        onClick={() => addPage(doc.pages.length - 1)}
        className={cn(
          'press focus-ring flex shrink-0 items-center justify-center gap-1 rounded-md border border-dashed border-separator text-footnote text-secondary-label hover:bg-quaternary-fill',
          horizontal ? 'h-11 w-11' : 'h-9',
        )}
        aria-label="添加页面"
      >
        <Plus className="size-4" />
        {horizontal ? null : '页面'}
      </button>
    </div>
  )
}

function PageItem({
  page, index, firstNumber, count, paper, active, activeSub, horizontal, canDelete, onDragStart, onDrop,
}: {
  page: DocPage
  index: number
  firstNumber: number
  count: number
  paper: PaperBase
  active: boolean
  activeSub: number
  horizontal: boolean
  canDelete: boolean
  onDragStart: () => void
  onDrop: () => void
}) {
  const go = (sub: number) => useStudio.getState().setView({ page: index, sub })
  const thumb = (sub: number, isActive: boolean, label: string) => (
    <button
      key={sub}
      type="button"
      role="option"
      aria-selected={isActive}
      aria-label={label}
      onClick={() => go(sub)}
      className={cn('focus-ring relative flex shrink-0 flex-col items-center gap-1 rounded-md p-1', isActive ? 'bg-accent/12' : 'hover:bg-quaternary-fill')}
    >
      <span className={cn('rounded-[3px] p-0.5', isActive ? 'ring-2 ring-accent' : '')}>
        <PageThumb page={page} paper={paper} sub={sub} size={horizontal ? 40 : 76} />
      </span>
      {horizontal ? null : (
        <span className="flex items-center gap-1 text-caption tabular-nums text-secondary-label">
          {firstNumber + sub}
        </span>
      )}
    </button>
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn('flex shrink-0 gap-1', horizontal ? 'flex-row' : 'flex-col items-center')}
          draggable={!horizontal}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('application/x-penplot-page', String(index))
            onDragStart()
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-penplot-page')) e.preventDefault()
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onDrop()
          }}
        >
          {Array.from({ length: count }, (_, sub) => thumb(sub, active && activeSub === sub, `第 ${firstNumber + sub} 页`))}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => addPage(index)}>{count > 1 ? '在信笺后插入空白页' : '在后面插入空白页'}</ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicatePage(index)}>
          <Copy className="size-4" /> {count > 1 ? `复制信笺（共 ${count} 页）` : '复制页面'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!canDelete}
          className="text-red"
          onSelect={async () => {
            if (page.elements.length && !(await confirm({ title: `删除第 ${firstNumber} 页${count > 1 ? `及其后 ${count - 1} 页信笺` : ''}？`, description: `页面上的 ${page.elements.length} 个元素也会被删除（可撤销）。`, confirmLabel: '删除', destructive: true }))) return
            deletePage(index)
          }}
        >
          <Trash2 className="size-4" /> {count > 1 ? `删除信笺（共 ${count} 页）` : '删除页面'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function LayersList() {
  const { doc, view, selection } = useStudio(useShallow((s) => ({ doc: s.doc, view: s.view, selection: s.selection })))
  const [drag, setDrag] = React.useState<string | null>(null)
  const [over, setOver] = React.useState<number | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const page = doc?.pages[view.page]
  if (!page) return null
  const list = sortedByZ(page.elements.filter((e) => elementOnPage(e, view.sub))).reverse() // top first
  const bgRow = page.background ? <BackgroundRow bg={page.background} /> : null
  if (!list.length)
    return (
      <>
        <p className="px-4 py-6 text-center text-footnote text-tertiary-label">本页还没有元素。<br />从工具栏插入文本、形状或文件。</p>
        {bgRow ? <div className="px-2 pb-3">{bgRow}</div> : null}
      </>
    )
  return (
    <>
    <ul className="flex flex-col px-2 pb-1" role="listbox" aria-label="图层" aria-multiselectable>
      {list.map((el, i) => {
        const Icon = TYPE_ICON[el.type]
        const sel = selection.includes(el.id)
        return (
          <li
            key={el.id}
            role="option"
            aria-selected={sel}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('application/x-penplot-layer', el.id)
              setDrag(el.id)
            }}
            onDragOver={(e) => {
              if (!drag) return
              e.preventDefault()
              setOver(i)
            }}
            onDragEnd={() => {
              setDrag(null)
              setOver(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (drag) moveToIndex(drag, list.length - 1 - i)
              setDrag(null)
              setOver(null)
            }}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) studio.get().toggleSelect(el.id)
              else studio.get().select([el.id])
            }}
            onDoubleClick={() => setRenaming(el.id)}
            className={cn(
              'group flex h-8 cursor-default items-center gap-1 rounded-sm pl-1 pr-1.5 text-body pointer-coarse:h-11',
              sel ? 'bg-accent text-white' : 'hover:bg-quaternary-fill',
              over === i && drag !== el.id && 'shadow-[inset_0_2px_0_rgb(var(--accent))]',
              el.hidden && !sel && 'text-tertiary-label',
            )}
          >
            <IconButton
              label={el.hidden ? '显示' : '隐藏'}
              size="sm"
              className={cn(sel && 'text-white/90 hover:bg-white/15 hover:text-white')}
              onClick={(e) => {
                e.stopPropagation()
                toggleHidden([el.id])
              }}
            >
              {el.hidden ? <EyeOff /> : <Eye />}
            </IconButton>
            <IconButton
              label={el.locked ? '解锁' : '锁定'}
              size="sm"
              className={cn(!el.locked && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60', sel && 'text-white/90 hover:bg-white/15 hover:text-white')}
              onClick={(e) => {
                e.stopPropagation()
                toggleLock([el.id])
              }}
            >
              {el.locked ? <Lock /> : <LockOpen />}
            </IconButton>
            <Icon className={cn('size-3.5 shrink-0', sel ? 'text-white' : 'text-secondary-label')} aria-hidden />
            {renaming === el.id ? (
              <input
                autoFocus
                defaultValue={elementName(el)}
                className="min-w-0 flex-1 rounded-xs bg-bg-elevated px-1 text-body text-label outline-none ring-2 ring-accent"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    e.preventDefault()
                    e.currentTarget.blur()
                  }
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim()
                  setRenaming(null)
                  studio.updateElement(el.id, (x) => ({ ...x, name: name || null }))
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate pl-1">{elementName(el)}</span>
            )}
          </li>
        )
      })}
    </ul>
    {bgRow ? <div className="hairline-t mx-2 mb-3 pt-1">{bgRow}</div> : null}
    </>
  )
}

/** The page's reference background, below every layer (never printed). Click = 对齐背景. */
function BackgroundRow({ bg }: { bg: NonNullable<DocPage['background']> }) {
  const align = useStudio((s) => s.bgAlign)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => useStudio.getState().setBgAlign(!align)}
      onKeyDown={(e) => e.key === 'Enter' && useStudio.getState().setBgAlign(!align)}
      className={cn('group flex h-8 cursor-default items-center gap-1 rounded-sm pl-1 pr-1.5 text-body pointer-coarse:h-11', align ? 'bg-orange/20' : 'hover:bg-quaternary-fill', !bg.visible && 'text-tertiary-label')}
      title="参考背景（不打印）· 点按对齐"
    >
      <IconButton
        label={bg.visible ? '隐藏背景' : '显示背景'}
        size="sm"
        onClick={(e) => {
          e.stopPropagation()
          patchBackground({ visible: !bg.visible })
        }}
      >
        {bg.visible ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton
        label={bg.locked ? '解锁背景' : '锁定背景'}
        size="sm"
        className={cn(!bg.locked && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60')}
        onClick={(e) => {
          e.stopPropagation()
          patchBackground({ locked: !bg.locked })
        }}
      >
        {bg.locked ? <Lock /> : <LockOpen />}
      </IconButton>
      <ImageIcon className="size-3.5 shrink-0 text-orange" aria-hidden />
      <span className="min-w-0 flex-1 truncate pl-1">参考背景</span>
      <span className="shrink-0 text-caption text-tertiary-label">不打印</span>
    </div>
  )
}

export function Navigator() {
  const [tab, setTab] = React.useState<'pages' | 'layers'>('pages')
  return (
    <div className="flex h-full flex-col">
      <div className="hairline-b shrink-0 p-2">
        <Segmented value={tab} onValueChange={setTab} options={[{ value: 'pages', label: '页面' }, { value: 'layers', label: '图层' }]} block size="sm" aria-label="左栏" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{tab === 'pages' ? <PagesList /> : <LayersList />}</div>
    </div>
  )
}
