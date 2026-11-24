"""Font-independent advances for structural and invisible text characters."""

SPACE_WIDTH_EM = {
    ' ': 0.3, '\t': 0.6, '\u00a0': 0.3, '\u1680': 0.5,
    '\u2000': 0.5, '\u2001': 1.0, '\u2002': 0.5, '\u2003': 1.0,
    '\u2004': 1 / 3, '\u2005': 0.25, '\u2006': 1 / 6, '\u2007': 0.55,
    '\u2008': 0.25, '\u2009': 0.18, '\u200a': 0.1, '\u202f': 0.18,
    '\u205f': 2 / 9, '\u3000': 1.0,
    **dict.fromkeys('\u00ad\u200b\u200c\u200d\u2060\ufeff', 0.0),
}
