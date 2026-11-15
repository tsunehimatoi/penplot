import type { SerialPort } from '@/api/types'

/** Use the same preference order as the backend's automatic connection. */
export function preferredPort(ports: SerialPort[] | undefined, ...current: (string | null | undefined)[]) {
  if (!ports?.length) return undefined
  const key = (p: SerialPort) => p.by_id || p.path
  for (const value of current) {
    if (!value) continue
    const match = ports.find((p) => [key(p), p.path].some((v) => v === value ||
      (/^com\d+$/i.test(v) && v.toLowerCase() === value.toLowerCase())))
    if (match) return key(match)
  }
  const ch = ports.find((p) => p.vid === '1a86' || /1a86|ch340/i.test(`${p.by_id ?? ''} ${p.description}`))
  const usb = ports.find((p) => /usb|acm/i.test(`${p.path} ${p.by_id ?? ''}`))
  return key(ch ?? usb ?? ports[0])
}
