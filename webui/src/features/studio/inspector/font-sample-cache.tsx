import * as React from 'react'

const STORAGE_KEY = 'penplot.fonts.sample_cache.v1'
const MAX_ENTRIES = 200

const memoryCache = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()
let hydrated = false

function hydrate() {
  if (hydrated) return
  hydrated = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const entries = JSON.parse(raw) as [string, string][]
    if (!Array.isArray(entries)) return
    for (const [k, v] of entries) {
      if (typeof k === 'string' && typeof v === 'string') {
        memoryCache.set(k, v)
      }
    }
  } catch {
    /* ignore corrupted cache */
  }
}

function persist() {
  try {
    while (memoryCache.size > MAX_ENTRIES) {
      const oldest = memoryCache.keys().next().value
      if (oldest === undefined) break
      memoryCache.delete(oldest)
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...memoryCache.entries()]))
  } catch {
    // Quota exceeded: drop half the oldest entries and retry once
    try {
      const drop = Math.max(1, Math.floor(memoryCache.size / 2))
      for (let i = 0; i < drop; i++) {
        const oldest = memoryCache.keys().next().value
        if (oldest === undefined) break
        memoryCache.delete(oldest)
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...memoryCache.entries()]))
    } catch {
      /* ignore */
    }
  }
}

export function getCachedSample(url: string): string | undefined {
  hydrate()
  const hit = memoryCache.get(url)
  if (hit !== undefined) {
    // Refresh LRU order
    memoryCache.delete(url)
    memoryCache.set(url, hit)
  }
  return hit
}

function fetchSample(url: string): Promise<string | null> {
  const existing = inFlight.get(url)
  if (existing) return existing

  const p = fetch(url, { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return null
      const svg = await res.text()
      if (!svg.trimStart().startsWith('<')) return null
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      hydrate()
      memoryCache.delete(url)
      memoryCache.set(url, dataUrl)
      persist()
      return dataUrl
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(url)
    })

  inFlight.set(url, p)
  return p
}

export function FontSampleImg({
  url,
  alt,
  className,
}: {
  url: string
  alt: string
  className?: string
}) {
  const [src, setSrc] = React.useState<string | undefined>(() => getCachedSample(url))
  const ref = React.useRef<HTMLImageElement | null>(null)

  React.useEffect(() => {
    const cached = getCachedSample(url)
    if (cached) {
      setSrc(cached)
      return
    }
    setSrc(undefined)

    const el = ref.current
    if (!el) return

    let cancelled = false
    const load = () => {
      void fetchSample(url).then((dataUrl) => {
        if (!cancelled && dataUrl) setSrc(dataUrl)
      })
    }

    if (typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        cancelled = true
      }
    }

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect()
          load()
        }
      },
      { rootMargin: '120px' },
    )
    obs.observe(el)
    return () => {
      cancelled = true
      obs.disconnect()
    }
  }, [url])

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      className={className}
    />
  )
}
