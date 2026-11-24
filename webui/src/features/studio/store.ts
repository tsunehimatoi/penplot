/**
 * Studio editor state (Zustand): the open project document, undo/redo history, selection, tool, view.
 * All document edits go through `edit()` so history, dirty state and autosave stay consistent.
 */
import { create } from 'zustand'
import type { DocPage, Element, Project, ProjectDoc } from '@/api/studio'
import { elementOnPage, clone, normalizeZ } from './model'

export type Tool = 'select' | 'hand' | 'text' | 'rect' | 'ellipse' | 'line'
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

export interface Overlays {
  rulers: boolean
  grid: boolean
  snap: boolean
  origin: boolean
  axes: boolean
  workArea: boolean
  travel: boolean
  source: boolean
  unit: 'mm' | 'in'
}

const OVERLAY_KEY = 'penplot.studio.overlays'
function loadOverlays(): Overlays {
  const def: Overlays = { rulers: true, grid: false, snap: true, origin: true, axes: true, workArea: true, travel: false, source: false, unit: 'mm' }
  try {
    return { ...def, ...(JSON.parse(localStorage.getItem(OVERLAY_KEY) ?? '{}') as Partial<Overlays>) }
  } catch {
    return def
  }
}

export interface View {
  zoom: number // px per mm
  panX: number // screen px of page x=0
  panY: number
}

/** Which page the canvas shows: a project page, or an auto (flow overflow) page `sub` ≥ 1 after it. */
export interface PageView {
  page: number
  sub: number
}

interface Hist {
  doc: ProjectDoc
  selection: string[]
  view: PageView
}

export interface StudioState {
  project: Pick<Project, 'id' | 'name' | 'rev' | 'is_template' | 'updated_at'> | null
  doc: ProjectDoc | null
  /** Incremented on every doc change (render/autosave triggers). */
  version: number
  savedVersion: number
  saveState: SaveState
  saveError: string | null
  past: Hist[]
  future: Hist[]
  lastCoalesce: { key: string; at: number } | null

  view: PageView
  selection: string[]
  tool: Tool
  /** Viewer role: local edits are ignored (remote patches still apply). */
  readOnly: boolean
  setReadOnly: (v: boolean) => void
  spaceHand: boolean
  zoom: View
  fitRequest: number
  overlays: Overlays
  animate: boolean
  /** Element id whose text should be edited (focus canvas textbox / open sheet). */
  editTextOf: string | null
  /** Element id of the text/flow_text box that currently holds input focus (shows floating format toolbar). */
  focusedTextId: string | null

  load: (p: Project) => void
  close: () => void
  setProjectMeta: (p: Partial<NonNullable<StudioState['project']>>) => void
  markSaved: (rev: number, version: number, updated_at?: number) => void
  setSaveState: (s: SaveState, err?: string | null) => void

  /** Apply an edit. `coalesce`: merge with the previous edit of the same key within 1 s (typing). `record:false` = no history entry (drag move after a checkpoint). */
  edit: (fn: (doc: ProjectDoc) => ProjectDoc | void, opts?: { coalesce?: string; record?: boolean; clone?: boolean; remote?: boolean }) => void
  checkpoint: () => void
  undo: () => void
  redo: () => void

  setView: (v: PageView, keepTextFocus?: boolean) => void
  select: (ids: string[]) => void
  toggleSelect: (id: string) => void
  setTool: (t: Tool) => void
  setSpaceHand: (b: boolean) => void
  setZoom: (v: View) => void
  requestFit: () => void
  setOverlay: <K extends keyof Overlays>(k: K, v: Overlays[K]) => void
  /** Per-job XY placement offset (mm, page axes) applied at print/export/frame time only — the design is untouched. */
  placement: { dx: number; dy: number }
  setPlacement: (p: { dx: number; dy: number }) => void
  /** Ids being dragged right now (remote patches for them are deferred). */
  dragging: string[]
  setAnimate: (b: boolean) => void
  setEditText: (id: string | null) => void
  setFocusedTextId: (id: string | null) => void
  /** 对齐背景 mode: the page background becomes the only editable object on the canvas. */
  bgAlign: boolean
  setBgAlign: (b: boolean) => void
  /** Two-point calibration in progress (image px of the picked points). */
  bgCalib: BgCalib | null
  setBgCalib: (c: BgCalib | null) => void
  /** Canvas gesture target in align mode on touch: move the background or pan/zoom the view. */
  bgTouch: 'bg' | 'view'
  setBgTouch: (m: 'bg' | 'view') => void
}

export interface BgCalib {
  step: 'a' | 'b' | 'dist'
  a?: { x: number; y: number }
  b?: { x: number; y: number }
}

const MAX_HISTORY = 100

function loadPlacement(id: string) {
  try {
    const v = JSON.parse(localStorage.getItem(`penplot.studio.placement.${id}`) ?? 'null') as { dx: number; dy: number } | null
    return v && Number.isFinite(v.dx) && Number.isFinite(v.dy) ? v : { dx: 0, dy: 0 }
  } catch {
    return { dx: 0, dy: 0 }
  }
}

export const useStudio = create<StudioState>((set, get) => ({
  project: null,
  doc: null,
  version: 0,
  savedVersion: 0,
  saveState: 'saved',
  saveError: null,
  past: [],
  future: [],
  lastCoalesce: null,
  view: { page: 0, sub: 0 },
  selection: [],
  tool: 'select',
  readOnly: false,
  setReadOnly: (v) => set(v ? { readOnly: true, tool: 'hand', selection: [], focusedTextId: null } : { readOnly: false }),
  spaceHand: false,
  zoom: { zoom: 2, panX: 40, panY: 40 },
  fitRequest: 0,
  overlays: loadOverlays(),
  animate: false,
  editTextOf: null,
  focusedTextId: null,
  placement: { dx: 0, dy: 0 },
  dragging: [],
  setPlacement: (p) => {
    set({ placement: p })
    const id = get().project?.id
    if (id) {
      try {
        localStorage.setItem(`penplot.studio.placement.${id}`, JSON.stringify(p))
      } catch {
        /* ignore */
      }
    }
  },

  load: (p) =>
    set({
      project: { id: p.id, name: p.name, rev: p.rev, is_template: p.is_template, updated_at: p.updated_at },
      doc: p.doc,
      version: 1,
      savedVersion: 1,
      saveState: 'saved',
      saveError: null,
      past: [],
      future: [],
      lastCoalesce: null,
      view: { page: 0, sub: 0 },
      selection: [],
      fitRequest: get().fitRequest + 1,
      placement: loadPlacement(p.id),
      editTextOf: null,
      focusedTextId: null,
      bgAlign: false,
      bgCalib: null,
    }),
  close: () => set({ project: null, doc: null, past: [], future: [], selection: [], editTextOf: null, focusedTextId: null }),
  setProjectMeta: (p) => {
    const cur = get().project
    if (cur) set({ project: { ...cur, ...p } })
  },
  markSaved: (rev, version, updated_at) => {
    const cur = get().project
    if (!cur) return
    set({
      project: { ...cur, rev, updated_at: updated_at ?? cur.updated_at },
      savedVersion: version,
      saveState: get().version === version ? 'saved' : 'dirty',
      saveError: null,
    })
  },
  setSaveState: (s, err = null) => set({ saveState: s, saveError: err }),

  edit: (fn, opts = {}) => {
    const { doc, past, lastCoalesce, selection, view } = get()
    if (!doc) return
    if (get().readOnly && !opts.remote) return
    const draft = opts.clone === false ? doc : clone(doc)
    const out = fn(draft) ?? draft
    const now = Date.now()
    const coalesced = !!opts.coalesce && lastCoalesce?.key === opts.coalesce && now - lastCoalesce.at < 1000
    const record = opts.record !== false && !coalesced
    set({
      doc: out,
      version: get().version + 1,
      saveState: 'dirty',
      past: record ? [...past.slice(-MAX_HISTORY + 1), { doc, selection, view }] : past,
      future: opts.record === false ? get().future : [],
      lastCoalesce: opts.coalesce ? { key: opts.coalesce, at: now } : null,
    })
  },
  checkpoint: () => {
    const { doc, past, selection, view } = get()
    if (!doc) return
    set({ past: [...past.slice(-MAX_HISTORY + 1), { doc, selection, view }], future: [], lastCoalesce: null })
  },
  undo: () => {
    const { past, doc, future, selection, view } = get()
    if (!past.length || !doc) return
    const prev = past[past.length - 1]
    set({
      doc: prev.doc,
      past: past.slice(0, -1),
      future: [{ doc, selection, view }, ...future].slice(0, MAX_HISTORY),
      version: get().version + 1,
      saveState: 'dirty',
      selection: prev.selection,
      view: { ...prev.view, page: Math.min(prev.view.page, prev.doc.pages.length - 1) },
      lastCoalesce: null,
    })
  },
  redo: () => {
    const { past, doc, future, selection, view } = get()
    if (!future.length || !doc) return
    const next = future[0]
    set({
      doc: next.doc,
      future: future.slice(1),
      past: [...past, { doc, selection, view }],
      version: get().version + 1,
      saveState: 'dirty',
      selection: next.selection,
      view: { ...next.view, page: Math.min(next.view.page, next.doc.pages.length - 1) },
      lastCoalesce: null,
    })
  },

  setView: (v, keepTextFocus = false) => {
    const prev = get().view
    const pageChanged = v.page !== prev.page
    const viewChanged = pageChanged || v.sub !== prev.sub
    set({
      view: v,
      selection: !pageChanged ? get().selection.filter((id) => get().doc?.pages[v.page]?.elements.some((e) => e.id === id && elementOnPage(e, v.sub))) : [],
      ...(pageChanged ? { bgCalib: null } : {}),
      ...(viewChanged && !keepTextFocus ? { focusedTextId: null } : {}),
    })
  },
  select: (ids) => {
    const curFocused = get().focusedTextId
    set({
      selection: ids,
      ...(ids.length === 0 || (curFocused && !ids.includes(curFocused)) ? { focusedTextId: null } : {}),
    })
  },
  toggleSelect: (id) => {
    const s = get().selection
    set({ selection: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] })
  },
  setTool: (t) => set({ tool: get().readOnly ? 'hand' : t }),
  setSpaceHand: (b) => set({ spaceHand: b }),
  setZoom: (v) => set({ zoom: v }),
  requestFit: () => set({ fitRequest: get().fitRequest + 1 }),
  setOverlay: (k, v) => {
    const overlays = { ...get().overlays, [k]: v }
    set({ overlays })
    try {
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlays))
    } catch {
      /* ignore */
    }
  },
  setAnimate: (b) => set(b ? { animate: true, focusedTextId: null } : { animate: false }),
  setEditText: (id) => set(id ? { editTextOf: id, focusedTextId: id } : { editTextOf: null }),
  setFocusedTextId: (id) => set({ focusedTextId: id }),
  bgAlign: false,
  setBgAlign: (b) => set(b ? { bgAlign: true, selection: [], tool: 'select', animate: false } : { bgAlign: false, bgCalib: null }),
  bgCalib: null,
  setBgCalib: (c) => set({ bgCalib: c }),
  bgTouch: 'bg',
  setBgTouch: (m) => set({ bgTouch: m }),
}))

// ------------------------------------------------------------------ selectors / edit helpers

export function currentPage(s: Pick<StudioState, 'doc' | 'view'>): DocPage | null {
  return s.doc?.pages[s.view.page] ?? null
}

export function selectedElements(s: Pick<StudioState, 'doc' | 'view' | 'selection'>): Element[] {
  const p = currentPage(s)
  if (!p) return []
  return p.elements.filter((e) => s.selection.includes(e.id) && elementOnPage(e, s.view.sub))
}

export const studio = {
  get: () => useStudio.getState(),
  /** Mutate elements of the current page by id. */
  updateElements(ids: string[], fn: (el: Element) => Element | void, opts?: { coalesce?: string; record?: boolean }) {
    const { view } = useStudio.getState()
    useStudio.getState().edit((doc) => {
      const page = doc.pages[view.page]
      if (!page) return
      page.elements = page.elements.map((e) => (ids.includes(e.id) ? ((fn(e) as Element | undefined) ?? e) : e))
    }, opts)
  },
  /** Immutable, non-cloning update of element transforms/props (live drag). */
  patchLive(patches: Map<string, Partial<Element>>) {
    const { view } = useStudio.getState()
    useStudio.getState().edit(
      (doc) => ({
        ...doc,
        pages: doc.pages.map((p, i) =>
          i !== view.page ? p : { ...p, elements: p.elements.map((e) => (patches.has(e.id) ? ({ ...e, ...patches.get(e.id) } as Element) : e)) },
        ),
      }),
      { record: false, clone: false },
    )
  },
  updateElement(id: string, fn: (el: Element) => Element | void, opts?: { coalesce?: string; record?: boolean }) {
    studio.updateElements([id], fn, opts)
  },
  /** Patch props of one element (typed loosely; callers know the element type). */
  setProps(id: string, patch: Record<string, unknown>, coalesce?: string) {
    studio.updateElement(id, (e) => ({ ...e, props: { ...e.props, ...patch } }) as Element, { coalesce: coalesce ? `${id}.${coalesce}` : undefined })
  },
  addElements(els: Element[], pageIndex?: number) {
    const st = useStudio.getState()
    const pi = pageIndex ?? st.view.page
    const sub = pageIndex == null ? st.view.sub : 0
    st.edit((doc) => {
      const page = doc.pages[pi]
      if (!page) return
      page.elements = normalizeZ([...page.elements, ...els.map((el) => ({ ...el, page_offset: el.type === 'flow_text' ? 0 : sub }))])
    })
    useStudio.setState({ selection: els.map((e) => e.id), view: { page: pi, sub } })
  },
  deleteElements(ids: string[]) {
    if (!ids.length) return
    const st = useStudio.getState()
    st.edit((doc) => {
      const page = doc.pages[st.view.page]
      if (page) page.elements = normalizeZ(page.elements.filter((e) => !ids.includes(e.id)))
    })
    useStudio.setState({ selection: [] })
  },
}

if (import.meta.env.DEV) (globalThis as { __studio?: unknown }).__studio = useStudio
