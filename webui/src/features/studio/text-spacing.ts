// Keep advances in sync with penplot/text_spacing.py.
const SPACE_WIDTH_EM = new Map<string, number>([
  [' ', 0.3], ['\t', 0.6], ['\u00a0', 0.3], ['\u1680', 0.5],
  ['\u2000', 0.5], ['\u2001', 1], ['\u2002', 0.5], ['\u2003', 1],
  ['\u2004', 1 / 3], ['\u2005', 0.25], ['\u2006', 1 / 6], ['\u2007', 0.55],
  ['\u2008', 0.25], ['\u2009', 0.18], ['\u200a', 0.1], ['\u202f', 0.18],
  ['\u205f', 2 / 9], ['\u3000', 1],
  ...Array.from('\u00ad\u200b\u200c\u200d\u2060\ufeff', (ch): [string, number] => [ch, 0]),
])

export function spacingWidthEm(ch: string): number | undefined {
  return SPACE_WIDTH_EM.get(ch)
}

export function needsStrokeGlyph(ch: string): boolean {
  return !/\s/u.test(ch) && !SPACE_WIDTH_EM.has(ch)
}
