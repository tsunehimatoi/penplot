/** Polylines decoded from the `PPL1` binary (04 §6). Each entry is a flat [x0,y0,x1,y1,…] array in mm. */
export type Polylines = Float32Array[]

export function decodePaths(buf: ArrayBuffer): Polylines {
  const dv = new DataView(buf)
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x314c5050) throw new Error('bad paths magic')
  const n = dv.getUint32(4, true)
  const offs = new Uint32Array(n + 1)
  for (let i = 0; i <= n; i++) offs[i] = dv.getUint32(8 + i * 4, true)
  const base = 8 + (n + 1) * 4
  const total = offs[n]
  const xy = new Float32Array(buf.slice(base, base + total * 8))
  const out: Polylines = []
  for (let k = 0; k < n; k++) out.push(xy.subarray(offs[k] * 2, offs[k + 1] * 2))
  return out
}

