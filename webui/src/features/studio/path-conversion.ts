import { api } from '@/api/client'
import type { PathPreview } from './path-data'

type Job = { resolve: (value: PathPreview) => void; reject: (error: Error) => void }
type Slot = { worker: Worker; jobs: Map<number, Job> }
const pool: Slot[] = []
const concurrency = Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))
let serial = 0

function makeSlot(): Slot {
  const worker = new Worker(new URL('./path-worker.ts', import.meta.url), { type: 'module' })
  const slot: Slot = { worker, jobs: new Map() }
  worker.onmessage = (event: MessageEvent<{ id: number; result: PathPreview; error?: string }>) => {
    const { id, result, error } = event.data
    const job = slot.jobs.get(id)
    slot.jobs.delete(id)
    if (error) job?.reject(new Error(error))
    else job?.resolve(result)
  }
  worker.onerror = (event) => {
    for (const job of slot.jobs.values()) job.reject(new Error(event.message || '路径预览处理失败'))
    slot.jobs.clear()
    worker.terminate()
    pool.splice(pool.indexOf(slot), 1)
  }
  pool.push(slot)
  return slot
}

/** A bounded worker pool, rather than four downloads feeding one serial worker. */
export function convertPathBuffer(buffer: ArrayBuffer): Promise<PathPreview> {
  let slot = pool.find(s => s.jobs.size === 0)
  if (!slot) slot = pool.length < concurrency ? makeSlot() : pool.reduce((a, b) => a.jobs.size <= b.jobs.size ? a : b)
  const target = slot
  const id = ++serial
  return new Promise((resolve, reject) => {
    target.jobs.set(id, { resolve, reject })
    try { target.worker.postMessage({ id, buffer }, [buffer]) }
    catch (error) { target.jobs.delete(id); reject(error) }
  })
}

let active = 0
const waiting: (() => void)[] = []
export async function fetchPathPreview(rid: string, index: number): Promise<PathPreview> {
  await new Promise<void>((resolve) => {
    const start = () => { active++; resolve() }
    if (active < concurrency) start()
    else waiting.push(start)
  })
  try {
    const response = await api.get<Response>(`/render/${rid}/pages/${index}/paths`, {
      query: { space: 'page' }, raw: true, headers: { Accept: 'application/octet-stream' },
    })
    return await convertPathBuffer(await response.arrayBuffer())
  } finally { active--; waiting.shift()?.() }
}

/** Decode framed pages as they arrive, keeping at most four conversions in flight.
 * A missing/truncated/duplicate page is an error, never a successful partial render.
 */
export async function streamPathPreviews(
  rid: string, indices: number[], onPage: (index: number, page: PathPreview) => void, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const response = await api.get<Response>(`/render/${rid}/paths-stream`, {
    raw: true, signal, headers: { Accept: 'application/octet-stream' },
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('浏览器不支持流式预览')
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  const expected = new Set(indices), seen = new Set<number>()
  const jobs = new Set<Promise<void>>()
  let bytes = new Uint8Array(0)
  let failure: unknown
  const check = () => { signal?.throwIfAborted(); if (failure) throw failure }
  try {
    for (;;) {
      check()
      const { value, done } = await reader.read()
      check()
      if (done) break
      const combined = new Uint8Array(bytes.length + value.length)
      combined.set(bytes); combined.set(value, bytes.length); bytes = combined
      while (bytes.length >= 8) {
        const header = new DataView(bytes.buffer, bytes.byteOffset, 8)
        const index = header.getUint32(0, true), size = header.getUint32(4, true)
        if (!expected.has(index) || seen.has(index) || size < 12 || size > 256 * 1024 * 1024) throw new Error('路径流页面数据无效')
        if (bytes.length < size + 8) break
        seen.add(index)
        const buffer = bytes.slice(8, size + 8).buffer
        bytes = bytes.subarray(size + 8)
        const job = convertPathBuffer(buffer).then(page => { check(); onPage(index, page) })
          .catch(error => { failure = error }).finally(() => jobs.delete(job))
        jobs.add(job)
        if (jobs.size >= concurrency) { await Promise.race(jobs); check() }
      }
    }
    await Promise.all(jobs)
    check()
    if (bytes.length || seen.size !== expected.size) throw new Error('路径流不完整，请重试')
  } finally {
    signal?.removeEventListener('abort', abort)
    // Completed conversions must not publish after cancellation or an error.
    failure ??= new DOMException('aborted', 'AbortError')
    await reader.cancel().catch(() => undefined)
  }
}
