import { decodePaths } from '@/api/paths'
import { polylinesBBox, polylinesToD } from './geometry'

export function buildPathPreview(buffer: ArrayBuffer) {
  const lines = decodePaths(buffer)
  return { d: polylinesToD(lines), bbox: polylinesBBox(lines), strokes: lines.length }
}

export type PathPreview = ReturnType<typeof buildPathPreview>
