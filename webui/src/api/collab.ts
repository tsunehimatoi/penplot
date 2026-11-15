/**
 * Desktop mode compatibility module: no multi-user auth, no control lease, no presence.
 * Keeps types & hooks so existing feature components operate with full local control.
 */
import { create } from 'zustand'
import { isApiError } from './client'
import type { components } from './schema'

type S = components['schemas']

export type Role = 'admin' | 'operator' | 'viewer'
export const ROLE_LABEL: Record<Role, string> = { admin: '管理员', operator: '操作员', viewer: '只读观察' }
export const ROLE_DESC: Record<Role, string> = {
  admin: '全部权限：用户、配置、固件参数、终端',
  operator: '可控制机器、打印、编辑项目',
  viewer: '只能查看状态与任务',
}

export interface UserRef {
  id: string
  username: string
  display_name?: string | null
  role?: Role
}
export type Me = UserRef
export type UserInfo = UserRef
export type LeaseHolder = UserRef & { since?: number | null; user?: string }
export interface Lease {
  held: boolean
  holder?: LeaseHolder | null
  online?: boolean
  release_after_s?: number
  mine?: boolean
  since?: number | null
}
export interface PresenceEntry {
  conn_id: string
  user?: UserRef
  page?: string | null
  project_id?: string | null
  element_id?: string | null
  client?: string | null
  since?: number
}
export type DiagStatus = S['DiagnosticCheck']['status']
export type DiagCheck = S['DiagnosticCheck']
export type DiagReport = S['DiagnosticsResult']

export function userLabel(u: { display_name?: string | null; username?: string } | string | null | undefined): string {
  if (!u) return '桌面用户'
  if (typeof u === 'string') return u
  return u.display_name || u.username || '桌面用户'
}

export const collabKeys = {
  me: ['auth', 'me'] as const,
  users: ['users'] as const,
  lease: ['machine', 'lease'] as const,
  presence: ['presence'] as const,
  diagnostics: ['system', 'diagnostics'] as const,
}

export function isUnavailable(e: unknown) {
  return isApiError(e) && (e.status === 404 || e.status === 405 || e.status === 501)
}

const DESKTOP_USER: UserRef = { id: 'desktop', username: 'desktop', display_name: '桌面用户', role: 'admin' }

export function useMe() {
  return { data: DESKTOP_USER, isPending: false, isError: false, error: null }
}

export function useRole(): Role {
  return 'admin'
}

export function useCanEdit(): boolean {
  return true
}

export const useLeaseStore = create<{ lease: Lease | null; supported: boolean | null }>(() => ({
  lease: null,
  supported: false,
}))

export function refreshLease(): Promise<void> {
  return Promise.resolve()
}

export async function acquireLease(_force = false) {
  return { held: false, holder: null, online: false, release_after_s: 60, mine: true }
}

export async function releaseLease() {}

export interface LeaseView {
  supported: boolean
  canControl: boolean
  mine: boolean
  free: boolean
  holderName: string | null
  since: number | null
}

export function useLease(): LeaseView {
  return { supported: false, canControl: true, mine: true, free: true, holderName: null, since: null }
}

export function usePresence(_enabled = true) {
  return { data: [] as PresenceEntry[], isPending: false, isError: false, error: null }
}

export function clientLabel(ua?: string | null) {
  if (!ua) return '桌面端'
  return ua
}
