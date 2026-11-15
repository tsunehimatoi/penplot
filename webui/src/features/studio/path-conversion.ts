import { api } from '@/api/client'
import type { PathPreview } from './path-data'

let worker: Worker | null = null
let serial = 0
const pending = new Map<number, { resolve: (value: PathPreview) => void; reject: (error: Error) => void }>()

/** Transfer binary buffers; decoding and SVG string construction never block the UI. */
export function convertPathBuffer(buffer: ArrayBuffer): Promise<PathPreview> {
  if (!worker) {
    worker = new Worker(new URL('./path-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; result: PathPreview; error?: string }>) => {
      const { id, result, error } = event.data
      const request = pending.get(id)
      pending.delete(id)
      if (error) request?.reject(new Error(error))
      else request?.resolve(result)
    }
    worker.onerror = (event) => {
      for (const request of pending.values()) request.reject(new Error(event.message || '路径预览处理失败'))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  const id = ++serial
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      worker!.postMessage({ id, buffer }, [buffer])
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

// Bound both downloads and conversion buffers across all elements, not just each letter.
let active = 0
const waiting: (() => void)[] = []
export async function fetchPathPreview(rid: string, index: number): Promise<PathPreview> {
  await new Promise<void>((resolve) => {
    const start = () => { active++; resolve() }
    if (active < 4) start()
    else waiting.push(start)
  })
  try {
    const response = await api.get<Response>(`/render/${rid}/pages/${index}/paths`, {
      query: { space: 'page' }, raw: true, headers: { Accept: 'application/octet-stream' },
    })
    return await convertPathBuffer(await response.arrayBuffer())
  } finally {
    active--
    waiting.shift()?.()
  }
}
