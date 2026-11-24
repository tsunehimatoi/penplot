const utf8 = new TextEncoder()

export function crc32Utf8(text: string): number {
  let crc = 0xffffffff
  for (const byte of utf8.encode(text)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
