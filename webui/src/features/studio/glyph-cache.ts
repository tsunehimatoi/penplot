/**
 * Client-side incremental glyph cache for instant single-stroke rendering.
 * Fetches missing glyphs via `POST /api/v1/fonts/{font_id}/glyphs`, pre-parses
 * SVG path_d into Float32Array polylines, and bumps `version` to trigger React re-renders.
 */
import { create } from 'zustand'
import { api } from '@/api/client'
import type { FontMixEntry, FontRoles } from '@/api/studio'
import { defaultFontId } from './actions'
import { needsStrokeGlyph } from './text-spacing'

export interface GlyphData {
  w: number
  x0: number
  hasAdvance: boolean
  segs: Float32Array[]
}

export interface FontGlyphMap {
  refSize: number
  glyphs: Map<string, GlyphData | null>
}

interface GlyphApiItem {
  cp?: number
  char?: string
  w?: number
  x0?: number
  has_advance?: boolean
  path_d?: string
}

interface GlyphApiResponse {
  font_id?: string
  ref_size?: number
  total?: number
  next_from?: number | null
  glyphs?: GlyphApiItem[]
}

interface GlyphCacheState {
  version: number
  bump: () => void
}

export const useGlyphCache = create<GlyphCacheState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

const fontCache = new Map<string, FontGlyphMap>()
const inflightChars = new Map<string, Set<string>>()
const prewarmedFonts = new Set<string>()

const PREWARM_CHARS = (() => {
  let s = ''
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c)
  s += '，。！？；：“”‘’（）、—…《》·'
  return s
})()

/** Parse an SVG path_d string (M/L commands) into Float32Array polylines [x0,y0,x1,y1,...]. */
export function parsePathDToSegs(d: string | undefined | null): Float32Array[] {
  if (!d) return []
  const segs: Float32Array[] = []
  let cur: number[] = []
  let cmd = ''
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  let i = 0
  const n = d.length

  const skipSep = () => {
    while (i < n) {
      const ch = d.charCodeAt(i)
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 44) i++
      else break
    }
  }

  const readNum = (): number | null => {
    skipSep()
    if (i >= n) return null
    const start = i
    if (d[i] === '-' || d[i] === '+') i++
    let hasDigit = false
    while (i < n && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) {
      hasDigit = true
      i++
    }
    if (i < n && d[i] === '.') {
      i++
      while (i < n && d.charCodeAt(i) <= 57 && d.charCodeAt(i) >= 48) {
        hasDigit = true
        i++
      }
    }
    if (!hasDigit) {
      i = start
      return null
    }
    if (i < n && (d[i] === 'e' || d[i] === 'E')) {
      const expStart = i
      i++
      if (i < n && (d[i] === '+' || d[i] === '-')) i++
      let expDigits = false
      while (i < n && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) {
        expDigits = true
        i++
      }
      if (!expDigits) i = expStart
    }
    return Number(d.slice(start, i))
  }

  const flush = () => {
    if (cur.length >= 4) segs.push(new Float32Array(cur))
    cur = []
  }

  while (i < n) {
    skipSep()
    if (i >= n) break
    const ch = d[i]
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      cmd = ch
      i++
      if (cmd === 'Z' || cmd === 'z') {
        if (cur.length >= 2) {
          cur.push(sx, sy)
          cx = sx
          cy = sy
        }
        flush()
        continue
      }
    }
    if (cmd === 'M' || cmd === 'm') {
      const x = readNum()
      const y = readNum()
      if (x == null || y == null) { i++; continue }
      flush()
      cx = cmd === 'm' ? cx + x : x
      cy = cmd === 'm' ? cy + y : y
      sx = cx
      sy = cy
      cur.push(cx, cy)
      cmd = cmd === 'm' ? 'l' : 'L'
    } else if (cmd === 'L' || cmd === 'l') {
      const x = readNum()
      const y = readNum()
      if (x == null || y == null) { i++; continue }
      cx = cmd === 'l' ? cx + x : x
      cy = cmd === 'l' ? cy + y : y
      cur.push(cx, cy)
    } else if (cmd === 'H' || cmd === 'h') {
      const x = readNum()
      if (x == null) { i++; continue }
      cx = cmd === 'h' ? cx + x : x
      cur.push(cx, cy)
    } else if (cmd === 'V' || cmd === 'v') {
      const y = readNum()
      if (y == null) { i++; continue }
      cy = cmd === 'v' ? cy + y : y
      cur.push(cx, cy)
    } else {
      i++
    }
  }
  flush()
  return segs
}

function getOrCreateFont(fontId: string): FontGlyphMap {
  let entry = fontCache.get(fontId)
  if (!entry) {
    entry = { refSize: 100, glyphs: new Map() }
    fontCache.set(fontId, entry)
  }
  return entry
}

export function getCachedFont(fontId: string | null | undefined): FontGlyphMap | undefined {
  return fontCache.get(fontId || 'builtin')
}

export function getCachedGlyph(fontId: string | null | undefined, ch: string): { glyph: GlyphData | null | undefined; refSize: number; pending: boolean } {
  const fid = fontId || 'builtin'
  const entry = fontCache.get(fid)
  const pending = inflightChars.get(fid)?.has(ch) ?? false
  if (!entry) return { glyph: undefined, refSize: 100, pending }
  return { glyph: entry.glyphs.get(ch), refSize: entry.refSize, pending }
}

/** Prewarm ASCII printable chars and common CJK punctuation for a newly encountered font. */
export function prewarmFont(fontId: string | null | undefined): void {
  const fid = fontId || 'builtin'
  if (prewarmedFonts.has(fid)) return
  prewarmedFonts.add(fid)
  void ensureGlyphs(fid, PREWARM_CHARS)
}

/**
 * Ensure all unique characters that need strokes are cached for `fontId`.
 * Returns immediately if all characters are already cached.
 */
export async function ensureGlyphs(fontId: string | null | undefined, text: string): Promise<void> {
  const fid = fontId || 'builtin'
  if (!prewarmedFonts.has(fid)) {
    if (![...text].some(needsStrokeGlyph)) return
    prewarmedFonts.add(fid)
    // Merge prewarm chars on first encounter of a font so one request covers common glyphs
    text = text + PREWARM_CHARS
  }
  if (!text) return

  const entry = fontCache.get(fid)
  let inflight = inflightChars.get(fid)
  const missing: string[] = []
  const seen = new Set<string>()

  for (const ch of text) {
    if (!needsStrokeGlyph(ch)) continue
    if (seen.has(ch)) continue
    seen.add(ch)
    if (entry?.glyphs.has(ch)) continue
    if (inflight?.has(ch)) continue
    missing.push(ch)
  }

  if (missing.length === 0) return

  if (!inflight) {
    inflight = new Set<string>()
    inflightChars.set(fid, inflight)
  }
  for (const ch of missing) inflight.add(ch)

  const CHUNK = 1500
  let updated = false
  try {
    for (let start = 0; start < missing.length; start += CHUNK) {
      const chunk = missing.slice(start, start + CHUNK)
      const res = await api.post<GlyphApiResponse>(`/fonts/${encodeURIComponent(fid)}/glyphs`, {
        text: chunk.join(''),
      })
      const target = getOrCreateFont(fid)
      if (res && typeof res.ref_size === 'number' && res.ref_size > 0) {
        target.refSize = res.ref_size
      }
      const received = new Map<string, GlyphData | null>()
      if (res && Array.isArray(res.glyphs)) {
        for (const item of res.glyphs) {
          const ch = item.char ?? (typeof item.cp === 'number' ? String.fromCodePoint(item.cp) : '')
          if (!ch) continue
          const segs = parsePathDToSegs(item.path_d)
          let minX = Infinity
          let maxX = -Infinity
          for (const seg of segs) {
            for (let k = 0; k < seg.length; k += 2) {
              if (seg[k] < minX) minX = seg[k]
              if (seg[k] > maxX) maxX = seg[k]
            }
          }
          const x0 = typeof item.x0 === 'number' && Number.isFinite(item.x0)
            ? item.x0
            : Number.isFinite(minX) ? minX : 0
          const w = typeof item.w === 'number' && Number.isFinite(item.w)
            ? item.w
            : Number.isFinite(maxX) ? (maxX - minX) + Math.max(0, minX) : 0
          const hasAdvance = Boolean(item.has_advance)
          received.set(ch, { w, x0, hasAdvance, segs })
        }
      }
      for (const ch of chunk) {
        target.glyphs.set(ch, received.get(ch) ?? null)
      }
      updated = true
    }
  } catch {
    // Graceful fallback when backend is unavailable or mocked: mark as null so we don't retry-loop
    const target = getOrCreateFont(fid)
    for (const ch of missing) {
      if (!target.glyphs.has(ch)) target.glyphs.set(ch, null)
    }
  } finally {
    const set = inflightChars.get(fid)
    if (set) {
      for (const ch of missing) set.delete(ch)
    }
    if (updated) {
      useGlyphCache.getState().bump()
    }
  }
}

function resolvePrimaryFontId(
  primaryFontId: string | null | undefined,
  fontMix?: FontMixEntry[] | null,
): string {
  return fontMix?.[0]?.font_id || primaryFontId || defaultFontId() || 'builtin'
}

/** Ensure glyphs for primary font, font_roles, and font_mix used by a text/flow_text element. */
export function ensureElementGlyphs(
  text: string,
  primaryFontId: string | null | undefined,
  fontRoles?: FontRoles | null,
  fontMix?: FontMixEntry[] | null,
): void {
  const effectivePrimary = resolvePrimaryFontId(primaryFontId, fontMix)
  const fids = new Set<string>()
  fids.add(effectivePrimary)
  if (fontRoles) {
    if (fontRoles.en) fids.add(fontRoles.en)
    if (fontRoles.zh) fids.add(fontRoles.zh)
    if (fontRoles.symbol) fids.add(fontRoles.symbol)
    if (fontRoles.fallback) fids.add(fontRoles.fallback)
  }
  if (fontMix) {
    for (const m of fontMix) {
      if (m.font_id) fids.add(m.font_id)
    }
  }
  for (const fid of fids) {
    void ensureGlyphs(fid, text)
  }
}

// ------------------------------------------------------------------ font_roles / font_mix resolution (mirrors penplot/font_resolver.py)

export type CharCategory = 'en' | 'zh' | 'symbol' | 'other'

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x2e80 && code <= 0x2eff)
    || (code >= 0x3100 && code <= 0x312f)
    || (code >= 0x31a0 && code <= 0x31bf)
    || (code >= 0x20000 && code <= 0x2ebef)
    || (code >= 0x30000 && code <= 0x323af)
  )
}

export function charCategory(ch: string): CharCategory {
  if (!ch) return 'other'
  const code = ch.codePointAt(0) ?? 0
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
    return 'en'
  }
  if (isCjk(code)) return 'zh'
  if (
    (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xff00 && code <= 0xffef)
    || (code >= 0x2000 && code <= 0x27bf)
  ) {
    return 'symbol'
  }
  if (/^[\p{P}\p{S}]$/u.test(ch)) return 'symbol'
  return 'other'
}

function hasCachedGlyph(fontId: string, ch: string): boolean {
  const g = fontCache.get(fontId)?.glyphs.get(ch)
  return g != null && (g.segs.length > 0 || g.w > 0)
}

export function pickFontForChar(
  ch: string,
  primaryFontId: string | null | undefined,
  fontRoles?: FontRoles | null,
  fontMix?: FontMixEntry[] | null,
  rng?: () => number,
): { fontId: string; glyph: GlyphData | null | undefined; refSize: number; pending: boolean } {
  const primary = resolvePrimaryFontId(primaryFontId, fontMix)
  const cat = charCategory(ch)

  if (fontRoles && (cat === 'en' || cat === 'zh' || cat === 'symbol')) {
    const roleFid = fontRoles[cat]
    if (roleFid) {
      const info = getCachedGlyph(roleFid, ch)
      if (info.glyph != null && (info.glyph.segs.length > 0 || info.glyph.w > 0)) {
        return { fontId: roleFid, ...info }
      }
      if (info.glyph === undefined) {
        return { fontId: roleFid, ...info, pending: true }
      }
    }
  }

  if (fontMix && fontMix.length > 0) {
    const valid = fontMix.filter((m) => m.font_id && (m.weight ?? 1) > 0)
    const withGlyph = valid.filter((m) => hasCachedGlyph(m.font_id, ch))
    const candidates = withGlyph.length > 0 ? withGlyph : valid
    if (candidates.length === 1) {
      const fid = candidates[0].font_id
      return { fontId: fid, ...getCachedGlyph(fid, ch) }
    }
    if (candidates.length > 1) {
      const cumWeights: number[] = new Array(candidates.length)
      let totalW = 0
      for (let i = 0; i < candidates.length; i++) {
        totalW += Number(candidates[i].weight ?? 1)
        cumWeights[i] = totalW
      }
      const target = (rng ? rng() : Math.random()) * totalW
      let lo = 0
      let hi = candidates.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (target < cumWeights[mid]) hi = mid
        else lo = mid + 1
      }
      const picked = candidates[lo].font_id
      return { fontId: picked, ...getCachedGlyph(picked, ch) }
    }
  }

  const primInfo = getCachedGlyph(primary, ch)
  if (primInfo.glyph != null && (primInfo.glyph.segs.length > 0 || primInfo.glyph.w > 0)) {
    return { fontId: primary, ...primInfo }
  }
  if (primInfo.glyph === undefined) {
    return { fontId: primary, ...primInfo, pending: true }
  }

  if (fontRoles?.fallback) {
    const fbInfo = getCachedGlyph(fontRoles.fallback, ch)
    if (fbInfo.glyph != null && (fbInfo.glyph.segs.length > 0 || fbInfo.glyph.w > 0)) {
      return { fontId: fontRoles.fallback, ...fbInfo }
    }
    if (fbInfo.glyph === undefined) {
      return { fontId: fontRoles.fallback, ...fbInfo, pending: true }
    }
  }

  return { fontId: primary, ...primInfo }
}
