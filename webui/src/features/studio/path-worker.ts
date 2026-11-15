import { buildPathPreview } from './path-data'

self.onmessage = (event: MessageEvent<{ id: number; buffer: ArrayBuffer }>) => {
  const { id, buffer } = event.data
  try {
    self.postMessage({ id, result: buildPathPreview(buffer) })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
