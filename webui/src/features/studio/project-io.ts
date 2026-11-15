/** Project persistence: save (PUT with rev), autosave, conflict resolution, create / open / templates. */
import { useEffect } from 'react'
import { api, errorMessage, isApiError } from '@/api/client'
import { qk, queryClient } from '@/api/query'
import type { Project, ProjectDoc } from '@/api/studio'
import { toast } from '@/lib/toast'
import { emptyDoc } from './model'
import { useStudio } from './store'

export const LAST_KEY = 'penplot.studio.last'

let saving: Promise<boolean> | null = null

/** Save immediately. Resolves true when the latest version is on the server. */
export async function saveNow(opts: { force?: boolean } = {}): Promise<boolean> {
  if (saving) {
    await saving
    const s = useStudio.getState()
    if (s.version === s.savedVersion) return true
  }
  const s = useStudio.getState()
  if (!s.project || !s.doc) return false
  if (s.version === s.savedVersion && !opts.force) return true
  if (s.saveState === 'conflict' && !opts.force) return false
  const version = s.version
  const { id, rev, name } = s.project
  s.setSaveState('saving')
  saving = (async () => {
    try {
      const sent = s.doc!
      const p = await api.put<Project>(`/projects/${id}`, { doc: { ...sent, name }, rev, name })
      afterSave(p, version)
      return true
    } catch (e) {
      if (isApiError(e) && e.status === 409) useStudio.getState().setSaveState('conflict', e.message)
      else if (isApiError(e) && e.isOffline) useStudio.getState().setSaveState('offline', e.message)
      else useStudio.getState().setSaveState('error', errorMessage(e))
      return false
    } finally {
      saving = null
    }
  })()
  return saving
}

function afterSave(p: Project, version: number) {
  useStudio.getState().markSaved(p.rev, version, p.updated_at)
  void queryClient.invalidateQueries({ queryKey: qk.projects.list() })
}

/** Overwrite the server copy with ours (after a rev conflict). */
export async function overwriteServer() {
  const s = useStudio.getState()
  if (!s.project) return
  const latest = await api.get<Project>(`/projects/${s.project.id}`)
  useStudio.getState().setProjectMeta({ rev: latest.rev })
  useStudio.getState().setSaveState('dirty')
  await saveNow({ force: true })
}

/** Discard local changes and load the server copy. */
export async function reloadFromServer() {
  const s = useStudio.getState()
  if (!s.project) return
  const latest = await api.get<Project>(`/projects/${s.project.id}`)
  useStudio.getState().load(latest)
}

/** Autosave 1.5 s after the last change (and retry offline saves every 10 s). */
export function useAutosave() {
  const version = useStudio((s) => s.version)
  const saved = useStudio((s) => s.savedVersion)
  const state = useStudio((s) => s.saveState)
  useEffect(() => {
    if (version === saved || state === 'conflict' || state === 'saving') return
    const t = setTimeout(() => void saveNow(), state === 'offline' || state === 'error' ? 10_000 : 1500)
    return () => clearTimeout(t)
  }, [version, saved, state])
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const s = useStudio.getState()
      if (s.version !== s.savedVersion) {
        void saveNow()
        e.preventDefault()
      }
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') void saveNow()
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])
}

export async function createProject(name = '未命名项目', doc?: ProjectDoc, fromTemplate?: string): Promise<Project> {
  const p = await api.post<Project>('/projects', { name, doc: doc ?? (fromTemplate ? null : emptyDoc(name)), from_template_id: fromTemplate ?? null, is_template: false })
  void queryClient.invalidateQueries({ queryKey: qk.projects.all })
  return p
}

export async function saveAsTemplate(name: string) {
  const s = useStudio.getState()
  if (!s.project) return
  await saveNow()
  const p = await api.post<Project>(`/projects/${s.project.id}/save-as-template`, { name })
  void queryClient.invalidateQueries({ queryKey: qk.projects.all })
  toast.success('已存为模板', { description: p.name })
  return p
}

export async function duplicateProject(): Promise<Project | undefined> {
  const s = useStudio.getState()
  if (!s.project) return
  await saveNow()
  const p = await api.post<Project>(`/projects/${s.project.id}/duplicate`, {})
  void queryClient.invalidateQueries({ queryKey: qk.projects.all })
  return p
}

export function renameProject(name: string) {
  const s = useStudio.getState()
  if (!s.project || !name.trim() || name === s.project.name) return
  s.setProjectMeta({ name: name.trim() })
  s.edit((d) => {
    d.name = name.trim()
  })
}
