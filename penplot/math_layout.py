# -*- coding: utf-8 -*-
"""Single-stroke handwritten LaTeX math parser and box layout engine.

Renders LaTeX expressions using the user's selected stroke font for letters,
digits, and basic operators, combined with clean single-stroke vector glyphs
for math symbols (\\int, \\sum, \\pi, \\pm, \\sqrt, \\frac, etc.) — no hollow
outline fonts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Optional

from .geometry import Affine2D, Path, bbox_of

# Callback: (ch, em_mm) -> (paths_at_baseline_y0, advance_mm)
GlyphFn = Callable[[str, float], tuple[list[Path], float]]


# ------------------------------------------------------------------ Single-stroke math symbols (in 1.0-em box, baseline y=0, y-down)

def _poly(pts: list[tuple[float, float]], em: float) -> Path:
    p = Path()
    for i, (x, y) in enumerate(pts):
        p.move_to(x * em, y * em) if i == 0 else p.line_to(x * em, y * em)
    return p


def _arc(cx: float, cy: float, rx: float, ry: float, a0: float, a1: float, em: float, steps: int = 12) -> Path:
    p = Path()
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        x, y = (cx + rx * math.cos(a)) * em, (cy + ry * math.sin(a)) * em
        p.move_to(x, y) if i == 0 else p.line_to(x, y)
    return p


def _symbol_paths(name: str, em: float) -> Optional[tuple[list[Path], float]]:
    """Return (paths, advance_mm) with baseline at y=0 (y-down) for LaTeX symbols."""
    if name == 'circ':
        return ([_arc(0.20, -0.23, 0.12, 0.12, 0, math.tau, em, 16)], 0.4 * em)
    if name == '°':
        return ([_arc(0.18, -0.59, 0.10, 0.10, 0, math.tau, em, 16)], 0.35 * em)
    if name in ('pm', '±'):
        return ([
            _poly([(0.10, -0.35), (0.58, -0.35)], em),
            _poly([(0.34, -0.58), (0.34, -0.12)], em),
            _poly([(0.10, -0.02), (0.58, -0.02)], em),
        ], 0.68 * em)
    if name in ('mp', '∓'):
        return ([
            _poly([(0.10, -0.55), (0.58, -0.55)], em),
            _poly([(0.10, -0.25), (0.58, -0.25)], em),
            _poly([(0.34, -0.45), (0.34, -0.02)], em),
        ], 0.68 * em)
    if name in ('times', '×'):
        return ([
            _poly([(0.12, -0.50), (0.54, -0.08)], em),
            _poly([(0.54, -0.50), (0.12, -0.08)], em),
        ], 0.66 * em)
    if name in ('div', '÷'):
        return ([
            _poly([(0.10, -0.30), (0.58, -0.30)], em),
            _arc(0.34, -0.48, 0.04, 0.04, 0, math.tau, em, 8),
            _arc(0.34, -0.12, 0.04, 0.04, 0, math.tau, em, 8),
        ], 0.68 * em)
    if name in ('cdot', '·'):
        return ([_arc(0.22, -0.28, 0.04, 0.04, 0, math.tau, em, 8)], 0.44 * em)
    if name in ('to', 'rightarrow', '→'):
        return ([
            _poly([(0.06, -0.28), (0.76, -0.28)], em),
            _poly([(0.58, -0.42), (0.76, -0.28), (0.58, -0.14)], em),
        ], 0.84 * em)
    if name in ('leftarrow', '←'):
        return ([
            _poly([(0.76, -0.28), (0.06, -0.28)], em),
            _poly([(0.24, -0.42), (0.06, -0.28), (0.24, -0.14)], em),
        ], 0.84 * em)
    if name in ('Rightarrow', '⇒'):
        return ([
            _poly([(0.06, -0.35), (0.68, -0.35)], em),
            _poly([(0.06, -0.21), (0.68, -0.21)], em),
            _poly([(0.54, -0.46), (0.76, -0.28), (0.54, -0.10)], em),
        ], 0.84 * em)
    if name in ('leq', 'le', '≤'):
        return ([
            _poly([(0.60, -0.56), (0.12, -0.36), (0.60, -0.16)], em),
            _poly([(0.12, -0.04), (0.60, -0.04)], em),
        ], 0.72 * em)
    if name in ('geq', 'ge', '≥'):
        return ([
            _poly([(0.12, -0.56), (0.60, -0.36), (0.12, -0.16)], em),
            _poly([(0.12, -0.04), (0.60, -0.04)], em),
        ], 0.72 * em)
    if name in ('neq', 'ne', '≠'):
        return ([
            _poly([(0.10, -0.38), (0.62, -0.38)], em),
            _poly([(0.10, -0.20), (0.62, -0.20)], em),
            _poly([(0.50, -0.56), (0.22, -0.02)], em),
        ], 0.72 * em)
    if name in ('approx', '≈'):
        return ([
            _poly([(0.08, -0.36), (0.24, -0.44), (0.44, -0.30), (0.62, -0.38)], em),
            _poly([(0.08, -0.18), (0.24, -0.26), (0.44, -0.12), (0.62, -0.20)], em),
        ], 0.70 * em)
    if name in ('infty', '∞'):
        pts = []
        for i in range(25):
            t = i * math.tau / 24
            denom = 1.0 + math.sin(t) ** 2
            x = 0.45 + 0.35 * math.cos(t) / denom
            y = -0.26 + 0.22 * math.sin(t) * math.cos(t) / denom
            pts.append((x, y))
        return ([_poly(pts, em)], 0.90 * em)
    if name in ('pi', 'π'):
        return ([
            _poly([(0.06, -0.48), (0.68, -0.48)], em),
            _poly([(0.24, -0.48), (0.20, 0.0)], em),
            _poly([(0.48, -0.48), (0.48, -0.08), (0.54, 0.0), (0.62, -0.03)], em),
        ], 0.74 * em)
    if name in ('phi', 'varphi', 'φ'):
        return ([
            _arc(0.32, -0.28, 0.22, 0.24, 0, math.tau, em, 16),
            _poly([(0.42, -0.62), (0.22, 0.16)], em),
        ], 0.64 * em)
    if name in ('alpha', 'α'):
        return ([
            _poly([(0.56, -0.48), (0.42, -0.14), (0.28, 0.0), (0.14, -0.06), (0.12, -0.28),
                   (0.24, -0.46), (0.38, -0.44), (0.48, -0.12), (0.58, 0.0)], em),
        ], 0.66 * em)
    if name in ('beta', 'β'):
        return ([
            _poly([(0.16, 0.16), (0.22, -0.64), (0.38, -0.74), (0.52, -0.64), (0.48, -0.46),
                   (0.32, -0.38), (0.52, -0.30), (0.54, -0.10), (0.38, 0.0), (0.20, -0.04)], em),
        ], 0.64 * em)
    if name in ('gamma', 'γ'):
        return ([
            _poly([(0.08, -0.46), (0.24, -0.36), (0.36, 0.16), (0.32, 0.22), (0.30, 0.02), (0.54, -0.48)], em),
        ], 0.62 * em)
    if name in ('theta', 'θ'):
        return ([
            _arc(0.30, -0.34, 0.20, 0.34, 0, math.tau, em, 16),
            _poly([(0.12, -0.34), (0.48, -0.34)], em),
        ], 0.60 * em)
    if name in ('lambda', 'λ'):
        return ([
            _poly([(0.14, -0.68), (0.26, -0.68), (0.52, 0.0)], em),
            _poly([(0.34, -0.34), (0.12, 0.0)], em),
        ], 0.62 * em)
    if name in ('mu', 'μ'):
        return ([
            _poly([(0.16, 0.18), (0.22, -0.48)], em),
            _poly([(0.20, -0.12), (0.28, 0.0), (0.42, -0.06), (0.48, -0.48), (0.50, -0.06), (0.58, 0.0)], em),
        ], 0.66 * em)
    if name in ('sigma', 'σ'):
        return ([
            _arc(0.28, -0.24, 0.20, 0.22, 0, math.tau, em, 14),
            _poly([(0.28, -0.46), (0.60, -0.46)], em),
        ], 0.64 * em)
    if name in ('omega', 'ω'):
        return ([
            _poly([(0.18, -0.46), (0.08, -0.16), (0.16, 0.0), (0.32, -0.06), (0.36, -0.26),
                   (0.38, -0.06), (0.54, 0.0), (0.62, -0.16), (0.52, -0.46)], em),
        ], 0.70 * em)
    if name in ('Delta', 'Δ'):
        return ([
            _poly([(0.08, 0.0), (0.36, -0.70), (0.64, 0.0), (0.08, 0.0)], em),
        ], 0.72 * em)
    if name in ('sum', '∑'):
        return ([
            _poly([(0.72, -0.78), (0.10, -0.78), (0.46, -0.32), (0.10, 0.14), (0.72, 0.14)], em),
        ], 0.82 * em)
    if name in ('prod', '∏'):
        return ([
            _poly([(0.08, -0.76), (0.74, -0.76)], em),
            _poly([(0.22, -0.76), (0.22, 0.12)], em),
            _poly([(0.60, -0.76), (0.60, 0.12)], em),
        ], 0.82 * em)
    if name in ('int', '∫'):
        return ([
            _poly([(0.56, -0.82), (0.46, -0.90), (0.36, -0.78), (0.30, -0.30),
                   (0.24, 0.18), (0.14, 0.28), (0.06, 0.20)], em),
        ], 0.64 * em)
    if name in ('partial', '∂'):
        return ([
            _arc(0.30, -0.22, 0.18, 0.20, 0, math.tau, em, 14),
            _poly([(0.48, -0.22), (0.44, -0.62), (0.26, -0.70), (0.16, -0.60)], em),
        ], 0.60 * em)
    if name in ('nabla', '∇'):
        return ([
            _poly([(0.08, -0.68), (0.64, -0.68), (0.36, 0.0), (0.08, -0.68)], em),
        ], 0.72 * em)
    if name in ('ldots', 'cdots', 'dots', '…'):
        y = -0.28 if name == 'cdots' else -0.04
        return ([
            _arc(0.16, y, 0.03, 0.03, 0, math.tau, em, 6),
            _arc(0.38, y, 0.03, 0.03, 0, math.tau, em, 6),
            _arc(0.60, y, 0.03, 0.03, 0, math.tau, em, 6),
        ], 0.76 * em)
    return None


# ------------------------------------------------------------------ AST & Parser

@dataclass
class _MRow:
    items: list


@dataclass
class _MSym:
    text: str
    is_cmd: bool = False


@dataclass
class _MFrac:
    num: _MRow
    den: _MRow


@dataclass
class _MAccent:
    body: _MRow
    kind: str


@dataclass
class _MSqrt:
    body: _MRow
    deg: Optional[_MRow] = None


@dataclass
class _MScript:
    base: object
    sub: Optional[_MRow] = None
    sup: Optional[_MRow] = None


@dataclass
class _MSpace:
    em: float


@dataclass
class _MMatrix:
    rows: list[list[_MRow]]
    left: str = '('
    right: str = ')'


_FUNC_NAMES = {'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
               'sinh', 'cosh', 'tanh', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'gcd'}
_BIG_OPS = {'sum', 'prod', 'int', 'iint', 'oint', 'lim'}
_SPACES = {',': 0.16, ':': 0.22, ';': 0.28, ' ': 0.25, 'quad': 0.9, 'qquad': 1.8, '!': -0.1}


def _tokenize(tex: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    i = 0
    n = len(tex)
    while i < n:
        ch = tex[i]
        if ch in ' \t\r\n':
            i += 1
            continue
        if ch == '\\':
            if i + 1 < n and not tex[i + 1].isalpha():
                tokens.append(('cmd', tex[i + 1]))
                i += 2
                continue
            j = i + 1
            while j < n and tex[j].isalpha():
                j += 1
            name = tex[i + 1:j]
            if name == 'text':
                start = j
                while start < n and tex[start].isspace():
                    start += 1
                if start < n and tex[start] == '{':
                    end = tex.find('}', start + 1)
                    body = tex[start + 1:end] if end >= 0 else ''
                    if end >= 0 and '{' not in body and '\\' not in body:
                        tokens.append(('text', body))
                        i = end + 1
                        continue
            tokens.append(('cmd', name))
            i = j
            continue
        if ch in '{}^_[]&':
            tokens.append((ch, ch))
            i += 1
            continue
        tokens.append(('ch', ch))
        i += 1
    return tokens


class _MathParser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.toks = tokens
        self.pos = 0

    def peek(self) -> Optional[tuple[str, str]]:
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def next(self) -> Optional[tuple[str, str]]:
        t = self.peek()
        if t is not None:
            self.pos += 1
        return t

    def parse_row(self, stop_at: tuple[str, ...] = ()) -> _MRow:
        items: list = []
        while True:
            t = self.peek()
            if t is None:
                break
            if t[0] in stop_at:
                break
            if t == ('cmd', 'right') or t == ('cmd', 'end'):
                break
            if t[0] in ('^', '_'):
                op = self.next()[0]
                arg = self.parse_atom_as_row()
                base = items.pop() if items else _MSym('')
                if isinstance(base, _MScript):
                    if op == '^':
                        base.sup = arg
                    else:
                        base.sub = arg
                    items.append(base)
                else:
                    items.append(_MScript(base, sub=arg if op == '_' else None, sup=arg if op == '^' else None))
                continue
            items.append(self.parse_atom())
        return _MRow(items)

    def parse_atom_as_row(self) -> _MRow:
        t = self.peek()
        if t is not None and t[0] == '{':
            self.next()
            r = self.parse_row(stop_at=('}',))
            if self.peek() and self.peek()[0] == '}':
                self.next()
            return r
        return _MRow([self.parse_atom()])

    def parse_atom(self):
        t = self.next()
        if t is None:
            return _MSym('')
        kind, val = t
        if kind == 'text':
            return _MRow([_MSpace(0.25) if ch.isspace() else _MSym(ch) for ch in val])
        if kind == '{':
            r = self.parse_row(stop_at=('}',))
            if self.peek() and self.peek()[0] == '}':
                self.next()
            return r
        if kind == 'cmd':
            if val in _SPACES:
                return _MSpace(_SPACES[val])
            if val in ('frac', 'dfrac', 'tfrac'):
                num = self.parse_atom_as_row()
                den = self.parse_atom_as_row()
                return _MFrac(num, den)
            if val in ('bar', 'overline', 'underline', 'hat', 'widehat', 'vec'):
                return _MAccent(self.parse_atom_as_row(), val)
            if val == 'sqrt':
                deg = None
                if self.peek() == ('[', '['):
                    self.next()
                    deg = self.parse_row(stop_at=(']',))
                    if self.peek() == (']', ']'):
                        self.next()
                body = self.parse_atom_as_row()
                return _MSqrt(body, deg)
            if val in ('text', 'mathrm', 'mathbf', 'mathit', 'operatorname'):
                return self.parse_atom_as_row()
            if val == 'left':
                lt = self.next()
                lch = lt[1] if lt else '('
                if lch == '.':
                    lch = ''
                body = self.parse_row()
                if self.peek() == ('cmd', 'right'):
                    self.next()
                    rt = self.next()
                    rch = rt[1] if rt else ')'
                    if rch == '.':
                        rch = ''
                else:
                    rch = ''
                return _MRow(([ _MSym(lch) ] if lch else []) + [body] + ([ _MSym(rch) ] if rch else []))
            if val == 'begin':
                env_row = self.parse_atom_as_row()
                env = ''.join(it.text for it in env_row.items if isinstance(it, _MSym))
                rows: list[list[_MRow]] = [[]]
                while True:
                    cur = self.parse_row(stop_at=('&',))
                    rows[-1].append(cur)
                    p = self.peek()
                    if p == ('&', '&'):
                        self.next()
                        continue
                    if p == ('cmd', '\\'):
                        self.next()
                        rows.append([])
                        continue
                    if p == ('cmd', 'end'):
                        self.next()
                        self.parse_atom_as_row()
                        break
                    break
                delims = {'pmatrix': ('(', ')'), 'bmatrix': ('[', ']'), 'vmatrix': ('|', '|')}.get(env, ('', ''))
                return _MMatrix(rows, delims[0], delims[1])
            if val in _FUNC_NAMES:
                return _MRow([_MSym(ch) for ch in val])
            return _MSym(val, is_cmd=True)
        if val == '℃':
            return _MRow([_MSym('°'), _MSym('C')])
        return _MSym(val)


# ------------------------------------------------------------------ Box Layout

@dataclass
class _MBox:
    paths: list[Path]
    w: float
    ascent: float   # distance above baseline y=0 (positive)
    descent: float  # distance below baseline y=0 (positive)


def _translate_box(b: _MBox, dx: float, dy: float) -> list[Path]:
    out = []
    for p in b.paths:
        c = p.clone()
        c.transform(Affine2D().translate(dx, dy))
        out.append(c)
    return out


def _layout_node(node, em: float, glyph_fn: GlyphFn, display: bool) -> _MBox:
    if isinstance(node, _MSpace):
        return _MBox([], max(0.0, node.em * em), 0.1 * em, 0.0)

    if isinstance(node, _MSym):
        if not node.text:
            return _MBox([], 0.0, 0.1 * em, 0.0)
        if node.is_cmd:
            sym = _symbol_paths(node.text, em)
            if sym is not None:
                ps, adv = sym
                bb = bbox_of(ps)
                asc = max(0.3 * em, -bb[1]) if bb else 0.7 * em
                desc = max(0.0, bb[3]) if bb else 0.1 * em
                return _MBox(ps, adv, asc, desc)
            # Fallback: draw command text
            return _layout_node(_MRow([_MSym(c) for c in node.text]), em, glyph_fn, display)
        # Check single-stroke symbol override for unicode math chars
        sym = _symbol_paths(node.text, em)
        if sym is not None:
            ps, adv = sym
            bb = bbox_of(ps)
            asc = max(0.3 * em, -bb[1]) if bb else 0.7 * em
            desc = max(0.0, bb[3]) if bb else 0.1 * em
            return _MBox(ps, adv, asc, desc)
        ps, adv = glyph_fn(node.text, em)
        bb = bbox_of(ps)
        if bb:
            adv = max(adv, bb[2])
        if node.text.isalnum():
            adv += 0.07 * em
        asc = max(0.35 * em, -bb[1]) if bb else 0.7 * em
        desc = max(0.0, bb[3]) if bb else 0.05 * em
        # Slight extra padding around binary operators
        if node.text in ('+', '-', '=', '<', '>'):
            pad = 0.12 * em
            shifted = _translate_box(_MBox(ps, adv, asc, desc), pad, 0.0)
            return _MBox(shifted, adv + pad * 2, asc, desc)
        return _MBox(ps, adv, asc, desc)

    if isinstance(node, _MRow):
        paths: list[Path] = []
        x = 0.0
        asc = 0.35 * em
        desc = 0.05 * em
        for it in node.items:
            b = _layout_node(it, em, glyph_fn, display)
            paths.extend(_translate_box(b, x, 0.0))
            x += b.w
            asc = max(asc, b.ascent)
            desc = max(desc, b.descent)
        return _MBox(paths, x, asc, desc)

    if isinstance(node, _MFrac):
        sub_em = em * 0.76
        nb = _layout_node(node.num, sub_em, glyph_fn, False)
        db = _layout_node(node.den, sub_em, glyph_fn, False)
        bar_y = -0.28 * em
        pad_x = 0.12 * em
        w = max(nb.w, db.w) + pad_x * 2
        gap = 0.10 * em
        paths: list[Path] = []
        paths.extend(_translate_box(nb, (w - nb.w) * 0.5, bar_y - gap - nb.descent))
        paths.extend(_translate_box(db, (w - db.w) * 0.5, bar_y + gap + db.ascent))
        bar = Path()
        bar.move_to(0.0, bar_y)
        bar.line_to(w, bar_y)
        paths.append(bar)
        asc = -bar_y + gap + nb.descent + nb.ascent
        desc = bar_y + gap + db.ascent + db.descent
        return _MBox(paths, w, max(0.4 * em, asc), max(0.1 * em, desc))

    if isinstance(node, _MAccent):
        base = _layout_node(node.body, em, glyph_fn, display)
        if not base.paths:
            return base
        left, _, right, _ = bbox_of(base.paths)
        width = max(right - left, 0.15 * em)
        right = left + width
        pad = 0.08 * em
        y = -base.ascent - pad
        accent = Path()
        ascent, descent = base.ascent, base.descent
        if node.kind == 'underline':
            y = base.descent + pad
            accent.move_to(left, y)
            accent.line_to(right, y)
            descent = y
        elif node.kind in ('hat', 'widehat'):
            accent.move_to(left, y)
            accent.line_to((left + right) / 2, y - 0.13 * em)
            accent.line_to(right, y)
            ascent = -y + 0.13 * em
        else:
            accent.move_to(left, y)
            accent.line_to(right, y)
            if node.kind == 'vec':
                head = min(width * 0.3, 0.12 * em)
                accent.move_to(right - head, y - head)
                accent.line_to(right, y)
                ascent = -y + head
            else:
                ascent = -y
        return _MBox([*base.paths, accent], max(base.w, right), ascent, descent)

    if isinstance(node, _MSqrt):
        bb = _layout_node(node.body, em, glyph_fn, display)
        rad_w = 0.42 * em
        pad_top = 0.12 * em
        top_y = -bb.ascent - pad_top
        bot_y = bb.descent
        mid_y = (top_y + bot_y) * 0.55
        paths: list[Path] = []
        # Optional nth-root degree
        deg_w = 0.0
        if node.deg is not None:
            db = _layout_node(node.deg, em * 0.55, glyph_fn, False)
            deg_w = db.w + 0.05 * em
            paths.extend(_translate_box(db, 0.0, mid_y - 0.1 * em))
        rad = Path()
        rad.move_to(deg_w + 0.02 * em, mid_y)
        rad.line_to(deg_w + 0.14 * em, mid_y - 0.06 * em)
        rad.line_to(deg_w + 0.26 * em, bot_y + 0.04 * em)
        rad.line_to(deg_w + rad_w, top_y)
        rad.line_to(deg_w + rad_w + bb.w + 0.08 * em, top_y)
        paths.append(rad)
        paths.extend(_translate_box(bb, deg_w + rad_w + 0.04 * em, 0.0))
        return _MBox(paths, deg_w + rad_w + bb.w + 0.12 * em, -top_y, bot_y + 0.05 * em)

    if isinstance(node, _MScript):
        is_big = isinstance(node.base, _MSym) and node.base.is_cmd and node.base.text in _BIG_OPS
        is_lim = isinstance(node.base, _MRow) and ''.join(
            c.text for c in node.base.items if isinstance(c, _MSym)) == 'lim'
        bb = _layout_node(node.base, em, glyph_fn, display)
        scr_em = em * 0.64
        sub_b = _layout_node(node.sub, scr_em, glyph_fn, False) if node.sub else None
        sup_b = _layout_node(node.sup, scr_em, glyph_fn, False) if node.sup else None

        # Centered limits above/below for \sum, \prod, \lim in display mode
        if display and (is_lim or (is_big and getattr(node.base, 'text', '') != 'int')):
            w = max(bb.w, sub_b.w if sub_b else 0.0, sup_b.w if sup_b else 0.0)
            paths = _translate_box(bb, (w - bb.w) * 0.5, 0.0)
            asc = bb.ascent
            desc = bb.descent
            if sup_b:
                sy = -bb.ascent - 0.08 * em - sup_b.descent
                paths.extend(_translate_box(sup_b, (w - sup_b.w) * 0.5, sy))
                asc = -sy + sup_b.ascent
            if sub_b:
                sy = bb.descent + 0.08 * em + sub_b.ascent
                paths.extend(_translate_box(sub_b, (w - sub_b.w) * 0.5, sy))
                desc = sy + sub_b.descent
            return _MBox(paths, w, asc, desc)

        paths = list(bb.paths)
        scr_w = 0.0
        asc = bb.ascent
        desc = bb.descent
        if sup_b:
            sy = -max(0.38 * em, bb.ascent * 0.62)
            paths.extend(_translate_box(sup_b, bb.w, sy))
            scr_w = max(scr_w, sup_b.w)
            asc = max(asc, -sy + sup_b.ascent)
        if sub_b:
            sy = max(0.22 * em, bb.descent + 0.16 * em)
            paths.extend(_translate_box(sub_b, bb.w, sy))
            scr_w = max(scr_w, sub_b.w)
            desc = max(desc, sy + sub_b.descent)
        return _MBox(paths, bb.w + scr_w + 0.04 * em, asc, desc)

    if isinstance(node, _MMatrix):
        cell_boxes = [[_layout_node(c, em * 0.85, glyph_fn, False) for c in r] for r in node.rows]
        ncols = max((len(r) for r in cell_boxes), default=0)
        if ncols == 0:
            return _MBox([], 0.0, 0.5 * em, 0.1 * em)
        col_ws = [max((r[c].w for r in cell_boxes if c < len(r)), default=0.0) for c in range(ncols)]
        col_gap = 0.5 * em
        row_gap = 0.25 * em
        total_w = sum(col_ws) + col_gap * max(0, ncols - 1)
        row_hs = [max((b.ascent + b.descent for b in r), default=0.8 * em) for r in cell_boxes]
        total_h = sum(row_hs) + row_gap * max(0, len(cell_boxes) - 1)
        y_top = -0.3 * em - total_h * 0.5
        paths: list[Path] = []
        del_w = 0.35 * em if node.left else 0.0
        cur_y = y_top
        for ri, r in enumerate(cell_boxes):
            row_asc = max((b.ascent for b in r), default=0.5 * em)
            cur_x = del_w
            for ci, b in enumerate(r):
                paths.extend(_translate_box(b, cur_x + (col_ws[ci] - b.w) * 0.5, cur_y + row_asc))
                cur_x += col_ws[ci] + col_gap
            cur_y += row_hs[ri] + row_gap
        if node.left == '(':
            lp = _arc(del_w * 0.9, -0.3 * em, del_w * 0.5, total_h * 0.55, math.pi * 0.65, math.pi * 1.35, 1.0, 12)
            rp = _arc(del_w + total_w + del_w * 0.1, -0.3 * em, del_w * 0.5, total_h * 0.55, -math.pi * 0.35, math.pi * 0.35, 1.0, 12)
            paths.extend([lp, rp])
        elif node.left == '[':
            lp = Path(); lp.move_to(del_w * 0.8, y_top); lp.line_to(del_w * 0.3, y_top); lp.line_to(del_w * 0.3, y_top + total_h); lp.line_to(del_w * 0.8, y_top + total_h)
            rp = Path(); rx = del_w + total_w; rp.move_to(rx + del_w * 0.2, y_top); rp.line_to(rx + del_w * 0.7, y_top); rp.line_to(rx + del_w * 0.7, y_top + total_h); rp.line_to(rx + del_w * 0.2, y_top + total_h)
            paths.extend([lp, rp])
        elif node.left == '|':
            lp = Path(); lp.move_to(del_w * 0.5, y_top); lp.line_to(del_w * 0.5, y_top + total_h)
            rp = Path(); rx = del_w + total_w + del_w * 0.5; rp.move_to(rx, y_top); rp.line_to(rx, y_top + total_h)
            paths.extend([lp, rp])
        return _MBox(paths, total_w + del_w * 2, -y_top, y_top + total_h)

    return _MBox([], 0.0, 0.3 * em, 0.05 * em)


def render_handwritten_math(latex: str, em_mm: float, glyph_fn: GlyphFn,
                            display: bool = False) -> tuple[list[Path], float, float, float]:
    """Render LaTeX math into single-stroke Paths (top-left at 0,0, y-down).

    Returns (paths, width_mm, height_mm, baseline_y_mm).
    """
    tex = latex.strip()
    if not tex:
        return [], 0.0, em_mm, em_mm * 0.75
    tokens = _tokenize(tex)
    ast_root = _MathParser(tokens).parse_row()
    box = _layout_node(ast_root, em_mm, glyph_fn, display)
    # Shift vertically so top of box is at y=0; baseline (originally y=0) moves to box.ascent
    paths = _translate_box(box, 0.0, box.ascent)
    return paths, box.w, box.ascent + box.descent, box.ascent
