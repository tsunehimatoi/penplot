import { useEffect, useRef, useState } from 'react'

const listeners = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

/** Share one observer; offscreen thumbnails keep their size without mounting heavy SVG paths. */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (!observer) observer = new IntersectionObserver((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
    }, { rootMargin: '120px' })
    listeners.set(node, setVisible)
    observer.observe(node)
    return () => {
      observer?.unobserve(node)
      listeners.delete(node)
      if (!listeners.size) { observer?.disconnect(); observer = null }
    }
  }, [])
  return { ref, visible }
}
