/** Onboarding uses the same device API as the rest of the workbench. */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { connectMachine } from '@/api/machine'
import { frameBox, jog, setPen, setZero } from '@/api/machine-control'
import { qk } from '@/api/query'
import { useLive } from '@/api/store'
import type { MachineStatus, SerialPort } from '@/api/types'
export { preferredPort } from '@/lib/serial-port'

export type Mode = 'live' | 'offline' | 'checking'
export function useMachineMode(): Mode {
  const q = useQuery({
    queryKey: qk.machine.status,
    queryFn: () => api.get<MachineStatus>('/machine/status', { timeoutMs: 5000 }),
    retry: false,
    staleTime: 5000,
    refetchInterval: 5000,
  })
  if (q.isPending) return 'checking'
  return q.isError ? 'offline' : 'live'
}
export function useStatus(mode: Mode): MachineStatus | null {
  const live = useLive((s) => s.machine)
  const q = useQuery({ queryKey: qk.machine.status, queryFn: () => api.get<MachineStatus>('/machine/status'), enabled: false })
  return mode === 'live' ? live ?? q.data ?? null : null
}
export function usePortList(mode: Mode) {
  return useQuery({
    queryKey: qk.machine.ports,
    queryFn: () => api.get<SerialPort[]>('/machine/ports'),
    enabled: mode === 'live',
    staleTime: 5000,
  })
}

export function machineActions() {
  return {
    async connect(port?: string) { await connectMachine(port ? { port } : {}) },
    async jog(d: { dx?: number; dy?: number; dz?: number }) { await jog(d, d.dz && !d.dx && !d.dy ? 600 : undefined) },
    async zero(axes: 'xyz' | 'xy' | 'z') { await setZero(axes) },
    async pen(state: 'up' | 'down') { await setPen(state) },
    async frame(w: number, h: number) { await frameBox([0, -h, w, 0]) },
  }
}
